import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentService } from "./service.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { inputs } from "./contracts.js";
import { fingerprint } from "./domain.js";

const ids = (p: any) => p.allocations.map((a: any) => a.trader.id);
const controls = (a: any) =>
  Object.fromEntries(
    [
      "amount_usdc",
      "leverage_cap",
      "leverage_mode",
      "stop_loss_pct",
      "copy_mode",
      "fixed_margin_usdc",
      "proportional_multiplier",
      "loss_policy",
      "emergency_exit_pct",
    ].map((k) => [k, a[k]]),
  );
async function fixture() {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = Array.from({ length: 8 }, (_, i) => {
    const c = candidate(i + 1);
    c.assets = [`ASSET${i}`];
    c.style = `style${i}`;
    c.score = 85;
    const stability = i < 4 ? 95 : 55;
    const opportunity = i < 4 ? 55 : 95;
    c.components = {
      ...c.components,
      stability,
      pathSmoothness: stability,
      drawdownRecovery: stability,
      positionLeverageStability: stability,
      profitQuality: opportunity,
      copyability: opportunity,
    };
    return c;
  });
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  const call = async (
    name: Parameters<AgentService["tool"]>[1],
    args = {},
    user = "alice",
  ) => (await api.tool(user, name, args)).data as any;
  const initial = await call("recommend_traders", {
    preferences: {
      market: "perps",
      budget_usdc: "30",
      risk_tolerance: "low",
      loss_trigger_pct: 10,
      basket_size: 4,
      portfolio_kind: "basket",
    },
  });
  const state = () => repo.transact("alice", async (s) => structuredClone(s));
  return { repo, adapter, call, initial, state };
}

it("system reselection uses risk evidence while keeping the original four amounts and explicit exit trigger", async () => {
  const { initial, call, state, adapter } = await fixture();
  const before = await state();
  assert.equal(initial.plan.risk_selection.status, "applied");
  const d = await call("recommend_traders", {
    base_plan_id: initial.plan.id,
    selection: "system",
    preferences: { risk_tolerance: "high" },
  });
  assert.notEqual(d.plan.id, initial.plan.id);
  assert.notDeepEqual(ids(d.plan), ids(initial.plan));
  assert.equal(d.plan.allocations.length, 4);
  assert.deepEqual(
    d.plan.allocations.map(controls),
    initial.plan.allocations.map(controls),
  );
  assert.equal(d.plan.preferences.loss_trigger_pct, 10);
  assert.equal(d.plan.preference_sources.loss_trigger_pct, "user");
  assert.equal(d.plan.previous_plan_id, initial.plan.id);
  assert.equal(d.plan.selection_source, "system");
  assert.equal(d.plan.risk_selection.status, "applied");
  assert.equal(d.edit_kind, "system_reselection");
  assert.equal(d.execution_authorized, false);
  assert.equal(d.requires_new_confirmation, true);
  assert.deepEqual(
    d.recommended_portfolio.map((a: any) => a.trader_id),
    ids(d.plan),
  );
  assert.deepEqual(
    d.recommended_trader_comparison.map((a: any) => a.trader_id),
    ids(d.plan),
  );
  assert.deepEqual(
    d.final_review.traders.map((a: any) => a.trader_id),
    ids(d.plan),
  );
  const after = await state();
  assert.deepEqual(
    after.plans.find((p) => p.id === initial.plan.id),
    initial.plan,
  );
  assert.deepEqual(after.portfolios, before.portfolios);
  assert.deepEqual(after.proposals, before.proposals);
  assert.equal(adapter.submitCount, 0);
});

it("a risk-only edit respects manually pinned traders until explicit system reselection", async () => {
  const { call, initial, state } = await fixture();
  await call("recommend_traders", { trader_ids: ids(initial.plan) });
  const pinned = (await state()).selected_trader_ids;
  const d = await call("recommend_traders", {
    preferences: { risk_tolerance: "high" },
  });
  assert.deepEqual(new Set(ids(d.plan)), new Set(ids(initial.plan)));
  assert.equal(d.plan.risk_selection.status, "preserved_selection");
  assert.deepEqual((await state()).selected_trader_ids, pinned);
  const next = await call("recommend_traders", {
    base_plan_id: d.plan.id,
    selection: "system",
  });
  assert.notDeepEqual(new Set(ids(next.plan)), new Set(ids(d.plan)));
  assert.equal((await state()).selected_trader_ids, undefined);
});

