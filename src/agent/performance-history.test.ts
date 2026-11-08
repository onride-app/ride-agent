import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  localDay,
  performanceView,
  recordPerformance,
  type PerformancePoint,
} from "./analytics.js";
import { recommend, type Portfolio } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import {
  emptyState,
  PgRepository,
  Cursor,
  type MonitorHistoryReader,
  type State,
} from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";
import { migrateHistorySchema } from "./cold-history.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 30_000 };
const hour = 3_600_000;
const day = 24 * hour;

function portfolio(at = Date.now()): Portfolio {
  const p = fromPlan(
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
  p.snapshot = { ...snapshot(), observed_at: at };
  p.account_id = p.snapshot.account_id;
  p.initial_equity = "500";
  p.ledger_started_at = at - 10 * day;
  return p;
}

function point(p: Portfolio, at: number, revision = 1): PerformancePoint {
  return {
    portfolio_id: p.id,
    at,
    revision,
    state: p.state,
    account_value_usdc: "500",
    external_flows_usdc: "0",
    net_profit_usdc: String(revision),
    reconciliation: "complete",
    ledger_version: "fixture",
    sleeves: p.sleeves.map((s) => ({
      copy_id: s.copy_id,
      trader_id: s.trader.id,
      handle: s.trader.handle,
      state: s.state,
      net_profit_usdc: String(revision),
    })),
  };
}

async function fixture(legacySchemaOnly = false) {
  const admin = new pg.Pool({ connectionString: database });
  const schema = "performance_history_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database!);
  url.searchParams.set("options", "-c search_path=" + schema);
  const repo = new PgRepository(url.toString());
  if (legacySchemaOnly) await migrateHistorySchema(repo.pool);
  else await repo.migrate();
  const user = randomUUID();
  return {
    repo,
    user,
    url: url.toString(),
    async seed(state: State, owner = user) {
      await repo.pool.query(
        "INSERT INTO ride_agent_state(user_id,state) VALUES($1,$2)",
        [owner, state],
      );
    },
    async hotVersion() {
      return (
        await repo.pool.query(
          "SELECT xmin::text version,state ? 'performance' inline FROM ride_agent_state WHERE user_id=$1",
          [user],
        )
      ).rows[0];
    },
    async close() {
      await repo.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

it(
  "upgrades an existing history-v1 database once and concurrent new pools share the performance schema",
  options,
  async () => {
    const f = await fixture(true);
    const second = new PgRepository(f.url);
    try {
      const s = emptyState(),
        p = portfolio();
      s.portfolios = [p];
      s.performance = [point(p, 1), point(p, 1, 2)];
      await f.seed(s);
      await f.repo.pool.query(
        "INSERT INTO ride_agent_history_migrations(user_id) VALUES($1)",
        [f.user],
      );
      await Promise.all([f.repo.migrate(), second.migrate()]);
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_performance_schema WHERE version=1",
          )
        ).rows[0].n,
        1,
      );
      await f.repo.transactMonitor(f.user, async () => {});
      assert.deepEqual(await second.read(f.user), s);
    } finally {
      await second.close();
      await f.close();
    }
  },
);

it(
  "moves 62k legacy points without transferring history into the monitor, preserving global and same-ms order",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio(),
        other = portfolio();
      s.portfolios = [p, other];
      p.executions.push({
        id: "original_unknown",
        status: "uncertain",
        task_id: null,
      } as Portfolio["executions"][number]);
      s.performance = Array.from({ length: 62_000 }, (_, n) =>
        point(
          n % 2 ? p : other,
          p.snapshot!.observed_at - Math.floor(n / 3),
          n,
        ),
      );
      s.performance.push({ ...point(p, 1), portfolio_id: "removed_portfolio" });
      await f.seed(s);
      // Existing updates/decisions users already have the old marker.
      await f.repo.pool.query(
        "INSERT INTO ride_agent_history_migrations(user_id) VALUES($1)",
        [f.user],
      );
      assert.deepEqual(await f.repo.read(f.user), s);
      await assert.rejects(
        f.repo.transactMonitor(f.user, async () => {
          throw Error("rollback migration");
        }),
      );
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_performance",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_performance_heads",
          )
        ).rows[0].n,
        0,
      );
      assert.deepEqual(await f.repo.read(f.user), s);
      await f.repo.transactMonitor(f.user, async (projection) => {
        assert.deepEqual(projection.performance, s.performance!.slice(-3, -1));
        assert.equal(
          projection.portfolios[0].executions[0].id,
          "original_unknown",
        );
        assert.ok(JSON.stringify(projection).length < 15_000);
      });
      assert.deepEqual(await f.repo.read(f.user), s);
      const stored = await f.hotVersion();
      assert.equal(stored.inline, false);
      await f.repo.transactMonitor(f.user, async () => {});
      assert.deepEqual(
        await f.hotVersion(),
        stored,
        "no-op must not rewrite hot JSON",
      );
      const raw = (
        await f.repo.pool.query(
          "SELECT count(*)::int n,count(*) FILTER(WHERE payload=original)::int unchanged,min(ordinal)::int first,max(ordinal)::int last FROM ride_agent_performance",
        )
      ).rows[0];
      assert.deepEqual(raw, {
        n: 62_001,
        unchanged: 62_001,
        first: 1,
        last: 62_001,
      });
    } finally {
      await f.close();
    }
  },
);

