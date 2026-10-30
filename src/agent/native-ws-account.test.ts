import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import type { Portfolio } from "./domain.js";

const user = "0x" + "a".repeat(40);
const base = 1793200000000;
function fixture(t: TestContext, issue = "") {
  let clock = base,
    calls = 0;
  t.mock.method(Date, "now", () => clock);
  const previous = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any,
    reads: any[] = [],
    actions: any[] = [];
  stub.core = async (operation: string) => {
    assert.equal(operation, "perps_account");
    return { master: user, status: 4 };
  };
  stub.venueReads.accountObservedAt = () => base + 100;
  stub.info = async (input: any) => {
    reads.push({ ...input, at: clock });
    clock += 100;
    switch (input.type) {
      case "userAbstraction":
        return issue === "mode" &&
          reads.filter((r) => r.type === input.type).length > 1
          ? "disabled"
          : "unifiedAccount";
      case "perpDexs":
        return [null, { name: "xyz" }];
      case "userDexAbstraction":
        return false;
      case "clearinghouseState":
        return {
          marginSummary: { accountValue: "0" },
          withdrawable: "0",
          assetPositions: [],
        };
      case "frontendOpenOrders":
        return [];
      case "allMids":
        return { BTC: "100" };
      case "spotClearinghouseState":
        return {
          balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }],
        };
      case "meta":
        return { universe: [{ name: "BTC", maxLeverage: 10, szDecimals: 3 }] };
      default:
        assert.fail(input.type);
    }
  };
  stub.paged = async (
    type: string,
    owner: string,
    start: number,
    end: number,
  ) => {
    assert.equal(owner, user);
    assert.equal(start, base - 60000);
    actions.push({ type, at: clock, end });
    clock += 100;
    if (issue === "history throw")
      throw new Error("fixture history unavailable");
    return { events: [], complete: issue !== "history incomplete" };
  };
  let nativeDispatch = 0,
    completion = 0;
  stub.orderSnapshots = {
    readAccount: async (owner: string, dexes: string[]) => {
      assert.equal(owner, user);
      calls++;
      actions.push({ type: "ws", dexes, at: clock });
      nativeDispatch = clock - 250; // Native may precede spot/mids; never relabel it.
      const state: any = {
        marginSummary: { accountValue: issue === "numeric zero" ? 0 : "0" },
        withdrawable: "0",
        assetPositions: [],
      };
      if (issue === "NaN balance") state.marginSummary.accountValue = NaN;
      if (issue === "infinite balance")
        state.marginSummary.accountValue = Infinity;
      if (issue === "boolean balance") state.marginSummary.accountValue = false;
      if (issue === "empty balance") state.marginSummary.accountValue = "";
      if (issue === "null balance") state.marginSummary.accountValue = null;
      if (issue === "missing balance") delete state.marginSummary.accountValue;
      if (issue === "invalid decimal")
        state.marginSummary.accountValue = "0x10";
      if (issue === "missing withdrawal") delete state.withdrawable;
      const result: any = {
        orders: new Map([
          ["", issue === "nonempty" ? [{ oid: 1 }] : []],
          ["xyz", []],
        ]),
        states: new Map([
          ["", state],
          ["xyz", { assetPositions: [] }],
        ]),
        dispatches: {
          orders: new Map([
            ["", nativeDispatch],
            ["xyz", clock],
          ]),
          states: new Map([
            ["", nativeDispatch + 5],
            ["xyz", clock],
          ]),
        },
      };
      if (issue === "partial") result.states.delete("xyz");
      if (issue === "missing proof") delete result.dispatches;
      if (issue === "malformed proof") result.dispatches.orders = {};
      if (issue === "malformed states") result.states = {};
      if (issue === "future") result.dispatches.states.set("", clock + 10000);
      if (issue === "zero stamp") result.dispatches.orders.set("", 0);
      if (issue === "fractional stamp")
        result.dispatches.orders.set("", nativeDispatch + 0.5);
      clock += 1000;
      completion = clock;
      return result;
    },
  };
  const portfolio = {
    account_id: "owned",
    venue_accounts: { perps: "owned" },
    sleeves: [],
    executions: [],
    ledger_started_at: base - 60000,
  } as unknown as Portfolio;
  t.after(async () => {
    if (previous === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = previous;
    await bridge.close();
  });
  return {
    bridge,
    portfolio,
    reads,
    actions,
    get calls() {
      return calls;
    },
    get nativeDispatch() {
      return nativeDispatch;
    },
    get completion() {
      return completion;
    },
  };
}

