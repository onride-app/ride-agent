import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { recordDecision, type Decision } from "./analytics.js";
import type { VenueAdapter } from "./adapter.js";
import { fingerprint, recommend } from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import { MAX_RECENT_MONITOR_UPDATES } from "./cold-history.js";
import {
  Cursor,
  emptyState,
  PgRepository,
  type State,
  type Update,
} from "./repository.js";
import { eventOnce } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 20_000 };
function portfolio() {
  return fromPlan(
    recommend(
      {
        budget_usdc: "100",
        loss_trigger_pct: 20,
        market: "perps",
        assets: ["BTC"],
        allow_altcoins: false,
        portfolio_kind: "single",
        basket_size: 1,
      },
      [candidate(1)],
    ),
  );
}
function update(
  id: string,
  notification: Update["notification"] = "delivered",
): Update {
  return {
    id,
    at: Date.now() - 7_200_000,
    kind: "fixture",
    portfolio_id: null,
    message: "Historical fixture",
    data: { audit: "a".repeat(512) },
    notification,
  };
}
function decision(index: number): Decision {
  return {
    at: index,
    copy_id: "copy",
    key: "perps:BTC",
    source_revision: String(index),
    reason: "SOURCE_UPDATED",
    config: {} as Decision["config"],
    source_quantity: "1",
    target_quantity: index === 0 ? "1" : null,
    source_entry_price: "100",
    follower_mark: "100",
  };
}
async function fixture() {
  const admin = new pg.Pool({ connectionString: database });
  const schema = "cold_history_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database!);
  url.searchParams.set("options", "-c search_path=" + schema);
  const repo = new PgRepository(url.toString());
  await repo.migrate();
  const user = randomUUID();
  return {
    repo,
    user,
    url: url.toString(),
    async seed(state: State) {
      await repo.pool.query(
        "INSERT INTO ride_agent_state(user_id,state) VALUES($1,$2)",
        [user, state],
      );
    },
    async close() {
      await repo.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

it(
  "lazily moves legacy history atomically, keeps stable event cursors/raw records, and bounds the monitor projection",
  options,
  async () => {
    const f = await fixture();
    try {
      const state = emptyState(),
        p = portfolio();
      p.decisions = Array.from({ length: 1500 }, (_, i) => decision(i));
      state.portfolios.push(p);
      state.updates = Array.from({ length: 1500 }, (_, i) =>
        update(`event_${i}`),
      );
      state.updates.push(
        ...Array.from({ length: 25 }, (_, i) =>
          update(`pending_${i}`, "pending"),
        ),
      );
      // All financial/unknown fields are part of the unchanged hot portfolio.
      p.executions.push({
        id: "unknown_original",
        status: "uncertain",
        task_id: null,
      } as (typeof p.executions)[number]);
      await f.seed(state);
      assert.deepEqual(await f.repo.read(f.user), state);
      await assert.rejects(
        f.repo.transactMonitor(f.user, async () => {
          throw Error("rollback");
        }),
      );
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_history_migrations",
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(await f.repo.read(f.user), state);
      await f.repo.transactMonitor(f.user, async (projection) => {
        assert.equal(projection.updates.length, 4);
        assert.equal(projection.portfolios[0].decisions!.length, 2);
        assert.equal(
          projection.portfolios[0].decisions![0].target_quantity,
          "0",
          "older admission evidence survives a latest null decision",
        );
        assert.equal(
          projection.portfolios[0].executions[0].id,
          "unknown_original",
        );
        assert.ok(
          JSON.stringify(projection).length < JSON.stringify(state).length / 20,
        );
      });
      assert.deepEqual(await f.repo.read(f.user), state);
      const stored = await f.repo.pool.query(
        `SELECT state->'updates' updates,state->'portfolios'->0 ? 'decisions' inline_decisions FROM ride_agent_state WHERE user_id=$1`,
        [f.user],
      );
      assert.deepEqual(stored.rows[0], {
        updates: [],
        inline_decisions: false,
      });
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_updates WHERE payload=original",
          )
        ).rows[0].n,
        1525,
      );
      const before = (
        await f.repo.pool.query(
          "SELECT xmin::text version FROM ride_agent_state WHERE user_id=$1",
          [f.user],
        )
      ).rows[0].version;
      await f.repo.transactMonitor(f.user, async () => {});
      const after = (
        await f.repo.pool.query(
          "SELECT xmin::text version FROM ride_agent_state WHERE user_id=$1",
          [f.user],
        )
      ).rows[0].version;
      assert.equal(
        after,
        before,
        "unchanged monitor must not rewrite hot JSON",
      );
      assert.ok((await f.repo.users()).includes(f.user));
      const second = new PgRepository(f.url);
      try {
        assert.deepEqual(await second.read(f.user), state);
      } finally {
        await second.close();
      }
    } finally {
      await f.close();
    }
  },
);

