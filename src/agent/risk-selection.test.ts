import assert from "node:assert/strict";
import { it } from "node:test";
import { preferences, type Preferences } from "./contracts.js";
import { recommend, type Candidate } from "./domain.js";
import { candidate } from "./fixtures.js";
import {
  createRiskSelectionPolicy,
  RISK_SELECTION_POLICY_VERSION,
} from "./risk-selection.js";

const pref = (risk_tolerance: "low" | "medium" | "high") =>
  preferences.parse({
    budget_usdc: "30",
    loss_trigger_pct: 10,
    market: "perps",
    portfolio_kind: "single",
    basket_size: 1,
    copy_mode: "ride_recommends",
    risk_tolerance,
  });
function modelCandidate(
  i: number,
  stable: number,
  opportunity: number,
): Candidate {
  const c = candidate(i);
  c.score = 90 - i;
  c.components = {
    ...c.components,
    stability: stable,
    pathSmoothness: stable,
    drawdownRecovery: stable,
    positionLeverageStability: stable,
    profitQuality: opportunity,
    copyability: opportunity,
  };
  return c;
}
const distinctPool = () => [
  modelCandidate(1, 90, 45),
  modelCandidate(2, 45, 90),
  modelCandidate(3, 72, 72),
];
const ids = (plan: ReturnType<typeof recommend>) =>
  plan.allocations.map((a) => a.trader.id);

it("applies explicit low, balanced and high model priorities without changing Copy Score or leverage semantics", () => {
  const pool = distinctPool();
  const before = structuredClone(pool);
  const plans = ["low", "medium", "high"].map((profile) =>
    recommend(pref(profile as "low" | "medium" | "high"), pool),
  );
  assert.deepEqual(
    plans.map((p) => ids(p)[0]),
    [pool[0].id, pool[2].id, pool[1].id],
  );
  for (const plan of plans) {
    assert.equal(plan.risk_selection?.status, "applied");
    assert.equal(
      plan.risk_selection?.policy_version,
      RISK_SELECTION_POLICY_VERSION,
    );
    assert.equal(plan.risk_selection?.candidate_count, 3);
    assert.equal(plan.risk_selection?.evidence_count, 3);
    assert.equal(plan.preferences.loss_trigger_pct, 10);
    assert.equal(plan.allocations[0].leverage_mode, "follow_source");
    assert.equal(plan.allocations[0].leverage_cap, null);
    assert.equal(plan.allocations[0].amount_usdc, "30.000000");
    assert.equal(
      plan.allocations[0].trader.score,
      pool.find((c) => c.id === ids(plan)[0])!.score,
    );
    assert.match(
      plan.risk_selection!.selected[0].reasons.join(" "),
      /同版模型/,
    );
  }
  assert.deepEqual(pool, before);
});

it("uses stable public IDs for exact ties and does not force different profiles to have different rosters", () => {
  const pool = [modelCandidate(2, 80, 80), modelCandidate(1, 80, 80)];
  pool.forEach((c) => {
    c.score = 85;
  });
  const low = recommend(pref("low"), pool);
  const high = recommend(pref("high"), [...pool].reverse());
  assert.deepEqual(ids(low), [pool[1].id]);
  assert.deepEqual(ids(high), ids(low));
  assert.deepEqual(ids(recommend(pref("low"), [...pool].reverse())), ids(low));
});

it("keeps the existing overlap penalty active within each profile's model priority", () => {
  const pool = Array.from({ length: 3 }, (_, i) =>
    modelCandidate(i + 1, 80, 80),
  );
  pool.forEach((c) => {
    c.assets = ["BTC"];
    c.style = "trend";
    c.direction = "long";
  });
  pool[2].assets = ["ETH"];
  pool[2].style = "swing";
  pool[2].direction = "short";
  const p = {
    ...pref("low"),
    portfolio_kind: "basket" as const,
    basket_size: 2,
  };
  assert.deepEqual(ids(recommend(p, pool)), [pool[0].id, pool[2].id]);
});

it("never substitutes a partial profile or a zero for missing, non-finite or out-of-range evidence", () => {
  for (const value of [null, NaN, Infinity, -1, 100.01, undefined]) {
    const pool = distinctPool();
    pool[2].components.stability = value as number | null;
    const plan = recommend(pref("low"), pool);
    assert.equal(plan.risk_selection?.status, "insufficient_evidence");
    assert.equal(plan.risk_selection?.candidate_count, 3);
    assert.equal(plan.risk_selection?.evidence_count, 2);
    assert.deepEqual(plan.risk_selection?.unavailable_trader_ids, [pool[2].id]);
    assert.deepEqual(
      plan.risk_selection?.missing_metrics_by_trader[pool[2].id],
      ["stability"],
    );
    const metadata = createRiskSelectionPolicy(pref("low"), pool).summary([
      pool[2],
    ]);
    assert(!("stability" in metadata.selected[0].metrics));
    assert.match(plan.risk_selection!.explanation, /未宣称已完成风险匹配/);
  }
});

it("accepts actual zero-valued model evidence without treating it as missing", () => {
  const pool = [modelCandidate(1, 0, 0)];
  const plan = recommend(pref("low"), pool);
  assert.equal(plan.risk_selection?.status, "applied");
  assert.equal(plan.risk_selection?.selected[0].metrics.stability, 0);
});

