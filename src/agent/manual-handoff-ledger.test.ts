import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { D, pnl, type ManualMarketHandoff, type Portfolio } from "./domain.js";
import { snapshot } from "./fixtures.js";
import {
  applyFill,
  applyFunding,
  applyManualFill,
  applyManualHandoffs,
  MANUAL_LEDGER_OWNER,
  reconcileQuantities,
} from "./ledger.js";

const key = "perps:BTC",
  at = 1793200000000;
export function handoff(
  overrides: Partial<ManualMarketHandoff> = {},
): ManualMarketHandoff {
  return {
    handoff_id: "11111111-1111-4111-8111-111111111111",
    binding_id: "owned",
    coin: "BTC",
    at_ms: at - 2000,
    mark_px: "110",
    signed_size: "1",
    master: "0x" + "a".repeat(40),
    agent: "0x" + "b".repeat(40),
    network: 2,
    wallet_generation: 1,
    ...overrides,
  };
}
function portfolio(quantities = ["1"]): Portfolio {
  return {
    id: "fixture",
    account_id: "owned",
    sleeves: quantities.map((quantity, i) => ({
      copy_id: `copy_${i}`,
      intents: { [key]: { key, quantity, asset: "BTC", market: "perps" } },
      lots: {
        [key]: {
          key,
          asset: "BTC",
          market: "perps",
          quantity,
          cost: D(quantity).times(100).toString(),
          realized: "0",
          fees: "0",
          funding: "0",
        },
      },
      fixed_targets: { [key]: quantity },
    })),
    executions: [],
    seen_fills: [],
    seen_funding: [],
    seen_flows: [],
    initial_equity: "500",
    flow_total: "0",
    reconciliation: "complete",
    snapshot: {
      ...snapshot(),
      account_id: "owned",
      account_value_usdc: "510",
      positions: { [key]: "1" },
      prices: { [key]: "110" },
      manual_markets: [handoff()],
    },
  } as unknown as Portfolio;
}

it("records a real ownership-transfer journal once, without an exchange fill or fee, and conserves total PnL", () => {
  const p = portfolio();
  const transfers = applyManualHandoffs(p);
  assert.equal(transfers.length, 1);
  assert.deepEqual(transfers[0].quantities, { copy_0: "1" });
  assert.deepEqual(transfers[0].realized_usdc, { copy_0: "10" });
  assert.equal(p.sleeves[0].lots[key].quantity, "0");
  assert.equal(p.sleeves[0].intents[key].quantity, "0");
  assert.equal(p.sleeves[0].fixed_targets![key], "0");
  assert.equal(p.manual_ledger!.lots[key].quantity, "1");
  assert.equal(p.manual_ledger!.lots[key].cost, "110");
  assert.deepEqual(p.seen_fills, []);
  assert.deepEqual(p.manual_ledger!.seen_fills, []);
  assert.equal(reconcileQuantities(p), true);
  assert.equal(pnl(p).net_usdc, "10.000000");
  assert.equal(pnl(p).manual_net_usdc, "0.000000");
  const saved = structuredClone(p);
  assert.deepEqual(applyManualHandoffs(p), []);
  assert.deepEqual(p, saved);
});

it("settles opposing gross sleeves at one observed mark before transferring only their signed net", () => {
  const p = portfolio(["5", "-3"]);
  p.snapshot!.manual_markets = [handoff({ signed_size: "2" })];
  p.snapshot!.positions[key] = "2";
  p.snapshot!.account_value_usdc = "520";
  applyManualHandoffs(p);
  assert.deepEqual(p.manual_ledger!.transfers[0].realized_usdc, {
    copy_0: "50",
    copy_1: "-30",
  });
  assert.equal(p.manual_ledger!.lots[key].quantity, "2");
  assert.equal(pnl(p).net_usdc, "20.000000");
  assert.equal(reconcileQuantities(p), true);
});

it("manual partial close and flip keep fees and future PnL out of copy returns", () => {
  const p = portfolio();
  applyManualHandoffs(p);
  const fill = {
    id: "manual_real_exchange_fill",
    order_id: "77",
    handoff_id: handoff().handoff_id,
    key,
    quantity: "-1.5",
    price: "120",
    fee_usdc: ".1",
    at: at - 1000,
  };
  applyManualFill(p, fill);
  applyManualFill(p, fill);
  p.snapshot!.positions[key] = "-0.5";
  p.snapshot!.prices[key] = "100";
  p.snapshot!.account_value_usdc = "529.9";
  assert.equal(p.manual_ledger!.lots[key].quantity, "-0.5");
  assert.equal(p.manual_ledger!.lots[key].cost, "-60");
  assert.equal(p.manual_ledger!.seen_fills.length, 1);
  assert.equal(reconcileQuantities(p), true);
  assert.equal(pnl(p).net_usdc, "10.000000");
  assert.equal(pnl(p).manual_net_usdc, "19.900000");
});

it("funding before and after the handoff is assigned to historical copy and manual owners", () => {
  const p = portfolio();
  applyManualHandoffs(p);
  applyFunding(
    p,
    { id: "before", key, amount_usdc: "-1", at: at - 2500 },
    { copy_0: "1" },
  );
  applyFunding(
    p,
    { id: "after", key, amount_usdc: "-2", at: at - 1000 },
    { copy_0: "0", [MANUAL_LEDGER_OWNER]: "1" },
  );
  p.snapshot!.account_value_usdc = "507";
  assert.equal(p.sleeves[0].lots[key].funding, "-1");
  assert.equal(p.manual_ledger!.lots[key].funding, "-2");
  assert.equal(pnl(p).net_usdc, "9.000000");
  assert.equal(pnl(p).manual_net_usdc, "-2.000000");
});

