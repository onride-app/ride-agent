import { it } from "node:test";
import assert from "node:assert/strict";
import { sourceEvidenceView } from "./source-evidence-view.js";
import type { PlanReadEvidence } from "./read-evidence.js";

const observedAt = 1_000_000;

function evidence(): PlanReadEvidence {
  return {
    observed_at: observedAt,
    read_only: true,
    execution_authorized: false,
    sources: [
      {
        trader_id: "trader_000000000001",
        status: "available",
        account_mode: "standard",
        equity_basis: "standard_clearinghouse_account_value",
        equity_verified: true,
        scope: "base_perps",
        coverage_complete: true,
        timestamp_basis: "exchange_time",
        snapshot: {
          observed_at: observedAt,
          revision: "source_revision",
          complete: true,
          account_value_usdc: "100",
          positions: [
            {
              market: "perps",
              asset: "BTC",
              key: "perps:BTC",
              quantity: "1",
              price: "200",
              mark_price: "200",
              position_notional_usdc: "200",
              position_notional_basis: "current_mark",
              source_leverage: 8,
              source_leverage_verified: true,
              source_entry_price: "190",
              observed_at: observedAt,
              source_revision: "source_revision",
            },
            {
              market: "perps",
              asset: "ETH",
              key: "perps:ETH",
              quantity: "-2",
              price: "25",
              mark_price: "25",
              position_notional_usdc: "50",
              position_notional_basis: "current_mark",
              source_leverage: 3,
              source_leverage_verified: true,
              source_entry_price: "20",
              observed_at: observedAt,
              source_revision: "source_revision",
            },
          ],
        },
      },
    ],
    market: {
      observed_at: observedAt,
      prices: { "perps:BTC": "200", "perps:ETH": "25" },
      max_leverages: { "perps:BTC": 20, "perps:ETH": 10 },
      quantity_decimals: { "perps:BTC": 5, "perps:ETH": 4 },
      min_notionals: { "perps:BTC": "10", "perps:ETH": "10" },
      coverage_complete: true,
      scope: "base_perps",
      product_planning_max_leverage: 40,
      legacy_candidate_venue_max_leverage_basis: "product_planning_envelope",
      reason_codes: [],
    },
  };
}

function assertNoRatios(input: PlanReadEvidence) {
  const result = sourceEvidenceView(input, observedAt);
  for (const source of result.sources) {
    assert.equal(source.base_perps_gross_exposure_to_equity, null);
    for (const position of source.snapshot?.positions ?? [])
      assert.equal(position.base_perps_position_notional_to_equity, null);
  }
}

it("distinguishes position leverage settings, current notional/equity and venue/planning limits", () => {
  const result = sourceEvidenceView(evidence(), observedAt);
  const source = result.sources[0];
  const [btc, eth] = source.snapshot!.positions;
  assert.equal(
    source.source_position_leverage_basis,
    "venue_position_leverage_setting",
  );
  assert.equal(
    btc.source_leverage,
    8,
    "the legacy field retains its venue setting",
  );
  assert.equal(btc.position_leverage_setting, 8);
  assert.equal(btc.base_perps_position_notional_to_equity, "2");
  assert.equal(eth.position_leverage_setting, 3);
  assert.equal(eth.base_perps_position_notional_to_equity, "0.5");
  assert.equal(
    source.base_perps_gross_exposure_to_equity,
    "2.5",
    "short notional contributes to gross exposure instead of netting",
  );
  assert.equal(result.market.product_planning_max_leverage, 40);
  assert.equal(result.market.max_leverages["perps:BTC"], 20);
  assert.match(
    result.field_semantics.source_leverage,
    /position leverage setting/,
  );
  assert.match(
    result.field_semantics.base_perps_exposure_to_equity,
    /neither historical leverage distributions nor margin-based leverage/,
  );
});

