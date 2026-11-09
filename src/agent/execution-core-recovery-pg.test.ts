import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import pg from "pg";
import { AgentError } from "./contracts.js";
import { CoreBridge } from "./core_bridge.js";
import type { Execution, Portfolio } from "./domain.js";
import { now, recommend } from "./domain.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import type { VenueAdapter } from "./adapter.js";
import { PgRepository, Cursor } from "./repository.js";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
if (
  database &&
  !["127.0.0.1", "localhost", "[::1]"].includes(new URL(database).hostname)
)
  throw new Error(
    "Recovery integration tests require an isolated loopback PostgreSQL",
  );
const options = { skip: !database, timeout: 15_000 };

async function fixture() {
  const admin = new pg.Pool({ connectionString: database, max: 2 });
  const schema = `execution_recovery_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  await pool.query(`CREATE TABLE ride_agent_core_outbox (
    execution_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,portfolio_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,payload JSONB NOT NULL,response JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const user = randomUUID(),
    account = randomUUID(),
    task = randomUUID(),
    epoch = randomUUID();
  const p = {
    id: `portfolio_${randomUUID()}`,
    account_id: account,
    sleeves: [],
  } as unknown as Portfolio;
  const at = Date.now();
  const e: Execution = {
    id: `execution_${randomUUID()}`,
    key: "perps:BTC",
    target_quantity: "1",
    allocations: {},
    status: "uncertain",
    revision: 1,
    fingerprint: "f".repeat(64),
    created_at: at - 120_000,
    expires_at: at - 60_000,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "10",
    error: null,
  };
  const payload = {
    user_id: user,
    account_id: account,
    execution_id: e.id,
    fingerprint: e.fingerprint,
    asset: "BTC",
    direction: "long",
    target_position_pct: "10.0000",
    leverage: 2,
    created_at: e.created_at,
    expires_at: e.expires_at,
    policy_revision: 1,
    target_quantity: "1",
    entry_reference_price: "100",
    max_entry_deviation_bps: 20,
  };
  const bridges: CoreBridge[] = [];
  const calls: string[] = [];
  let response: "positive" | "unknown" | "unsupported" | "negative" =
    "positive";
  let failAccount = false;
  let taskStatus = 2;
  let settlementPending = false;
  let taskResponsePatch: Record<string, unknown> = {};
  let retirementMode: "retired" | "unknown" | "lost" = "unknown";
  const tombstone = randomUUID();
  let retiredAt: number | undefined;
  let lostRetirementResponse = false;
  function bridge(network: "mainnet" | "testnet" = "mainnet") {
    const result = new CoreBridge(
      "https://core.test",
      "fixture",
      url.toString(),
      "fixture-original-source-salt-at-least-32",
      network,
    );
    const stub = result as any;
    stub.core = async (operation: string, input: any) => {
      calls.push(operation);
      if (operation === "perps_execution_retirement") {
        assert.equal(process.env.RIDE_AGENT_READ_ONLY, "false");
        if (retirementMode === "unknown")
          return { protocol_version: 1, retirement: "unknown", proof: null };
        retiredAt ??= Date.now();
        if (retirementMode === "lost" && !lostRetirementResponse) {
          lostRetirementResponse = true;
          throw new AgentError(
            "CORE_UNAVAILABLE",
            "Permanent fence committed but response lost",
            true,
            503,
          );
        }
        return {
          protocol_version: 1,
          retirement: "original_absence_retired",
          reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED",
          proof: {
            ...input,
            network: "mainnet",
            observed_at: Date.now(),
            current_execution_epoch: epoch,
            retirement_epoch: epoch,
            tombstone_id: tombstone,
            retired_at: retiredAt,
            serialized_absence_check: true,
            permanent_original_id_fence: true,
            historical_bindings_checked: true,
          },
        };
      }
      if (operation === "perps_execution_recovery") {
        assert.deepEqual(Object.keys(input).sort(), [
          "account_id",
          "asset",
          "created_at",
          "execution_id",
          "expires_at",
          "fingerprint",
          "target_quantity",
          "user_id",
        ]);
        if (response === "unsupported")
          throw new AgentError(
            "CORE_UNAVAILABLE",
            "Unsupported read-only recovery",
            true,
            503,
          );
        if (response !== "positive")
          return {
            protocol_version: 1,
            acceptance: "unknown",
            task_id: null,
            reason_code: "ORIGINAL_NOT_FOUND",
            proof: null,
          };
        return {
          protocol_version: 1,
          acceptance: "accepted",
          task_id: task,
          reason_code: "ORIGINAL_TASK_FOUND",
          proof: {
            ...input,
            network: "mainnet",
            observed_at: Date.now(),
            intent_id: randomUUID(),
            current_execution_epoch: epoch,
            original_execution_epoch: epoch,
            wallet_generation: 3,
            original_wallet_generation: 3,
            serialized_identity_check: true,
          },
        };
      }
      if (operation === "perps_execution_acceptance") {
        const fields = [
          "user_id",
          "account_id",
          "execution_id",
          "fingerprint",
          "asset",
          "direction",
          "target_position_pct",
          "leverage",
          "created_at",
          "expires_at",
          "policy_revision",
        ];
        assert.deepEqual(
          input,
          Object.fromEntries(fields.map((key) => [key, (payload as any)[key]])),
        );
        if (response !== "positive" && response !== "negative")
          return { acceptance: "unknown" };
        const negative = response === "negative";
        return {
          protocol_version: 1,
          acceptance: negative ? "not_accepted_expired" : "accepted",
          task_id: negative ? null : task,
          reason_code: negative
            ? "EXPIRED_ABSENT_UNDER_ADMISSION_LOCK"
            : "ORIGINAL_TASK_FOUND",
          proof: {
            ...input,
            network: "mainnet",
            observed_at: Date.now(),
            current_execution_epoch: epoch,
            serialized_expiry_check: negative,
          },
        };
      }
      if (operation === "perps_execution") {
        assert.deepEqual(input, {
          user_id: user,
          account_id: account,
          task_id: task,
        });
        return {
          task_id: task,
          status: taskStatus,
          snapshot: {
            fill_settlement_pending: settlementPending,
            settlement_observation_required: false,
          },
          legs: [{ quantity: "0.4" }],
          ...taskResponsePatch,
        };
      }
      assert.fail(`Recovery cannot call a financial write: ${operation}`);
    };
    stub.account = async () => {
      calls.push("fresh_account_observation");
      if (failAccount)
        throw new AgentError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          "Fixture read denied",
          true,
          503,
        );
      return { positions: { "perps:BTC": "0.4" } };
    };
    bridges.push(result);
    return result;
  }
  return {
    pool,
    user,
    p,
    e,
    payload,
    task,
    bridge,
    calls,
    url: url.toString(),
    tombstone,
    setRetirementMode: (value: typeof retirementMode) => {
      retirementMode = value;
    },
    setResponse: (value: typeof response) => {
      response = value;
    },
    setFailAccount: (value: boolean) => {
      failAccount = value;
    },
    setTaskStatus: (value: number, pending = false) => {
      taskStatus = value;
      settlementPending = pending;
    },
    setTaskResponsePatch: (value: Record<string, unknown>) => {
      taskResponsePatch = value;
    },
    async close() {
      await Promise.all(bridges.map((b) => b.close()));
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}

it(
  "PostgreSQL missing-outbox recovery survives restart without synthesizing payloads or resubmitting an unknown original",
  options,
  async () => {
    const f = await fixture();
    const original = structuredClone(f.e);
    try {
      for (const unavailable of ["unknown", "unsupported"] as const) {
        f.setResponse(unavailable);
        assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
          status: "uncertain",
          observed_quantity: null,
          settled: false,
        });
        assert.equal(
          (
            await f.pool.query(
              "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
            )
          ).rows[0].n,
          0,
        );
      }
      f.setResponse("positive");
      f.setFailAccount(true);
      await assert.rejects(f.bridge().execution(f.user, f.p, f.e), {
        code: "VENUE_READ_BUDGET_EXHAUSTED",
      });
      assert.deepEqual(
        f.e,
        original,
        "A partial read must not mutate or release the original local unknown",
      );
      f.setFailAccount(false);
      const recovered = await f.bridge().execution(f.user, f.p, f.e);
      assert.deepEqual(recovered, {
        task_id: f.task,
        status: "partially_filled",
        observed_quantity: "0.4",
        settled: false,
      });
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
      assert.ok(
        f.calls.every((operation) =>
          [
            "perps_execution_recovery",
            "perps_execution",
            "fresh_account_observation",
          ].includes(operation),
        ),
      );
      assert.deepEqual(f.e, original);
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL NULL-response reconciliation retains the exact frozen payload and original identity while recovering only its accepted task",
  options,
  async () => {
    const f = await fixture();
    try {
      await f.pool.query(
        "INSERT INTO ride_agent_core_outbox(execution_id,user_id,portfolio_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5)",
        [f.e.id, f.user, f.p.id, f.e.fingerprint, f.payload],
      );
      const before = (
        await f.pool.query(
          "SELECT execution_id,user_id,portfolio_id,fingerprint,payload::text,created_at FROM ride_agent_core_outbox",
        )
      ).rows;
      f.setResponse("unknown");
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.equal(
        (await f.pool.query("SELECT response FROM ride_agent_core_outbox"))
          .rows[0].response,
        null,
      );
      f.setResponse("positive");
      assert.equal(
        (await f.bridge().execution(f.user, f.p, f.e)).task_id,
        f.task,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT execution_id,user_id,portfolio_id,fingerprint,payload::text,created_at FROM ride_agent_core_outbox",
          )
        ).rows,
        before,
      );
      assert.deepEqual(
        (await f.pool.query("SELECT response FROM ride_agent_core_outbox"))
          .rows,
        [{ response: { task_id: f.task } }],
      );
      f.calls.length = 0;
      await f.bridge().execution(f.user, f.p, f.e);
      assert.deepEqual(
        f.calls,
        ["perps_execution", "fresh_account_observation"],
        "Restart reads the original accepted task, never submit or regenerate frozen fields",
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL accepted recovery does not invent settlement and preserves an authoritative failed or superseded original task",
  options,
  async () => {
    const f = await fixture();
    try {
      f.setTaskStatus(3, true);
      const pending = await f.bridge().execution(f.user, f.p, f.e);
      assert.equal(pending.settled, false);
      assert.notEqual(pending.status, "completed");
      f.setTaskStatus(3);
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        task_id: f.task,
        status: "completed",
        observed_quantity: "0.4",
        settled: true,
      });
      f.setTaskStatus(4);
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        task_id: f.task,
        status: "failed",
        observed_quantity: "0.4",
        settled: false,
      });
      f.setTaskStatus(6);
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        task_id: f.task,
        status: "superseded",
        observed_quantity: "0.4",
        settled: false,
      });
      for (const status of [3, 4, 5, 6]) {
        f.setTaskStatus(status, true);
        const unsettled = await f.bridge().execution(f.user, f.p, f.e);
        assert.equal(unsettled.task_id, f.task);
        assert.equal(unsettled.status, "settling");
        assert.equal(unsettled.settled, false);
      }
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL positive recovery cannot cross network or use another task, unspecified status or missing settlement evidence",
  options,
  async () => {
    const f = await fixture();
    try {
      const uncertain = {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      };
      assert.deepEqual(
        await f.bridge("testnet").execution(f.user, f.p, f.e),
        uncertain,
      );
      assert.deepEqual(f.calls, []);
      for (const patch of [
        { task_id: randomUUID() },
        { task_id: undefined },
        { status: 0 },
        { status: "3" },
        { snapshot: {} },
        { snapshot: "null" },
        { snapshot: [] },
        { snapshot: { fill_settlement_pending: false } },
      ]) {
        f.calls.length = 0;
        f.setTaskResponsePatch(patch);
        assert.deepEqual(
          await f.bridge().execution(f.user, f.p, f.e),
          uncertain,
        );
        assert.deepEqual(f.calls, [
          "perps_execution_recovery",
          "perps_execution",
        ]);
      }
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(f.e.task_id, null);
      assert.equal(f.e.status, "uncertain");
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL a recovered task keeps the same-task boundary after restart when its task_id is already durable",
  options,
  async () => {
    const f = await fixture();
    try {
      f.e.task_id = f.task;
      f.e.status = "submitted";
      const original = structuredClone(f.e);
      for (const patch of [
        { task_id: undefined },
        { task_id: randomUUID() },
        { status: 0 },
        { status: 8 },
        { status: "3" },
        { status: 3, snapshot: {} },
      ]) {
        f.calls.length = 0;
        f.setTaskResponsePatch(patch);
        assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
          status: "uncertain",
          observed_quantity: null,
          settled: false,
        });
        assert.deepEqual(f.calls, ["perps_execution"]);
        assert.deepEqual(f.e, original);
      }
      f.setTaskResponsePatch({});
      f.calls.length = 0;
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        task_id: f.task,
        status: "partially_filled",
        observed_quantity: "0.4",
        settled: false,
      });
      assert.deepEqual(f.calls, [
        "perps_execution",
        "fresh_account_observation",
      ]);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL retirement is an explicit non-read-only write and cannot fabricate a missing outbox or replay its original ID",
  options,
  async () => {
    const f = await fixture();
    const oldReadOnly = process.env.RIDE_AGENT_READ_ONLY;
    const original = structuredClone(f.e);
    try {
      f.setResponse("unknown");
      f.setRetirementMode("retired");
      for (const flag of ["true", undefined]) {
        if (flag === undefined) delete process.env.RIDE_AGENT_READ_ONLY;
        else process.env.RIDE_AGENT_READ_ONLY = flag;
        f.calls.length = 0;
        assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
          status: "uncertain",
          observed_quantity: null,
          settled: false,
        });
        assert.deepEqual(f.calls, ["perps_execution_recovery"]);
      }
      process.env.RIDE_AGENT_READ_ONLY = "false";
      const result = await f.bridge().execution(f.user, f.p, f.e);
      assert.equal(result.status, "failed");
      assert.equal(result.settled, false);
      assert.equal(result.task_id, undefined);
      assert.equal(result.retirement?.proof.tombstone_id, f.tombstone);
      assert.deepEqual(f.e, original);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
      const durable = { ...f.e, retirement: result.retirement };
      f.calls.length = 0;
      assert.deepEqual(
        await f.bridge().execution(f.user, f.p, durable),
        result,
      );
      assert.deepEqual(
        f.calls,
        [],
        "A committed permanent receipt needs no new external write after restart",
      );
      const conflict = {
        ...durable,
        task_id: f.task,
        status: "submitted" as const,
      };
      assert.deepEqual(await f.bridge().execution(f.user, f.p, conflict), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.equal(
        conflict.task_id,
        f.task,
        "Conflicting stored retirement and accepted task must never clear the task fence",
      );
      assert.deepEqual(f.calls, []);
      await assert.rejects(
        f.bridge().submit(f.user, f.p, { ...durable, status: "queued" }),
        { code: "EXECUTION_REJECTED" },
      );
      assert.deepEqual(
        f.calls,
        [],
        "Late submit of the same retired original is rejected before outbox or Core calls",
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      if (oldReadOnly === undefined) delete process.env.RIDE_AGENT_READ_ONLY;
      else process.env.RIDE_AGENT_READ_ONLY = oldReadOnly;
      await f.close();
    }
  },
);

