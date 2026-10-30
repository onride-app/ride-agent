import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { AgentError } from "./contracts.js";
import {
  recommend,
  type ManualMarketHandoff,
  type Execution,
} from "./domain.js";
import { candidate, snapshot } from "./fixtures.js";
import { applyManualHandoffs } from "./ledger.js";
import { fromPlan } from "./service.js";

const base = 1793200000000,
  key = "perps:BTC",
  master = "0x" + "a".repeat(40),
  agent = "0x" + "b".repeat(40);
function fixture(t: TestContext) {
  t.mock.method(Date, "now", () => base);
  const marker: ManualMarketHandoff = {
    handoff_id: "11111111-1111-4111-8111-111111111111",
    binding_id: "owned",
    coin: "BTC",
    at_ms: base - 2000,
    mark_px: "110",
    signed_size: "1",
    master,
    agent,
    network: 2,
    wallet_generation: 1,
  };
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any;
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
      },
      [candidate(1)],
    ),
  );
  p.account_id = "owned";
  p.venue_accounts = { perps: "owned" };
  p.ledger_started_at = base - 10000;
  p.initial_equity = "500";
  p.state = "active";
  p.executions = [
    {
      id: "execution_owned",
      key,
      target_quantity: "1",
      allocations: { [p.sleeves[0].copy_id]: "1" },
      status: "failed",
      revision: 1,
      fingerprint: "owned",
      created_at: base - 9000,
      expires_at: base + 10000,
      task_id: "task_owned",
      observed_quantity: "1",
      reserve_usdc: "0",
      error: null,
    },
  ];
  const ownedFill = {
    oid: 7,
    tid: 1,
    coin: "BTC",
    time: base - 3000,
    sz: "1",
    side: "B",
    px: "100",
    fee: "0",
    feeToken: "USDC",
  };
  const manualFill = {
    oid: 8,
    tid: 2,
    coin: "BTC",
    time: base - 1000,
    sz: ".5",
    side: "B",
    px: "110",
    fee: ".01",
    feeToken: "USDC",
  };
  const identity: any = {
    account_id: "owned",
    master,
    agent,
    status: 4,
    network: 2,
    wallet_generation: 1,
    manual_markets: [marker],
  };
  const calls: { operation: string; input: any }[] = [],
    reads: string[] = [],
    controls: any[] = [];
  let fills: any[] = [ownedFill, manualFill],
    funding: any[] = [],
    orders: any[] = [
      { oid: 9, coin: "BTC", timestamp: base - 500, reduceOnly: false },
    ],
    positions: any[] = [{ position: { coin: "BTC", szi: "1.5" } }],
    lookup: any = { found: false };
  stub.core = async (operation: string, input: any) => {
    calls.push({ operation, input });
    assert.ok(
      ["perps_account", "perps_execution", "perps_execution_lookup"].includes(
        operation,
      ),
      "no signing or submission in this read fixture",
    );
    if (operation === "perps_account") return structuredClone(identity);
    if (operation === "perps_execution_lookup") return structuredClone(lookup);
    return {
      status: 4,
      snapshot: {
        fill_settlement_pending: false,
        settlement_observation_required: false,
      },
      legs: [{ oid: 7 }],
    };
  };
  stub.control = async (operation: string, input: any) => {
    controls.push({ operation, input });
    return {};
  };
  stub.venueReads.accountObservedAt = () => base;
  stub.info = async (payload: any) => {
    reads.push(payload.type);
    switch (payload.type) {
      case "userAbstraction":
        return "disabled";
      case "clearinghouseState":
        return {
          marginSummary: { accountValue: "500" },
          withdrawable: "400",
          assetPositions: structuredClone(positions),
        };
      case "allMids":
        return { BTC: "110", ETH: "100" };
      case "frontendOpenOrders":
        return structuredClone(orders);
      case "meta":
        return {
          universe: [
            { name: "BTC", maxLeverage: 8, szDecimals: 3 },
            { name: "ETH", maxLeverage: 8, szDecimals: 3 },
          ],
        };
      default:
        assert.fail("Unexpected financial scope " + payload.type);
    }
  };
  stub.paged = async (type: string) => ({
    events: structuredClone(
      type === "userFillsByTime"
        ? fills
        : type === "userFunding"
          ? funding
          : [],
    ),
    complete: true,
  });
  t.after(() => bridge.close());
  return {
    bridge,
    stub,
    p,
    marker,
    identity,
    calls,
    reads,
    controls,
    ownedFill,
    manualFill,
    setFills(value: any[]) {
      fills = value;
    },
    setFunding(value: any[]) {
      funding = value;
    },
    setOrders(value: any[]) {
      orders = value;
    },
    setPositions(value: any[]) {
      positions = value;
    },
    setLookup(value: any) {
      lookup = value;
    },
  };
}

