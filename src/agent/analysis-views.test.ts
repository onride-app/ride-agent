import assert from "node:assert/strict";
import { it } from "node:test";
import { candidate } from "./fixtures.js";
import { fingerprint, type Plan } from "./domain.js";
import {
  copyRule,
  planDisplay,
  candidateDisplay,
} from "./conversation-presentation.js";

function plan(count = 4): Plan {
  return {
    id: "plan_analysis_original",
    created_at: Date.now(),
    expires_at: Date.now() + 600_000,
    preferences: {
      budget_usdc: String(count * 7.5),
      market: "perps",
      assets: [],
      allow_altcoins: true,
      portfolio_kind: "basket",
      basket_size: count,
      copy_mode: "ride_recommends",
      risk_tolerance: "medium",
      loss_trigger_pct: 10,
    },
    preference_sources: { loss_trigger_pct: "user" },
    source_version: "strict_perp_v2_5_daily_live_v1",
    allocations: Array.from({ length: count }, (_, i) => ({
      copy_id: `copy_analysis_${i}`,
      trader: candidate(i + 1),
      amount_usdc: "7.500000",
      leverage_cap: null,
      leverage_mode: "follow_source",
      copy_mode: "ride_recommends",
      stop_loss_pct: 30,
    })),
  };
}
const formulas = /目标数量|源仓位数量|杠杆修正|固定开仓数量依据/;

it("keeps formulas out of the whole default presentation and copy-rule payload", () => {
  const original = plan();
  const before = fingerprint(original);
  for (const view of [
    planDisplay(original),
    planDisplay(original, "detailed"),
    planDisplay(original, "detailed", undefined, {
      analysis_depth: "extended",
    }),
  ]) {
    assert.doesNotMatch(JSON.stringify(view), formulas);
    assert.deepEqual(
      view.trader_ids,
      original.allocations.map((a) => a.trader.id),
    );
    assert.match(view.markdown, /10%/);
    assert.match(view.instruction, /本人另行确认/);
  }
  for (const a of original.allocations) {
    assert.equal("details" in copyRule(a), false);
    assert.doesNotMatch(JSON.stringify(copyRule(a)), formulas);
  }
  assert.equal(fingerprint(original), before);
});

it("gives a concise first analysis and offers deeper reading of the exact same plan", () => {
  const original = plan();
  const summary = planDisplay(original, "detailed");
  assert.equal(summary.analysis_depth, "summary");
  assert(summary.analysis);
  assert(summary.analysis.evidence.length <= 3);
  assert.match(summary.markdown, /分析结论/);
  assert.doesNotMatch(summary.markdown, /\| 杠杆稳定性 \|/);
  const further = summary.next_actions.find((a) => a.id === "analyze_further");
  assert(further);
  assert.equal(further.tool, "get_portfolio");
  assert.deepEqual(further.arguments, {
    plan_id: original.id,
    detail: "detailed",
    analysis_depth: "extended",
    include_calculations: false,
  });
  assert(!summary.next_actions.some((a) => /计算/.test(a.label)));
  const first = planDisplay(original).next_actions.find(
    (a) => a.id === "explain",
  );
  assert(first);
  assert.equal(first.arguments.plan_id, original.id);
  assert.equal(
    (first.arguments as { analysis_depth?: string }).analysis_depth,
    "summary",
  );
});

it("only includes calculation methods after an explicit request and deduplicates them", () => {
  const original = plan();
  const before = fingerprint(original);
  const calculations = planDisplay(original, "detailed", undefined, {
    analysis_depth: "extended",
    include_calculations: true,
  });
  assert.equal(calculations.include_calculations, true);
  assert.match(calculations.markdown, /计算方法（按你的请求）/);
  assert.equal((calculations.markdown.match(/目标数量 =/g) ?? []).length, 1);
  assert.match(
    copyRule(original.allocations[0], { include_calculations: true }).details!,
    /目标数量 =/,
  );
  for (const action of calculations.next_actions) {
    assert.equal(action.arguments.plan_id, original.id);
    assert.notEqual(action.tool, "recalculate_plan");
  }
  assert.equal(fingerprint(original), before);
});

