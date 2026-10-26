import {
  cash,
  D,
  type Allocation,
  type Candidate,
  type Plan,
} from "./domain.js";
import { compatibility } from "./conversational.js";
import { verifiedWindow } from "./candidate-filters.js";

export type Detail = "brief" | "detailed";
export interface AnalysisOptions {
  analysis_depth?: "summary" | "extended";
  include_calculations?: boolean;
}
// Trader text is untrusted. It may supply a label, never Markdown or actions.
const cell = (value: unknown) =>
  String(value ?? "—")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 80)
    .replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
const pct = (value: number | null) =>
  typeof value !== "number" || !Number.isFinite(value)
    ? "未提供"
    : `${value.toFixed(2)}%`;

export function copyRule(a: Allocation, options: AnalysisOptions = {}) {
  const mode = a.copy_mode ?? "ride_recommends";
  const multiplier = a.proportional_multiplier ?? 1;
  const sizing =
    mode === "fixed"
      ? `每次经核实的源开仓使用 ${a.fixed_margin_usdc ?? "未设置"} USDC 保证金；减仓按源成交比例跟随。`
      : `按分配资金与源账户权益的比例缩放源仓位${multiplier === 1 ? "" : `，再乘 ${multiplier} 倍`}。`;
  const limits =
    a.trader.market === "perps"
      ? `${a.leverage_cap == null ? "跟随核实的源杠杆，无额外用户上限" : `额外杠杆上限 ${a.leverage_cap}x`}，同时受交易所限制、预算和风控约束；不足最小下单额则跳过，不自动加钱或加杠杆。`
      : "预测市场按对应结果仓位跟随，杠杆为 1x；受可用抵押品、预算和交易限制约束。";
  return {
    mode,
    label:
      mode === "fixed"
        ? "固定保证金"
        : mode === "proportional"
          ? "比例跟单"
          : "Ride 自动比例跟单",
    sizing,
    summary: sizing + limits,
    allocated_usdc: a.amount_usdc,
    fixed_margin_usdc: a.fixed_margin_usdc ?? null,
    proportional_multiplier: multiplier,
    leverage_cap: a.leverage_cap,
    sizing_basis:
      mode === "fixed"
        ? "verified_source_open_fills"
        : "allocation_over_verified_source_equity",
    source_equity_usdc: null,
    next_order_size: null,
    ...(options.include_calculations
      ? {
          details:
            mode === "fixed"
              ? "固定开仓数量依据经核实的源成交、固定保证金、允许杠杆及价格计算；不靠仓位变化猜测新成交。"
              : `目标数量 = 源仓位数量 × 分配资金 / 核实的源账户权益 × 杠杆修正 × ${multiplier}；Perps 杠杆修正为允许杠杆 / max(1, 源杠杆)。预测市场为 1x。实际还须按精度取整、净额合并并检查下单限制。`,
        }
      : {}),
  };
}

export function planChange(previous: Plan, plan: Plan) {
  const before = compatibility(previous),
    after = compatibility(plan);
  const beforeIds = previous.allocations.map((a) => a.trader.id);
  const afterIds = plan.allocations.map((a) => a.trader.id);
  const maxWeight = (p: Plan) => {
    const total = p.allocations.reduce((n, a) => n.plus(a.amount_usdc), D(0));
    return total.isZero()
      ? null
      : cash(
          D.max(
            ...p.allocations.map((a) => D(a.amount_usdc).div(total).times(100)),
          ),
        );
  };
  return {
    base_plan_id: previous.id,
    new_plan_id: plan.id,
    before_trader_ids: beforeIds,
    after_trader_ids: afterIds,
    before_count: beforeIds.length,
    after_count: afterIds.length,
    removed_trader_ids: beforeIds.filter((id) => !afterIds.includes(id)),
    added_trader_ids: afterIds.filter((id) => !beforeIds.includes(id)),
    budget_unchanged: D(previous.preferences.budget_usdc).eq(
      plan.preferences.budget_usdc,
    ),
    capital_concentration: {
      before_max_weight_pct: maxWeight(previous),
      after_max_weight_pct: maxWeight(plan),
    },
    overlap_assessment: {
      method: "qualitative_asset_direction_style_flags",
      before_flags: before.warnings,
      after_flags: after.warnings,
      fewer_flags: before.warnings - after.warnings,
    },
    measured_portfolio_risk_improvement: null,
    historical_loss_correlation: null,
    explanation:
      "仅比较资金权重和资产、方向、风格重叠标记；人数、单人金额或标记变化不能证明组合风险降低。历史组合回撤和亏损相关性未测得。",
    original_plan_unchanged: true,
    execution_authorized: false,
  };
}

