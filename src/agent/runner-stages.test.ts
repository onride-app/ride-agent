import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { recommend, type Execution, type Portfolio } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository, type State } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
async function fixture(t: TestContext, basket = false) {
  const base = 1793200000000;
  let at = 0;
  t.mock.method(Date, "now", () => base + at);
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter(),
    p = fromPlan(
      recommend(
        {
          budget_usdc: basket ? "200" : "20",
          market: "perps",
          assets: [],
          allow_altcoins: true,
          loss_trigger_pct: 10,
          risk_tolerance: "medium",
          portfolio_kind: basket ? "basket" : "single",
          basket_size: basket ? 2 : 1,
        },
        basket ? [candidate(1), candidate(2)] : [candidate(1)],
      ),
    );
  p.account_id = snapshot().account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = base - 1000;
  p.reconciliation = "complete";
  for (const sleeve of p.sleeves) sleeve.reviewed_at = base;
  await repository.transact("alice", async (state) => {
    state.portfolios.push(p);
    state.updates.push({
      id: "notification_original",
      at: base,
      kind: "fixture",
      portfolio_id: p.id,
      message: "Pending fixture",
      data: {},
      notification: "pending",
    });
  });
  const committed: State[] = [],
    transact = repository.transact.bind(repository),
    read = repository.read.bind(repository);
  // Capture after the real MemoryRepository commit and before the Runner can
  // enter its next transaction; reading while its next tail is open would wait.
  repository.transact = async (user, work) => {
    const result = await transact(user, work);
    committed.push(await read(user));
    return result;
  };
  return {
    repository,
    adapter,
    p,
    committed,
    base,
    runner: new AgentRunner(
      new AgentService(
        repository,
        adapter,
        "https://ride.test",
        new Cursor("s".repeat(32)),
      ),
    ),
    advance(value: number) {
      at = value;
    },
    flat: () => ({
      observed_at: base + at,
      revision: "flat",
      account_value_usdc: "1000",
      complete: true,
      positions: [],
    }),
  };
}

it("publishes the audit before a slow source, then commits verified planning before durable notifications", async (t) => {
  const f = await fixture(t),
    source = deferred(),
    notification = deferred();
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0],
      sleeve = p.sleeves[0];
    p.state = "attention";
    p.last_error = {
      at: f.base - 1000,
      code: "SOURCE_NOT_FOUND",
      message: "Previous source unavailable",
      retryable: true,
    };
    sleeve.copy_mode = "fixed";
    sleeve.fixed_last_fill_at = f.base - 1000;
    sleeve.fixed_targets = {};
    sleeve.source_quantities = {};
    sleeve.fixed_seen_fills = [];
  });
  f.committed.length = 0;
  f.adapter.source = async () => {
    await source.promise;
    return f.flat();
  };
  f.adapter.sourceFills = async () => ({ fills: [], complete: true });
  let notifying = false,
    finished = false;
  f.adapter.notify = async () => {
    notifying = true;
    await notification.promise;
  };
  const running = f.runner.tick("alice").then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.equal(f.committed.length, 1);
    const audit = f.committed[0].portfolios[0];
    assert.equal(audit.snapshot?.observed_at, f.base);
    assert.equal(audit.audit_verified_at, f.base);
    assert.equal(
      audit.state,
      "attention",
      "a financial audit alone must not publish source recovery",
    );
    assert.equal(audit.last_error?.code, "SOURCE_NOT_FOUND");
    assert.equal(audit.sleeves[0].fixed_last_fill_at, f.base - 1000);
    assert.equal(notifying, false);
    assert.equal(finished, false);
    f.advance(6000);
    source.resolve();
    await flush();
    assert.equal(f.committed.length, 3);
    assert.equal(f.committed[1].portfolios[0].state, "active");
    assert.equal(f.committed[1].portfolios[0].last_error, undefined);
    assert.equal(
      f.committed[1].portfolios[0].sleeves[0].fixed_last_fill_at,
      f.base + 6000,
    );
    assert.equal(
      f.committed[1].portfolios[0].snapshot?.observed_at,
      f.base,
      "planning must not relabel the already published financial evidence",
    );
    assert.equal(notifying, true);
    assert.equal(
      finished,
      true,
      "delivery must not keep the financial tick in flight",
    );
    notification.resolve();
    await running;
    await f.runner.notificationsIdle();
  } finally {
    source.resolve();
    notification.resolve();
    await running;
    await f.runner.notificationsIdle();
  }
  assert.equal(f.committed.length, 4);
  assert.ok(
    f.committed
      .at(-1)!
      .updates.every((update) => update.notification === "delivered"),
  );
  assert.equal(f.adapter.submitCount, 0);
});

