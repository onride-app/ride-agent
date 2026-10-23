import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentService } from "./service.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import { traderRow } from "./discovery.js";

function fixture(count = 8) {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = Array.from({ length: count }, (_, i) => candidate(i + 1));
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  const call = async (
    name: "recommend_traders" | "recalculate_plan" | "browse_traders",
    args = {},
  ) => (await api.tool("fixture_comparison", name, args)).data as any;
  return { repo, adapter, call };
}
const ids = (rows: any[]) => rows.map((r) => r.trader_id);
function assertAligned(d: any) {
  const expected = d.plan.allocations.map((a: any) => a.trader.id);
  assert.deepEqual(ids(d.recommended_portfolio), expected);
  assert.deepEqual(ids(d.recommended_trader_comparison), expected);
  assert.deepEqual(ids(d.final_review.traders), expected);
  assert.deepEqual(ids(d.compatibility.capital_weights), expected);
  assert(
    d.compatibility.pairs.every((pair: any) =>
      pair.traders.every((id: string) => expected.includes(id)),
    ),
  );
  assert.deepEqual(
    d.recommended_trader_comparison,
    d.plan.allocations.map((a: any) => traderRow(a.trader)),
  );
  assert.equal(d.recommended_comparison_meta.plan_id, d.plan.id);
  assert.equal(d.final_review.execution_authorized, false);
}

it("compares all four recommended traders when diversity selects a trader outside the top-five candidate ranking", async () => {
  const { call, adapter } = fixture(6);
  adapter.pool = adapter.pool.map((c, i) => ({
    ...c,
    score: i < 4 ? 84.99 : 81.25,
    style:
      i === 2
        ? "altcoin_long"
        : i === 4
          ? "altcoin_short"
          : i === 5
            ? "zec_neutral"
            : "btc_eth_long",
    assets: i === 2 || i === 4 ? ["SOL"] : i === 5 ? ["ZEC"] : ["BTC", "ETH"],
    direction: i === 4 ? "short" : i === 5 ? "mixed" : "long",
  }));
  const d = await call("recommend_traders", {
    preferences: {
      budget_usdc: "30",
      risk_tolerance: "medium",
      market: "perps",
    },
  });
  assertAligned(d);
  assert.equal(d.recommended_portfolio.length, 4);
  assert(
    d.recommended_portfolio.some(
      (r: any) => r.trader_id === adapter.pool[5].id,
    ),
  );
  assert(
    !d.candidate_table.some((r: any) => r.trader_id === adapter.pool[5].id),
  );
  assert.equal(d.candidate_table.length, 5);
  assert.equal(d.candidate_page.returned, 5);
  assert(
    d.recommended_portfolio.every((r: any) => r.amount_usdc === "7.500000"),
  );
  assert.equal(adapter.submitCount, 0);
});

it("preserves exact comparison membership/order for eight manually selected traders and after recalculation", async () => {
  const { call, adapter } = fixture(10);
  const selected = [9, 1, 8, 3, 6, 2, 7, 0].map((i) => adapter.pool[i].id);
  const first = await call("recommend_traders", {
    preferences: {
      budget_usdc: "80",
      risk_tolerance: "medium",
      market: "perps",
    },
    trader_ids: selected,
  });
  assertAligned(first);
  assert.equal(first.recommended_trader_comparison.length, 8);
  assert.equal(first.candidate_table.length, 5);
  const edited = await call("recalculate_plan", {
    plan_id: first.plan.id,
    allocations: [...first.plan.allocations]
      .reverse()
      .map((a: any) => ({ trader_id: a.trader.id, amount_usdc: "9" })),
  });
  assertAligned(edited);
  assert.notEqual(edited.plan.id, first.plan.id);
  assert.equal(edited.recommended_trader_comparison.length, 8);
  const before = structuredClone(edited.plan);
  const browse = await call("browse_traders", { sort_by: "roi", limit: 5 });
  assert.equal(browse.saved_plan_id, before.id);
  assert.equal(browse.plan_unchanged, true);
  assert.equal(browse.recommended_trader_comparison, undefined);
  assert.equal(adapter.submitCount, 0);
});

it("keeps missing historical values and actual periods instead of relabelling them as monthly data", async () => {
  const { call, adapter } = fixture(1);
  adapter.pool[0] = {
    ...adapter.pool[0],
    source_roi_pct: null,
    metric_periods: {
      roi: {
        period: "source_all_time",
        start_at: null,
        end_at: null,
        basis: "source history",
      },
      drawdown: {
        period: "unavailable",
        start_at: null,
        end_at: null,
        basis: "unknown",
      },
    },
  };
  const d = await call("recommend_traders", {
    preferences: { budget_usdc: "30", risk_tolerance: "medium" },
  });
  assertAligned(d);
  assert.equal(d.recommended_trader_comparison.length, 1);
  const row = d.recommended_trader_comparison[0];
  assert.equal(row.historical_roi_pct, null);
  assert.equal(row.historical_drawdown_pct, 2);
  assert.equal(row.metric_window, null);
  assert.equal(row.metric_periods.roi.period, "source_all_time");
});

it("leaves the recommended comparison empty on plan failure while retaining the candidate ranking", async () => {
  const { call, adapter } = fixture(8);
  adapter.pool = adapter.pool.map((c) => ({
    ...c,
    market: "prediction",
    venue_max_leverage: 1,
  }));
  const d = await call("recommend_traders", {
    preferences: {
      budget_usdc: "30",
      risk_tolerance: "medium",
      market: "prediction",
      basket_size: 4,
    },
  });
  assert.equal(d.plan, null);
  assert.deepEqual(d.recommended_trader_comparison, []);
  assert.equal(d.recommended_comparison_meta.plan_id, null);
  assert.equal(d.candidate_table.length, 5);
  assert.equal(d.candidates.length, 8);
  assert.equal(adapter.submitCount, 0);
});