it(
  "retains row-lock serialization and full Repository mutations without overwriting unloaded records",
  options,
  async () => {
    const f = await fixture();
    try {
      const state = emptyState(),
        p = portfolio();
      p.decisions = [decision(0), decision(1)];
      state.portfolios.push(p);
      state.updates = [update("historical"), update("pending", "pending")];
      await f.seed(state);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const inside = new Promise<void>((done) => {
        entered = done;
      });
      const first = f.repo.transactMonitor(f.user, async (s) => {
        entered();
        await gate;
        s.updates.find((e) => e.id === "pending")!.notification = "delivered";
      });
      await inside;
      let secondEntered = false;
      const second = f.repo.transact(f.user, async (s) => {
        secondEntered = true;
        assert.equal(
          s.updates.find((e) => e.id === "pending")!.notification,
          "delivered",
        );
        s.updates.find((e) => e.id === "historical")!.message =
          "Preserved update";
        s.portfolios[0].decisions!.push(decision(2));
      });
      await delay(30);
      assert.equal(secondEntered, false);
      release();
      await Promise.all([first, second]);
      const saved = await f.repo.read(f.user);
      assert.equal(saved.updates.length, 2);
      assert.equal(saved.portfolios[0].decisions!.length, 3);
      assert.equal(saved.updates[0].message, "Preserved update");
      const raw = (
        await f.repo.pool.query(
          "SELECT original->>'message' message FROM ride_agent_updates WHERE user_id=$1 AND id='historical'",
          [f.user],
        )
      ).rows[0];
      assert.equal(raw.message, "Historical fixture");
      let firstToken = "";
      await f.repo.transactMonitor(f.user, async (s) => {
        firstToken = fingerprint(s.portfolios[0]);
      });
      await f.repo.transact(f.user, async (s) => {
        // Change a cold record outside the latest projection. The durable
        // history version must still invalidate the approved phase token.
        s.portfolios[0].decisions![0].reason = "HISTORICAL_CORRECTION";
      });
      await f.repo.transactMonitor(f.user, async (s) => {
        assert.notEqual(fingerprint(s.portfolios[0]), firstToken);
      });
      await assert.rejects(
        f.repo.transactMonitor(f.user, async (s) => {
          s.portfolios[0].decisions![0].target_quantity = null;
        }),
        /guarded prefix/,
      );
      await f.repo.transact(f.user, async (s) => {
        delete s.portfolios[0].decisions;
        s.updates = [];
      });
      const cleared = await f.repo.read(f.user);
      assert.equal(Object.hasOwn(cleared.portfolios[0], "decisions"), false);
      assert.deepEqual(cleared.updates, []);
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_updates WHERE user_id=$1",
            [f.user],
          )
        ).rows[0].n,
        2,
        "logical removal never destroys original history",
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "old notification claims and delayed ACKs use exact IDs across cold projection and restart",
  options,
  async () => {
    const f = await fixture();
    try {
      const state = emptyState();
      state.updates = Array.from({ length: 9 }, (_, i) =>
        update(`pending_${i}`, "pending"),
      );
      await f.seed(state);
      const delivered: string[] = [];
      const adapter: VenueAdapter = new FakeAdapter();
      adapter.notify = async (_user, e) => {
        delivered.push(e.id);
      };
      const dispatcher = new NotificationDispatcher(f.repo, adapter);
      dispatcher.enqueue(f.user);
      await dispatcher.idle();
      assert.equal(delivered.length, 4);
      assert.equal(
        (await f.repo.read(f.user)).updates.filter(
          (e) => e.notification === "delivered",
        ).length,
        4,
      );
      await dispatcher.close();
      const next = new NotificationDispatcher(f.repo, adapter);
      next.enqueue(f.user);
      await next.idle();
      await next.close();
      assert.equal(new Set(delivered).size, 8);
      const rows = (await f.repo.read(f.user)).updates;
      assert.equal(
        rows.filter((e) => e.notification === "delivered").length,
        8,
      );
      assert.equal(rows.filter((e) => e.notification === "pending").length, 1);
      const preparedDispatcher = new NotificationDispatcher(f.repo, adapter);
      const prepared = await f.repo.transactMonitor(f.user, async (s) =>
        preparedDispatcher.prepare(f.user, s),
      );
      preparedDispatcher.committed(prepared);
      await preparedDispatcher.idle();
      await preparedDispatcher.flush();
      await preparedDispatcher.close();
      assert.equal(
        (await f.repo.read(f.user)).updates.filter(
          (e) => e.notification === "delivered",
        ).length,
        9,
      );
      assert.equal(
        new Set(delivered).size,
        9,
        "prepared ACK must load the exact old claimed ID, even when its lease excludes it from the due projection",
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "legacy budget delivery merges retain every raw audit, isolate diagnostic identities and never cancel a claimed or financial event",
  options,
  async () => {
    const f = await fixture();
    try {
      const state = emptyState(),
        base = Date.now() - 7_200_000;
      state.updates = Array.from({ length: 100 }, (_, i) => ({
        ...update(`budget_${i}`, "pending"),
        at: base + i,
        kind: "VENUE_READ_BUDGET_EXHAUSTED",
        portfolio_id: "portfolio",
        data: { diagnostics: { retry_after_ms: 5000 - i, scope: "account" } },
      }));
      const separate = [
        {
          ...state.updates[0],
          id: "nonobject_diagnostics",
          data: { diagnostics: ["preserved"] },
        },
        {
          ...state.updates[0],
          id: "source_scope",
          data: { diagnostics: { scope: "source" } },
        },
        {
          ...state.updates[0],
          id: "different_portfolio",
          portfolio_id: "another",
        },
        ...["diagnostic_a", "diagnostic_b"].map((id) => ({
          ...state.updates[0],
          id,
          data: { diagnostics: { diagnostic_id: id, retry_after_ms: 20 } },
        })),
        ...["execution_a", "execution_b"].map((id) => ({
          ...state.updates[0],
          id,
          data: { execution_id: id, diagnostics: { retry_after_ms: 20 } },
        })),
        {
          ...state.updates[0],
          id: "claimed",
          notification_claim: {
            token: "original_claim",
            expires_at: Date.now() + 60_000,
          },
        },
        {
          ...state.updates[0],
          id: "expired_claim",
          notification_claim: { token: "unknown_send", expires_at: 1 },
        },
        ...[
          "EXECUTION_UNCERTAIN",
          "funding_received",
          "sleeve_loss_triggered",
        ].map((kind) => ({ ...update(kind, "pending"), kind })),
      ];
      state.updates.push(...separate);
      await f.seed(state);
      await f.repo.transactMonitor(f.user, async () => {});
      const saved = await f.repo.read(f.user),
        budgets = saved.updates.filter((e) => /^budget_/.test(e.id));
      assert.equal(budgets.length, 100);
      assert.equal(
        budgets.filter((e) => e.notification === "cancelled").length,
        99,
      );
      const representative = budgets.find((e) => e.notification === "pending")!;
      assert.equal(representative.id, "budget_99");
      assert.equal(representative.observation_episode!.count, 100);
      assert.ok(
        budgets
          .filter((e) => e.notification === "cancelled")
          .every((e) => e.notification_superseded_by === representative.id),
      );
      for (const original of separate)
        assert.deepEqual(
          saved.updates.find((e) => e.id === original.id),
          original,
        );
      const raw = await f.repo.pool.query(
        "SELECT id,original FROM ride_agent_updates WHERE user_id=$1 ORDER BY ordinal",
        [f.user],
      );
      assert.deepEqual(
        raw.rows.map((r) => r.original),
        state.updates,
      );
      assert.equal(raw.rowCount, state.updates.length);
    } finally {
      await f.close();
    }
  },
);

it(
  "nine thousand recent history rows stay capped while old due/ACK notifications, full pagination and unknown execution IDs remain available",
  options,
  async () => {
    const f = await fixture();
    try {
      const state = emptyState(),
        p = portfolio(),
        at = Date.now() - 1000;
      p.executions.push({
        id: "unknown_execution_id",
        status: "uncertain",
        task_id: null,
      } as (typeof p.executions)[number]);
      state.portfolios.push(p);
      state.updates = Array.from({ length: 9000 }, (_, i) => ({
        ...update(`recent_${String(i).padStart(5, "0")}`),
        at,
        data: { index: i },
      }));
      const financial = {
        ...update("financial_unknown", "pending"),
        kind: "EXECUTION_UNCERTAIN",
      };
      const ack = {
        ...update("inflight_ack", "pending"),
        notification_claim: {
          token: "preserved",
          expires_at: Date.now() + 60_000,
        },
      };
      state.updates.push(financial, ack);
      await f.seed(state);
      await f.repo.transactMonitor(
        f.user,
        async (s) => {
          assert.equal(s.updates.length, MAX_RECENT_MONITOR_UPDATES + 2);
          assert.ok(s.updates.find((e) => e.id === financial.id));
          assert.deepEqual(
            s.updates.find((e) => e.id === ack.id),
            ack,
          );
          assert.equal(
            s.portfolios[0].executions[0].id,
            "unknown_execution_id",
          );
          assert.equal(s.portfolios[0].executions[0].status, "uncertain");
        },
        [ack.id],
      );
      const api = new AgentService(
        f.repo,
        new FakeAdapter(),
        "https://fixture.invalid",
        new Cursor("k".repeat(32)),
      );
      const sorted = [...state.updates].sort(
        (a, b) => a.at - b.at || a.id.localeCompare(b.id),
      );
      const first = (await api.tool(f.user, "get_updates", { limit: 50 }))
        .data as any;
      const second = (
        await api.tool(f.user, "get_updates", {
          limit: 50,
          cursor: first.next_cursor,
        })
      ).data as any;
      assert.deepEqual(
        first.updates.map((e: Update) => e.id),
        sorted.slice(0, 50).map((e) => e.id),
      );
      assert.deepEqual(
        second.updates.map((e: Update) => e.id),
        sorted.slice(50, 100).map((e) => e.id),
      );
      assert.equal(first.has_more, true);
      assert.equal(
        (await f.repo.read(f.user)).updates.length,
        state.updates.length,
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "native discovery includes future deferred/claimed delivery, attention and digest users without depending on the bounded projection",
  options,
  async () => {
    const f = await fixture();
    try {
      const state = emptyState();
      const pending = {
        ...update("future_claim", "pending"),
        next_notification_at: Date.now() + 3_600_000,
        notification_claim: { token: "keep", expires_at: Date.now() + 60_000 },
      };
      state.updates.push(pending);
      await f.seed(state);
      assert.ok(
        (await f.repo.users()).includes(f.user),
        "NULL imported eligibility keeps the exact legacy fallback",
      );
      await f.repo.transactMonitor(f.user, async (s) => {
        assert.equal(s.updates.length, 0);
      });
      assert.ok(
        (await f.repo.users()).includes(f.user),
        "future pending must survive even when it is absent from the monitor snapshot",
      );
      await f.repo.transact(f.user, async (s) => {
        s.updates[0].notification = "delivered";
      });
      assert.equal((await f.repo.users()).includes(f.user), false);
      await f.repo.transact(f.user, async (s) => {
        s.notification_preferences = {
          daily_digest: true,
          enabled_at: Date.now(),
          local_time: "09:00",
          timezone: "UTC",
        };
      });
      assert.ok((await f.repo.users()).includes(f.user));
      await f.repo.transact(f.user, async (s) => {
        s.notification_preferences!.daily_digest = false;
        const p = portfolio();
        p.state = "attention";
        s.portfolios.push(p);
      });
      assert.ok((await f.repo.users()).includes(f.user));
      await f.repo.transact(f.user, async (s) => {
        s.portfolios[0].state = "closed";
      });
      assert.equal((await f.repo.users()).includes(f.user), false);
      const row = (
        await f.repo.pool.query(
          "SELECT monitor_eligible FROM ride_agent_state WHERE user_id=$1",
          [f.user],
        )
      ).rows[0];
      assert.equal(row.monitor_eligible, false);
    } finally {
      await f.close();
    }
  },
);

it(
  "schema startup follows state-before-history lock order and a warm new reader needs no DDL lock during a financial callback",
  options,
  async () => {
    const f = await fixture(),
      migrating = new PgRepository(f.url),
      reader = new PgRepository(f.url);
    let release: (() => void) | undefined, work: Promise<void> | undefined;
    try {
      await f.seed(emptyState());
      await f.repo.transactMonitor(f.user, async () => {});
      let entered!: () => void;
      let inside = new Promise<void>((done) => {
        entered = done;
      });
      let gate = new Promise<void>((done) => {
        release = done;
      });
      work = f.repo.transactMonitor(f.user, async (s) => {
        entered();
        await gate;
        s.updates.push(update("committed_after_ddl_wait"));
      });
      await inside;
      // This is an isolated test schema, simulating first startup while an older
      // history-aware process already holds the normal business row lock.
      await f.repo.pool.query("DROP TABLE ride_agent_history_schema");
      let migrated = false;
      const migration = migrating.migrate().then(() => {
        migrated = true;
      });
      await delay(30);
      assert.equal(migrated, false);
      release!();
      await Promise.all([work, migration]);
      assert.equal(
        (await migrating.read(f.user)).updates[0].id,
        "committed_after_ddl_wait",
      );
      inside = new Promise<void>((done) => {
        entered = done;
      });
      gate = new Promise<void>((done) => {
        release = done;
      });
      work = f.repo.transactMonitor(f.user, async () => {
        entered();
        await gate;
      });
      await inside;
      const visible = await reader.read(f.user);
      assert.equal(visible.updates[0].id, "committed_after_ddl_wait");
      release!();
      await work;
    } finally {
      release?.();
      await work?.catch(() => {});
      await migrating.close();
      await reader.close();
      await f.close();
    }
  },
);

it("budget countdown observations share one stable event episode; execution/scoped changes and hourly boundaries remain separate", () => {
  const s = emptyState(),
    kind = "VENUE_READ_BUDGET_EXHAUSTED";
  eventOnce(s, kind, "p", "budget", {
    diagnostics: { retry_after_ms: 5000, scope: "account" },
  });
  const original = s.updates[0],
    id = original.id;
  original.notification = "delivered";
  eventOnce(s, kind, "p", "budget", {
    diagnostics: { retry_after_ms: 4000, scope: "account" },
  });
  assert.equal(s.updates.length, 1);
  assert.equal(original.id, id);
  assert.equal(original.notification, "delivered");
  assert.equal(original.observation_episode?.count, 2);
  assert.equal(
    original.data.diagnostics &&
      (original.data.diagnostics as any).retry_after_ms,
    5000,
  );
  assert.equal(
    (original.observation_episode!.latest_data.diagnostics as any)
      .retry_after_ms,
    4000,
  );
  eventOnce(s, kind, "p", "budget", {
    diagnostics: { retry_after_ms: 4000, scope: "source" },
  });
  assert.equal(s.updates.length, 2);
  for (const execution_id of ["original_a", "original_b"])
    eventOnce(s, "EXECUTION_UNCERTAIN", "p", "uncertain", { execution_id });
  assert.equal(s.updates.length, 4);
  original.at -= 3600_001;
  eventOnce(s, kind, "p", "budget", {
    diagnostics: { retry_after_ms: 3000, scope: "account" },
  });
  assert.equal(s.updates.length, 5);
});

it("identical decision observations summarize only exact business equality, preserving source/config/target changes", () => {
  const p = portfolio(),
    sleeve = p.sleeves[0],
    source = {
      key: "perps:BTC",
      quantity: "1",
      source_revision: "same",
      source_entry_price: "100",
    };
  recordDecision(p, sleeve, source, "100", null, "MIN_NOTIONAL");
  recordDecision(p, sleeve, source, "100", null, "MIN_NOTIONAL");
  assert.equal(p.decisions!.length, 1);
  assert.equal(p.decisions![0].observation_episode?.count, 2);
  recordDecision(
    p,
    sleeve,
    { ...source, source_revision: "changed" },
    "100",
    null,
    "MIN_NOTIONAL",
  );
  recordDecision(p, sleeve, source, "100", "0.1", "MIN_NOTIONAL");
  sleeve.amount_usdc = "200";
  recordDecision(p, sleeve, source, "100", "0.1", "MIN_NOTIONAL");
  assert.equal(p.decisions!.length, 4);
});