it("reselection retains nonuniform slots and all inherited controls", async () => {
  const { repo, call, initial, state } = await fixture();
  const old = structuredClone(initial.plan);
  old.allocations.forEach((a: any, i: number) =>
    Object.assign(a, {
      amount_usdc: ["9.000000", "8.000000", "7.000000", "6.000000"][i],
      leverage_cap: i === 0 ? 3 : null,
      leverage_mode: i === 0 ? "custom_cap" : "follow_source",
      stop_loss_pct: 18,
      copy_mode: "fixed",
      fixed_margin_usdc: "2.000000",
      loss_policy: "pause_then_exit",
      emergency_exit_pct: 70,
    }),
  );
  await repo.transact("alice", async (s) => {
    s.plans[s.plans.length - 1] = structuredClone(old);
  });
  const d = await call("recommend_traders", {
    base_plan_id: old.id,
    selection: "system",
    preferences: { risk_tolerance: "high" },
  });
  assert.deepEqual(
    d.plan.allocations.map(controls),
    old.allocations.map(controls),
  );
  assert.deepEqual(
    (await state()).plans.find((p) => p.id === old.id),
    old,
  );
});

it("unavailable risk evidence or incompatible slots preserve plans, preferences and selection", async () => {
  for (const problem of [
    "missing_evidence",
    "stale_source",
    "slot_leverage",
    "too_few",
  ]) {
    const { repo, call, initial, state, adapter } = await fixture();
    if (problem === "missing_evidence")
      adapter.pool[7].components.copyability = null;
    if (problem === "stale_source")
      adapter.pool.forEach((c) => {
        c.expires_at = 0;
      });
    if (problem === "too_few") adapter.pool = adapter.pool.slice(0, 2);
    if (problem === "slot_leverage") {
      await repo.transact("alice", async (s) => {
        const a = s.plans[0].allocations[0];
        a.leverage_cap = 41;
        a.leverage_mode = "custom_cap";
      });
    }
    const before = await state();
    await assert.rejects(
      call("recommend_traders", {
        base_plan_id: initial.plan.id,
        selection: "system",
        preferences: { risk_tolerance: "high" },
      }),
    );
    assert.deepEqual(await state(), before, problem);
    assert.equal(adapter.submitCount, 0);
  }
});

it("base reselect rejects cross-account plans and unrelated preference edits without writes", async () => {
  const { call, initial, state } = await fixture();
  const before = await state();
  await assert.rejects(
    call(
      "recommend_traders",
      {
        base_plan_id: initial.plan.id,
        selection: "system",
        preferences: { risk_tolerance: "high" },
      },
      "bob",
    ),
    /not found/,
  );
  for (const preferences of [
    { budget_usdc: "40" },
    { basket_size: 2 },
    { loss_trigger_pct: 30 },
  ])
    await assert.rejects(
      call("recommend_traders", {
        base_plan_id: initial.plan.id,
        selection: "system",
        preferences,
      }),
      /preserves/,
    );
  assert.deepEqual(await state(), before);
});

it("explanation layers read one immutable plan and calculations are opt-in in the entire serialized view", async () => {
  const { call, initial, state } = await fixture();
  const before = fingerprint(await state());
  for (const analysis_depth of ["summary", "extended"]) {
    const d = await call("get_portfolio", {
      plan_id: initial.plan.id,
      detail: "detailed",
      analysis_depth,
    });
    assert.equal(d.plan.id, initial.plan.id);
    assert.doesNotMatch(JSON.stringify(d), /目标数量 =|max\(1, 源杠杆\)/);
    assert(
      d.final_review.traders.every((t: any) => !("details" in t.copy_rule)),
    );
  }
  const calculation = await call("get_portfolio", {
    plan_id: initial.plan.id,
    detail: "detailed",
    include_calculations: true,
  });
  assert.match(JSON.stringify(calculation), /目标数量 =/);
  assert.equal(fingerprint(await state()), before);
});

