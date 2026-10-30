import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import {
  recommend,
  pnl,
  type Execution,
  type ManualMarketHandoff,
} from "./domain.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const base = 1793200000000,
  key = "perps:BTC";
async function fixture(t: TestContext, fixed = false) {
  let clock = base;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(console, "info", () => {});
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  const trader = { ...candidate(1), assets: ["BTC", "ETH"] };
  adapter.pool = [trader];
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "100",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "single",
        basket_size: 1,
        ...(fixed
          ? { copy_mode: "fixed" as const, fixed_margin_usdc: "4" }
          : {}),
      },
      [trader],
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = base - 10000;
  p.reconciliation = "complete";
  const sleeve = p.sleeves[0];
  sleeve.reviewed_at = base;
  sleeve.initialized = true;
  const intent = {
    key,
    asset: "BTC",
    market: "perps" as const,
    quantity: "1",
    price: "100",
    source_entry_price: "100",
    source_leverage: 5,
    observed_at: base,
    source_revision: "old",
  };
  sleeve.intents[key] = intent;
  sleeve.lots[key] = {
    key,
    asset: "BTC",
    market: "perps",
    quantity: "1",
    cost: "100",
    realized: "0",
    fees: "0",
    funding: "0",
  };
  if (fixed) {
    sleeve.fixed_last_fill_at = base - 3000;
    sleeve.fixed_targets = { [key]: "1", "perps:ETH": "0" };
    sleeve.source_quantities = { [key]: "5", "perps:ETH": "0" };
    sleeve.fixed_seen_fills = [];
  }
  const marker: ManualMarketHandoff = {
    handoff_id: "11111111-1111-4111-8111-111111111111",
    binding_id: adapter.snap.account_id,
    coin: "BTC",
    at_ms: base - 2000,
    mark_px: "110",
    signed_size: "1",
    master: "0x" + "a".repeat(40),
    agent: "0x" + "b".repeat(40),
    network: 2,
    wallet_generation: 1,
  };
  adapter.snap = {
    ...adapter.snap,
    account_value_usdc: "517",
    positions: { [key]: ".5" },
    prices: { [key]: "120", "perps:ETH": "100" },
    manual_markets: [marker],
    manual_fills: [
      {
        id: "manual_fill",
        order_id: "manual_order",
        handoff_id: marker.handoff_id,
        key,
        quantity: "-.5",
        price: "120",
        fee_usdc: "0",
        at: base - 1000,
      },
    ],
    funding: [
      { id: "before_handoff", key, amount_usdc: "-1", at: base - 2500 },
      { id: "after_handoff", key, amount_usdc: "-2", at: base - 500 },
    ],
  };
  adapter.source = async () => ({
    observed_at: clock,
    revision: `source_${clock}`,
    account_value_usdc: "1000",
    complete: true,
    positions: [
      {
        ...intent,
        quantity: fixed ? (clock === base ? "10" : "20") : "5",
        price: "120",
        observed_at: clock,
        source_revision: `source_${clock}`,
      },
      {
        ...intent,
        key: "perps:ETH",
        asset: "ETH",
        quantity: "5",
        observed_at: clock,
        source_revision: `source_${clock}`,
      },
    ],
  });
  if (fixed)
    adapter.sourceFills = async () => ({
      complete: true,
      fills:
        clock === base
          ? [
              {
                id: "source_manual_market",
                key,
                start_quantity: "5",
                quantity: "5",
                price: "120",
                fee_usdc: null,
                realized_usdc: null,
                at: base - 1500,
              },
              {
                id: "source_other_market",
                key: "perps:ETH",
                start_quantity: "0",
                quantity: "5",
                price: "100",
                fee_usdc: null,
                realized_usdc: null,
                at: base - 1000,
              },
            ]
          : [
              {
                id: "source_manual_market_later",
                key,
                start_quantity: "10",
                quantity: "10",
                price: "120",
                fee_usdc: null,
                realized_usdc: null,
                at: base + 500,
              },
            ],
    });
  await repository.transact("alice", async (state) => {
    state.portfolios.push(p);
    state.checkpoints.push({
      at: base - 3000,
      key: `${p.id}:${key}`,
      quantities: { [sleeve.copy_id]: "1" },
    });
  });
  const service = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  return {
    repository,
    adapter,
    p,
    marker,
    runner: () => new AgentRunner(service),
    advance(ms: number) {
      clock += ms;
    },
    read: async () => (await repository.read("alice")).portfolios[0],
  };
}

