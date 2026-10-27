import { it } from "node:test";
import assert from "node:assert/strict";
import {
  isPlanReadEvidence,
  readSelectedPlanEvidence,
  type PlanEvidenceReader,
} from "./read-evidence.js";
import { BridgeAdapter } from "./adapter.js";
import { CoreBridge } from "./core_bridge.js";
import { candidate } from "./fixtures.js";

const selected = (id = 1) => ({ ...candidate(id), assets: ["BTC"] });
function fixture(
  options: {
    mode?: string;
    time?: number;
    leverage?: number | null;
    dex?: boolean;
    hold?: string;
  } = {},
) {
  const calls: { type: string; user?: string }[] = [];
  const resolves: string[] = [];
  const state = {
    time: options.time ?? Date.now(),
    marginSummary: {
      accountValue: options.mode === "unifiedAccount" ? "4" : "10000",
    },
    assetPositions: [
      {
        position: {
          coin: "BTC",
          szi: "0.25",
          positionValue: "10000",
          entryPx: "39000",
          leverage:
            options.leverage === null ? {} : { value: options.leverage ?? 5 },
        },
      },
    ],
  };
  const reader: PlanEvidenceReader = {
    resolveTrader: async (id) => {
      resolves.push(id);
      return { address: id };
    },
    info: async (payload) => {
      calls.push(payload as { type: string; user?: string });
      switch (payload.type) {
        case "meta":
          return {
            universe: [{ name: "BTC", maxLeverage: 20, szDecimals: 5 }],
          };
        case "allMids":
          return { BTC: "42000", ETH: "2000" };
        case "userAbstraction":
          return options.mode ?? "disabled";
        case "userDexAbstraction":
          return options.dex ?? false;
        case "clearinghouseState":
          return structuredClone(state);
        case "spotClearinghouseState":
          return {
            balances: [
              {
                coin: "USDC",
                token: 0,
                total: "37.5",
                hold: options.hold ?? "2",
              },
            ],
          };
        default:
          assert.fail("Forbidden or unexpected read " + payload.type);
      }
    },
  };
  return { reader, calls, resolves, state };
}

it("reads only selected Standard public accounts and separates actual venue rules from legacy planning limits", async () => {
  const f = fixture();
  const trader = selected();
  const before = structuredClone(trader);
  const result = await readSelectedPlanEvidence([trader], f.reader);
  assert.deepEqual(trader, before);
  assert.deepEqual(f.resolves, [trader.id]);
  const source = result.sources[0];
  assert.equal(source.status, "available");
  assert.equal(source.equity_verified, true);
  assert.equal(source.equity_basis, "standard_clearinghouse_account_value");
  assert.equal(source.timestamp_basis, "exchange_time");
  assert.equal(source.snapshot?.account_value_usdc, "10000");
  assert.equal(source.snapshot?.complete, true);
  const position = source.snapshot!.positions[0];
  assert.equal(position.quantity, "0.25");
  assert.equal(position.mark_price, "42000");
  assert.equal(position.position_notional_usdc, "10500");
  assert.equal(position.source_leverage, 5);
  assert.equal(position.source_leverage_verified, true);
  assert.equal(result.market.max_leverages["perps:BTC"], 20);
  assert.equal(result.market.product_planning_max_leverage, 40);
  assert.equal(
    result.market.legacy_candidate_venue_max_leverage_basis,
    "product_planning_envelope",
  );
  assert.equal(
    result.market.prices["perps:ETH"],
    undefined,
    "unselected asset metadata must not leak into the view",
  );
  assert.equal(result.read_only, true);
  assert.equal(result.execution_authorized, false);
  assert(
    f.calls.every((x) => !/bind|submit|register|preflight|fund/i.test(x.type)),
  );
});