it("clones every display field without mutating evidence or sharing projection state", () => {
  const input = evidence();
  const before = structuredClone(input);
  const freeze = (value: any) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(input);
  const first = sourceEvidenceView(input, observedAt);
  const second = sourceEvidenceView(input, observedAt);
  first.sources[0].snapshot!.positions[0].source_leverage = 30;
  first.sources[0].snapshot!.positions[0].quantity = "50";
  first.market.prices["perps:BTC"] = "1";
  first.market.reason_codes.push("view_only");
  first.field_semantics.source_leverage = "view_only";
  assert.deepEqual(input, before);
  assert.equal(second.sources[0].snapshot!.positions[0].source_leverage, 8);
  assert.equal(second.sources[0].snapshot!.positions[0].quantity, "1");
  assert.equal(second.market.prices["perps:BTC"], "200");
  assert.deepEqual(second.market.reason_codes, []);
  assert.notEqual(second.field_semantics.source_leverage, "view_only");
  assert.equal(first.read_only, true);
  assert.equal(first.execution_authorized, false);
});

it("leaves ratios unavailable for partial or Unified evidence and unverified settings", () => {
  const partial = evidence();
  partial.sources[0].status = "partial";
  partial.sources[0].coverage_complete = false;
  partial.sources[0].snapshot!.complete = false;
  partial.sources[0].snapshot!.positions[0].source_leverage_verified = false;
  partial.sources[0].snapshot!.positions[0].mark_price = null;
  assertNoRatios(partial);
  assert.equal(
    sourceEvidenceView(partial, observedAt).sources[0].snapshot!.positions[0]
      .position_leverage_setting,
    null,
  );
  const unified = evidence();
  unified.sources[0].account_mode = "unified";
  unified.sources[0].equity_basis = "unified_spot_usdc_total";
  unified.sources[0].status = "partial";
  unified.sources[0].coverage_complete = false;
  unified.sources[0].snapshot!.complete = false;
  assertNoRatios(unified);
  unified.sources[0].status = "available";
  unified.sources[0].coverage_complete = true;
  unified.sources[0].snapshot!.complete = true;
  assertNoRatios(unified);
});

it("does not project stale or future observations as current exposure", () => {
  for (const at of [observedAt - 30_001, observedAt + 1]) {
    const variants = [evidence(), evidence(), evidence(), evidence()];
    variants[0].observed_at = at;
    variants[1].market.observed_at = at;
    variants[2].sources[0].snapshot!.observed_at = at;
    variants[3].sources[0].snapshot!.positions[0].observed_at = at;
    for (const input of variants) assertNoRatios(input);
  }
});

it("requires positive verified equity and finite nonnegative notionals without inventing ratios", () => {
  for (const equity of ["0", "-1", "Infinity", "NaN"]) {
    const input = evidence();
    input.sources[0].snapshot!.account_value_usdc = equity;
    assertNoRatios(input);
  }
  for (const notional of [null, "-1", "Infinity", "NaN"]) {
    const input = evidence();
    input.sources[0].snapshot!.positions[0].position_notional_usdc = notional;
    assertNoRatios(input);
  }
  const input = evidence();
  input.sources[0].equity_verified = false;
  assertNoRatios(input);
  const flat = evidence();
  flat.sources[0].snapshot!.positions = [];
  assert.equal(
    sourceEvidenceView(flat, observedAt).sources[0]
      .base_perps_gross_exposure_to_equity,
    "0",
  );
  flat.sources[0].snapshot!.account_value_usdc = "0";
  assertNoRatios(flat);
});

it("has no network path and retains unavailable sources as unavailable", () => {
  const input = evidence();
  input.sources[0] = {
    ...input.sources[0],
    status: "unavailable",
    snapshot: null,
    equity_basis: "unavailable",
    equity_verified: false,
    account_mode: "unknown",
    coverage_complete: false,
    timestamp_basis: null,
    reason_code: "SOURCE_UNAVAILABLE",
  };
  const previous = globalThis.fetch;
  globalThis.fetch = (() =>
    assert.fail(
      "Display projection must not make network requests",
    )) as typeof fetch;
  try {
    const source = sourceEvidenceView(input, observedAt).sources[0];
    assert.equal(source.snapshot, null);
    assert.equal(source.status, "unavailable");
    assert.equal(source.reason_code, "SOURCE_UNAVAILABLE");
    assert.equal(source.base_perps_gross_exposure_to_equity, null);
  } finally {
    globalThis.fetch = previous;
  }
});