it("splits only post-marker unowned fills into manual history and preserves full account positions, funds and orders", async (t) => {
  const f = fixture(t),
    snap = await f.bridge.perpsAccount("alice", f.p);
  assert.equal(snap.coverage_complete, true);
  assert.equal(snap.fills[0].task_id, "task_owned");
  assert.equal(snap.fills.length, 1);
  assert.equal(snap.manual_fills!.length, 1);
  assert.equal(snap.manual_fills![0].handoff_id, f.marker.handoff_id);
  assert.equal("task_id" in snap.manual_fills![0], false);
  assert.deepEqual(snap.manual_markets, [f.marker]);
  assert.deepEqual(snap.positions, { [key]: "1.5" });
  assert.equal(snap.available_usdc, "400");
  assert.equal(snap.account_value_usdc, "500");
  assert.equal(snap.orders[0].ownership, "manual");
});

for (const condition of [
  "before",
  "tie",
  "owned_after",
  "non_usdc",
  "no_marker",
]) {
  it(`keeps ${condition} fills incomplete instead of silently treating them as manual`, async (t) => {
    const f = fixture(t);
    if (condition === "before")
      f.setFills([{ ...f.manualFill, time: f.marker.at_ms - 1 }]);
    if (condition === "tie")
      f.setFills([{ ...f.manualFill, time: f.marker.at_ms }]);
    if (condition === "owned_after")
      f.setFills([{ ...f.ownedFill, time: f.marker.at_ms + 1 }]);
    if (condition === "non_usdc")
      f.setFills([{ ...f.manualFill, feeToken: "HYPE" }]);
    if (condition === "no_marker") {
      delete f.identity.manual_markets;
      f.setFills([f.manualFill]);
    }
    const snap = await f.bridge.perpsAccount("alice", f.p);
    assert.equal(snap.coverage_complete, false);
    assert.equal(snap.manual_fills?.length ?? 0, 0);
  });
}

it("a funding timestamp tied with the handoff makes coverage incomplete", async (t) => {
  const f = fixture(t);
  f.setFunding([{ time: f.marker.at_ms, delta: { coin: "BTC", usdc: "-1" } }]);
  assert.equal(
    (await f.bridge.perpsAccount("alice", f.p)).coverage_complete,
    false,
  );
});

for (const field of [
  "binding_id",
  "master",
  "agent",
  "network",
  "wallet_generation",
  "at_ms",
  "mark_px",
  "duplicate",
]) {
  it(`rejects malformed or mismatched ${field} ownership before any venue request`, async (t) => {
    const f = fixture(t);
    if (field === "duplicate")
      f.identity.manual_markets.push({
        ...f.marker,
        handoff_id: "22222222-2222-4222-8222-222222222222",
      });
    else
      f.identity.manual_markets[0][field] =
        field === "at_ms"
          ? base + 1
          : field === "mark_px"
            ? "0"
            : field === "network"
              ? 1
              : field === "wallet_generation"
                ? 2
                : "wrong";
    await assert.rejects(
      f.bridge.perpsAccount("alice", f.p),
      (error) => error instanceof AgentError && error.code === "ACCOUNT_STALE",
    );
    assert.deepEqual(f.reads, []);
  });
}

it("read-only external execution lookup restores lost task/OID attribution before handoff", async (t) => {
  const f = fixture(t);
  f.p.executions[0].task_id = null;
  f.p.executions[0].status = "uncertain";
  f.setLookup({
    found: true,
    task_id: "recovered_task",
    status: 3,
    snapshot: {
      fill_settlement_pending: false,
      settlement_observation_required: false,
    },
    legs: [{ oid: 7 }],
  });
  const snap = await f.bridge.perpsAccount("alice", f.p);
  assert.equal(snap.coverage_complete, true);
  assert.equal(snap.fills[0].task_id, "recovered_task");
  assert.deepEqual(snap.recovered_executions, [
    {
      execution_id: "execution_owned",
      task_id: "recovered_task",
      status: "completed",
      settled: true,
    },
  ]);
  assert.deepEqual(
    f.calls
      .filter((x) => x.operation === "perps_execution_lookup")
      .map((x) => x.input.execution_id),
    ["execution_owned"],
  );
  assert.equal(
    f.calls.some((x) => x.operation.includes("submit")),
    false,
  );
});

