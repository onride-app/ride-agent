import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { now, recommend } from "./domain.js";
import { FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

async function fixture() {
  const adapter = new FakeAdapter();
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
      [adapter.pool[0]],
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = now() - 1000;
  p.snapshot = structuredClone(adapter.snap);
  p.reconciliation = "complete";
  adapter.source = async () => ({
    observed_at: now(),
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  const repo = new MemoryRepository();
  await repo.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  const service = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  return {
    adapter,
    repo,
    service,
    runner: new AgentRunner(service),
    read: () =>
      repo.transact("alice", async (s) => structuredClone(s.portfolios[0])),
  };
}

for (const code of ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_RATE_LIMITED"]) {
  it(`honors persisted ${code} retry advice across runner restart without changing evidence or cursors`, async (context) => {
    let at = 1793200000000;
    context.mock.method(Date, "now", () => at);
    const f = await fixture();
    let reads = 0;
    f.adapter.account = async () => {
      reads++;
      if (reads === 1)
        throw new AgentError(code, "Wait for read capacity", true, 503, {
          retry_after_ms: 45000,
        });
      return f.adapter.preflight();
    };
    await f.runner.tick("alice");
    const failed = await f.read();
    assert.equal(failed.state, "attention");
    const restarted = new AgentRunner(f.service);
    for (const elapsed of [5000, 10000, 44999]) {
      at = 1793200000000 + elapsed;
      await restarted.tick("alice");
      const waiting = await f.read();
      assert.equal(reads, 1);
      assert.deepEqual(waiting.last_error, failed.last_error);
      assert.deepEqual(waiting.snapshot, failed.snapshot);
      assert.deepEqual(waiting.sleeves, failed.sleeves);
      assert.equal(f.adapter.submitCount, 0);
    }
    at = 1793200045000;
    await restarted.tick("alice");
    const recovered = await f.read();
    assert.equal(reads, 2);
    assert.equal(recovered.last_error, undefined);
    assert.equal(recovered.state, "active");
    assert.equal(recovered.snapshot?.observed_at, at);
    assert.equal(f.adapter.submitCount, 0);
  });
}

it("keeps unknown submission reconciliation and pending notifications running during read backoff", async () => {
  const f = await fixture();
  await f.repo.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.state = "attention";
    p.last_error = {
      at: now(),
      code: "VENUE_READ_BUDGET_EXHAUSTED",
      message: "Wait",
      retryable: true,
      details: { retry_after_ms: 60000 },
    };
    p.executions.push({
      id: "original",
      key: "perps:BTC",
      target_quantity: "0.1",
      allocations: {},
      revision: p.revision,
      fingerprint: "original",
      created_at: now(),
      expires_at: now() + 60000,
      status: "uncertain",
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "2",
      error: null,
    });
    state.updates.push({
      id: "pending",
      at: now(),
      kind: "fixture",
      portfolio_id: p.id,
      message: "Pending",
      data: {},
      notification: "pending",
    });
  });
  let reconciliations = 0;
  f.adapter.account = async () => {
    assert.fail("account reads must wait");
  };
  f.adapter.execution = async () => {
    reconciliations++;
    return {
      task_id: "existing_task",
      status: "submitted",
      observed_quantity: null,
      settled: false,
    };
  };
  await f.runner.tick("alice");
  const p = await f.read();
  assert.equal(reconciliations, 1);
  assert.equal(p.executions[0].id, "original");
  assert.equal(p.executions[0].task_id, "existing_task");
  assert.equal(p.executions[0].status, "submitted");
  assert.equal(f.adapter.notifyCount, 1);
  assert.equal(f.adapter.submitCount, 0);
});

it("does not postpone non-throttling failures or unbounded retry metadata", async () => {
  const f = await fixture();
  let reads = 0;
  f.adapter.account = async () => {
    reads++;
    return f.adapter.preflight();
  };
  for (const [code, retry] of [
    ["ACCOUNT_STALE", 60000],
    ["VENUE_READ_BUDGET_EXHAUSTED", 60001],
    ["VENUE_RATE_LIMITED", 0],
  ] as const) {
    await f.repo.transact("alice", async (state) => {
      state.portfolios[0].last_error = {
        at: now(),
        code,
        message: "Retry",
        retryable: true,
        details: { retry_after_ms: retry },
      };
    });
    await f.runner.tick("alice");
  }
  assert.equal(reads, 3);
});