it("verifies Unified USDC independently without double counting and discloses missing other-DEX coverage", async () => {
  const f = fixture({ mode: "unifiedAccount" });
  const result = await readSelectedPlanEvidence([selected()], f.reader);
  const source = result.sources[0];
  assert.equal(source.account_mode, "unified");
  assert.equal(source.equity_basis, "unified_spot_usdc_total");
  assert.equal(source.snapshot?.account_value_usdc, "37.500000");
  assert.equal(source.equity_verified, true);
  assert.equal(source.scope, "base_perps");
  assert.equal(source.coverage_complete, false);
  assert.equal(source.snapshot?.complete, false);
  assert.equal(source.status, "partial");
  assert.equal(source.reason_code, "UNIFIED_DEX_COVERAGE_UNVERIFIED");
  assert.equal(
    f.calls.filter((c) => c.type === "spotClearinghouseState").length,
    1,
  );
  assert.equal(
    f.calls.some((c) => c.type === "perpDexs"),
    false,
    "do not sweep every venue DEX",
  );
});

it("fails unknown modes, unverified Standard abstraction and invalid Unified balances closed", async () => {
  for (const options of [
    { mode: "portfolioMargin" },
    { dex: true },
    { mode: "unifiedAccount", hold: "1000" },
  ]) {
    const f = fixture(options);
    const result = await readSelectedPlanEvidence([selected()], f.reader);
    assert.notEqual(result.sources[0].status, "available");
    assert.equal(result.sources[0].snapshot, null);
    assert.equal(result.sources[0].equity_verified, false);
  }
});

it("keeps stale timestamps and missing actual source leverage distinguishable from verified data", async () => {
  const stale = await readSelectedPlanEvidence(
    [selected()],
    fixture({ time: Date.now() - 60_000 }).reader,
  );
  assert.equal(stale.sources[0].reason_code, "SOURCE_STALE");
  assert.equal(stale.sources[0].snapshot, null);
  const missing = await readSelectedPlanEvidence(
    [selected()],
    fixture({ leverage: null }).reader,
  );
  assert.equal(missing.sources[0].status, "partial");
  assert.equal(
    missing.sources[0].snapshot?.positions[0].source_leverage_verified,
    false,
  );
  assert.equal(missing.sources[0].snapshot?.complete, false);
});

it("does not invent a current mark when only a venue position value is available", async () => {
  const f = fixture();
  const info = f.reader.info;
  f.reader.info = async (payload) =>
    payload.type === "allMids" ? {} : info(payload);
  const result = await readSelectedPlanEvidence([selected()], f.reader);
  assert.equal(result.market.coverage_complete, false);
  assert.equal(result.market.prices["perps:BTC"], undefined);
  const source = result.sources[0];
  assert.equal(source.status, "partial");
  assert.equal(source.snapshot?.positions[0].mark_price, null);
  assert.equal(source.snapshot?.positions[0].position_notional_usdc, "10000");
  assert.equal(
    source.snapshot?.positions[0].position_notional_basis,
    "venue_position_value",
  );
});

it("uses observed source assets instead of a stale candidate asset list", async () => {
  const trader = { ...selected(), assets: ["UNLISTED"] };
  const result = await readSelectedPlanEvidence([trader], fixture().reader);
  assert.equal(result.market.coverage_complete, true);
  assert.deepEqual(Object.keys(result.market.prices), ["perps:BTC"]);
  assert.equal(result.sources[0].snapshot?.positions[0].asset, "BTC");
});

it("retains one successful selected source when another read fails and does not query unselected profiles", async () => {
  const f = fixture();
  const first = selected(1),
    second = selected(2);
  const info = f.reader.info;
  f.reader.info = async (payload) => {
    if (payload.user === second.id) throw Error("source unavailable");
    return info(payload);
  };
  const result = await readSelectedPlanEvidence([first, second], f.reader);
  assert.equal(result.sources[0].status, "available");
  assert.equal(result.sources[1].status, "unavailable");
  assert.deepEqual(f.resolves.sort(), [first.id, second.id]);
});