it("a real Runner transfers only the taken-over market, preserves funding boundaries, and continues another coin", async (t) => {
  const f = await fixture(t);
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(p.state, "active");
  assert.equal(p.reconciliation, "complete");
  assert.equal(p.sleeves[0].lots[key].quantity, "0");
  assert.equal(p.sleeves[0].lots[key].funding, "-1");
  assert.equal(p.manual_ledger!.lots[key].quantity, "0.5");
  assert.equal(p.manual_ledger!.lots[key].funding, "-2");
  assert.equal(pnl(p).net_usdc, "9.000000");
  assert.equal(pnl(p).manual_net_usdc, "8.000000");
  assert.equal(p.executions.length, 1);
  assert.equal(p.executions[0].key, "perps:ETH");
  assert.equal(p.executions[0].status, "submitted");
  const state = await f.repository.read("alice");
  const transfer = state.checkpoints.find(
    (x) => x.key === `${p.id}:${key}` && x.at === f.marker.at_ms,
  )!;
  assert.equal(transfer.quantities[p.sleeves[0].copy_id], "0");
  assert.equal(transfer.quantities.manual, "1");
  assert.equal(
    state.updates.filter((x) => x.kind === "market_handed_to_manual").length,
    1,
  );
});

it("Fixed full source history continues its cursor across a manually owned coin without rebuilding that target", async (t) => {
  const f = await fixture(t, true);
  await f.runner().tick("alice");
  const first = await f.read();
  assert.equal(first.last_error, undefined);
  assert.equal(first.sleeves[0].fixed_last_fill_at, base);
  assert.equal(first.sleeves[0].source_quantities![key], "10");
  assert.equal(first.sleeves[0].fixed_targets![key], "0");
  assert.equal(first.sleeves[0].fixed_targets!["perps:ETH"], "0.2");
  assert.ok(first.executions.some((x) => x.key === "perps:ETH"));
  assert.equal(
    first.executions.some((x) => x.key === key),
    false,
  );
  f.advance(1000);
  await f.runner().tick("alice");
  const second = await f.read();
  assert.equal(second.sleeves[0].fixed_last_fill_at, base + 1000);
  assert.equal(second.sleeves[0].source_quantities![key], "20");
  assert.equal(second.sleeves[0].fixed_targets![key], "0");
  assert.equal(second.manual_ledger!.transfers.length, 1);
  assert.equal(second.manual_ledger!.seen_fills.length, 1);
  assert.equal(
    second.executions.some((x) => x.key === key),
    false,
  );
});

it("lost submission responses recover the same task and its fill before the one-time transfer", async (t) => {
  const f = await fixture(t);
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.sleeves[0].lots[key].quantity = "0";
    p.sleeves[0].lots[key].cost = "0";
    p.executions.push({
      id: "stable_original",
      key,
      target_quantity: "1",
      allocations: { [p.sleeves[0].copy_id]: "1" },
      status: "uncertain",
      revision: p.revision,
      fingerprint: "stable",
      created_at: base - 9000,
      expires_at: base + 10000,
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "20",
      error: null,
    });
  });
  f.adapter.snap.recovered_executions = [
    {
      execution_id: "stable_original",
      task_id: "original_core_task",
      status: "completed",
      settled: true,
    },
  ];
  f.adapter.snap.fills = [
    {
      id: "original_exchange_fill",
      order_id: "7",
      task_id: "original_core_task",
      key,
      quantity: "1",
      price: "100",
      fee_usdc: "0",
      at: base - 3000,
    },
  ];
  await f.runner().tick("alice");
  const p = await f.read(),
    original = p.executions.find((x) => x.id === "stable_original")!;
  assert.equal(original.task_id, "original_core_task");
  assert.equal(original.status, "completed");
  assert.equal(p.manual_ledger!.transfers.length, 1);
  assert.equal(p.manual_ledger!.lots[key].quantity, "0.5");
  assert.equal(
    p.seen_fills.filter((x) => x === "original_exchange_fill").length,
    1,
  );
  assert.equal(p.executions.filter((x) => x.key === key).length, 1);
});

for (const knownTask of [false, true])
  it(`a superseded Core task ${knownTask ? "with" : "without"} its saved task ID does not permanently block handoff or other coins`, async (t) => {
    const f = await fixture(t);
    await f.repository.transact("alice", async (state) => {
      const p = state.portfolios[0];
      p.executions.push({
        id: "old_superseded",
        key,
        target_quantity: "2",
        allocations: {},
        status: knownTask ? "submitted" : "uncertain",
        revision: p.revision,
        fingerprint: "stable",
        created_at: base - 9000,
        expires_at: base + 10000,
        task_id: knownTask ? "superseded_task" : null,
        observed_quantity: null,
        reserve_usdc: "20",
        error: null,
      });
    });
    f.adapter.snap.recovered_executions = [
      {
        execution_id: "old_superseded",
        task_id: "superseded_task",
        status: "superseded",
        settled: true,
      },
    ];
    await f.runner().tick("alice");
    const p = await f.read();
    assert.equal(p.last_error, undefined);
    assert.equal(
      p.executions.find((e) => e.id === "old_superseded")!.status,
      "superseded",
    );
    assert.equal(p.manual_ledger!.transfers.length, 1);
    assert.ok(
      p.executions.some(
        (e) => e.key === "perps:ETH" && e.status === "submitted",
      ),
    );
  });