it("does not treat different or unsupported scoring versions as comparable model evidence", () => {
  for (const allUnsupported of [false, true]) {
    const pool = distinctPool();
    pool[1].score_version = "unverified_custom_version";
    if (allUnsupported)
      pool.forEach((c) => {
        c.score_version = "unverified_custom_version";
      });
    const plan = recommend(pref("low"), pool);
    assert.equal(plan.risk_selection?.status, "unsupported");
    assert.equal(
      plan.risk_selection?.scoring_version,
      allUnsupported ? "unverified_custom_version" : null,
    );
    assert(
      plan.risk_selection?.missing_metrics_by_trader[pool[1].id].includes(
        "unsupported_score_version",
      ),
    );
    assert.deepEqual(plan.risk_selection?.priorities, []);
  }
});

it("does not use unknown-window source return or drawdown to invent risk-fit rankings", () => {
  const pool = distinctPool();
  const baseline = ids(recommend(pref("low"), pool));
  pool[0].source_roi_pct = -99;
  pool[0].source_drawdown_pct = 99;
  pool[1].source_roi_pct = 900;
  pool[1].source_drawdown_pct = 0;
  assert.deepEqual(ids(recommend(pref("low"), pool)), baseline);
  assert.match(
    recommend(pref("low"), pool).risk_selection!.explanation,
    /未使用周期未核实/,
  );
});

it("preserves pinned and refresh selection ranking without claiming a new system risk match", () => {
  const pool = distinctPool();
  const plan = recommend(pref("low"), pool, {
    selection_source: "explicit",
    risk_selection: "preserve",
  });
  assert.equal(plan.selection_source, "explicit");
  assert.equal(plan.risk_selection?.status, "preserved_selection");
  assert.deepEqual(ids(plan), [pool[0].id]);
  assert.match(plan.risk_selection!.explanation, /未按风险偏好重新系统选人/);
});

it("retains legacy and prediction behavior with explicit unsupported scope metadata", () => {
  const legacy: Preferences = {
    ...pref("low"),
    portfolio_kind: undefined,
    basket_size: 3,
  };
  const legacyPlan = recommend(legacy, distinctPool());
  assert.equal(legacyPlan.selection_source, "legacy_unknown");
  assert.equal(legacyPlan.risk_selection?.status, "unsupported");
  assert(
    legacyPlan.allocations.every(
      (a) => a.leverage_mode == null && a.leverage_cap === 3,
    ),
  );
  const prediction = modelCandidate(4, 90, 90);
  prediction.market = "prediction";
  prediction.assets = ["YES"];
  const predictionPlan = recommend(
    { ...pref("high"), market: "prediction", budget_usdc: "100" },
    [prediction],
  );
  assert.equal(predictionPlan.risk_selection?.status, "unsupported");
  assert.equal(predictionPlan.allocations[0].leverage_cap, 1);
});

it("does not infer a risk profile from an explicit numeric loss trigger", () => {
  const p = { ...pref("low"), risk_tolerance: undefined };
  const plan = recommend(p, distinctPool());
  assert.equal(plan.risk_selection?.status, "not_requested");
  assert.equal(plan.risk_selection?.profile, null);
  assert.equal(plan.preferences.loss_trigger_pct, 10);
});

it("risk metadata retains the full evidence pool when a caller mutates its working list", () => {
  const pool = distinctPool();
  const policy = createRiskSelectionPolicy(pref("low"), pool);
  const selected = [pool.shift()!];
  const metadata = policy.summary(selected);
  assert.equal(metadata.candidate_count, 3);
  assert.equal(metadata.evidence_count, 3);
  assert.equal(metadata.selected.length, 1);
});

it("does not personalize mixed markets or let rejected stale evidence invalidate a verified Perps pool", () => {
  const perps = modelCandidate(1, 90, 70);
  const prediction = modelCandidate(2, 70, 90);
  prediction.market = "prediction";
  prediction.assets = ["YES"];
  const mixed = recommend(
    {
      ...pref("high"),
      market: "both",
      portfolio_kind: "basket",
      basket_size: 2,
      budget_usdc: "100",
    },
    [perps, prediction],
  );
  assert.equal(mixed.risk_selection?.status, "unsupported");
  assert.match(mixed.risk_selection!.explanation, /不同市场/);
  const stale = modelCandidate(3, 80, 80);
  stale.expires_at = Date.now() - 1;
  stale.components = {};
  const fresh = recommend(pref("low"), [perps, stale]);
  assert.equal(fresh.risk_selection?.status, "applied");
  assert.equal(fresh.risk_selection?.candidate_count, 1);
  assert.deepEqual(ids(fresh), [perps.id]);
});

it("reports an empty evidence pool and an absent component record as unavailable, not zero", () => {
  const empty = createRiskSelectionPolicy(pref("low"), []).summary([]);
  assert.equal(empty.status, "insufficient_evidence");
  assert.equal(empty.candidate_count, 0);
  const c = modelCandidate(1, 80, 80);
  c.components = undefined as unknown as Candidate["components"];
  const result = createRiskSelectionPolicy(pref("low"), [c]).summary([c]);
  assert.equal(result.status, "insufficient_evidence");
  assert.deepEqual(result.selected[0].metrics, {});
  assert.equal(result.evidence_count, 0);
});