it("bounds reads and supports cancellation without launching further source requests", async () => {
  let calls = 0;
  const reader: PlanEvidenceReader = {
    resolveTrader: async (id) => ({ address: id }),
    info: async () => {
      calls++;
      return new Promise(() => {});
    },
  };
  const result = await readSelectedPlanEvidence(
    [selected(1), selected(2), selected(3)],
    reader,
    { timeout_ms: 15 },
  );
  assert(
    result.sources.every(
      (s) =>
        s.status === "unavailable" && s.reason_code === "EVIDENCE_READ_TIMEOUT",
    ),
  );
  assert(
    calls <= 4,
    "only two metadata reads and two bounded source workers may start",
  );
  const controller = new AbortController();
  controller.abort();
  const before = calls;
  const cancelled = await readSelectedPlanEvidence([selected()], reader, {
    signal: controller.signal,
  });
  assert.equal(cancelled.sources[0].reason_code, "EVIDENCE_READ_ABORTED");
  assert.equal(calls, before);
  const frozen = await readSelectedPlanEvidence(
    [selected(1), selected(2), selected(3)],
    reader,
    { timeout_ms: 5, clock: () => 1234 },
  );
  assert(
    frozen.sources.every(
      (source) => source.reason_code === "EVIDENCE_READ_TIMEOUT",
    ),
  );
  const inFlight = new AbortController();
  const aborting: PlanEvidenceReader = {
    resolveTrader: reader.resolveTrader,
    info: async () => {
      inFlight.abort();
      return new Promise(() => {});
    },
  };
  const stopped = await readSelectedPlanEvidence([selected()], aborting, {
    signal: inFlight.signal,
  });
  assert.equal(stopped.sources[0].reason_code, "EVIDENCE_READ_ABORTED");
});

it("validates duplicate requests and leaves Prediction and unsupported scoped assets unread", async () => {
  const f = fixture();
  await assert.rejects(
    readSelectedPlanEvidence([selected(), selected()], f.reader),
    /unique selected traders/,
  );
  assert.equal(f.calls.length, 0);
  const prediction = { ...selected(), market: "prediction" as const };
  const result = await readSelectedPlanEvidence([prediction], f.reader);
  assert.equal(result.sources[0].status, "unsupported");
  assert.equal(f.calls.length, 0);
  assert.equal(f.resolves.length, 0);
});

it("does not mislabel a scoped RWA trader as a complete empty base account", async () => {
  const f = fixture();
  f.reader.resolveTrader = async () => ({
    address: "scoped-trader",
    tags: ["category:stocks_rwa"],
  });
  const result = await readSelectedPlanEvidence([selected()], f.reader);
  assert.equal(result.sources[0].status, "unsupported");
  assert.equal(result.sources[0].snapshot, null);
  assert.equal(result.sources[0].reason_code, "SOURCE_SCOPE_UNSUPPORTED");
  assert(f.calls.every((call) => ["meta", "allMids"].includes(call.type)));
});

it("forwards only the read_plan_evidence operation across BridgeAdapter", async () => {
  const trader = selected();
  const evidence = await readSelectedPlanEvidence([trader], fixture().reader);
  const previous = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(evidence), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const bridge = new BridgeAdapter("https://bridge.test", "fixture");
    assert.deepEqual(await bridge.readPlanEvidence([trader]), evidence);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://bridge.test/internal/agent/read_plan_evidence",
    );
    assert.deepEqual(calls[0].body, { traders: [trader] });
  } finally {
    globalThis.fetch = previous;
  }
});