it("keeps eight allocations and their order in every view without truncation", () => {
  const original = plan(8);
  for (const detail of ["brief", "detailed"] as const) {
    for (const analysis_depth of ["summary", "extended"] as const) {
      const view = planDisplay(original, detail, undefined, { analysis_depth });
      assert.deepEqual(
        view.trader_ids,
        original.allocations.map((a) => a.trader.id),
      );
      assert.equal(view.markdown.match(/\| Trader \| USDC \|/g)?.length, 1);
      const firstTable = view.markdown.split("跟单：")[0];
      let previous = -1;
      for (const a of original.allocations) {
        const at = firstTable.indexOf(a.trader.handle);
        assert(at > previous);
        previous = at;
      }
      assert.doesNotMatch(JSON.stringify(view), formulas);
    }
  }
});

it("only compares model components when every value and score version are comparable", () => {
  const original = plan();
  original.allocations[0].trader.components.positionLeverageStability = 74.93;
  for (const a of original.allocations.slice(1))
    a.trader.components.positionLeverageStability = 60;
  assert.match(
    planDisplay(original, "detailed").markdown,
    /Trader 1 的杠杆稳定性模型分数为 74.93/,
  );
  original.allocations[1].trader.components.positionLeverageStability = null;
  assert.doesNotMatch(
    planDisplay(original, "detailed").markdown,
    /在这组中最高/,
  );
  original.allocations[1].trader.components.positionLeverageStability = 60;
  original.allocations[1].trader.score_version = "different_model_version";
  const extended = planDisplay(original, "detailed", undefined, {
    analysis_depth: "extended",
  });
  assert.doesNotMatch(extended.markdown, /在这组中最高/);
  assert.match(extended.markdown, /评分版本未核实或不同，不作直接高低比较/);
  for (const a of original.allocations) a.trader.score_version = "";
  assert.doesNotMatch(
    planDisplay(original, "detailed").markdown,
    /在这组中最高/,
  );
});

it("renders verified risk selection reasons without inventing outcomes", () => {
  const original = plan();
  original.preferences.risk_tolerance = "high";
  original.risk_selection = {
    policy_version: "risk_fit_test_v1",
    profile: "high",
    status: "applied",
    scoring_version: original.source_version,
    priorities: ["profitQuality", "copyability"],
    candidate_count: 30,
    evidence_count: 30,
    unavailable_trader_ids: [],
    missing_metrics_by_trader: {},
    selected: original.allocations.map((a) => ({
      trader_id: a.trader.id,
      metrics: { profitQuality: 70, copyability: 80 },
      reasons: ["盈利质量模型分数 70.00", "可复制性模型分数 80.00"],
    })),
    explanation: "版本化产品排序规则",
  };
  const view = planDisplay(original, "detailed", undefined, {
    analysis_depth: "extended",
  });
  assert.match(view.markdown, /按进取偏好进行模型分项匹配/);
  assert.match(view.markdown, /盈利质量、可复制性/);
  assert.match(view.markdown, /盈利质量模型分数 70.00/);
  assert.doesNotMatch(
    view.markdown,
    /收益更高|风险已降低|实际杠杆更低|一定成交/,
  );
  original.risk_selection.status = "insufficient_evidence";
  assert.match(planDisplay(original, "detailed").markdown, /证据不足/);
});