it(
  "retains finite fractional timestamp precision in legacy migration, append and window comparisons",
  options,
  async () => {
    const f = await fixture();
    try {
      const end = Date.now() + 0.25,
        p = portfolio(end),
        s = emptyState();
      s.portfolios = [p];
      s.performance = [
        point(p, end - day - 0.25, 1),
        point(p, end - day + 0.5, 2),
        point(p, end, 3),
      ];
      await f.seed(s);
      await f.repo.transactMonitor(f.user, async (state, history) => {
        const points = await history!.performanceWindow(p.id, end - day, end);
        assert.deepEqual(
          performanceView({ ...state, performance: points }, p, "daily"),
          performanceView(s, p, "daily"),
        );
        state.performance!.push(point(p, end + 0.5, 4));
      });
      assert.deepEqual((await f.repo.read(f.user)).performance, [
        ...s.performance,
        point(p, end + 0.5, 4),
      ]);
    } finally {
      await f.close();
    }
  },
);

it(
  "full reads retain absent versus empty performance on legacy and migrated owners",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.seed(emptyState());
      assert.equal("performance" in (await f.repo.read(f.user)), false);
      await f.repo.transactMonitor(f.user, async (s) => {
        assert.equal("performance" in s, false);
      });
      assert.equal("performance" in (await f.repo.read(f.user)), false);
      await f.repo.transact(f.user, async (s) => {
        s.performance = [];
      });
      assert.deepEqual((await f.repo.read(f.user)).performance, []);
      await f.repo.transact(f.user, async (s) => {
        delete s.performance;
      });
      assert.equal("performance" in (await f.repo.read(f.user)), false);
    } finally {
      await f.close();
    }
  },
);