it("rejects malformed or mismatched evidence at the BridgeAdapter read boundary", async () => {
  const trader = selected();
  const evidence = await readSelectedPlanEvidence([trader], fixture().reader);
  const previous = globalThis.fetch;
  let body: unknown = { ...evidence, execution_authorized: true };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const bridge = new BridgeAdapter("https://bridge.test", "fixture");
    await assert.rejects(
      bridge.readPlanEvidence([trader]),
      (e: any) => e.code === "EXECUTOR_RESPONSE_INVALID",
    );
    body = {
      ...evidence,
      sources: [{ ...evidence.sources[0], trader_id: selected(2).id }],
    };
    await assert.rejects(
      bridge.readPlanEvidence([trader]),
      (e: any) => e.code === "EXECUTOR_RESPONSE_INVALID",
    );
    body = {
      ...evidence,
      sources: [
        { ...evidence.sources[0], status: "available", snapshot: null },
      ],
    };
    await assert.rejects(
      bridge.readPlanEvidence([trader]),
      (e: any) => e.code === "EXECUTOR_RESPONSE_INVALID",
    );
  } finally {
    globalThis.fetch = previous;
  }
});

it("fails contradictory account mode, equity basis, timestamp and coverage claims closed at the bridge boundary", async () => {
  const trader = selected();
  const standard = await readSelectedPlanEvidence([trader], fixture().reader);
  const unified = await readSelectedPlanEvidence(
    [trader],
    fixture({ mode: "unifiedAccount" }).reader,
  );
  assert.equal(isPlanReadEvidence(standard), true);
  assert.equal(isPlanReadEvidence(unified), true);
  const unavailableUnified = await readSelectedPlanEvidence(
    [trader],
    fixture({ mode: "unifiedAccount", hold: "1000" }).reader,
  );
  assert.equal(
    isPlanReadEvidence(unavailableUnified),
    true,
    "an unavailable Unified read contains no verified equity or snapshot",
  );
  const s = standard.sources[0];
  const u = unified.sources[0];
  const contradictions = [
    { ...s, account_mode: "unified", equity_basis: "unified_spot_usdc_total" },
    { ...s, account_mode: "unknown" },
    { ...s, account_mode: "unsupported" },
    { ...s, equity_basis: "unified_spot_usdc_total" },
    { ...s, timestamp_basis: null },
    { ...s, coverage_complete: false },
    { ...s, snapshot: { ...s.snapshot, complete: false } },
    { ...u, status: "available" },
    { ...u, snapshot: { ...u.snapshot, complete: true } },
    { ...u, coverage_complete: true },
    { ...u, equity_basis: "standard_clearinghouse_account_value" },
    { ...u, account_mode: "standard" },
    { ...u, equity_verified: false },
    { ...u, timestamp_basis: null },
    { ...u, status: "unavailable" },
  ];
  const previous = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const bridge = new BridgeAdapter("https://bridge.test", "fixture");
    for (const source of contradictions) {
      body = { ...standard, sources: [source] };
      assert.equal(isPlanReadEvidence(body), false, JSON.stringify(source));
      await assert.rejects(
        bridge.readPlanEvidence([trader]),
        (error: any) => error.code === "EXECUTOR_RESPONSE_INVALID",
      );
    }
  } finally {
    globalThis.fetch = previous;
  }
});