it("only an explicit read-only not-found can supersede an unsubmitted handoff target", async (t) => {
  const f = fixture(t);
  f.setFills([]);
  f.p.executions[0].task_id = null;
  f.p.executions[0].status = "queued";
  const snap = await f.bridge.perpsAccount("alice", f.p);
  assert.deepEqual(snap.recovered_executions, [
    {
      execution_id: "execution_owned",
      task_id: null,
      status: "superseded",
      settled: true,
    },
  ]);
  f.setLookup({ error: "unknown_operation" });
  await assert.rejects(
    f.bridge.perpsAccount("alice", f.p),
    (error) => error instanceof AgentError && error.code === "HANDOFF_PENDING",
  );
});

for (const status of [6, 7, 0])
  it(`handles Core task enum ${status} without confusing superseded, reconcile-only or unknown`, async (t) => {
    const f = fixture(t);
    f.setFills([]);
    f.p.executions[0].task_id = null;
    f.p.executions[0].status = "uncertain";
    f.setLookup({
      found: true,
      task_id: "stable_task",
      status,
      snapshot: {
        fill_settlement_pending: false,
        settlement_observation_required: false,
      },
      legs: [],
    });
    if (status === 0) {
      await assert.rejects(
        f.bridge.perpsAccount("alice", f.p),
        (error) =>
          error instanceof AgentError && error.code === "HANDOFF_PENDING",
      );
      return;
    }
    const snap = await f.bridge.perpsAccount("alice", f.p);
    assert.equal(
      snap.recovered_executions![0].status,
      status === 6 ? "superseded" : "settling",
    );
    assert.equal(snap.recovered_executions![0].settled, status === 6);
  });

it("even a terminal Core task remains unresolved while settlement flags are pending or missing", async (t) => {
  const f = fixture(t);
  f.setFills([]);
  f.p.executions[0].status = "uncertain";
  f.p.executions[0].task_id = null;
  f.setLookup({
    found: true,
    task_id: "stable_task",
    status: 6,
    snapshot: {
      fill_settlement_pending: true,
      settlement_observation_required: false,
    },
    legs: [],
  });
  assert.equal(
    (await f.bridge.perpsAccount("alice", f.p)).recovered_executions![0].status,
    "settling",
  );
  f.setLookup({
    found: true,
    task_id: "stable_task",
    status: 3,
    snapshot: {},
    legs: [],
  });
  await assert.rejects(f.bridge.perpsAccount("alice", f.p));
});

it("read-only recovery cannot erase or replace a previously known task identity", async (t) => {
  const f = fixture(t);
  f.setFills([]);
  f.p.executions[0].status = "submitted";
  await assert.rejects(
    f.bridge.perpsAccount("alice", f.p),
    (error) => error instanceof AgentError && error.code === "HANDOFF_PENDING",
  );
  f.setLookup({
    found: true,
    task_id: "different_task",
    status: 6,
    snapshot: {
      fill_settlement_pending: false,
      settlement_observation_required: false,
    },
    legs: [],
  });
  await assert.rejects(
    f.bridge.perpsAccount("alice", f.p),
    (error) => error instanceof AgentError && error.code === "HANDOFF_PENDING",
  );
});

it("malformed manual exchange fill quantities remain incomplete rather than throwing during decimal parsing", async (t) => {
  const f = fixture(t);
  f.setFills([{ ...f.manualFill, sz: "-" }]);
  const snap = await f.bridge.perpsAccount("alice", f.p);
  assert.equal(snap.coverage_complete, false);
  assert.deepEqual(snap.manual_fills, []);
});

it("orders without a provably later manual timestamp remain unknown and are not exempted", async (t) => {
  const f = fixture(t);
  f.setOrders([
    { oid: 7, coin: "BTC", timestamp: base - 3000 },
    { oid: 90, coin: "BTC", timestamp: f.marker.at_ms },
    { oid: 91, coin: "ETH", timestamp: base - 100 },
  ]);
  const snap = await f.bridge.perpsAccount("alice", f.p);
  assert.deepEqual(
    snap.orders.map((x) => x.ownership),
    ["copy", "unknown", "unknown"],
  );
});