const componentLabels: Record<string, string> = {
  stability: "稳定性",
  pathSmoothness: "收益路径平滑度",
  drawdownRecovery: "回撤恢复",
  positionLeverageStability: "杠杆稳定性",
  profitQuality: "盈利质量",
  copyability: "可复制性",
  stability_floor: "稳定性相关分项的短板",
  opportunity_floor: "盈利质量与可复制性的短板",
  balanced_floor: "稳定性与盈利质量的均衡",
  copy_score: "Copy Score",
};
const riskLabels = { low: "稳健", medium: "平衡", high: "进取" } as const;
const modelMetric = (c: Candidate, key: string) => {
  const value = c.components?.[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
};

function comparableModelVersions(plan: Plan) {
  const version = plan.allocations[0]?.trader.score_version;
  return (
    typeof version === "string" &&
    version.trim().length > 0 &&
    !["unknown", "unavailable"].includes(version.toLowerCase()) &&
    plan.allocations.every((a) => a.trader.score_version === version)
  );
}

function analysisSummary(plan: Plan, previous?: Plan) {
  const risk = plan.risk_selection;
  const profile = plan.preferences.risk_tolerance;
  const riskLabel = profile ? riskLabels[profile] : null;
  const change = previous ? planChange(previous, plan) : null;
  const conclusion =
    risk?.status === "applied"
      ? `这组 trader 已按${riskLabel ?? "当前"}偏好进行模型分项匹配，资金分配和退出设置以本方案为准。`
      : plan.selection_source === "explicit"
        ? "这份预览保留你指定的交易员；调整偏好不会自动替换这些成员。"
        : risk?.status === "preserved_selection"
          ? "本次刷新保留原名单，未重新系统选人。"
          : risk?.status === "insufficient_evidence" ||
              risk?.status === "unsupported"
            ? "当前证据不足以确认这组 trader 已完成所选风险偏好的匹配。"
            : `这是一份 ${plan.allocations.length} 人跟单预览，是否实际成交仍取决于每笔订单条件。`;
  const equalAmounts = plan.allocations.every((a) =>
    D(a.amount_usdc).eq(plan.allocations[0]?.amount_usdc ?? 0),
  );
  const evidence: string[] = [
    equalAmounts && plan.allocations.length
      ? `每人分配 ${plan.allocations[0].amount_usdc} USDC；这是资金配置，不能据此确定能复制多少笔交易。`
      : "各人的资金配置见上表；不能仅凭分配金额确定实际成交覆盖率。",
  ];
  if (risk?.status === "applied") {
    const priorities = risk.priorities
      .map((key) => componentLabels[key] ?? key)
      .slice(0, 3);
    evidence.push(
      `本次选人优先考虑${priorities.map(cell).join("、")}，Copy Score 的原始含义保持不变。`,
    );
  } else {
    const sameVersion = comparableModelVersions(plan);
    const leverage = plan.allocations.map((a) => ({
      a,
      value: modelMetric(a.trader, "positionLeverageStability"),
    }));
    if (
      sameVersion &&
      leverage.length > 1 &&
      leverage.every((x) => x.value != null)
    ) {
      const maximum = Math.max(...leverage.map((x) => x.value!));
      const leaders = leverage.filter((x) => x.value === maximum);
      evidence.push(
        leaders.length === 1
          ? `${cell(leaders[0].a.trader.handle)} 的杠杆稳定性模型分数为 ${maximum.toFixed(2)}，在这组中最高。`
          : `这组有 ${leaders.length} 人的杠杆稳定性模型分数并列最高（${maximum.toFixed(2)}）。`,
      );
    }
  }
  if (change) {
    evidence.push(
      `相对原方案，移出 ${change.removed_trader_ids.length} 位、加入 ${change.added_trader_ids.length} 位；人数 ${change.before_count} → ${change.after_count}，原方案保留。`,
    );
  } else if (
    plan.allocations.some((a) => a.trader.score_explanation?.cap_applied)
  ) {
    evidence.push(
      "部分展示分数受等级封顶影响；同分不代表交易行为或盈利质量相同。",
    );
  }
  return { conclusion, evidence: evidence.slice(0, 3) };
}

export function planDisplay(
  plan: Plan,
  detail: Detail = "brief",
  previous?: Plan,
  options: AnalysisOptions = {},
) {
  const depth = options.analysis_depth ?? "summary";
  const rules = plan.allocations.map((a) => ({
    trader_id: a.trader.id,
    ...copyRule(a, options),
  }));
  const uniqueRules = [...new Set(rules.map((r) => r.summary))];
  const mixedSummary = [
    ...(rules.some((r) => r.mode !== "fixed")
      ? ["按分配资金与源账户权益的比例缩放源仓位，并应用各自保存的倍率。"]
      : []),
    ...(rules.some((r) => r.mode === "fixed")
      ? ["固定模式按逐人设定的保证金跟随核实的源开仓。"]
      : []),
    "杠杆按逐人保存值及交易所限制执行；受预算、风控及最小下单限制约束。",
  ].join("");
  const change = previous ? planChange(previous, plan) : null;
  const analysis =
    detail === "detailed" ? analysisSummary(plan, previous) : null;
  const markdown = [
    `${plan.allocations.length} 人方案 · ${cell(plan.id.slice(-8))} · 预算 ${cell(plan.preferences.budget_usdc)} USDC${plan.expires_at <= Date.now() ? "（已过期，需刷新后确认）" : ""}`,
    "| Trader | USDC | Score | 来源收益 | 来源回撤 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...plan.allocations.map(
      (a) =>
        `| ${cell(a.trader.handle)} | ${cell(a.amount_usdc)} | ${cell(a.trader.score)} | ${pct(a.trader.source_roi_pct)} | ${pct(a.trader.source_drawdown_pct)} |`,
    ),
    ...(plan.risk_selection
      ? [
          plan.risk_selection.status === "applied"
            ? `选人：已按${riskLabels[plan.preferences.risk_tolerance!]}偏好匹配同版模型分项；不是组合收益或风险改善的实测结论。`
            : plan.risk_selection.status === "insufficient_evidence" ||
                plan.risk_selection.status === "unsupported"
              ? "选人：风险分项证据不足或不适用，本次未完成风险偏好匹配。"
              : plan.risk_selection.status === "preserved_selection"
                ? plan.selection_source === "explicit"
                  ? "选人：保留你指定的名单，本次没有重新系统选人。"
                  : "选人：保留原名单，本次没有重新系统选人。"
                : "选人：未指定低、中、高风险偏好。",
        ]
      : []),
    `跟单：${uniqueRules.length === 1 ? uniqueRules[0] : mixedSummary}`,
    `组合退出触发（${plan.preference_sources?.loss_trigger_pct === "user" ? "你设置的" : plan.preference_sources?.loss_trigger_pct === "recommended" ? "系统建议，待确认" : "设置来源未核实"}）：${plan.preferences.loss_trigger_pct}%（按预算为 ${cash(D(plan.preferences.budget_usdc).times(plan.preferences.loss_trigger_pct).div(100))} USDC），触发后尝试退出，不保证最大亏损。`,
    "来源历史的统计周期可能未核实，不代表跟单收益；尚无实测组合风险改善结论。",
    ...(change
      ? [
          `相对 ${previous!.id.slice(-8)}：${change.before_count} 人 → ${change.after_count} 人；${change.added_trader_ids.length || change.removed_trader_ids.length ? `移出 ${change.removed_trader_ids.length} 位、加入 ${change.added_trader_ids.length} 位` : "成员保持不变"}。原方案保留。`,
        ]
      : []),
  ];
  if (analysis) {
    markdown.push(
      `分析结论：${analysis.conclusion}`,
      ...analysis.evidence.map((line) => `- ${line}`),
    );
    if (depth === "extended") {
      const sameVersion = comparableModelVersions(plan);
      markdown.push(
        `模型分项${sameVersion ? "（同一评分版本）" : "（评分版本未核实或不同，不作直接高低比较）"}：`,
        "| Trader | 稳定性 | 杠杆稳定性 | 盈利质量 | 可复制性 |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...plan.allocations.map(
          (a) =>
            `| ${cell(a.trader.handle)} | ${[
              "stability",
              "positionLeverageStability",
              "profitQuality",
              "copyability",
            ]
              .map((key) => {
                const value = modelMetric(a.trader, key);
                return value == null ? "未提供" : value.toFixed(2);
              })
              .join(" | ")} |`,
        ),
      );
      const selected =
        plan.risk_selection?.status === "applied"
          ? plan.risk_selection.selected
          : [];
      for (const a of plan.allocations) {
        const reasons = selected
          .find((row) => row.trader_id === a.trader.id)
          ?.reasons.slice(0, 2);
        if (reasons?.length)
          markdown.push(
            `${cell(a.trader.handle)}：${reasons.map(cell).join("；")}。`,
          );
      }
      const assessment = compatibility(plan);
      markdown.push(
        `资产、方向和风格重叠标记 ${assessment.warnings} 项；模型分项不等于实时杠杆或实际跟单收益。`,
      );
    }
  }
  if (options.include_calculations) {
    markdown.push(
      "计算方法（按你的请求）：",
      ...new Set(rules.flatMap((rule) => (rule.details ? [rule.details] : []))),
    );
  }
  markdown.push(
    detail === "brief"
      ? "可选：查看其他 trader · 分析这组 trader"
      : depth === "summary" && !options.include_calculations
        ? "可选：进一步分析 · 查看其他 trader"
        : "可选：简短分析结论 · 查看其他 trader",
  );
  const nextActions = [
    {
      id: "browse_alternatives",
      label: "查看其他 trader",
      tool: "browse_traders",
      arguments: { plan_id: plan.id, exclude_selected: true, detail: "brief" },
    },
    {
      id:
        detail === "brief"
          ? "explain"
          : depth === "summary" && !options.include_calculations
            ? "analyze_further"
            : "analysis_summary",
      label:
        detail === "brief"
          ? "分析这组 trader"
          : depth === "summary" && !options.include_calculations
            ? "进一步分析"
            : "简短分析结论",
      tool: "get_portfolio",
      arguments: {
        plan_id: plan.id,
        detail: "detailed",
        analysis_depth:
          detail === "brief" ||
          options.include_calculations ||
          depth === "extended"
            ? "summary"
            : "extended",
        include_calculations: false,
      },
    },
    ...(detail === "detailed"
      ? [
          {
            id: "collapse",
            label: "收起说明",
            tool: "get_portfolio",
            arguments: {
              plan_id: plan.id,
              detail: "brief",
              include_calculations: false,
            },
          },
        ]
      : []),
  ];
  return {
    detail,
    analysis_depth: detail === "detailed" ? depth : null,
    include_calculations: options.include_calculations ?? false,
    plan_id: plan.id,
    trader_ids: plan.allocations.map((a) => a.trader.id),
    analysis,
    markdown: markdown.join("\n"),
    instruction:
      "直接展示此 markdown，保持用户语言。分析先给结论，只有进一步分析才展开模型分项；仅在用户明确询问计算方法时 include_calculations:true。不得自动补充公式、接口评价、其他方案或未验证的成交金额、收益与风险改善。方案仍需本人另行确认。",
    next_actions: nextActions,
  };
}