it("unresolved original executions retain their identity and block transfer instead of being relabeled manual", async (t) => {
  const f = await fixture(t);
  await f.repository.transact("alice", async (state) => {
    state.portfolios[0].executions.push({
      id: "stable_unknown",
      key,
      status: "submitted",
      task_id: "unknown_task",
      allocations: {},
      revision: 1,
    } as unknown as Execution);
  });
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(p.manual_ledger, undefined);
  assert.equal(p.last_error!.code, "HANDOFF_PENDING");
  assert.equal(p.executions[0].id, "stable_unknown");
  assert.equal(p.executions[0].task_id, "unknown_task");
  assert.equal(p.sleeves[0].lots[key].quantity, "1");
});

it("closing copy positions releases only the copy while its explicitly handed-off manual position survives", async (t) => {
  const f = await fixture(t);
  f.adapter.snap.manual_fills = [];
  f.adapter.snap.funding = [];
  f.adapter.snap.positions[key] = "1";
  f.adapter.snap.account_value_usdc = "510";
  f.adapter.snap.prices[key] = "110";
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.state = "closing";
    p.sleeves[0].state = "closing";
    p.sleeves[0].intents[key].quantity = "0";
  });
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(p.state, "closed");
  assert.equal(f.adapter.releases, 1);
  assert.equal(p.manual_ledger!.lots[key].quantity, "1");
  assert.equal(f.adapter.submitCount, 0);
});

it("a now-flat manual coin remains handed off after a restart and source revision change", async (t) => {
  const f = await fixture(t);
  f.adapter.snap.manual_fills = [];
  f.adapter.snap.funding = [];
  f.adapter.snap.positions[key] = "1";
  f.adapter.snap.account_value_usdc = "510";
  f.adapter.snap.prices[key] = "110";
  await f.runner().tick("alice");
  f.advance(1000);
  f.adapter.snap.manual_fills = [
    {
      id: "manual_close",
      order_id: "close",
      handoff_id: f.marker.handoff_id,
      key,
      quantity: "-1",
      price: "110",
      fee_usdc: "0",
      at: base + 500,
    },
  ];
  f.adapter.snap.positions = {};
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(p.manual_ledger!.lots[key].quantity, "0");
  assert.equal(p.manual_ledger!.transfers.length, 1);
  assert.equal(p.sleeves[0].intents[key].quantity, "0");
  assert.equal(
    p.executions.some((x) => x.key === key),
    false,
  );
});

it("incomplete history prevents ownership transfer without silently shrinking account coverage", async (t) => {
  const f = await fixture(t);
  f.adapter.snap.coverage_complete = false;
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(p.last_error!.code, "HANDOFF_PENDING");
  assert.equal(p.manual_ledger, undefined);
  assert.equal(p.sleeves[0].lots[key].quantity, "1");
  assert.equal(f.adapter.submitCount, 0);
});

it("a cash attribution mismatch blocks new targets while the durable phase still reconciles the original unknown ID", async (t) => {
  const f = await fixture(t),
    reconciled: string[] = [];
  f.adapter.snap.account_value_usdc = "518";
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.executions.push({
      id: "original_unknown_eth",
      key: "perps:ETH",
      target_quantity: ".5",
      allocations: { [p.sleeves[0].copy_id]: ".5" },
      status: "uncertain",
      task_id: null,
      revision: p.revision,
      fingerprint: "original",
      created_at: base - 3000,
      expires_at: base + 10000,
      observed_quantity: null,
      reserve_usdc: "10",
      error: null,
    });
  });
  f.adapter.execution = async (...args: unknown[]) => {
    reconciled.push((args[2] as Execution).id);
    return { status: "uncertain", observed_quantity: null, settled: false };
  };
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(
    p.reconciliation,
    "complete",
    "quantity equality alone is insufficient for cash attribution",
  );
  assert.equal(p.last_error!.code, "HANDOFF_ACCOUNTING_INCOMPLETE");
  assert.equal(p.last_error!.retryable, true);
  assert.equal(pnl(p).net_usdc, null);
  assert.equal(f.adapter.submitCount, 0);
  assert.deepEqual(reconciled, ["original_unknown_eth"]);
  assert.equal(p.executions.length, 1);
  assert.equal(p.executions[0].id, "original_unknown_eth");
});

it("cash attribution resumes only after actual account evidence becomes conserved", async (t) => {
  const f = await fixture(t);
  f.adapter.snap.account_value_usdc = "518";
  await f.runner().tick("alice");
  assert.equal(
    (await f.read()).last_error!.code,
    "HANDOFF_ACCOUNTING_INCOMPLETE",
  );
  f.advance(1000);
  f.adapter.snap.account_value_usdc = "517";
  await f.runner().tick("alice");
  const p = await f.read();
  assert.equal(p.last_error, undefined);
  assert.equal(p.manual_ledger!.transfers.length, 1);
  assert.equal(pnl(p).net_usdc, "9.000000");
  assert.ok(
    p.executions.some((e) => e.key === "perps:ETH" && e.status === "submitted"),
  );
});
