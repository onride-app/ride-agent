import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import type { Portfolio } from "./domain.js";

const owner = "0x" + "a".repeat(40);
const historyTypes = [
  "userFillsByTime",
  "userFunding",
  "userNonFundingLedgerUpdates",
];
type Read = {
  type: string;
  dex?: string;
  start: number;
  end: number;
  fence?: number;
  user?: string;
};

function fixture(t: TestContext, mode = "unifiedAccount") {
  let clock = 1793200000000;
  const base = clock,
    reads: Read[] = [],
    actions: { operation: string; at: number }[] = [],
    previous = process.env.RIDE_AGENT_UNIFIED_ENABLED,
    previousRwa = process.env.RIDE_AGENT_RWA_ENABLED;
  t.mock.method(Date, "now", () => clock);
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any;
  // info is isolated below; retain VenueReads' original earliest-wire
  // timestamp contract rather than let that stub stamp completion time.
  stub.venueReads.accountObservedAt = () => reads[0]?.start ?? clock;
  let changedMode = false,
    modeAfterFinancialRead: string | undefined,
    abstractionReads = 0,
    foreignOrder = false,
    foreignPosition = false,
    incompleteFunding = false;
  stub.core = async (operation: string, input: any) => {
    actions.push({ operation, at: clock });
    assert.ok(
      ["perps_account", "perps_wallet", "perps_bind"].includes(operation),
    );
    if (operation === "perps_bind") return { account_id: "owned" };
    assert.equal(input.user_id, "alice");
    return { master: owner, status: 4 };
  };
  stub.configure = async () => {
    actions.push({ operation: "configure", at: clock });
  };
  const eventAt = base + 100,
    fundingEvents = [
      ...Array.from({ length: 500 }, (_, i) => ({
        hash: `funding_${i}`,
        time: eventAt + i,
        delta: { coin: "BTC", usdc: "0" },
      })),
      {
        hash: "funding_loss",
        time: eventAt + 600,
        delta: { coin: "BTC", usdc: "-10" },
      },
    ],
    flowEvents = [
      ...Array.from({ length: 500 }, (_, i) => ({
        hash: `flow_${i}`,
        time: eventAt + i,
        delta: { type: "deposit", usdc: "0" },
      })),
      {
        hash: "flow_deposit",
        time: eventAt + 600,
        delta: { type: "deposit", usdc: "10" },
      },
    ];
  stub.info = async (payload: any) => {
    if (payload.user !== undefined) assert.equal(payload.user, owner);
    const read: Read = {
      type: payload.type,
      dex: payload.dex,
      user: payload.user,
      start: clock,
      end: -1,
      fence: payload.endTime,
    };
    reads.push(read);
    await Promise.resolve();
    clock += [
      "clearinghouseState",
      "allMids",
      "spotClearinghouseState",
    ].includes(payload.type)
      ? 1000
      : 10;
    read.end = clock;
    switch (payload.type) {
      case "userAbstraction":
        abstractionReads++;
        return changedMode && abstractionReads === 2 ? "disabled" : mode;
      case "clearinghouseState":
        if (!payload.dex && modeAfterFinancialRead)
          mode = modeAfterFinancialRead;
        return {
          time: clock,
          marginSummary: { accountValue: "100" },
          withdrawable: "100",
          assetPositions: [],
        };
      case "allMids":
        return { [payload.dex ? "TSLA" : "BTC"]: "100" };
      case "spotClearinghouseState":
        // Funding -10 and a deposit +10 occurred after identity resolution
        // but before this response. Equal and opposite cash changes must not
        // disappear simply because the final equity and quantity are equal.
        assert.ok(clock > eventAt + 600);
        return {
          balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }],
        };
      case "frontendOpenOrders":
        return [];
      case "meta":
        return {
          collateralToken: 0,
          universe: [
            {
              name: payload.dex ? "TSLA" : "BTC",
              maxLeverage: 10,
              szDecimals: 3,
            },
          ],
        };
      case "userDexAbstraction":
        return false;
      case "perpDexs":
        return [null, { name: "xyz" }];
      case "userFillsByTime":
        return [];
      case "userFunding":
        if (incompleteFunding) return {};
        return fundingEvents
          .filter(
            (row) =>
              row.time >= payload.startTime && row.time <= payload.endTime,
          )
          .slice(0, 500);
      case "userNonFundingLedgerUpdates":
        return flowEvents
          .filter(
            (row) =>
              row.time >= payload.startTime && row.time <= payload.endTime,
          )
          .slice(0, 500);
      default:
        assert.fail("Unexpected read " + payload.type);
    }
  };
  stub.orderSnapshots = {
    readAccount: async (user: string, dexes: string[], signal: AbortSignal) => {
      assert.equal(user, owner);
      assert.deepEqual(dexes, dexes.includes("") ? ["", "xyz"] : ["xyz"]);
      assert.equal(signal.aborted, false);
      actions.push({ operation: "foreign_snapshot", at: clock });
      const dispatched = clock;
      clock += 10;
      return {
        dispatches: {
          orders: new Map(dexes.map((dex) => [dex, dispatched])),
          states: new Map(dexes.map((dex) => [dex, dispatched])),
        },
        orders: new Map([
          ...(dexes.includes("") ? [["", []] as [string, unknown[]]] : []),
          ["xyz", foreignOrder ? [{ oid: 1, coin: "xyz:TSLA" }] : []],
        ]),
        states: new Map([
          ...(dexes.includes("")
            ? [
                [
                  "",
                  {
                    marginSummary: { accountValue: "100" },
                    withdrawable: "100",
                    assetPositions: [],
                  },
                ] as [string, any],
              ]
            : []),
          [
            "xyz",
            {
              assetPositions: foreignPosition
                ? [{ position: { coin: "xyz:TSLA", szi: "1" } }]
                : [],
            },
          ],
        ]),
      };
    },
  };
  const portfolio = {
    id: "portfolio_owned",
    account_id: "owned",
    venue_accounts: { perps: "owned" },
    sleeves: [],
    executions: [],
    ledger_started_at: base - 60000,
  } as unknown as Portfolio;
  t.after(async () => {
    if (previous === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = previous;
    if (previousRwa === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = previousRwa;
    await bridge.close();
  });
  return {
    bridge,
    portfolio,
    reads,
    actions,
    eventAt,
    fail(kind: "foreign order" | "foreign position" | "mode changed") {
      if (kind === "foreign order") foreignOrder = true;
      if (kind === "foreign position") foreignPosition = true;
      if (kind === "mode changed") changedMode = true;
    },
    incompleteHistory() {
      incompleteFunding = true;
    },
    changeModeDuringFinancialRead(value: string) {
      modeAfterFinancialRead = value;
    },
  };
}

it("fences all complete histories after the financial responses and before the expensive Unified guards", async (t) => {
  const f = fixture(t),
    snapshot = await f.bridge.perpsAccount("alice", f.portfolio),
    histories = f.reads.filter((read) => historyTypes.includes(read.type)),
    financial = f.reads.filter((read) =>
      ["clearinghouseState", "allMids", "spotClearinghouseState"].includes(
        read.type,
      ),
    ),
    firstHistory = Math.min(...histories.map((read) => read.start)),
    lastHistory = Math.max(...histories.map((read) => read.end));
  assert.equal(snapshot.coverage_complete, true);
  assert.equal(snapshot.account_value_usdc, "100.000000");
  assert.equal(snapshot.available_usdc, "100.000000");
  assert.deepEqual(snapshot.positions, {});
  assert.deepEqual(snapshot.orders, []);
  assert.equal(
    snapshot.funding.length,
    501,
    "all funding pages must remain present",
  );
  assert.equal(
    snapshot.flows.length,
    501,
    "all ledger pages must remain present",
  );
  assert.equal(
    snapshot.funding.find((row) => row.amount_usdc === "-10")?.at,
    f.eventAt + 600,
  );
  assert.equal(
    snapshot.flows.find((row) => row.amount_usdc === "10")?.at,
    f.eventAt + 600,
  );
  assert.equal(snapshot.fills.length, 0);
  assert.ok(histories.every((read) => read.user === owner));
  assert.equal(
    new Set(histories.map((read) => read.fence)).size,
    1,
    "all pages and methods share one explicit financial fence",
  );
  assert.ok(
    histories.every(
      (read) => read.fence! >= Math.max(...financial.map((row) => row.end)),
    ),
  );
  assert.ok(firstHistory >= Math.max(...financial.map((read) => read.end)));
  for (const method of ["frontendOpenOrders", "meta", "userDexAbstraction"])
    assert.ok(
      f.reads
        .filter((read) => read.type === method)
        .every((read) => read.start >= lastHistory),
      `${method} cannot increase the prefix before bounded fill history`,
    );
  assert.ok(
    f.reads.find((read) => read.type === "perpDexs")!.end <= firstHistory,
  );
  assert.ok(
    f.actions.find((row) => row.operation === "foreign_snapshot")!.at <=
      firstHistory,
  );
  assert.equal(
    f.reads.filter((read) => read.type === "userAbstraction").length,
    2,
  );
  assert.ok(
    snapshot.observed_at <= Math.min(...financial.map((read) => read.start)),
    "the original evidence timestamp cannot be moved to the end of the frame",
  );
  assert.deepEqual(
    f.actions.map((row) => row.operation),
    ["perps_account", "foreign_snapshot"],
  );
});

for (const changedMode of ["unifiedAccount", "portfolioMargin"])
  it(`rejects a Standard account that changes to ${changedMode} while financial evidence is being read`, async (t) => {
    const f = fixture(t, "disabled");
    f.changeModeDuringFinancialRead(changedMode);
    await assert.rejects(f.bridge.perpsAccount("alice", f.portfolio), {
      code: "ACCOUNT_STALE",
    });
    const modeReads = f.reads.filter((read) => read.type === "userAbstraction");
    assert.equal(modeReads.length, 2);
    assert.ok(
      modeReads[1].start >=
        Math.max(
          ...f.reads
            .filter((read) =>
              [
                "clearinghouseState",
                "frontendOpenOrders",
                "allMids",
                "meta",
              ].includes(read.type),
            )
            .map((read) => read.end),
        ),
    );
    assert.deepEqual(
      f.actions.map((row) => row.operation),
      ["perps_account"],
    );
  });

for (const failure of [
  "foreign order",
  "foreign position",
  "mode changed",
] as const)
  it(`keeps ${failure} rejection after early complete history has been read`, async (t) => {
    const f = fixture(t);
    f.fail(failure);
    await assert.rejects(f.bridge.perpsAccount("alice", f.portfolio), {
      code: failure === "mode changed" ? "ACCOUNT_STALE" : "ACCOUNT_NOT_READY",
    });
    assert.ok(
      historyTypes.every((type) => f.reads.some((read) => read.type === type)),
    );
    assert.ok(
      !f.actions.some((row) => /bind|configure|submit/.test(row.operation)),
    );
  });

it("retains incomplete-history coverage instead of upgrading it to a complete account", async (t) => {
  const f = fixture(t);
  f.incompleteHistory();
  const snapshot = await f.bridge.perpsAccount("alice", f.portfolio);
  assert.equal(snapshot.coverage_complete, false);
  assert.equal(snapshot.funding.length, 0);
  assert.ok(f.actions.some((row) => row.operation === "foreign_snapshot"));
  assert.equal(
    f.reads.filter((read) => read.type === "userAbstraction").length,
    2,
  );
});

for (const path of ["standard", "RWA", "bind", "unbound", "no ledger"] as const)
  it(`preserves the existing late-history boundary for ${path}`, async (t) => {
    const f = fixture(
      t,
      ["standard", "RWA"].includes(path) ? "disabled" : "unifiedAccount",
    );
    if (path === "RWA")
      f.portfolio.sleeves = [
        { trader: { market: "perps", assets: ["xyz:TSLA"] } },
      ] as any;
    if (path === "unbound") {
      f.portfolio.account_id = null;
      f.portfolio.venue_accounts = undefined;
    }
    if (path === "no ledger") f.portfolio.ledger_started_at = null;
    await f.bridge.perpsAccount("alice", f.portfolio, path === "bind");
    const histories = f.reads.filter((read) =>
      historyTypes.includes(read.type),
    );
    if (path === "no ledger") {
      assert.equal(histories.length, 0);
      return;
    }
    assert.ok(histories.length >= 3);
    const firstHistory = Math.min(...histories.map((read) => read.start));
    assert.ok(
      f.reads
        .filter((read) => !historyTypes.includes(read.type))
        .every((read) => read.end <= firstHistory),
      "state, native orders, rules and original guards must precede the old late history path",
    );
    if (path === "bind")
      assert.ok(
        f.actions.find((row) => row.operation === "perps_bind")!.at <=
          firstHistory,
      );
  });