it("completes later-sleeve loss controls before waiting for an earlier public source", async (t) => {
  const f = await fixture(t, true),
    source = deferred();
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    for (const [i, sleeve] of p.sleeves.entries()) {
      const asset = i === 0 ? "BTC" : "ETH",
        key = `perps:${asset}`;
      sleeve.stop_loss_pct = 10;
      sleeve.loss_policy = "exit";
      sleeve.lots[key] = {
        key,
        asset,
        market: "perps",
        quantity: "1",
        cost: "100",
        realized: "0",
        fees: "0",
        funding: "0",
      };
      sleeve.intents[key] = {
        key,
        asset,
        market: "perps",
        quantity: "1",
        price: "100",
        source_entry_price: "100",
        source_leverage: 1,
        observed_at: f.base,
        source_revision: "old",
      };
    }
  });
  f.committed.length = 0;
  f.adapter.account = async () => ({
    ...snapshot(),
    positions: { "perps:BTC": "1", "perps:ETH": "1" },
    prices: { "perps:BTC": "150", "perps:ETH": "50" },
  });
  f.adapter.source = async () => {
    await source.promise;
    throw new AgentError(
      "SOURCE_NOT_FOUND",
      "fixture source unavailable",
      true,
    );
  };
  let cancellations = 0;
  f.adapter.cancelIncreasing = async () => {
    cancellations++;
  };
  const running = f.runner.tick("alice");
  try {
    await flush();
    assert.equal(f.committed.length, 1);
    const audit = f.committed[0].portfolios[0];
    assert.equal(
      audit.loss_latched,
      false,
      "opposite sleeve PnL cancels at portfolio level",
    );
    assert.equal(audit.sleeves[1].state, "loss_triggered");
    assert.equal(audit.sleeves[1].intents["perps:ETH"].quantity, "0");
    assert.equal(f.adapter.fences, 1);
    assert.equal(cancellations, 1);
  } finally {
    source.resolve();
    await running;
  }
  assert.equal(
    f.adapter.fences,
    1,
    "planning must not repeat the audit's side effect",
  );
  assert.equal(cancellations, 1);
  assert.equal(
    f.committed[2].portfolios[0].last_error?.code,
    "SOURCE_NOT_FOUND",
  );
  assert.equal(f.adapter.submitCount, 0);
});

it("keeps pending-task status before fill application and publishes the reconciled ledger before source planning", async (t) => {
  const f = await fixture(t),
    source = deferred();
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0],
      sleeve = p.sleeves[0];
    sleeve.intents["perps:BTC"] = {
      key: "perps:BTC",
      asset: "BTC",
      market: "perps",
      quantity: "0.2",
      price: "100",
      source_entry_price: "100",
      source_leverage: 1,
      observed_at: f.base,
      source_revision: "old",
    };
    p.executions.push({
      id: "execution_original",
      key: "perps:BTC",
      target_quantity: "0.2",
      allocations: { [sleeve.copy_id]: "0.2" },
      revision: p.revision,
      fingerprint: "original",
      created_at: f.base - 1000,
      expires_at: f.base + 60000,
      status: "submitted",
      task_id: "task_original",
      observed_quantity: null,
      reserve_usdc: "20",
      error: null,
    });
  });
  f.committed.length = 0;
  f.adapter.account = async () => ({
    ...snapshot(),
    positions: { "perps:BTC": "0.2" },
    fills: [
      {
        id: "fill_original",
        order_id: "order_original",
        task_id: "task_original",
        key: "perps:BTC",
        quantity: "0.2",
        price: "100",
        fee_usdc: "0",
        at: f.base,
      },
    ],
  });
  let reconciliations = 0;
  f.adapter.execution = async (
    _user?: string,
    p?: Portfolio,
    execution?: Execution,
  ) => {
    assert.ok(p && execution);
    assert.equal(execution.id, "execution_original");
    assert.deepEqual(
      p.sleeves[0].lots,
      {},
      "status reconciliation remains before fill application",
    );
    reconciliations++;
    return {
      status: "completed" as const,
      observed_quantity: "0.2",
      settled: true,
    };
  };
  f.adapter.source = async () => {
    await source.promise;
    throw new AgentError("SOURCE_NOT_FOUND", "fixture unavailable", true);
  };
  const running = f.runner.tick("alice");
  try {
    await flush();
    assert.equal(f.committed.length, 1);
    const audit = f.committed[0].portfolios[0];
    assert.equal(reconciliations, 1);
    assert.equal(audit.executions[0].status, "completed");
    assert.equal(audit.sleeves[0].lots["perps:BTC"].quantity, "0.2");
    assert.deepEqual(audit.seen_fills, ["fill_original"]);
    assert.equal(audit.reconciliation, "complete");
  } finally {
    source.resolve();
    await running;
  }
  assert.equal(f.adapter.submitCount, 0);
});

it("keeps failed audits out of planning while durable unknown reconciliation and notifications still drain", async (t) => {
  const f = await fixture(t),
    source = deferred();
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.executions.push({
      id: "execution_uncertain_original",
      key: "perps:BTC",
      target_quantity: "0.1",
      allocations: {},
      revision: p.revision,
      fingerprint: "original",
      created_at: f.base,
      expires_at: f.base + 60000,
      status: "uncertain",
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "2",
      error: null,
    });
  });
  f.committed.length = 0;
  f.adapter.account = async () => {
    throw new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "fixture wait",
      true,
      503,
      { retry_after_ms: 1000 },
    );
  };
  f.adapter.source = async () => {
    await source.promise;
    return f.flat();
  };
  const ids: string[] = [];
  f.adapter.execution = async (
    _user?: string,
    _p?: Portfolio,
    execution?: Execution,
  ) => {
    assert.ok(execution);
    ids.push(execution.id);
    return {
      status: "uncertain" as const,
      observed_quantity: null,
      settled: false,
    };
  };
  await f.runner.tick("alice");
  await f.runner.notificationsIdle();
  assert.equal(f.committed.length, 4);
  assert.deepEqual(ids, ["execution_uncertain_original"]);
  assert.ok(
    f.committed
      .at(-1)!
      .updates.every((update) => update.notification === "delivered"),
  );
  assert.equal(
    f.committed[2].portfolios[0].last_error?.code,
    "VENUE_READ_BUDGET_EXHAUSTED",
  );
  const before = await f.repository.read("alice");
  f.advance(1000);
  source.resolve();
  await flush();
  assert.deepEqual(
    await f.repository.read("alice"),
    before,
    "late pure DTO work cannot mutate the committed targets, cursors, or audit",
  );
  assert.equal(f.adapter.submitCount, 0);
});
