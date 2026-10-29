import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { CoreBridge } from "./core_bridge.js";
import type { Portfolio } from "./domain.js";
import { VenueReads } from "./venue-reads.js";

const owner = "0x" + "a".repeat(40);
const dexNames = ["xyz", "flx", "hyna"];
const pendingOrder = { oid: 123, coin: "hyna:TSLA", reduceOnly: false };
const emptyOrders = () => new Map(dexNames.map((dex) => [dex, []]));
type AccountBatch = {
  orders: Map<string, unknown[]>;
  states: Map<string, unknown>;
};
const emptyBatch = (): AccountBatch => ({
  orders: emptyOrders(),
  states: new Map(dexNames.map((dex) => [dex, { assetPositions: [] }])),
});

function fixture(t: TestContext, network: "mainnet" | "testnet" = "mainnet") {
  const previous = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      network,
    ),
    stub = bridge as any,
    reads: { type: string; user?: string; dex?: string }[] = [],
    batches: { user: string; dexes: string[]; signal: AbortSignal }[] = [],
    writes: string[] = [];
  let mode = "unifiedAccount",
    modeReads = 0,
    changedMode = false,
    foreignPosition = false,
    restPending = false,
    scopes: unknown = [null, ...dexNames.map((name) => ({ name }))],
    batch: AccountBatch | undefined = emptyBatch();
  let batchRead = async (
    _user: string,
    _dexes: string[],
    _signal: AbortSignal,
  ) => batch;
  stub.orderSnapshots = {
    readAccount: async (user: string, dexes: string[], signal: AbortSignal) => {
      batches.push({ user, dexes: [...dexes], signal });
      return batchRead(user, dexes, signal);
    },
  };
  stub.core = async (operation: string) => {
    if (operation !== "perps_account") writes.push(operation);
    return { master: owner, status: 4 };
  };
  stub.info = async (input: any) => {
    reads.push({ ...input });
    switch (input.type) {
      case "userAbstraction":
        return changedMode && ++modeReads === 2 ? "disabled" : mode;
      case "userDexAbstraction":
        return false;
      case "perpDexs":
        return scopes;
      case "spotClearinghouseState":
        return {
          balances: [{ coin: "USDC", token: 0, total: "100", hold: "5" }],
        };
      case "clearinghouseState":
        return {
          marginSummary: { accountValue: "10" },
          withdrawable: "8",
          assetPositions:
            foreignPosition && input.dex === "hyna"
              ? [{ position: { coin: "hyna:TSLA", szi: "1" } }]
              : [],
        };
      case "frontendOpenOrders":
        return input.dex === "hyna" && restPending ? [pendingOrder] : [];
      case "allMids":
        return { BTC: "100" };
      case "meta":
        return { universe: [{ name: "BTC", maxLeverage: 20, szDecimals: 3 }] };
      default:
        assert.fail("Unexpected venue read " + input.type);
    }
  };
  const histories: string[] = [];
  stub.paged = async (method: string, user: string) => {
    assert.equal(user, owner);
    histories.push(method);
    return { events: [], complete: true };
  };
  const portfolio = {
    id: "portfolio_owned",
    account_id: "owned_account",
    venue_accounts: { perps: "owned_account" },
    sleeves: [],
    executions: [],
    ledger_started_at: Date.now() - 60000,
  } as unknown as Portfolio;
  t.after(async () => {
    if (previous === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = previous;
    await bridge.close();
  });
  return {
    bridge,
    stub,
    portfolio,
    reads,
    batches,
    writes,
    histories,
    setMode(value: string) {
      mode = value;
    },
    changeMode() {
      changedMode = true;
    },
    setPosition() {
      foreignPosition = true;
      batch?.states.set("hyna", {
        assetPositions: [{ position: { coin: "hyna:TSLA", szi: "1" } }],
      });
    },
    setRestPending() {
      restPending = true;
    },
    setScopes(value: unknown) {
      scopes = value;
    },
    setBatch(value: AccountBatch | undefined) {
      batch = value;
    },
    setBatchRead(value: typeof batchRead) {
      batchRead = value;
    },
  };
}

it("uses every fresh foreign-DEX state and order snapshot while retaining native and history reads", async (t) => {
  const f = fixture(t);
  const snap = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.equal(snap.coverage_complete, true);
  assert.equal(snap.account_value_usdc, "100.000000");
  assert.equal(snap.available_usdc, "95.000000");
  assert.equal(f.batches.length, 1);
  assert.equal(f.batches[0].user, owner);
  assert.deepEqual(f.batches[0].dexes, dexNames);
  assert.ok(f.batches[0].signal instanceof AbortSignal);
  assert.deepEqual(
    f.reads.filter((read) => read.type === "frontendOpenOrders"),
    [{ type: "frontendOpenOrders", user: owner }],
  );
  assert.equal(
    f.reads.filter((read) => read.type === "clearinghouseState" && read.dex)
      .length,
    0,
  );
  assert.deepEqual(f.histories.sort(), [
    "userFillsByTime",
    "userFunding",
    "userNonFundingLedgerUpdates",
  ]);
  assert.equal(
    f.reads.filter((read) => read.type === "userAbstraction").length,
    2,
  );
  assert.deepEqual(f.writes, []);
});

