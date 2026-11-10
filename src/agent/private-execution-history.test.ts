import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { CoreBridge, startManagedCoreBridge } from "./core_bridge.js";
import { BridgeAdapter } from "./adapter.js";
import { PgRepository, Cursor } from "./repository.js";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import {
  recommend,
  fingerprint,
  type Execution,
  type Portfolio,
} from "./domain.js";
import { candidate, snapshot } from "./fixtures.js";
import { perpsRecoveryRequest } from "./execution-core-recovery.js";
import {
  privateExecutionHistory,
  preparedWriteBinding,
  preparedProposalInput,
} from "./prepared-portfolio.js";
const user = "11111111-1111-4111-8111-111111111111",
  account = "22222222-2222-4222-8222-222222222222";
function portfolio() {
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
  p.account_id = account;
  p.venue_accounts = { perps: account };
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = Date.now() - 100000;
  p.reconciliation = "complete";
  p.snapshot = { ...snapshot(), account_id: account };
  p.sleeves[0].state = "active";
  p.sleeves[0].initialized = true;
  p.sleeves[0].reviewed_at = Date.now();
  return p;
}
function retired(index: number, p: Portfolio): Execution {
  const created = Date.now() - 180000 - index;
  const frozen = {
    id: "execution_history_" + index,
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: { [p.sleeves[0].copy_id]: "0.1" },
    revision: p.revision,
    created_at: created,
    expires_at: created + 60000,
  };
  const e: Execution = {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "failed",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error:
      "Original expired execution was not accepted; its ID is permanently rejected.",
  };
  const request = perpsRecoveryRequest(user, account, e)!;
  assert.ok(request);
  e.retirement = {
    protocol_version: 1,
    retirement: "original_absence_retired",
    reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED",
    proof: {
      ...request,
      network: "mainnet",
      observed_at: Date.now() - 1,
      current_execution_epoch: "33333333-3333-4333-8333-333333333333",
      retirement_epoch: "44444444-4444-4444-8444-444444444444",
      tombstone_id: "55555555-5555-4555-8555-555555555555",
      retired_at: Date.now() - 2,
      serialized_absence_check: true,
      permanent_original_id_fence: true,
      historical_bindings_checked: true,
    },
  };
  return e;
}
it("private projection omits only an exact permanent taskless Perps history and never mutates state", () => {
  const p = portfolio(),
    e = retired(1, p);
  p.executions = [e];
  const before = structuredClone(p);
  assert.deepEqual(privateExecutionHistory(p, user), []);
  assert.deepEqual(p, before);
  assert.equal(privateExecutionHistory(p, user, e.id)[0], e);
});
for (const kind of [
  "unknown",
  "task",
  "quantity",
  "prediction",
  "missing_receipt",
  "foreign_receipt",
  "bad_frozen",
  "legacy_expiry",
  "undefined_task",
] as const)
  it(
    "private projection preserves " +
      kind +
      " history without inferring financial absence",
    () => {
      const p = portfolio(),
        e = retired(1, p);
      p.executions = [e];
      if (kind === "unknown") e.status = "uncertain";
      if (kind === "task") e.task_id = "original-task";
      if (kind === "quantity") e.observed_quantity = "0";
      if (kind === "prediction") e.key = "prediction:original";
      if (kind === "missing_receipt") delete e.retirement;
      if (kind === "foreign_receipt")
        e.retirement!.proof.user_id = "66666666-6666-4666-8666-666666666666";
      if (kind === "bad_frozen") e.target_quantity = "0.2";
      if (kind === "legacy_expiry") e.expires_at++;
      if (kind === "undefined_task") delete (e as any).task_id;
      assert.equal(privateExecutionHistory(p, user), p.executions);
      assert.equal(privateExecutionHistory(p, user)[0], e);
    },
  );