it(
  "exact indexed windows preserve baseline ties, future exclusion, gaps/null coverage and full daily/weekly/inception reports",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio(),
        end = p.snapshot!.observed_at;
      s.portfolios = [p];
      s.performance = Array.from({ length: 241 }, (_, n) =>
        point(p, end - (240 - n) * hour, n),
      );
      s.performance.splice(216, 0, point(p, end - day, 1000));
      // The last same-ms baseline follows original array order, not a hash/ID.
      s.performance.push(point(p, end - day, 1001), point(p, end + hour, 2000));
      await f.seed(s);
      const expected = ["daily", "weekly", "inception"].map((period) =>
        performanceView(s, p, period),
      );
      await f.repo.transactMonitor(f.user, async (state, history) => {
        for (const [i, period] of ["daily", "weekly", "inception"].entries()) {
          const start =
            period === "inception"
              ? p.ledger_started_at!
              : end - (period === "daily" ? day : 7 * day);
          const points = await history!.performanceWindow(p.id, start, end);
          assert.deepEqual(
            performanceView(
              { ...state, performance: points },
              state.portfolios[0],
              period,
            ),
            expected[i],
          );
          assert.equal(
            state.performance!.length,
            1,
            "window must never replace the monitor heads",
          );
          assert.equal(
            points.some((x) => x.at > end),
            false,
          );
        }
      });
      assert.deepEqual(await f.repo.read(f.user), s);
      for (const period of ["daily", "weekly", "inception"])
        assert.deepEqual(
          performanceView(await f.repo.read(f.user), p, period),
          performanceView(s, p, period),
        );
      await f.repo.transact(f.user, async (state) => {
        state.performance = state.performance!.filter(
          (x) => x.at !== end - 5 * hour,
        );
        state.performance!.find(
          (x) => x.at === end - 3 * hour,
        )!.net_profit_usdc = null;
      });
      const full = await f.repo.read(f.user);
      await f.repo.transactMonitor(f.user, async (state, history) => {
        const points = await history!.performanceWindow(p.id, end - day, end);
        const actual = performanceView(
          { ...state, performance: points },
          p,
          "daily",
        );
        assert.deepEqual(actual, performanceView(full, p, "daily"));
        assert.equal(actual.coverage, "incomplete");
        assert.equal(actual.net_profit_usdc, null);
      });
    } finally {
      await f.close();
    }
  },
);

it(
  "the production record helper uses latest append order, only appends on events/hour marks and does not rewrite hot JSON",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio();
      s.portfolios = [p];
      recordPerformance(s, p);
      await f.seed(s);
      await f.repo.transactMonitor(f.user, async () => {});
      const version = await f.hotVersion();
      await f.repo.transactMonitor(f.user, async (state) => {
        recordPerformance(state, state.portfolios[0]);
      });
      assert.deepEqual(await f.repo.read(f.user), s);
      assert.deepEqual(await f.hotVersion(), version);
      await f.repo.transactMonitor(f.user, async (state) => {
        // Same timestamp, genuine revision change: a distinct immutable point.
        state.portfolios[0].revision++;
        recordPerformance(state, state.portfolios[0]);
      });
      const event = await f.repo.read(f.user);
      assert.equal(event.performance!.length, 2);
      assert.equal(event.performance![0].at, event.performance![1].at);
      const beforeHour = await f.hotVersion();
      await f.repo.transactMonitor(f.user, async (state) => {
        // A point-only append leaves the hot portfolio byte-for-byte unchanged.
        const copy = structuredClone(state.portfolios[0]);
        copy.snapshot!.observed_at += hour;
        recordPerformance(state, copy);
      });
      assert.equal((await f.repo.read(f.user)).performance!.length, 3);
      assert.deepEqual(await f.hotVersion(), beforeHour);
    } finally {
      await f.close();
    }
  },
);

it(
  "on-demand analytics includes unsaved same-ms and baseline appends from the current callback without deduplication",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio(),
        end = p.snapshot!.observed_at;
      s.portfolios = [p];
      s.performance = Array.from({ length: 25 }, (_, n) =>
        point(p, end - (24 - n) * hour, n),
      );
      await f.seed(s);
      await f.repo.transactMonitor(f.user, async (state, history) => {
        const extra = [
          point(p, end, 900),
          point(p, end - day, 901),
          point(p, end, 900),
          point(p, end - 2 * day, 902),
          point(p, end + hour, 903),
        ];
        state.performance!.push(...extra);
        const points = await history!.performanceWindow(p.id, end - day, end);
        const full = { ...s, performance: [...s.performance!, ...extra] };
        assert.deepEqual(
          performanceView({ ...state, performance: points }, p, "daily"),
          performanceView(full, p, "daily"),
        );
        assert.equal(
          points.filter((x) => x.at === end && x.revision === 900).length,
          2,
        );
        assert.equal(
          points.some((x) => x.at > end),
          false,
        );
        assert.equal(points.filter((x) => x.at < end - day).length, 0);
      });
      assert.equal((await f.repo.read(f.user)).performance!.length, 30);
    } finally {
      await f.close();
    }
  },
);