it(
  "PostgreSQL NULL frozen payload remains unchanged while explicit retirement retries the same permanent fence after a lost response",
  options,
  async () => {
    const f = await fixture();
    const oldReadOnly = process.env.RIDE_AGENT_READ_ONLY;
    try {
      process.env.RIDE_AGENT_READ_ONLY = "false";
      f.setResponse("unknown");
      f.setRetirementMode("lost");
      await f.pool.query(
        "INSERT INTO ride_agent_core_outbox(execution_id,user_id,portfolio_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5)",
        [f.e.id, f.user, f.p.id, f.e.fingerprint, f.payload],
      );
      const before = (
        await f.pool.query(
          "SELECT execution_id,user_id,portfolio_id,fingerprint,payload::text,response,created_at FROM ride_agent_core_outbox",
        )
      ).rows;
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.equal(f.e.retirement, undefined);
      const result = await f.bridge().execution(f.user, f.p, f.e);
      assert.equal(result.retirement?.proof.tombstone_id, f.tombstone);
      assert.equal(result.status, "failed");
      assert.equal(result.settled, false);
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT execution_id,user_id,portfolio_id,fingerprint,payload::text,response,created_at FROM ride_agent_core_outbox",
          )
        ).rows,
        before,
      );
      assert.ok(
        f.calls.every((op) =>
          ["perps_execution_acceptance", "perps_execution_retirement"].includes(
            op,
          ),
        ),
      );
      assert.equal(
        f.calls.filter((op) => op === "perps_execution_retirement").length,
        2,
      );
    } finally {
      if (oldReadOnly === undefined) delete process.env.RIDE_AGENT_READ_ONLY;
      else process.env.RIDE_AGENT_READ_ONLY = oldReadOnly;
      await f.close();
    }
  },
);