for (const unavailable of [
  "undefined",
  "throw",
  "partial",
  "malformed",
  "missing states",
  "partial states",
  "malformed states",
] as const)
  it(`falls back to the complete REST state and order sweep when the fresh batch is ${unavailable}`, async (t) => {
    const f = fixture(t);
    if (unavailable === "undefined") f.setBatch(undefined);
    if (unavailable === "throw")
      f.setBatchRead(async () => {
        throw new Error("fixture socket failure");
      });
    if (unavailable === "partial")
      f.setBatch({ ...emptyBatch(), orders: new Map([["xyz", []]]) });
    if (unavailable === "malformed")
      f.setBatch({
        ...emptyBatch(),
        orders: new Map(
          dexNames.map((dex) => [dex, dex === "flx" ? null : []]),
        ) as any,
      });
    if (unavailable === "missing states")
      f.setBatch({ ...emptyBatch(), states: undefined } as any);
    if (unavailable === "partial states")
      f.setBatch({
        ...emptyBatch(),
        states: new Map([["xyz", { assetPositions: [] }]]),
      });
    if (unavailable === "malformed states")
      f.setBatch({
        ...emptyBatch(),
        states: new Map(
          dexNames.map((dex) => [
            dex,
            dex === "flx" ? {} : { assetPositions: [] },
          ]),
        ),
      });
    const snap = await f.bridge.perpsAccount("alice", f.portfolio);
    assert.equal(snap.coverage_complete, true);
    assert.equal(f.batches.length, 1);
    assert.deepEqual(
      f.reads
        .filter((read) => read.type === "frontendOpenOrders" && read.dex)
        .map((read) => read.dex)
        .sort(),
      [...dexNames].sort(),
    );
    assert.deepEqual(
      f.reads
        .filter((read) => read.type === "clearinghouseState" && read.dex)
        .map((read) => read.dex)
        .sort(),
      [...dexNames].sort(),
    );
    assert.deepEqual(f.writes, []);
  });

it("checks a new order batch on every account observation and rejects newly observed foreign orders", async (t) => {
  const f = fixture(t);
  await f.bridge.perpsAccount("alice", f.portfolio);
  f.setBatch({
    ...emptyBatch(),
    orders: new Map(
      dexNames.map((dex) => [dex, dex === "hyna" ? [pendingOrder] : []]),
    ),
  });
  await assert.rejects(f.bridge.perpsAccount("alice", f.portfolio), {
    code: "ACCOUNT_NOT_READY",
  });
  assert.equal(f.batches.length, 2);
  assert.deepEqual(f.writes, []);
});

for (const conflict of ["position", "REST order", "mode changed"] as const)
  it(`retains fail-closed account checks for ${conflict}`, async (t) => {
    const f = fixture(t);
    if (conflict === "position") f.setPosition();
    if (conflict === "REST order") {
      f.setBatch(undefined);
      f.setRestPending();
    }
    if (conflict === "mode changed") f.changeMode();
    await assert.rejects(f.bridge.perpsAccount("alice", f.portfolio), {
      code: conflict === "mode changed" ? "ACCOUNT_STALE" : "ACCOUNT_NOT_READY",
    });
    assert.deepEqual(f.writes, []);
  });

it("validates complete foreign scopes before starting the live batch", async (t) => {
  const f = fixture(t);
  f.setScopes([null, { name: "xyz" }, {}]);
  await assert.rejects(f.bridge.perpsAccount("alice", f.portfolio), {
    code: "ACCOUNT_STALE",
  });
  assert.equal(f.batches.length, 0);
});

it("keeps Standard accounts on their existing REST path", async (t) => {
  const f = fixture(t);
  f.setMode("disabled");
  const snap = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.equal(snap.account_value_usdc, "10");
  assert.equal(snap.available_usdc, "8");
  assert.equal(f.batches.length, 0);
  assert.deepEqual(f.writes, []);
});

it("passes the complete account cancellation signal to the batch and does not dispatch REST fallback after expiry", async (t) => {
  const f = fixture(t);
  let clock = 100000,
    expire!: () => void;
  f.stub.venueReads = new VenueReads(
    async () => assert.fail("fixture replaces info reads"),
    () => clock,
    2,
    {
      timers: {
        setTimeout(run) {
          expire = run;
          return 1;
        },
        clearTimeout() {},
      },
    },
  );
  f.setBatchRead(async (_user, _dexes, signal) => {
    assert.equal(signal.aborted, false);
    clock += 20000;
    expire();
    assert.equal(signal.aborted, true);
    return undefined;
  });
  await assert.rejects(f.bridge.perpsAccount("alice", f.portfolio), (error) => {
    assert.ok(error instanceof AgentError);
    assert.equal(error.code, "VENUE_READ_DEADLINE");
    return true;
  });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(f.batches.length, 1);
  assert.equal(
    f.reads.filter((read) => read.type === "frontendOpenOrders" && read.dex)
      .length,
    0,
  );
  assert.deepEqual(f.writes, []);
});
