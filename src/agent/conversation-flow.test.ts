import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentService } from "./service.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import { compatibility } from "./conversational.js";
import { now } from "./domain.js";
function env(count = 24) {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = Array.from({ length: count }, (_, i) => ({
    ...candidate(i + 1),
    source_drawdown_pct: i % 2 ? 1 : 2,
    source_roi_pct: i + 1,
  }));
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  const call = async (name: any, args = {}, user = "alice") =>
    (await api.tool(user, name, args)).data as any;
  return { repo, adapter, api, call };
}
it("keeps score caps, unknown historical bounds and last trade evidence in native recommendation and browse rows", async () => {
  const { adapter, call } = env(2);
  adapter.pool = adapter.pool.map((c) => ({
    ...c,
    score: 84.99,
    score_explanation: {
      tier: "B 观察",
      raw_quality_score: 91,
      display_cap: 84.99,
      cap_applied: true,
      note: "Tier cap",
    },
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
        basis: "unknown source period",
      },
    },
  }));
  const recommended = await call("recommend_traders", {
    preferences: {
      budget_usdc: "20",
      loss_trigger_pct: 10,
      market: "perps",
      basket_size: 2,
      portfolio_kind: "basket",
    },
  });
  const browsed = await call("browse_traders", {});
  for (const rows of [recommended.candidate_table, browsed.candidate_table]) {
    assert.deepEqual(
      rows.map((r: any) => r.trader_id),
      adapter.pool.map((c) => c.id),
    );
    assert.ok(
      rows.every(
        (r: any) => r.score_explanation.cap_applied && r.last_trade_at != null,
      ),
    );
    assert.ok(
      rows.every(
        (r: any) =>
          r.metric_periods.roi.start_at === null &&
          r.metric_periods.drawdown.period === "unavailable",
      ),
    );
  }
  assert.equal(browsed.candidates_meta.period_comparable, false);
  assert.match(browsed.candidates_meta.score_tie_note, /tier caps/);
});
it("requests only the chosen market when refreshing recommendation candidates", async () => {
  const { adapter, call } = env(2);
  adapter.pool = adapter.pool.map((c) => ({
    ...c,
    market: "prediction",
    venue_max_leverage: 1,
    assets: ["SPORTS"],
  }));
  const requested: unknown[] = [];
  const original = adapter.candidates.bind(adapter);
  adapter.candidates = async (market?: "perps" | "prediction" | "both") => {
    requested.push(market);
    return original();
  };
  const d = await call("recommend_traders", {
    preferences: {
      market: "prediction",
      budget_usdc: "100",
      loss_trigger_pct: 20,
      portfolio_kind: "basket",
      basket_size: 2,
    },
  });
  assert.deepEqual(requested, ["prediction"]);
  assert.equal(d.plan.allocations.length, 2);
});
it("asks only budget and risk, preserves partial answers in either order and never reads candidates early", async () => {
  const { api, call, adapter } = env();
  let reads = 0;
  const original = adapter.candidates.bind(adapter);
  adapter.candidates = async () => {
    reads++;
    return original();
  };
  assert.deepEqual(
    (await call("recommend_traders")).preference_collection.missing_fields,
    ["budget_usdc", "risk_tolerance"],
  );
  await call("set_preferences", { budget_usdc: "200" });
  assert.deepEqual(
    (await call("get_preferences")).preference_collection.missing_fields,
    ["risk_tolerance"],
  );
  assert.equal(reads, 0);
  await call("set_preferences", { risk_tolerance: "medium" });
  const c = (await call("get_preferences")).preference_collection;
  assert.equal(c.ready, true);
  assert.equal(c.answers.market, "both");
  assert.equal(c.answers.asset_category, "any");
  assert.deepEqual(c.answers.assets, []);
  assert.equal(c.sources.loss_trigger_pct, "recommended");
  assert.equal(c.suggestions.requires_final_confirmation, true);
  assert.equal(c.sources.budget_usdc, "user");
  await call("set_preferences", { risk_tolerance: "low" }, "bob");
  assert.deepEqual(
    (await call("get_preferences", {}, "bob")).preference_collection
      .missing_fields,
    ["budget_usdc"],
  );
  assert.equal(
    (await api.tool("other", "get_preferences", {})).status,
    "requires_preferences",
  );
});
it("recommended risk changes with risk label, while explicit numbers and assets/market survive edits", async () => {
  const { call } = env();
  await call("set_preferences", { budget_usdc: "200", risk_tolerance: "low" });
  assert.equal(
    (await call("get_preferences")).preference_collection.answers
      .loss_trigger_pct,
    10,
  );
  await call("set_preferences", { risk_tolerance: "high" });
  assert.equal(
    (await call("get_preferences")).preference_collection.answers
      .loss_trigger_pct,
    30,
  );
  await call("set_preferences", {
    loss_trigger_pct: 17,
    market: "perps",
    assets: ["BTC"],
    allow_altcoins: false,
  });
  await call("set_preferences", { risk_tolerance: "medium" });
  const c = (await call("get_preferences")).preference_collection;
  assert.equal(c.answers.loss_trigger_pct, 17);
  assert.equal(c.sources.loss_trigger_pct, "user");
  assert.equal(c.suggestions, null);
  assert.deepEqual(c.answers.assets, ["BTC"]);
  assert.equal(c.answers.market, "perps");
});
for (const [budget, count, expected] of [
  [20, 1, 1],
  [20, 11, 4],
  [50, 1, 1],
  [100, 2, 2],
  [150, 3, 3],
  [200, 11, 4],
])
  it(`automatically recommends ${expected} from ${count} candidates for ${budget} USDC without asking a count`, async () => {
    const { call, adapter } = env(count);
    const d = await call("recommend_traders", {
      preferences: { budget_usdc: String(budget), risk_tolerance: "medium" },
    });
    assert.equal(d.plan.allocations.length, expected);
    assert.equal(d.presentation, "native_conversation");
    assert.equal(d.recommended_portfolio.length, expected);
    assert.equal(d.candidate_table.length, Math.min(count, 5));
    assert.equal(d.final_review.funds_verified, false);
    assert.equal(d.final_review.execution_authorized, false);
    assert.equal(d.plan.preference_sources.loss_trigger_pct, "recommended");
    assert.equal(adapter.submitCount, 0);
  });