it("rejects duplicate, out-of-scope and incomplete positions at the evidence bridge boundary", async () => {
  const trader = selected();
  const standard = await readSelectedPlanEvidence([trader], fixture().reader);
  const source = standard.sources[0];
  const position = source.snapshot!.positions[0];
  const partial = await readSelectedPlanEvidence(
    [trader],
    fixture({ leverage: null }).reader,
  );
  const partialPosition = partial.sources[0].snapshot!.positions[0];
  partialPosition.mark_price = null;
  partialPosition.position_notional_usdc = null;
  assert.equal(
    isPlanReadEvidence(partial),
    true,
    "partial evidence may retain missing marks and unverified leverage",
  );
  const zeroNotional = structuredClone(standard);
  zeroNotional.sources[0].snapshot!.positions[0].position_notional_usdc = "0";
  assert.equal(isPlanReadEvidence(zeroNotional), true);
  const invalidPositions: { name: string; positions: unknown[] }[] = [
    { name: "duplicate key", positions: [position, { ...position }] },
    ...[
      ["DEX-scoped asset", { asset: "xyz:TSLA", key: "perps:xyz:TSLA" }],
      ["empty base symbol", { asset: "", key: "perps:" }],
      ["invalid base symbol", { asset: "BTC/USDC", key: "perps:BTC/USDC" }],
      ["mismatched key", { key: "perps:ETH" }],
      ["negative timestamp", { observed_at: -1 }],
      ["fractional timestamp", { observed_at: 0.5 }],
      ["nonfinite timestamp", { observed_at: Infinity }],
      ["missing timestamp", { observed_at: undefined }],
      ["invalid source revision", { source_revision: 1 }],
      ["unverified leverage", { source_leverage_verified: false }],
      ["fractional leverage", { source_leverage: 1.5 }],
      ["zero leverage", { source_leverage: 0 }],
      ["negative leverage", { source_leverage: -1 }],
      ["nonfinite leverage", { source_leverage: Infinity }],
      ["missing mark", { mark_price: null }],
      ["zero mark", { mark_price: "0" }],
      ["negative mark", { mark_price: "-1" }],
      ["nonfinite mark", { mark_price: "Infinity" }],
      ["nonfinite quantity", { quantity: "Infinity" }],
      ["invalid quantity", { quantity: "NaN" }],
      ["missing notional", { position_notional_usdc: null }],
      ["negative notional", { position_notional_usdc: "-1" }],
      ["nonfinite notional", { position_notional_usdc: "Infinity" }],
    ].map(([name, overrides]) => ({
      name: name as string,
      positions: [{ ...position, ...(overrides as Record<string, unknown>) }],
    })),
  ];
  const previous = globalThis.fetch;
  let body: unknown;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const bridge = new BridgeAdapter("https://bridge.test", "fixture");
    for (const invalid of invalidPositions) {
      body = {
        ...standard,
        sources: [
          {
            ...source,
            snapshot: { ...source.snapshot, positions: invalid.positions },
          },
        ],
      };
      assert.equal(isPlanReadEvidence(body), false, invalid.name);
      await assert.rejects(
        bridge.readPlanEvidence([trader]),
        (error: any) => error.code === "EXECUTOR_RESPONSE_INVALID",
        invalid.name,
      );
    }
    const negativePartial = structuredClone(partial);
    negativePartial.sources[0].snapshot!.positions[0].position_notional_usdc =
      "-1";
    assert.equal(isPlanReadEvidence(negativePartial), false);
  } finally {
    globalThis.fetch = previous;
  }
});

it("CoreBridge read evidence has no account/write path and does not change legacy source equity semantics", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any;
  const f = fixture({ mode: "unifiedAccount" });
  const originalState = f.state;
  stub.resolve = async () => ({ address: "source" });
  stub.info = async (input: any, publicSource: boolean) => {
    assert.equal(publicSource, true);
    return f.reader.info(input);
  };
  for (const operation of [
    "account",
    "perpsAccount",
    "activationCheck",
    "submit",
    "execution",
    "control",
    "core",
    "profile",
    "candidates",
  ])
    stub[operation] = async () =>
      assert.fail("Forbidden operation " + operation);
  stub.pool.query = async () =>
    assert.fail("Evidence must not read or write account SQL");
  try {
    const legacyBefore = await stub.readSource(selected().id);
    const evidence = (await bridge.operation("read_plan_evidence", {
      traders: [selected()],
    })) as any;
    const legacyAfter = await stub.readSource(selected().id);
    assert.equal(
      legacyBefore.account_value_usdc,
      originalState.marginSummary.accountValue,
    );
    assert.equal(
      legacyAfter.account_value_usdc,
      originalState.marginSummary.accountValue,
    );
    assert.equal(evidence.sources[0].snapshot.account_value_usdc, "37.500000");
    assert.deepEqual(
      legacyBefore.positions.map((p: any) => [
        p.quantity,
        p.price,
        p.source_leverage,
      ]),
      legacyAfter.positions.map((p: any) => [
        p.quantity,
        p.price,
        p.source_leverage,
      ]),
    );
  } finally {
    await bridge.close();
  }
});
