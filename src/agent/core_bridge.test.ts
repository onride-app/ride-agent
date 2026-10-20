import { it } from "node:test";
import assert from "node:assert/strict";
import { CoreBridge } from "./core_bridge.js";
import { candidate } from "./fixtures.js";
import { now } from "./domain.js";
import { BridgeAdapter } from "./adapter.js";

it("preflights real unified cash, preserves Standard and rejects shared DEX exposure", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any;
  const previous = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  const previousRwa = process.env.RIDE_AGENT_RWA_ENABLED;
  let mode = "unifiedAccount",
    hold = "6.1",
    foreignPosition = false;
  const writes: string[] = [];
  stub.core = async (op: string) => {
    if (op !== "perps_wallet") writes.push(op);
    return { master: "0x" + "a".repeat(40), status: 4 };
  };
  stub.info = async (input: any) => {
    switch (input.type) {
      case "userAbstraction":
        return mode;
      case "userDexAbstraction":
        return false;
      case "perpDexs":
        return [null, { name: "xyz" }];
      case "spotClearinghouseState":
        return {
          balances: [{ coin: "USDC", token: 0, total: "36.302807", hold }],
        };
      case "clearinghouseState":
        return {
          marginSummary: { accountValue: input.dex ? "5" : "0" },
          withdrawable: mode === "disabled" ? "7" : "0",
          assetPositions:
            input.dex && foreignPosition
              ? [{ position: { coin: "xyz:TSLA", szi: "1" } }]
              : [],
        };
      case "frontendOpenOrders":
        return [];
      case "allMids":
        return { BTC: "100" };
      case "meta":
        return {
          collateralToken: 0,
          universe: [
            {
              name: input.dex ? "TSLA" : "BTC",
              maxLeverage: 20,
              szDecimals: 3,
            },
          ],
        };
      default:
        assert.fail("Unexpected read " + input.type);
    }
  };
  try {
    delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    await assert.rejects(
      bridge.perpsAccount("alice", null),
      /account mode is not supported/,
    );
    process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
    const snapshot = await bridge.perpsAccount("alice", null);
    assert.equal(snapshot.account_value_usdc, "36.302807");
    assert.equal(snapshot.available_usdc, "30.202807");
    assert.equal(snapshot.available_by_market?.perps, "30.202807");
    hold = "40";
    await assert.rejects(
      bridge.perpsAccount("alice", null),
      /could not be verified/,
    );
    hold = "0";
    foreignPosition = true;
    await assert.rejects(
      bridge.perpsAccount("alice", null),
      /other Perps DEXs/,
    );
    foreignPosition = false;
    mode = "portfolioMargin";
    await assert.rejects(
      bridge.perpsAccount("alice", null),
      /account mode is not supported/,
    );
    mode = "disabled";
    assert.equal(
      (await bridge.perpsAccount("alice", null)).available_usdc,
      "7",
    );
    process.env.RIDE_AGENT_RWA_ENABLED = "true";
    const rwa = await bridge.perpsAccount("alice", {
      sleeves: [{ trader: { market: "perps", assets: ["xyz:TSLA"] } }],
    } as any);
    assert.equal(rwa.account_value_usdc, "5");
    assert.equal(rwa.available_usdc, "14");
    assert.deepEqual(writes, []);
  } finally {
    if (previous === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = previous;
    if (previousRwa === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = previousRwa;
    await bridge.close();
  }
});

it("isolates Prediction and Perps discovery and rejects unknown market selectors", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "testnet",
  );
  const stub = bridge as any;
  const previous = process.env.RIDE_AGENT_PREDICTION_ENABLED;
  process.env.RIDE_AGENT_PREDICTION_ENABLED = "true";
  const prediction = { ...candidate(1), market: "prediction" };
  stub.rows = async () =>
    assert.fail("Prediction discovery must not read the Perps pool");
  stub.prediction.candidates = async () => [prediction];
  try {
    assert.deepEqual(
      await bridge.operation("candidates", { market: "prediction" }),
      [prediction],
    );
    stub.rows = async () => [];
    stub.prediction.candidates = async () =>
      assert.fail("Perps discovery must not read the Prediction pool");
    assert.deepEqual(
      await bridge.operation("candidates", { market: "perps" }),
      [],
    );
    await assert.rejects(
      bridge.operation("candidates", { market: "invalid" }),
      /Unknown candidate market/,
    );
  } finally {
    if (previous === undefined)
      delete process.env.RIDE_AGENT_PREDICTION_ENABLED;
    else process.env.RIDE_AGENT_PREDICTION_ENABLED = previous;
    await bridge.close();
  }
});