it(
  "PostgreSQL natural runner commits the typed permanent proof after response loss and restart without reactivating risk or resubmitting the original",
  options,
  async () => {
    const f = await fixture();
    const oldReadOnly = process.env.RIDE_AGENT_READ_ONLY;
    let repo = new PgRepository(f.url);
    try {
      process.env.RIDE_AGENT_READ_ONLY = "false";
      f.setResponse("unknown");
      f.setRetirementMode("lost");
      await repo.migrate();
      const adapter = new FakeAdapter();
      const mutable: VenueAdapter = adapter;
      adapter.account = async () => {
        throw new AgentError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          "Fixture budget guard remains effective",
          true,
          503,
          { retry_after_ms: 60000 },
        );
      };
      adapter.submit = async () =>
        assert.fail("Retirement cannot submit an old or replacement order");
      mutable.execution = (user, p, e) => f.bridge().execution(user, p, e);
      const p = fromPlan(
        recommend(
          {
            budget_usdc: "20",
            market: "perps",
            assets: [],
            allow_altcoins: true,
            loss_trigger_pct: 10,
            risk_tolerance: "medium",
            portfolio_kind: "single",
            basket_size: 1,
          },
          [candidate(1)],
        ),
      );
      p.id = f.p.id;
      p.account_id = f.p.account_id;
      p.venue_accounts = { perps: f.p.account_id! };
      p.initial_equity = "500";
      p.ledger_started_at = f.e.created_at - 1000;
      p.state = "active";
      p.reconciliation = "complete";
      p.executions.push(structuredClone(f.e));
      p.sleeves[0].reviewed_at = now();
      const originalPrefs = structuredClone(p.preferences),
        originalSleeves = p.sleeves.map((s) => ({
          copy_id: s.copy_id,
          amount_usdc: s.amount_usdc,
          state: s.state,
        }));
      await repo.transact(f.user, async (state) => {
        state.portfolios.push(p);
      });
      const runner = () =>
        new AgentRunner(
          new AgentService(
            repo,
            adapter,
            "https://ride.test",
            new Cursor("fixture-cursor-key-at-least-32-bytes"),
          ),
        );
      await runner().tick(f.user);
      const lost = await repo.transact(f.user, async (state) =>
        structuredClone(state.portfolios[0]),
      );
      assert.equal(lost.executions[0].status, "uncertain");
      assert.equal(lost.executions[0].retirement, undefined);
      await runner().tick(f.user);
      const retired = await repo.transact(f.user, async (state) =>
        structuredClone(state.portfolios[0]),
      );
      assert.equal(retired.executions[0].status, "failed");
      assert.equal(
        retired.executions[0].retirement?.proof.tombstone_id,
        f.tombstone,
      );
      assert.equal(retired.executions[0].id, f.e.id);
      assert.equal(retired.executions[0].fingerprint, f.e.fingerprint);
      assert.equal(retired.executions[0].created_at, f.e.created_at);
      assert.equal(retired.executions[0].expires_at, f.e.expires_at);
      assert.equal(retired.executions[0].task_id, null);
      assert.equal(retired.state, "attention");
      assert.deepEqual(retired.preferences, originalPrefs);
      assert.deepEqual(
        retired.sleeves.map((s) => ({
          copy_id: s.copy_id,
          amount_usdc: s.amount_usdc,
          state: s.state,
        })),
        originalSleeves,
      );
      // A queued stale copy of the same original still cannot replay after a
      // process/repository restart; only the committed typed proof is consumed.
      await repo.transact(f.user, async (state) => {
        state.portfolios[0].executions[0].status = "queued";
      });
      await repo.close();
      repo = new PgRepository(f.url);
      await repo.migrate();
      f.calls.length = 0;
      await runner().tick(f.user);
      const restarted = await repo.transact(f.user, async (state) =>
        structuredClone(state.portfolios[0]),
      );
      assert.equal(restarted.executions[0].status, "failed");
      assert.deepEqual(
        restarted.executions[0].retirement,
        retired.executions[0].retirement,
      );
      assert.deepEqual(f.calls, []);
      await assert.rejects(
        f.bridge().submit(f.user, restarted, {
          ...restarted.executions[0],
          status: "queued",
        }),
        { code: "EXECUTION_REJECTED" },
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      if (oldReadOnly === undefined) delete process.env.RIDE_AGENT_READ_ONLY;
      else process.env.RIDE_AGENT_READ_ONLY = oldReadOnly;
      await repo.close();
      await f.close();
    }
  },
);