it(
  "full callbacks can reorder, replace, splice and clear while every immutable original remains retained",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio();
      s.portfolios = [p];
      s.performance = [point(p, 1), point(p, 1, 2), point(p, 2, 3)];
      await f.seed(s);
      await f.repo.transactMonitor(f.user, async () => {});
      const original = structuredClone(s.performance);
      await f.repo.transact(f.user, async (state) => {
        state.performance!.reverse();
        state.performance![0].net_profit_usdc = "123";
        state.performance!.splice(1, 1);
      });
      const changed = await f.repo.read(f.user);
      assert.deepEqual(changed.performance, [
        { ...original[2], net_profit_usdc: "123" },
        original[0],
      ]);
      const audit = (
        await f.repo.pool.query(
          "SELECT original FROM ride_agent_performance WHERE user_id=$1 AND ordinal<=3 ORDER BY ordinal",
          [f.user],
        )
      ).rows.map((x) => x.original);
      assert.deepEqual(audit, original);
      await f.repo.transact(f.user, async (state) => {
        state.performance = [];
      });
      assert.deepEqual((await f.repo.read(f.user)).performance, []);
      await f.repo.transact(f.user, async (state) => {
        delete state.performance;
      });
      assert.equal("performance" in (await f.repo.read(f.user)), false);
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_performance WHERE user_id=$1",
            [f.user],
          )
        ).rows[0].n,
        5,
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "monitor rejects changing or removing a loaded prefix instead of losing unloaded history",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio();
      s.portfolios = [p];
      s.performance = [point(p, 1), point(p, 2)];
      await f.seed(s);
      await f.repo.transactMonitor(f.user, async () => {});
      for (const mutate of [
        (state: State) => {
          state.performance![0].revision++;
        },
        (state: State) => {
          state.performance = [];
        },
        (state: State) => {
          delete state.performance;
        },
      ]) {
        await assert.rejects(
          f.repo.transactMonitor(f.user, async (state) => {
            mutate(state);
          }),
          /guarded prefix/,
        );
        assert.deepEqual(await f.repo.read(f.user), s);
      }
    } finally {
      await f.close();
    }
  },
);

it(
  "a database failure after an append rolls back history, notification claims, ordinals and hot state together",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio();
      s.portfolios = [p];
      s.performance = [point(p, 1)];
      s.updates = [
        {
          id: "pending",
          at: Date.now(),
          kind: "fixture",
          portfolio_id: null,
          message: "fixture",
          data: {},
          notification: "pending",
        },
      ];
      await f.seed(s);
      await f.repo.transactMonitor(f.user, async () => {});
      await assert.rejects(
        f.repo.transactMonitor(f.user, async (state) => {
          state.portfolios[0].revision++;
          state.updates[0].notification_claim = {
            token: "fixture_claim",
            expires_at: Date.now() + hour,
          };
          state.performance!.push(point(p, 2), {
            ...point(p, 3),
            at: "not-an-integer" as unknown as number,
          });
        }),
      );
      assert.deepEqual(await f.repo.read(f.user), s);
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT count(*)::int n FROM ride_agent_performance",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await f.repo.pool.query(
            "SELECT next_ordinal::int n FROM ride_agent_performance_heads",
          )
        ).rows[0].n,
        1,
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "owner row locks serialize migration/appends and full MVCC readers never mix a new hot state with old performance",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio();
      s.portfolios = [p];
      s.performance = [point(p, 1)];
      await f.seed(s);
      let enter!: () => void, release!: () => void;
      const inside = new Promise<void>((r) => {
        enter = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const first = f.repo.transactMonitor(f.user, async (state) => {
        state.performance!.push(point(p, 2));
        state.portfolios[0].revision = 700;
        enter();
        await gate;
      });
      await inside;
      assert.deepEqual(
        await f.repo.read(f.user),
        s,
        "uncommitted migration remains invisible",
      );
      const secondRepo = new PgRepository(f.url);
      try {
        await Promise.race([
          secondRepo.migrate(),
          delay(1000).then(() => {
            throw Error("warm startup took a DDL lock");
          }),
        ]);
        let secondEntered = false;
        const second = secondRepo.transact(f.user, async (state) => {
          secondEntered = true;
          assert.equal(state.portfolios[0].revision, 700);
          assert.equal(state.performance!.length, 2);
          state.performance!.push(point(p, 3));
        });
        await delay(30);
        assert.equal(secondEntered, false);
        release();
        await Promise.all([first, second]);
        const full = await f.repo.read(f.user);
        assert.equal(full.portfolios[0].revision, 700);
        assert.deepEqual(full.performance, [
          ...s.performance,
          point(p, 2),
          point(p, 3),
        ]);
      } finally {
        release();
        await secondRepo.close();
      }
    } finally {
      await f.close();
    }
  },
);