it("forwards the requested market across the authenticated bridge boundary", async () => {
  const previous = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const adapter = new BridgeAdapter("http://127.0.0.1", "fixture");
    await adapter.candidates("prediction");
    await adapter.candidates("perps");
    await adapter.candidates();
    assert.deepEqual(bodies, [
      { market: "prediction" },
      { market: "perps" },
      {},
    ]);
  } finally {
    globalThis.fetch = previous;
  }
});

it("reads the real scheduler tradeMetrics timestamp and keeps missing or future activity unavailable", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "testnet",
  );
  const c = candidate(1),
    at = now() - 8 * 86400_000;
  const row: any = {
    score: c.score,
    score_version: c.score_version,
    computed_at: now(),
    expires_at: now() + 86400_000,
    eligibility: "PASS",
    tags: [],
    roi_ratio: 0.1,
    drawdown_ratio: 0.02,
    raw: "",
  };
  const stub = bridge as any;
  stub.resolve = async () => row;
  stub.source = async () => ({ positions: [] });
  stub.info = async () => [];
  try {
    for (const [timestamp, expected] of [
      [at, at],
      [null, null],
      [now() + 60000, null],
    ] as const) {
      row.raw = JSON.stringify({
        copyScoreV2_5: {
          components: c.components,
          displayTier: "B 观察",
          rawQualityScore: 91.5,
        },
        metrics: {
          allTimeRoi: 0.1,
          maxDrawdown: 0.02,
          maxDrawdownSource: "hyperdash.drawdownAllTime",
        },
        dailyRescore: { computedAt: now() },
        tradeMetrics: { status: "available", newestFillTime: timestamp },
      });
      row.score = 84.99;
      const profile = await bridge.profile(c.id);
      assert.equal(profile.last_trade_at, expected);
      assert.equal(profile.score_explanation?.display_cap, 84.99);
      assert.equal(profile.score_explanation?.raw_quality_score, 91.5);
      assert.equal(profile.score_explanation?.cap_applied, true);
      assert.equal(profile.metric_periods?.roi.period, "source_all_time");
      assert.equal(profile.metric_periods?.drawdown.period, "source_all_time");
      assert.equal(profile.metric_periods?.roi.start_at, null);
    }
    row.raw = JSON.stringify({
      tradeMetrics: { status: "unavailable", newestFillTime: at },
    });
    const unknown = await bridge.profile(c.id);
    assert.equal(unknown.last_trade_at, null);
    assert.equal(unknown.metric_periods?.roi.period, "unavailable");
    assert.equal(unknown.score_explanation?.cap_applied, null);
  } finally {
    await bridge.close();
  }
});
it("uses mainnet source fills even for testnet followers and strips upstream identities", async () => {
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "testnet",
    ),
    stub = bridge as any;
  const at = now() - 1000,
    address = "0x" + "a".repeat(40);
  let sourceNetwork = false;
  stub.resolve = async () => ({ address });
  stub.info = async (_payload: any, source: boolean) => {
    sourceNetwork = source;
    return [
      {
        tid: 1,
        oid: 2,
        time: at,
        coin: "BTC",
        sz: "1",
        side: "B",
        px: "100",
        fee: "0.1",
        feeToken: "USDC",
        closedPnl: "2",
        wallet: address,
      },
    ];
  };
  try {
    const result = (await bridge.operation("source_fills", {
      trader_id: candidate(1).id,
      market: "perps",
      start_at: at - 1,
      end_at: at + 1,
    })) as any;
    assert.equal(sourceNetwork, true);
    assert.equal(result.complete, true);
    assert.equal(result.fills[0].realized_usdc, "2");
    assert(!JSON.stringify(result).includes(address));
    const prediction = (await bridge.operation("source_fills", {
      trader_id: "prediction_test",
      market: "prediction",
      start_at: at - 1,
      end_at: at + 1,
    })) as any;
    assert.equal(prediction.complete, false);
    stub.core = async () => [];
    await assert.rejects(
      bridge.notify("alice", {
        id: "update_test",
        kind: "daily_digest",
        message: "test",
        portfolio_id: null,
      }),
      /No Ride App device/,
    );
  } finally {
    await bridge.close();
  }
});