export interface CandidateDisplayOptions {
  historical_metrics?: ("roi" | "drawdown")[];
}

const periodDay = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function historicalPeriodLabel(
  c: Candidate,
  metric: "roi" | "drawdown",
) {
  const period = c.metric_periods?.[metric];
  const bounds = verifiedWindow(c, metric);
  if (bounds) {
    return `${periodDay.format(new Date(bounds.start_at))} 至 ${periodDay.format(new Date(bounds.end_at))}（上海）`;
  }
  return metric === "roi" && period?.period === "source_month"
    ? "来源月收益，起止未核实"
    : metric === "drawdown"
      ? "统计周期未核实，不可视为同周期比较"
      : "统计周期未核实";
}
function historicalMetricCell(c: Candidate, metric: "roi" | "drawdown") {
  const value = metric === "roi" ? c.source_roi_pct : c.source_drawdown_pct;
  const reported =
    typeof value === "number" &&
    Number.isFinite(value) &&
    (metric !== "drawdown" || value >= 0)
      ? value
      : null;
  return `${pct(reported)} · ${historicalPeriodLabel(c, metric)}`;
}

export function candidateDisplay(
  candidates: Candidate[],
  plan: Plan | undefined,
  detail: Detail = "brief",
  availability:
    | "available"
    | "source_empty"
    | "no_matching_candidates"
    | "end_of_results" = candidates.length
    ? "available"
    : "no_matching_candidates",
  options: CandidateDisplayOptions = {},
) {
  const metrics = [...new Set(options.historical_metrics ?? [])];
  const columns = [
    "Trader",
    "Score",
    "资产",
    ...metrics.map((metric) =>
      metric === "roi" ? "来源收益（周期）" : "来源回撤（周期）",
    ),
  ];
  return {
    detail,
    availability,
    historical_metrics: metrics,
    base_plan_id: plan?.id ?? null,
    markdown: [
      plan
        ? `其他候选 · 原 ${plan.allocations.length} 人方案 ${plan.id.slice(-8)} 保持不变`
        : "候选 trader",
      ...(candidates.length
        ? [
            `| ${columns.join(" | ")} |`,
            `| ${["---", "---:", "---", ...metrics.map(() => "---")].join(" | ")} |`,
            ...candidates.map(
              (c) =>
                `| ${[
                  cell(c.handle),
                  cell(
                    typeof c.score === "number" && Number.isFinite(c.score)
                      ? c.score
                      : "未提供",
                  ),
                  cell(c.assets.join("/")),
                  ...metrics.map((metric) => historicalMetricCell(c, metric)),
                ].join(" | ")} |`,
            ),
          ]
        : [
            availability === "source_empty"
              ? "来源暂未返回可用 trader 数据，不能据此认定市场没有 trader。稍后可刷新候选；原方案保持不变，不因此缩减人数或调整预算和风险。"
              : availability === "end_of_results"
                ? "本页已到候选边界，原方案保持不变。可从首页重新浏览。"
                : "当前没有符合原条件的其他候选；原方案保持不变。可保留方案，或明确调整筛选条件后再浏览。",
          ]),
      ...(candidates.length
        ? [
            "这里只浏览候选，不生成新组合。选择替换对象后，一换一保留人数、金额和风险设置。",
          ]
        : []),
      ...(detail === "detailed"
        ? [
            "候选排名与降低风险是不同的判断；来源历史周期须单独核对，未测得历史亏损相关性。",
          ]
        : []),
    ].join("\n"),
    instruction:
      "简短展示候选和原方案未变；不创建两人方案、不调整预算或风险。让用户明确选择换出和换入的 trader 后，再调用 recalculate_plan.replacements。",
  };
}