it("uses one early explicit native and foreign batch before every history fence, keeping its original dispatch age", async (t) => {
  const f = fixture(t),
    snapshot = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.deepEqual(f.actions.find((x) => x.type === "ws").dexes, ["", "xyz"]);
  assert.equal(f.calls, 1);
  assert.equal(
    f.reads.filter((x) =>
      ["clearinghouseState", "frontendOpenOrders"].includes(x.type),
    ).length,
    0,
  );
  assert.equal(f.actions.filter((x) => x.type !== "ws").length, 3);
  assert.equal(
    f.actions.filter((x) => x.type !== "ws")[0].type,
    "userFillsByTime",
  );
  assert.equal(
    new Set(f.actions.filter((x) => x.type !== "ws").map((x) => x.end)).size,
    1,
  );
  assert.ok(
    f.actions
      .filter((x) => x.type !== "ws")
      .every((x) => x.end >= f.completion),
  );
  assert.equal(snapshot.observed_at, f.nativeDispatch);
  assert.equal(snapshot.account_value_usdc, "100.000000");
  assert.equal(f.reads.filter((x) => x.type === "userAbstraction").length, 2);
});
for (const issue of [
  "nonempty",
  "partial",
  "missing proof",
  "future",
  "zero stamp",
  "fractional stamp",
  "NaN balance",
  "infinite balance",
  "boolean balance",
  "empty balance",
  "null balance",
  "missing balance",
  "invalid decimal",
  "missing withdrawal",
  "malformed proof",
  "malformed states",
])
  it(`falls back to the complete REST sweep for native ${issue}, retaining the original history fence`, async (t) => {
    const f = fixture(t, issue);
    await f.bridge.perpsAccount("alice", f.portfolio);
    assert.equal(
      f.calls,
      1,
      "failed batches do not start a second late session",
    );
    for (const dex of [undefined, "xyz"])
      for (const type of ["clearinghouseState", "frontendOpenOrders"])
        assert.ok(
          f.reads.some((x) => x.type === type && x.dex === dex),
          `${type}:${dex}`,
        );
    const nativeDone = Math.max(
      ...f.reads
        .filter((x) => x.type === "clearinghouseState" && x.dex === undefined)
        .map((x) => x.at + 100),
    );
    assert.ok(
      f.actions
        .filter((x) => x.type !== "ws")
        .every((x) => x.end >= nativeDone),
    );
  });
it("keeps the account-mode guard after an otherwise complete native batch", async (t) => {
  const f = fixture(t, "mode");
  await assert.rejects(
    f.bridge.perpsAccount("alice", f.portfolio),
    (e: any) => e.code === "ACCOUNT_STALE",
  );
});

it("never publishes a complete native account frame when the full history is incomplete", async (t) => {
  const f = fixture(t, "history incomplete");
  const snapshot = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.equal(snapshot.coverage_complete, false);
  assert.equal(f.actions.filter((x) => x.type !== "ws").length, 3);
});
it("does not return a native account frame when a required history read throws", async (t) => {
  const f = fixture(t, "history throw");
  await assert.rejects(
    f.bridge.perpsAccount("alice", f.portfolio),
    /fixture history unavailable/,
  );
  assert.equal(f.actions.filter((x) => x.type !== "ws").length, 1);
});

it("accepts explicit finite native numeric zero without manufacturing a default or a newer observation", async (t) => {
  const f = fixture(t, "numeric zero");
  const snapshot = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.equal(
    f.reads.filter((x) =>
      ["clearinghouseState", "frontendOpenOrders"].includes(x.type),
    ).length,
    0,
  );
  assert.equal(snapshot.observed_at, f.nativeDispatch);
  assert.equal(snapshot.account_value_usdc, "100.000000");
});

it("rejects an otherwise fresh false proof produced before every history response completed", async (t) => {
  const f = fixture(t);
  let minimum = 0;
  (f.bridge as any).orderSnapshots.readAbstraction = async (
    _owner: string,
    _signal: AbortSignal,
    notBefore: number,
  ) => {
    minimum = notBefore;
    return {
      user,
      dex_abstraction_enabled: false,
      dispatch_at: Date.now(),
      server_time: notBefore - 1,
    };
  };
  const snapshot = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.ok(
    minimum >=
      Math.max(
        ...f.actions
          .filter((x) =>
            [
              "userFillsByTime",
              "userFunding",
              "userNonFundingLedgerUpdates",
            ].includes(x.type),
          )
          .map((x) => x.at + 100),
      ),
  );
  assert.equal(
    f.reads.filter((x) => x.type === "userDexAbstraction").length,
    1,
  );
  assert.equal(snapshot.observed_at, f.nativeDispatch);
});
it("accepts an explicit false proof at the real history-completion boundary without requiring a newer server clock", async (t) => {
  const f = fixture(t);
  (f.bridge as any).orderSnapshots.readAbstraction = async (
    _owner: string,
    _signal: AbortSignal,
    notBefore: number,
  ) => ({
    user,
    dex_abstraction_enabled: false,
    dispatch_at: Date.now(),
    server_time: notBefore,
  });
  await f.bridge.perpsAccount("alice", f.portfolio);
  assert.equal(
    f.reads.filter((x) => x.type === "userDexAbstraction").length,
    0,
  );
});