it("zero-net zero funding does not divide by zero or manufacture a funding mismatch", () => {
  const p = portfolio(["1", "-1"]);
  applyFunding(
    p,
    { id: "net_zero", key, amount_usdc: "0", at },
    { copy_0: "1", copy_1: "-1" },
  );
  assert.deepEqual(p.seen_funding, ["net_zero"]);
  assert.equal(p.sleeves[0].lots[key].funding, "0");
});

for (const kind of ["fill", "funding"] as const)
  it(`fails closed on an ambiguous ${kind}/handoff timestamp tie`, () => {
    const p = portfolio();
    if (kind === "fill")
      p.snapshot!.fills = [
        {
          id: "f",
          order_id: "o",
          task_id: "t",
          key,
          quantity: "1",
          price: "100",
          fee_usdc: "0",
          at: handoff().at_ms,
        },
      ];
    else
      p.snapshot!.funding = [
        { id: "fund", key, amount_usdc: "0", at: handoff().at_ms },
      ];
    assert.throws(
      () => applyManualHandoffs(p),
      (error) =>
        error instanceof AgentError && error.code === "HANDOFF_MISMATCH",
    );
    assert.equal(p.sleeves[0].lots[key].quantity, "1");
    assert.equal(p.manual_ledger, undefined);
  });

it("does not transfer incomplete history, unmatched quantities, or unresolved execution ownership", () => {
  for (const kind of ["coverage", "quantity", "unknown"]) {
    const p = portfolio();
    if (kind === "coverage") p.snapshot!.coverage_complete = false;
    if (kind === "quantity") p.snapshot!.manual_markets![0].signed_size = "2";
    if (kind === "unknown")
      p.executions = [
        {
          id: "stable_original",
          key,
          status: "uncertain",
          task_id: null,
        } as any,
      ];
    assert.throws(() => applyManualHandoffs(p));
    assert.equal(p.sleeves[0].lots[key].quantity, "1");
    if (kind === "unknown") assert.equal(p.executions[0].id, "stable_original");
  }
});

it("a removed or changed Core marker cannot reclaim a market after process restart", () => {
  const original = portfolio();
  applyManualHandoffs(original);
  for (const kind of ["missing", "changed"]) {
    const p = structuredClone(original);
    if (kind === "missing") p.snapshot!.manual_markets = [];
    else p.snapshot!.manual_markets![0].mark_px = "111";
    assert.throws(
      () => applyManualHandoffs(p),
      (error) =>
        error instanceof AgentError && error.code === "HANDOFF_CHANGED",
    );
    assert.equal(p.manual_ledger!.lots[key].quantity, "1");
  }
});

it("manual fills before/tied with the boundary and late unobserved copy fills never gain ownership", () => {
  const p = portfolio();
  applyManualHandoffs(p);
  for (const time of [handoff().at_ms - 1, handoff().at_ms])
    assert.throws(() =>
      applyManualFill(p, {
        id: "bad",
        order_id: "o",
        handoff_id: handoff().handoff_id,
        key,
        quantity: "1",
        price: "110",
        fee_usdc: "0",
        at: time,
      }),
    );
  assert.throws(
    () =>
      applyFill(p, {
        id: "late_copy",
        order_id: "o",
        task_id: "t",
        key,
        quantity: "1",
        price: "100",
        fee_usdc: "0",
        at: handoff().at_ms - 1,
      }),
    (error) =>
      error instanceof AgentError && error.code === "HANDOFF_HISTORY_CHANGED",
  );
  assert.equal(p.sleeves[0].lots[key].quantity, "0");
});

it("manual equity mismatch or missing prices remains unavailable rather than altering copy profit", () => {
  const p = portfolio();
  applyManualHandoffs(p);
  p.snapshot!.account_value_usdc = "511";
  assert.equal(pnl(p).net_usdc, null);
  assert.equal(pnl(p).manual_net_usdc, null);
  p.snapshot!.account_value_usdc = "510";
  delete p.snapshot!.prices[key];
  assert.equal(pnl(p).net_usdc, null);
});

it("combined Prediction and Perps keeps Prediction in copy PnL and only explicit Perps handoffs in manual PnL", () => {
  const p = portfolio();
  applyManualHandoffs(p);
  const prediction = "prediction:condition:YES";
  p.sleeves[0].lots[prediction] = {
    key: prediction,
    asset: "YES",
    market: "prediction",
    quantity: "10",
    cost: "5",
    realized: "0",
    fees: "0",
    funding: "0",
  };
  p.snapshot!.positions[prediction] = "10";
  p.snapshot!.prices[prediction] = ".6";
  p.snapshot!.prices[key] = "120";
  p.snapshot!.account_value_usdc = "521";
  assert.equal(reconcileQuantities(p), true);
  assert.equal(pnl(p).net_usdc, "11.000000");
  assert.equal(pnl(p).manual_net_usdc, "10.000000");
});

it("displayed copy and manual profit conserve every micro-USDC after independent ownership accounting", () => {
  const p = portfolio();
  applyManualHandoffs(p);
  p.sleeves[0].lots[key].realized = ".0000006";
  p.manual_ledger!.lots[key].realized = ".0000006";
  p.snapshot!.account_value_usdc = "500.0000012";
  const profit = pnl(p);
  assert.equal(profit.net_usdc, "0.000000");
  assert.equal(profit.manual_net_usdc, "0.000001");
  assert.equal(
    D(profit.net_usdc!).plus(profit.manual_net_usdc!).toFixed(6),
    "0.000001",
  );
});
