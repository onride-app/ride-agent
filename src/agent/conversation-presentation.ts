import {
  cash,
  D,
  type Allocation,
  type Candidate,
  type Plan,
} from "./domain.js";
import { compatibility } from "./conversational.js";

export type Detail = "brief" | "detailed";
// Trader text is untrusted. It may supply a label, never Markdown or actions.
const cell = (value: unknown) =>
  String(value ?? "—")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 80)
    .replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
const pct = (value: number | null) =>
  value == null ? "未提供" : `${value.toFixed(2)}%`;

export function copyRule(a: Allocation) {
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
    details:
      mode === "fixed"
        ? "固定开仓数量依据经核实的源成交、固定保证金、允许杠杆及价格计算；不靠仓位变化猜测新成交。"
        : `目标数量 = 源仓位数量 × 分配资金 / 核实的源账户权益 × 杠杆修正 × ${multiplier}；Perps 杠杆修正为允许杠杆 / max(1, 源杠杆)。预测市场为 1x。实际还须按精度取整、净额合并并检查下单限制。`,
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

export function planDisplay(
  plan: Plan,
  detail: Detail = "brief",
  previous?: Plan,
) {
  const rules = plan.allocations.map((a) => ({
    trader_id: a.trader.id,
    ...copyRule(a),
  }));
  const uniqueRules = [...new Set(rules.map((r) => r.summary))];
  const mixedSummary = [
    ...(rules.some((r) => r.mode !== "fixed")
      ? ["按分配资金与源账户权益的比例缩放源仓位，并应用各自保存的倍率。"]
      : []),
    ...(rules.some((r) => r.mode === "fixed")
      ? ["固定模式按逐人设定的保证金跟随核实的源开仓。"]
      : []),
    "杠杆按逐人保存值及交易所限制执行；受预算、风控及最小下单限制约束，展开说明查看逐人设置。",
  ].join(" ");
  const change = previous ? planChange(previous, plan) : null;
  const markdown = [
    `${plan.allocations.length} 人方案 · ${cell(plan.id.slice(-8))} · 预算 ${cell(plan.preferences.budget_usdc)} USDC${plan.expires_at <= Date.now() ? "（已过期，需刷新后确认）" : ""}`,
    "| Trader | USDC | Score | 来源收益 | 来源回撤 |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...plan.allocations.map(
      (a) =>
        `| ${cell(a.trader.handle)} | ${cell(a.amount_usdc)} | ${cell(a.trader.score)} | ${pct(a.trader.source_roi_pct)} | ${pct(a.trader.source_drawdown_pct)} |`,
    ),
    `跟单：${uniqueRules.length === 1 ? uniqueRules[0] : mixedSummary}`,
    `组合退出触发（${plan.preference_sources?.loss_trigger_pct === "user" ? "你设置的" : plan.preference_sources?.loss_trigger_pct === "recommended" ? "系统建议，待确认" : "设置来源未核实"}）：${plan.preferences.loss_trigger_pct}%（按预算为 ${cash(D(plan.preferences.budget_usdc).times(plan.preferences.loss_trigger_pct).div(100))} USDC），触发后尝试退出，不保证最大亏损。`,
    "来源历史的统计周期可能未核实，不代表跟单收益；尚无实测组合风险改善结论。",
    ...(change
      ? [
          `相对 ${previous!.id.slice(-8)}：${change.before_count} 人 → ${change.after_count} 人；${change.added_trader_ids.length || change.removed_trader_ids.length ? `移出 ${change.removed_trader_ids.length} 位、加入 ${change.added_trader_ids.length} 位` : "成员保持不变"}。原方案保留。`,
        ]
      : []),
  ];
  if (detail === "detailed") {
    markdown.push("跟单规则与方案依据：");
    for (const [i, a] of plan.allocations.entries()) {
      markdown.push(
        `${cell(a.trader.handle)}：${rules[i].label}。${rules[i].summary} ${rules[i].details}`,
      );
      const roi = a.trader.metric_periods?.roi;
      const dd = a.trader.metric_periods?.drawdown;
      markdown.push(
        `来源收益周期：${cell(roi?.start_at != null && roi?.end_at != null ? `${new Date(roi.start_at).toISOString().slice(0, 10)} 至 ${new Date(roi.end_at).toISOString().slice(0, 10)}` : roi?.period === "source_month" ? "来源标注月收益，日期未核实" : "统计周期未核实")}；回撤周期：${cell(dd?.start_at != null && dd?.end_at != null ? `${new Date(dd.start_at).toISOString().slice(0, 10)} 至 ${new Date(dd.end_at).toISOString().slice(0, 10)}` : "统计周期未核实")}。`,
      );
    }
    const assessment = compatibility(plan);
    markdown.push(
      `资产、方向和风格重叠标记 ${assessment.warnings} 项；历史组合回撤、亏损相关性未测得。资金分配与实际仓位敞口分别计算。`,
    );
    if (change)
      markdown.push(
        `对比 ${change.base_plan_id.slice(-8)} → ${change.new_plan_id.slice(-8)}：重叠标记 ${change.overlap_assessment.before_flags} → ${change.overlap_assessment.after_flags}；最大资金权重 ${change.capital_concentration.before_max_weight_pct}% → ${change.capital_concentration.after_max_weight_pct}%。${change.explanation}`,
      );
  }
  markdown.push(
    detail === "brief"
      ? "可选：查看其他 trader · 展开说明"
      : "可选：查看其他 trader · 收起说明",
  );
  return {
    detail,
    plan_id: plan.id,
    trader_ids: plan.allocations.map((a) => a.trader.id),
    markdown: markdown.join("\n"),
    instruction:
      "直接展示此 markdown，保持用户语言；默认不重复输出分析段落、计算过程或额外方案。只有明确要求才展开说明或改变人数。方案仍需本人另行确认，风险数据缺失不可省略。",
    next_actions: [
      {
        id: "browse_alternatives",
        label: "查看其他 trader",
        tool: "browse_traders",
        arguments: {
          plan_id: plan.id,
          exclude_selected: true,
          detail: "brief",
        },
      },
      {
        id: detail === "brief" ? "explain" : "collapse",
        label: detail === "brief" ? "展开说明" : "收起说明",
        tool: "get_portfolio",
        arguments: {
          plan_id: plan.id,
          detail: detail === "brief" ? "detailed" : "brief",
        },
      },
    ],
  };
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
) {
  return {
    detail,
    availability,
    base_plan_id: plan?.id ?? null,
    markdown: [
      plan
        ? `其他候选 · 原 ${plan.allocations.length} 人方案 ${plan.id.slice(-8)} 保持不变`
        : "候选 trader",
      ...(candidates.length
        ? [
            "| Trader | Score | 资产 |",
            "| --- | ---: | --- |",
            ...candidates.map(
              (c) =>
                `| ${cell(c.handle)} | ${cell(c.score)} | ${cell(c.assets.join("/"))} |`,
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