it("private projection requires the same user and actual Perps account and protects the standalone original", () => {
  const p = portfolio(),
    e = retired(1, p);
  p.executions = [e];
  assert.equal(
    privateExecutionHistory(p, "77777777-7777-4777-8777-777777777777"),
    p.executions,
  );
  p.venue_accounts!.perps = "88888888-8888-4888-8888-888888888888";
  assert.equal(privateExecutionHistory(p, user), p.executions);
  p.venue_accounts!.perps = account;
  assert.equal(privateExecutionHistory(p, user, e.id), p.executions);
});
it("canonical write bindings match the private wire projection while retaining all real authority", () => {
  const p = portfolio();
  p.executions = [retired(1, p), retired(2, p)];
  const current = retired(3, p);
  delete current.retirement;
  current.status = "queued";
  p.executions.push(current);
  const wire = {
    ...p,
    executions: privateExecutionHistory(p, user, current.id),
  };
  assert.equal(
    preparedWriteBinding(p, undefined, user),
    preparedWriteBinding(wire, undefined, user),
  );
  assert.equal(
    preparedProposalInput(p, user).write_binding,
    preparedProposalInput(wire, user).write_binding,
  );
  const changed = structuredClone(wire);
  changed.sleeves[0].state = "risk_off";
  assert.notEqual(
    preparedWriteBinding(p, undefined, user),
    preparedWriteBinding(changed, undefined, user),
  );
  assert.deepEqual(wire.executions, [current]);
});
it("a real one-megabyte private body can be reduced without raising its limit or dropping unknown/task evidence", () => {
  const p = portfolio();
  p.executions = Array.from({ length: 1500 }, (_, i) => retired(i, p));
  const current = retired(1600, p);
  delete current.retirement;
  current.status = "uncertain";
  p.executions.push(current);
  const raw = Buffer.byteLength(
    JSON.stringify({ user_id: user, portfolio: p, execution: current }),
  );
  const kept = privateExecutionHistory(p, user, current.id);
  const compact = Buffer.byteLength(
    JSON.stringify({
      user_id: user,
      portfolio: { ...p, executions: kept },
      execution: current,
    }),
  );
  assert.ok(raw > 1024 * 1024);
  assert.ok(compact < 64000);
  assert.deepEqual(kept, [current]);
  assert.equal(p.executions.length, 1501);
  assert.equal(current.retirement, undefined);
});
it(
  "oversized history recovery crosses the unchanged authenticated HTTP limit and retires only the original ID in real PG",
  { skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL, timeout: 30000 },
  async (t) => {
    const url = new URL(process.env.RIDE_AGENT_TEST_DATABASE_URL!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    const admin = new pg.Pool({ connectionString: url.toString(), max: 2 }),
      schema = "private_history_" + randomUUID().replaceAll("-", "");
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    const repository = new PgRepository(url.toString()),
      pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
    await repository.migrate();
    await pool.query(
      "CREATE TABLE ride_agent_core_outbox(execution_id TEXT PRIMARY KEY,user_id TEXT,portfolio_id TEXT,fingerprint TEXT,payload JSONB,response JSONB)",
    );
    await pool.query(
      "CREATE TABLE fixture_original_fences(execution_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,receipt JSONB NOT NULL)",
    );
    const p = portfolio();
    p.executions = Array.from({ length: 1500 }, (_, i) => retired(i, p));
    const current = retired(1600, p);
    delete current.retirement;
    current.status = "uncertain";
    current.first_submission_failure = {
      code: "EXECUTOR_REQUEST_TOO_LARGE",
      reason_code: "OTHER",
      retryable: false,
      at: Date.now() - 500,
      elapsed_ms: 120,
    };
    p.executions.push(current);
    const original = structuredClone(current),
      allIds = p.executions.map((e) => e.id);
    await repository.transact(user, async (state) => {
      state.portfolios.push(p);
    });
    let closeRunner = async () => {},
      managed: Awaited<ReturnType<typeof startManagedCoreBridge>> | undefined;
    let recovery = 0,
      retirement = 0,
      submits = 0,
      handlerCalls = 0;
    t.after(async () => {
      await closeRunner();
      await managed?.close();
      await repository.close();
      await pool.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
    });
    const env: Record<string, string> = {
      RIDE_AGENT_EXECUTOR_TOKEN: "e".repeat(48),
      RIDE_AGENT_CORE_URL: "https://core.fixture",
      RIDE_AGENT_CORE_SERVICE_TOKEN: "fixture-token",
      RIDE_AGENT_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
      RIDE_AGENT_TRADER_ID_SALT: "s".repeat(32),
      RIDE_AGENT_NETWORK: "mainnet",
      RIDE_AGENT_INFO_READ_ROUTE: "official",
      RIDE_AGENT_READ_ONLY: "false",
    };
    for (const [key, value] of Object.entries(env)) {
      const old = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (old === undefined) delete process.env[key];
        else process.env[key] = old;
      });
    }
    t.mock.method(
      CoreBridge.prototype,
      "migrate",
      async function (this: CoreBridge) {
        const b = this as any;
        await b.pool.end();
        b.pool = {
          query: (...args: any[]) => pool.query(args[0], args[1]),
          end: async () => {},
        };
        b.core = async (op: string, input: any) => {
          if (op === "perps_execution_recovery") {
            recovery++;
            return { protocol_version: 1, acceptance: "unknown" };
          }
          if (op === "perps_execution_retirement") {
            retirement++;
            const receipt = {
              protocol_version: 1,
              retirement: "original_absence_retired",
              reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED",
              proof: {
                ...input,
                network: "mainnet",
                observed_at: Date.now(),
                current_execution_epoch: "33333333-3333-4333-8333-333333333333",
                retirement_epoch: "44444444-4444-4444-8444-444444444444",
                tombstone_id: "55555555-5555-4555-8555-555555555555",
                retired_at: Date.now(),
                serialized_absence_check: true,
                permanent_original_id_fence: true,
                historical_bindings_checked: true,
              },
            };
            await pool.query(
              "INSERT INTO fixture_original_fences VALUES($1,$2,$3)",
              [input.execution_id, input.fingerprint, receipt],
            );
            return receipt;
          }
          if (op.includes("submit")) submits++;
          throw new Error("unexpected fixture Core operation");
        };
      },
    );
    t.mock.method(CoreBridge.prototype, "account", async () => {
      handlerCalls++;
      return {
        ...snapshot(),
        account_id: account,
        venue_accounts: { perps: account },
      };
    });
    t.mock.method(CoreBridge.prototype, "source", async () => ({
      observed_at: Date.now(),
      revision: "flat",
      account_value_usdc: "1000",
      positions: [],
      complete: true,
    }));
    managed = await startManagedCoreBridge({ host: "127.0.0.1", port: 0 });
    const base =
      "http://127.0.0.1:" + (managed.listener.address() as AddressInfo).port;
    const rawBody = JSON.stringify({
      user_id: user,
      portfolio: p,
      execution: current,
    });
    assert.ok(Buffer.byteLength(rawBody) > 1024 * 1024);
    const rejected = await fetch(base + "/internal/agent/execution", {
      method: "POST",
      headers: {
        authorization: "Bearer " + env.RIDE_AGENT_EXECUTOR_TOKEN,
        "content-type": "application/json",
      },
      body: rawBody,
    });
    assert.equal(rejected.status, 413);
    await rejected.body?.cancel();
    assert.equal(recovery, 0);
    assert.equal(retirement, 0);
    const adapter = new BridgeAdapter(base, env.RIDE_AGENT_EXECUTOR_TOKEN);
    adapter.notify = async () => {};
    const runner = new AgentRunner(
      new AgentService(
        repository,
        adapter,
        "https://fixture.invalid",
        new Cursor("s".repeat(32)),
      ),
    );
    closeRunner = () => runner.closeNotifications();
    await runner.tick(user);
    const saved = await repository.read(user),
      execution = saved.portfolios[0].executions.find(
        (e) => e.id === current.id,
      )!;
    assert.equal(execution.status, "failed");
    assert.ok(execution.retirement);
    assert.deepEqual(
      execution.first_submission_failure,
      original.first_submission_failure,
    );
    assert.equal(execution.task_id, null);
    assert.equal(execution.observed_quantity, null);
    assert.equal(recovery, 1);
    assert.equal(retirement, 1);
    assert.equal(submits, 0);
    assert.ok(handlerCalls > 0);
    assert.deepEqual(
      saved.portfolios[0].executions.map((e) => e.id),
      allIds,
    );
    for (const key of [
      "id",
      "key",
      "target_quantity",
      "allocations",
      "revision",
      "created_at",
      "expires_at",
      "fingerprint",
    ] as const)
      assert.deepEqual(execution[key], original[key]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
        )
      ).rows[0].n,
      0,
    );
    const fence = (
      await pool.query(
        "SELECT execution_id,fingerprint FROM fixture_original_fences",
      )
    ).rows;
    assert.deepEqual(fence, [
      { execution_id: original.id, fingerprint: original.fingerprint },
    ]);
    const reread = await adapter.execution(
      user,
      saved.portfolios[0],
      execution,
    );
    assert.equal(reread.status, "failed");
    assert.equal(retirement, 1);
    assert.equal(recovery, 1);
  },
);