it("future, noninteger and infinite order timestamps never receive the manual exemption", async (t) => {
  const f = fixture(t);
  f.setOrders(
    [base + 1, base - 0.5, Infinity].map((timestamp, i) => ({
      oid: 100 + i,
      coin: "BTC",
      timestamp,
      reduceOnly: false,
    })),
  );
  const snap = await f.bridge.perpsAccount("alice", f.p);
  assert.deepEqual(
    snap.orders.map((order) => order.ownership),
    ["unknown", "unknown", "unknown"],
  );
});

it("combined Prediction/Perps snapshots retain the perps handoff and manual fill evidence", async (t) => {
  const f = fixture(t);
  f.p.sleeves.push({
    ...structuredClone(f.p.sleeves[0]),
    copy_id: "prediction_copy",
    trader: { ...candidate(2), market: "prediction" },
  });
  f.stub.prediction.account = async () => ({
    ...snapshot(),
    account_id: "prediction_owned",
    venue_accounts: { prediction: "prediction_owned" },
    account_value_usdc: "10",
    available_usdc: "8",
    positions: { "prediction:condition:YES": "2" },
    fills: [],
  });
  const snap = await f.bridge.account("alice", f.p);
  assert.deepEqual(snap.manual_markets, [f.marker]);
  assert.equal(snap.manual_fills!.length, 1);
  assert.equal(snap.positions["prediction:condition:YES"], "2");
  assert.equal(snap.venue_accounts!.perps, "owned");
  assert.equal(snap.venue_accounts!.prediction, "prediction_owned");
  assert.equal(snap.account_value_usdc, "510.000000");
});

it("manual remaining positions/orders can survive copy release, while unknown orders or quantity drift still block it", async (t) => {
  const f = fixture(t);
  f.setFills([]);
  f.setPositions([{ position: { coin: "BTC", szi: "1" } }]);
  f.p.snapshot = {
    ...snapshot(),
    manual_markets: [f.marker],
    positions: { [key]: "1" },
  };
  f.p.sleeves[0].lots[key] = {
    key,
    asset: "BTC",
    market: "perps",
    quantity: "1",
    cost: "100",
    realized: "0",
    fees: "0",
    funding: "0",
  };
  applyManualHandoffs(f.p);
  await f.bridge.release("alice", f.p);
  assert.equal(f.controls.at(-1).input.state, "disabled");
  assert.equal(f.p.manual_ledger!.lots[key].quantity, "1");
  f.setOrders([
    { oid: 9, coin: "BTC", timestamp: f.marker.at_ms, reduceOnly: false },
  ]);
  await assert.rejects(f.bridge.release("alice", f.p));
  f.setOrders([]);
  f.setPositions([{ position: { coin: "BTC", szi: "2" } }]);
  await assert.rejects(f.bridge.release("alice", f.p));
});

it("cancel-increasing ignores only proven manual orders and does not cancel them", async (t) => {
  const f = fixture(t);
  f.setFills([]);
  f.p.snapshot = {
    ...snapshot(),
    manual_markets: [f.marker],
    positions: { [key]: "1" },
  };
  f.p.sleeves[0].lots[key] = {
    key,
    asset: "BTC",
    market: "perps",
    quantity: "1",
    cost: "100",
    realized: "0",
    fees: "0",
    funding: "0",
  };
  applyManualHandoffs(f.p);
  await f.bridge.operation("cancel_increasing", {
    user_id: "alice",
    portfolio: f.p,
  });
  assert.equal(
    f.calls.some((x) => x.operation.includes("cancel")),
    false,
  );
  f.setOrders([
    { oid: 90, coin: "ETH", timestamp: base - 100, reduceOnly: false },
  ]);
  await assert.rejects(
    f.bridge.operation("cancel_increasing", {
      user_id: "alice",
      portfolio: f.p,
    }),
    (error) =>
      error instanceof AgentError && error.code === "UNRESOLVED_OPEN_ORDER",
  );
});

it("a new copy target cannot submit into an already manual market", async (t) => {
  const f = fixture(t);
  f.stub.pool.query = async () => ({ rowCount: 0, rows: [] });
  f.setFills([]);
  await assert.rejects(
    f.bridge.submit("alice", f.p, {
      ...f.p.executions[0],
      id: "new_target",
      task_id: null,
      status: "queued",
      expires_at: base + 10000,
    } as Execution),
    (error) =>
      error instanceof AgentError && error.code === "EXECUTION_REJECTED",
  );
  assert.equal(
    f.calls.some((x) => x.operation.includes("submit")),
    false,
  );
});