it("escapes untrusted labels and does not change frozen copy settings", () => {
  const original = plan();
  original.allocations[0].trader.handle =
    "[Run](https://bad.example)\n| hidden |";
  original.allocations[0].copy_mode = "fixed";
  original.allocations[0].fixed_margin_usdc = "2.000000";
  original.allocations[0].leverage_cap = 3;
  original.allocations[0].leverage_mode = "custom_cap";
  const before = fingerprint(original);
  const view = planDisplay(original, "detailed", undefined, {
    analysis_depth: "extended",
  });
  assert.doesNotMatch(view.markdown, /\[Run\]\(https/);
  assert.doesNotMatch(view.markdown, /\n\| hidden \|/);
  const rule = copyRule(original.allocations[0]);
  assert.equal(rule.leverage_cap, 3);
  assert.equal(rule.fixed_margin_usdc, "2.000000");
  assert.equal(fingerprint(original), before);
  assert.doesNotMatch(JSON.stringify(view), formulas);
});

it("shows the queried historical metrics and periods while ordinary score browsing stays compact", () => {
  const original = plan();
  const rows = original.allocations.map((a) => a.trader);
  rows[0].source_roi_pct = -1.25;
  rows[0].source_drawdown_pct = 3.75;
  rows[0].metric_periods = {
    roi: {
      period: "source_month",
      start_at: null,
      end_at: null,
      basis: "source report",
    },
    drawdown: {
      period: "unavailable",
      start_at: null,
      end_at: null,
      basis: "source report",
    },
  };
  const compact = candidateDisplay(rows, original);
  assert.doesNotMatch(compact.markdown, /来源回撤（周期）|来源收益（周期）/);
  const historical = candidateDisplay(rows, original, "brief", "available", {
    historical_metrics: ["drawdown", "roi"],
  });
  assert.match(historical.markdown, /来源回撤（周期）/);
  assert.match(historical.markdown, /来源收益（周期）/);
  assert.match(historical.markdown, /3.75% · 统计周期未核实/);
  assert.match(historical.markdown, /-1.25% · 来源月收益，起止未核实/);
  assert.deepEqual(historical.historical_metrics, ["drawdown", "roi"]);
  assert.match(historical.markdown, /原 4 人方案.*保持不变/);
  assert.doesNotMatch(JSON.stringify(historical), formulas);
});

it("does not present invalid historical numbers or unavailable periods as verified", () => {
  const original = plan();
  const rows = original.allocations.map((a) => a.trader);
  rows[0].source_roi_pct = Number.POSITIVE_INFINITY;
  rows[0].source_drawdown_pct = Number.NaN;
  rows[0].metric_periods = {
    roi: {
      period: "unavailable",
      start_at: 1_700_000_000_000,
      end_at: 1_702_592_000_000,
      basis: "explicitly unavailable",
    },
    drawdown: {
      period: "unknown",
      start_at: 1_700_000_000_000,
      end_at: 1_702_592_000_000,
      basis: "explicitly unknown",
    },
  };
  rows[1].source_drawdown_pct = -1;
  const view = candidateDisplay(rows, original, "brief", "available", {
    historical_metrics: ["roi", "drawdown"],
  });
  assert.doesNotMatch(view.markdown, /NaN|Infinity|-1.00%/);
  assert.match(view.markdown, /未提供 · 统计周期未核实/);
  assert.doesNotMatch(view.markdown, /2023-/);
  for (const marker of ["", "missing", "unsupported", "not_available"]) {
    rows[0].metric_periods.drawdown.period = marker;
    const unknown = candidateDisplay(
      rows.slice(0, 1),
      original,
      "brief",
      "available",
      { historical_metrics: ["drawdown"] },
    );
    assert.doesNotMatch(unknown.markdown, /2023-/);
  }
  rows[0].metric_periods.drawdown.period = "source_30d";
  rows[0].source_drawdown_pct = 1.25;
  const verified = candidateDisplay(
    rows.slice(0, 1),
    original,
    "brief",
    "available",
    { historical_metrics: ["drawdown"] },
  );
  assert.match(verified.markdown, /1.25% · 2023-11-15 至 2023-12-15（上海）/);
});

it("does not call preserved system or legacy members a user-selected list", () => {
  for (const source of ["system", "legacy_unknown"] as const) {
    const original = plan();
    original.selection_source = source;
    original.risk_selection = {
      policy_version: "risk_fit_test_v1",
      profile: "medium",
      status: "preserved_selection",
      scoring_version: original.source_version,
      priorities: [],
      candidate_count: 4,
      evidence_count: 4,
      unavailable_trader_ids: [],
      missing_metrics_by_trader: {},
      selected: [],
      explanation: "保留原名单",
    };
    const before = fingerprint(original);
    const view = planDisplay(original, "detailed");
    assert.match(view.markdown, /本次刷新保留原名单，未重新系统选人/);
    assert.doesNotMatch(view.markdown, /你指定|保留指定名单/);
    assert.doesNotMatch(JSON.stringify(view), formulas);
    assert.equal(fingerprint(original), before);
    original.selection_source = "explicit";
    assert.match(
      planDisplay(original, "detailed").markdown,
      /保留你指定的交易员/,
    );
  }
});