it("pages without duplicates and sorts the full snapshot, compares data/periods without replacing edited allocations", async () => {
  const { call, adapter, repo } = env();
  const first = await call("recommend_traders", {
    preferences: { budget_usdc: "200", risk_tolerance: "medium" },
    trader_ids: adapter.pool.slice(0, 2).map((c) => c.id),
  });
  const edited = await call("recalculate_plan", {
    plan_id: first.plan.id,
    allocations: first.plan.allocations.map((a: any) => ({
      trader_id: a.trader.id,
      amount_usdc: "90",
      leverage_cap: 3,
      stop_loss_pct: 25,
    })),
  });
  const page = await call("browse_traders", { limit: 10 });
  const second = await call("browse_traders", {
    limit: 10,
    cursor: page.candidates_meta.next_cursor,
  });
  const third = await call("browse_traders", {
    limit: 10,
    cursor: second.candidates_meta.next_cursor,
  });
  assert.equal(
    new Set(
      [...page.candidates, ...second.candidates, ...third.candidates].map(
        (c) => c.id,
      ),
    ).size,
    24,
  );
  assert.equal(third.candidates_meta.has_more, false);
  const roi = await call("browse_traders", { sort_by: "roi", limit: 5 });
  assert.equal(roi.candidates[0].id, adapter.pool[23].id);
  const compare = await call("browse_traders", {
    compare_ids: adapter.pool.slice(0, 2).map((c) => c.id),
  });
  assert.equal(compare.comparison.rows.length, 2);
  assert.equal(compare.candidates_meta.period_comparable, false);
  for (const d of [page, second, third, roi, compare]) {
    assert.equal(d.saved_plan_id, edited.plan.id);
    assert.equal(d.plan_unchanged, true);
  }
  await repo.transact("alice", async (s) =>
    assert.equal(s.plans.at(-1)!.allocations[0].amount_usdc, "90.000000"),
  );
  const refreshed = await call("recommend_traders", {
    preferences: { market: "perps" },
  });
  assert.equal(refreshed.plan.allocations[0].amount_usdc, "90.000000");
  assert.equal(refreshed.plan.allocations[0].stop_loss_pct, 25);
  const reviewed = await call("start_copy", {
    plan_id: refreshed.plan.id,
    compatibility_ack: compatibility(refreshed.plan).fingerprint,
  });
  assert.ok(reviewed.proposal);
  assert.equal(adapter.submitCount, 0);
});
it("cursor and snapshots are isolated, query bound and expirable without losing selection", async () => {
  const { api, call, repo } = env(11);
  await call("recommend_traders", {
    preferences: { budget_usdc: "200", risk_tolerance: "medium" },
  });
  const first = await call("browse_traders");
  await call(
    "recommend_traders",
    { preferences: { budget_usdc: "200", risk_tolerance: "medium" } },
    "bob",
  );
  await assert.rejects(
    api.tool("bob", "browse_traders", {
      cursor: first.candidates_meta.next_cursor,
    }),
    /account/,
  );
  await assert.rejects(
    api.tool("alice", "browse_traders", {
      sort_by: "roi",
      cursor: first.candidates_meta.next_cursor,
    }),
    /Restart/,
  );
  await repo.transact("alice", async (s) => {
    s.discovery!.expires_at = now() - 1;
  });
  await assert.rejects(
    api.tool("alice", "browse_traders", {
      cursor: first.candidates_meta.next_cursor,
    }),
    /expired/,
  );
  const before = await repo.transact("alice", async (s) =>
    structuredClone(s.plans),
  );
  const refreshed = await call("browse_traders");
  assert.equal(refreshed.plan_unchanged, true);
  assert.deepEqual(await repo.transact("alice", async (s) => s.plans), before);
});
it("sorts missing metrics last and does not claim unknown source periods are comparable", async () => {
  const { call, adapter } = env(11);
  adapter.pool[0].source_roi_pct = null;
  await call("recommend_traders", {
    preferences: { budget_usdc: "200", risk_tolerance: "medium" },
  });
  const page = await call("browse_traders", {
    sort_by: "roi",
    direction: "asc",
    limit: 20,
  });
  assert.equal(page.candidates.at(-1).id, adapter.pool[0].id);
  assert.equal(page.candidate_table.at(-1).historical_roi_pct, null);
  assert.equal(page.candidates_meta.period_comparable, false);
});
it("explicit selection overrides an old count, persists through edits, and never substitutes filtered traders", async () => {
  const { call, adapter } = env(11);
  await call("recommend_traders", {
    preferences: {
      budget_usdc: "200",
      risk_tolerance: "medium",
      basket_size: 4,
    },
  });
  const selected = await call("recommend_traders", {
    trader_ids: [adapter.pool[0].id],
  });
  assert.equal(selected.plan.allocations.length, 1);
  const conflict = await call("recommend_traders", {
    preferences: { assets: ["SOL"], allow_altcoins: false },
  });
  assert.equal(conflict.plan, null);
  assert.equal(conflict.saved_plan_id, selected.plan.id);
  const reset = await call("recommend_traders", {
    selection: "system",
    preferences: { assets: [], allow_altcoins: true, basket_size: 2 },
  });
  assert.equal(reset.plan.allocations.length, 2);
});
it("sub-50 Perps allocations support preview and editing without authorizing execution", async () => {
  const { call, adapter } = env(11);
  const d = await call("recommend_traders", {
    preferences: {
      budget_usdc: "20",
      risk_tolerance: "medium",
      market: "perps",
    },
  });
  assert.equal(d.plan.allocations.length, 4);
  assert.ok(d.plan.allocations.every((a: any) => a.amount_usdc === "5.000000"));
  assert.equal(d.candidates.length, 11);
  assert.equal(d.planning_constraints.minimum_allocation_usdc, null);
  assert.equal(d.planning_constraints.perps_product_minimum_usdc, null);
  const edited = await call("recalculate_plan", {
    plan_id: d.plan.id,
    allocations: d.plan.allocations.map((a: any) => ({
      trader_id: a.trader.id,
      amount_usdc: "4",
      stop_loss_pct: 25,
    })),
  });
  assert.ok(
    edited.plan.allocations.every((a: any) => a.amount_usdc === "4.000000"),
  );
  const refreshed = await call("recommend_traders", {
    preferences: { assets: ["BTC", "ETH"] },
  });
  assert.ok(
    refreshed.plan.allocations.every(
      (a: any) => a.amount_usdc === "4.000000" && a.stop_loss_pct === 25,
    ),
  );
  assert.equal(refreshed.plan.preferences.budget_usdc, "20");
  assert.equal(refreshed.plan.preferences.loss_trigger_pct, 20);
  const proposal = await call("start_copy", {
    plan_id: refreshed.plan.id,
    compatibility_ack: compatibility(refreshed.plan).fingerprint,
  });
  assert.equal(proposal.proposal.status, "requires_confirmation");
  assert.equal(adapter.submitCount, 0);
});
it("partial allocation and preference edits retain exits, copy mode and saved answers", async () => {
  const { call, adapter } = env(11);
  const original = await call("recommend_traders", {
    preferences: { budget_usdc: "200", risk_tolerance: "medium" },
    trader_ids: adapter.pool.slice(0, 2).map((c) => c.id),
  });
  const custom = await call("recalculate_plan", {
    plan_id: original.plan.id,
    allocations: original.plan.allocations.map((a: any) => ({
      trader_id: a.trader.id,
      amount_usdc: "90",
      leverage_cap: 3,
      stop_loss_pct: 25,
      copy_mode: "proportional",
      proportional_multiplier: 0.8,
    })),
  });
  const partial = await call("recalculate_plan", {
    plan_id: custom.plan.id,
    preferences: { market: "perps" },
    allocations: custom.plan.allocations.map((a: any) => ({
      trader_id: a.trader.id,
      amount_usdc: "85",
    })),
  });
  for (const a of partial.plan.allocations) {
    assert.equal(a.stop_loss_pct, 25);
    assert.equal(a.leverage_cap, 3);
    assert.equal(a.proportional_multiplier, 0.8);
  }
  assert.equal(
    (await call("get_preferences")).preference_collection.answers.market,
    "perps",
  );
  const mode = await call("recalculate_plan", {
    plan_id: partial.plan.id,
    preferences: { copy_mode: "fixed", fixed_margin_usdc: "10" },
  });
  assert.ok(
    mode.plan.allocations.every(
      (a: any) =>
        a.copy_mode === "fixed" && a.fixed_margin_usdc === "10.000000",
    ),
  );
  const refreshed = await call("recommend_traders", {
    preferences: { assets: [], allow_altcoins: true },
  });
  assert.ok(
    refreshed.plan.allocations.every(
      (a: any) => a.copy_mode === "fixed" && a.stop_loss_pct === 25,
    ),
  );
});
it("the initial five-row table supplies a cursor for ten more without repeating the first page", async () => {
  const { call } = env();
  const d = await call("recommend_traders", {
    preferences: { budget_usdc: "200", risk_tolerance: "medium" },
  });
  assert.equal(d.candidate_page.returned, 5);
  assert.equal(d.candidate_page.total, 24);
  assert.equal(d.candidate_page.has_more, true);
  const more = await call("browse_traders", {
    limit: 10,
    cursor: d.candidate_page.next_cursor,
  });
  assert.equal(more.candidates.length, 10);
  const seen = new Set(d.candidate_table.map((c: any) => c.trader_id));
  assert.ok(more.candidates.every((c: any) => !seen.has(c.id)));
});