it("additive schemas validate reselect intent, numeric filters and analysis options", () => {
  assert(
    inputs.recommend_traders.safeParse({
      base_plan_id: "plan_original0001",
      selection: "system",
    }).success,
  );
  for (const input of [
    { base_plan_id: "plan_original0001" },
    {
      base_plan_id: "plan_original0001",
      selection: "system",
      trader_ids: ["trader_00000001"],
    },
  ])
    assert(!inputs.recommend_traders.safeParse(input).success);
  assert(
    inputs.browse_traders.safeParse({
      filters: {
        min_score: 0,
        max_drawdown_pct: 0,
        min_roi_pct: -20,
        max_roi_pct: 0,
      },
    }).success,
  );
  assert(
    !inputs.browse_traders.safeParse({
      filters: { min_roi_pct: 1, max_roi_pct: -1 },
    }).success,
  );
  assert(
    !inputs.browse_traders.safeParse({ filters: { min_score: Infinity } })
      .success,
  );
  assert(
    !inputs.browse_traders.safeParse({
      filters: {},
      compare_ids: ["trader_00000001"],
    }).success,
  );
  assert(
    !inputs.browse_traders.safeParse({
      metric_window: { start_at: 2, end_at: 1 },
    }).success,
  );
});

it("older risk-only calls and save-then-recommend keep unequal slots after system reselection", async () => {
  for (const separateSave of [false, true]) {
    const { repo, call, initial, state } = await fixture();
    await repo.transact("alice", async (s) => {
      s.plans[0].allocations.forEach(
        (a, i) =>
          (a.amount_usdc = ["9.000000", "8.000000", "7.000000", "6.000000"][i]),
      );
    });
    const high = await call("recommend_traders", {
      base_plan_id: initial.plan.id,
      selection: "system",
      preferences: { risk_tolerance: "high" },
    });
    const before = await state();
    if (separateSave) await call("set_preferences", { risk_tolerance: "low" });
    const next = await call(
      "recommend_traders",
      separateSave ? {} : { preferences: { risk_tolerance: "low" } },
    );
    assert.equal(next.edit_kind, "system_reselection");
    assert.deepEqual(
      next.plan.allocations.map(controls),
      high.plan.allocations.map(controls),
    );
    assert.deepEqual(
      (await state()).plans.find((p) => p.id === high.plan.id),
      high.plan,
    );
    assert.deepEqual(
      next.plan.risk_selection.selected.map((r: any) => r.trader_id),
      ids(next.plan),
    );
    assert.equal(
      next.plan.preferences.loss_trigger_pct,
      before.preferences!.loss_trigger_pct,
    );
  }
});

it("partial retention keeps risk analysis in canonical slot order", async () => {
  const { repo, call, initial, adapter } = await fixture();
  const common = adapter.pool[0];
  for (const key of Object.keys(common.components))
    common.components[key] = 100;
  // Leave the original saved plan intact; the fresh pool now has a common best trader.
  const next = await call("recommend_traders", {
    base_plan_id: initial.plan.id,
    selection: "system",
    preferences: { risk_tolerance: "high" },
  });
  assert(next.plan.allocations.some((a: any) => a.trader.id === common.id));
  assert(
    next.plan.allocations.some(
      (a: any) => !ids(initial.plan).includes(a.trader.id),
    ),
  );
  assert.deepEqual(
    next.plan.risk_selection.selected.map((r: any) => r.trader_id),
    ids(next.plan),
  );
});

it("explicit replacements and reordered allocations keep risk metadata in canonical slot order", async () => {
  for (const replacement of [true, false]) {
    const { call, initial, state, adapter } = await fixture();
    const original = structuredClone(initial.plan);
    const expected = replacement
      ? [adapter.pool[7].id, ...ids(original).slice(1)]
      : ids(original).reverse();
    const next = await call("recalculate_plan", {
      plan_id: original.id,
      ...(replacement
        ? {
            replacements: [
              {
                outgoing_trader_id: ids(original)[0],
                incoming_trader_id: adapter.pool[7].id,
              },
            ],
          }
        : {
            allocations: expected.map((trader_id: string) => ({
              trader_id,
              amount_usdc: "7.500000",
            })),
          }),
    });
    assert.deepEqual(ids(next.plan), expected);
    assert.equal(next.plan.risk_selection.status, "preserved_selection");
    assert.deepEqual(
      next.plan.risk_selection.selected.map((row: any) => row.trader_id),
      expected,
    );
    assert.deepEqual(
      next.recommended_trader_comparison.map((row: any) => row.trader_id),
      expected,
    );
    assert.deepEqual(
      next.final_review.traders.map((row: any) => row.trader_id),
      expected,
    );
    assert.deepEqual(
      (await state()).plans.find((p) => p.id === original.id),
      original,
    );
    assert.equal(adapter.submitCount, 0);
  }
});