it(
  "PostgreSQL a valid legacy expiry-only negative remains unknown until the new permanent all-bindings fence is proven",
  options,
  async () => {
    const f = await fixture();
    const oldReadOnly = process.env.RIDE_AGENT_READ_ONLY;
    try {
      process.env.RIDE_AGENT_READ_ONLY = "false";
      f.setResponse("negative");
      await f.pool.query(
        "INSERT INTO ride_agent_core_outbox(execution_id,user_id,portfolio_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5)",
        [f.e.id, f.user, f.p.id, f.e.fingerprint, f.payload],
      );
      const before = (
        await f.pool.query(
          "SELECT payload::text,response FROM ride_agent_core_outbox",
        )
      ).rows;
      assert.deepEqual(await f.bridge().execution(f.user, f.p, f.e), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.deepEqual(f.calls, [
        "perps_execution_acceptance",
        "perps_execution_retirement",
      ]);
      f.setRetirementMode("retired");
      const retired = await f.bridge().execution(f.user, f.p, f.e);
      assert.equal(retired.status, "failed");
      assert.equal(retired.retirement?.proof.tombstone_id, f.tombstone);
      assert.equal(retired.task_id, undefined);
      assert.equal(retired.settled, false);
      assert.deepEqual(
        (
          await f.pool.query(
            "SELECT payload::text,response FROM ride_agent_core_outbox",
          )
        ).rows,
        before,
      );
    } finally {
      if (oldReadOnly === undefined) delete process.env.RIDE_AGENT_READ_ONLY;
      else process.env.RIDE_AGENT_READ_ONLY = oldReadOnly;
      await f.close();
    }
  },
);