it(
  "performance windows are owner-bound, and retained contexts cannot query after their transaction",
  options,
  async () => {
    const f = await fixture();
    try {
      const p = portfolio(),
        s = emptyState(),
        other = emptyState();
      s.portfolios = [p];
      s.performance = [point(p, 1, 100)];
      other.portfolios = [p];
      other.performance = [point(p, 1, 900)];
      const otherUser = randomUUID();
      await f.seed(s);
      await f.seed(other, otherUser);
      await f.repo.transactMonitor(otherUser, async () => {});
      let retained: MonitorHistoryReader | undefined;
      await f.repo.transactMonitor(f.user, async (_state, history) => {
        retained = history;
        assert.deepEqual(
          await history!.performanceWindow(p.id, 0, 2),
          s.performance,
        );
        await assert.rejects(
          history!.performanceWindow("foreign_portfolio", 0, 2),
          /Invalid/,
        );
      });
      assert.throws(() => retained!.performanceWindow(p.id, 0, 2), /closed/);
      assert.deepEqual(await f.repo.read(otherUser), other);
    } finally {
      await f.close();
    }
  },
);

it(
  "the real runner queries history only when a digest is due and preserves exact report semantics",
  options,
  async () => {
    const f = await fixture();
    try {
      const s = emptyState(),
        p = portfolio(),
        end = p.snapshot!.observed_at;
      p.state = "closed";
      s.portfolios = [p];
      s.performance = Array.from({ length: 49 }, (_, n) =>
        point(p, end - (48 - n) * hour, n),
      );
      s.notification_preferences = {
        daily_digest: true,
        local_time: "00:00",
        timezone: "UTC",
        enabled_at: end - day,
        last_digest_day: localDay(Date.now(), "UTC").day,
      };
      await f.seed(s);
      let reads = 0;
      const transact = f.repo.transactMonitor.bind(f.repo);
      f.repo.transactMonitor = (user, fn, ids) =>
        transact(
          user,
          (state, history) =>
            fn(state, {
              performanceWindow: (...args) => {
                reads++;
                return history!.performanceWindow(...args);
              },
            }),
          ids,
        );
      const adapter = new FakeAdapter();
      const runner = new AgentRunner(
        new AgentService(
          f.repo,
          adapter,
          "http://fixture.invalid",
          new Cursor("c".repeat(32)),
        ),
      );
      await runner.tick(f.user);
      await runner.notificationsIdle();
      assert.equal(reads, 0);
      await f.repo.transact(f.user, async (state) => {
        delete state.notification_preferences!.last_digest_day;
      });
      const before = await f.repo.read(f.user);
      await runner.tick(f.user);
      await runner.notificationsIdle();
      assert.equal(reads, 1);
      const full = await f.repo.read(f.user);
      const digest = full.updates.find((x) => x.kind === "daily_digest")!;
      assert.deepEqual(
        digest.data.performance,
        performanceView(before, before.portfolios[0], "daily"),
      );
      assert.deepEqual(full.performance, s.performance);
      assert.equal(adapter.submitCount, 0, "fixture never invokes execution");
      assert.equal((await f.hotVersion()).inline, false);
    } finally {
      await f.close();
    }
  },
);
