import {
  cash,
  D,
  type Allocation,
  type Candidate,
  type Plan,
} from "./domain.js";
import { compatibility } from "./conversational.js";
import { verifiedWindow } from "./candidate-filters.js";
import { localized, resolveLocale, type Locale } from "./locale.js";

export type Detail = "brief" | "detailed";
export interface AnalysisOptions {
  analysis_depth?: "summary" | "extended";
  include_calculations?: boolean;
  locale?: Locale;
  copy_evidence?: Readonly<
    Record<
      string,
      {
        readonly source_equity_usdc: string | null;
        readonly next_order_size: unknown | null;
      }
    >
  >;
}
// Trader text is untrusted. It may supply a label, never Markdown or actions.
const cell = (value: unknown) =>
  String(value ?? "—")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 80)
    .replace(/[\\`*_{}\[\]<>|]/g, "\\$&");
const pct = (value: number | null, locale?: Locale) =>
  typeof value !== "number" || !Number.isFinite(value)
    ? localized(locale, "未提供", "Unavailable")
    : `${value.toFixed(2)}%`;

const copyabilityReasons: Record<string, [string, string]> = {
  ASSET_CONCENTRATION: [
    "拟议资产暴露超过现有集中度上限",
    "proposed asset exposure exceeds the existing concentration limit",
  ],
  BUDGET_EXCEEDED: [
    "拟议暴露或保证金超过已批准的预算上限",
    "proposed exposure or margin exceeds the approved budget limit",
  ],
  SCOPED_COLLATERAL_REQUIRED: [
    "所选 DEX 的可用保证金不足",
    "available collateral in the selected DEX is insufficient",
  ],
  INVALID_OUTCOME_POSITION: [
    "拟议结果代币持仓为负，现有规则不允许",
    "the proposed outcome position has negative inventory, which is not permitted",
  ],
  BELOW_MINIMUM_NOTIONAL: [
    "取整后的订单金额低于交易所最小下单额",
    "rounded order notional is below the venue minimum",
  ],
  BELOW_MINIMUM_QUANTITY: [
    "取整后的数量低于交易所最小下单数量",
    "rounded quantity is below the venue minimum",
  ],
  ENTRY_DEVIATION_OR_MISSING_SOURCE_PRICE: [
    "源开仓价缺失或入场价偏离超过现有上限",
    "the source entry price is missing or entry deviation exceeds the existing limit",
  ],
  SOURCE_STALE: ["源仓位数据已过时", "source-position data is stale"],
  SOURCE_INCOMPLETE: ["源仓位数据不完整", "source-position data is incomplete"],
  SOURCE_EQUITY_UNVERIFIED: [
    "源账户权益尚未核实",
    "source equity is unverified",
  ],
  SOURCE_LEVERAGE_UNAVAILABLE: [
    "实际源杠杆尚未核实",
    "actual source leverage is unverified",
  ],
  FIXED_FILL_EVIDENCE_REQUIRED: [
    "固定模式缺少经核实的源成交证据",
    "fixed mode lacks verified source-fill evidence",
  ],
  VENUE_RULES_UNAVAILABLE: [
    "当前交易所逐币规则尚未核实",
    "current per-asset venue rules are unverified",
  ],
  INVALID_ORDER_QUANTITY: [
    "目标数量不符合交易所当前精度",
    "target quantity does not match current venue precision",
  ],
  SOURCE_UNAVAILABLE: [
    "本次源账户数据读取不可用",
    "source-account data is unavailable for this read",
  ],
  SOURCE_EVIDENCE_UNAVAILABLE: [
    "本次源账户证据读取不可用",
    "source-account evidence is unavailable for this read",
  ],
  SOURCE_STATE_INCOMPLETE: [
    "本次源账户状态不完整",
    "source-account state is incomplete for this read",
  ],
  SOURCE_EQUITY_UNAVAILABLE: [
    "本次源账户权益不可用",
    "source equity is unavailable for this read",
  ],
  SOURCE_EQUITY_NONPOSITIVE: [
    "源账户权益不满足正数缩放条件",
    "source equity does not satisfy positive-equity sizing",
  ],
  SOURCE_POSITION_UNAVAILABLE: [
    "本次源仓位证据不可用",
    "source-position evidence is unavailable for this read",
  ],
  SOURCE_POSITION_PRICE_UNAVAILABLE: [
    "本次源仓位价格不可用",
    "source-position price is unavailable for this read",
  ],
  SOURCE_POSITION_EVIDENCE_INCOMPLETE: [
    "本次源仓位证据不完整",
    "source-position evidence is incomplete for this read",
  ],
  SOURCE_SCOPE_UNSUPPORTED: [
    "本次预检尚不覆盖该源账户范围",
    "this precheck does not cover the source-account scope",
  ],
  SOURCE_ACCOUNT_MODE_UNSUPPORTED: [
    "本次预检尚不支持该源账户模式",
    "this precheck does not support the source-account mode",
  ],
  SOURCE_DEX_ABSTRACTION_UNVERIFIED: [
    "源账户的 DEX 资金范围尚未核实",
    "the source account's DEX collateral scope is unverified",
  ],
  UNIFIED_DEX_COVERAGE_UNVERIFIED: [
    "统一账户的 DEX 覆盖尚未核实",
    "DEX coverage for the unified account is unverified",
  ],
  PREDICTION_EVIDENCE_UNSUPPORTED: [
    "本次只读预检尚不覆盖预测市场源证据",
    "this read-only precheck does not cover prediction-source evidence",
  ],
  MARKET_PRECHECK_UNSUPPORTED: [
    "本次只读预检尚不覆盖该市场",
    "this read-only precheck does not cover this market",
  ],
  BASKET_EVIDENCE_INCOMPLETE: [
    "部分组合证据缺失，尚未完成净额订单检查",
    "some basket evidence is missing, so net-order checks are incomplete",
  ],
  EVIDENCE_READER_UNAVAILABLE: [
    "本次只读证据读取不可用",
    "read-only evidence is unavailable for this request",
  ],
  EVIDENCE_READ_TIMEOUT: [
    "本次只读证据读取超时",
    "this read-only evidence request timed out",
  ],
  EVIDENCE_READ_ABORTED: [
    "本次只读证据读取已取消",
    "this read-only evidence request was cancelled",
  ],
  RISK_EVIDENCE_UNAVAILABLE: [
    "本次风控预检证据不可用",
    "risk-precheck evidence is unavailable for this request",
  ],
};

export function copyabilityReason(code: string, locale?: Locale) {
  const text = copyabilityReasons[code];
  return text
    ? localized(locale, ...text)
    : localized(
        locale,
        "本次下单条件尚未核实",
        "this order's conditions are unverified",
      );
}

function copyabilitySummary(options: AnalysisOptions, compact = false) {
  if (!options.copy_evidence) return null;
  const codes = new Set<string>();
  let checked = false;
  for (const evidence of Object.values(options.copy_evidence)) {
    const next = evidence.next_order_size;
    if (!next || typeof next !== "object") continue;
    const row = next as Record<string, unknown>;
    if (
      row.scope !== "hypothetical_initial_target" ||
      !["checked", "blocked", "incomplete", "not_evaluated", "flat"].includes(
        String(row.status),
      )
    )
      continue;
    checked = true;
    if (
      ["blocked", "incomplete", "not_evaluated"].includes(String(row.status)) &&
      typeof row.reason_code === "string"
    )
      codes.add(row.reason_code);
    if (Array.isArray(row.positions))
      for (const position of row.positions)
        if (
          position &&
          ["blocked", "skipped", "not_evaluated"].includes(
            String(position.status),
          ) &&
          typeof position.reason_code === "string"
        )
          codes.add(position.reason_code);
  }
  if (!checked) return null;
  if (compact)
    return codes.size
      ? localized(
          options.locale,
          `初始目标预检：${[...codes].map((code) => copyabilityReason(code, options.locale)).join("；")}`,
          `Initial-target check: ${[...codes].map((code) => copyabilityReason(code, options.locale)).join("; ")}`,
        )
      : localized(
          options.locale,
          "预检仅限当前初始目标，不代表成交覆盖率",
          "the check covers current initial targets, not fill coverage",
        );
  if (codes.size)
    return localized(
      options.locale,
      `本次复制性预检：${[...codes].map((code) => copyabilityReason(code, options.locale)).join("；")}；这是初始目标预检，不是实盘成交覆盖率。`,
      `Copyability precheck: ${[...codes].map((code) => copyabilityReason(code, options.locale)).join("; ")}; this checks hypothetical initial targets, not real fill coverage.`,
    );
  return localized(
    options.locale,
    "本次预检只覆盖假设的初始目标，不代表实盘成交覆盖率或已经下单。",
    "This precheck covers hypothetical initial targets, not real fill coverage or an executed order.",
  );
}

function briefSetting(a: Allocation, locale?: Locale) {
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const mode = a.copy_mode ?? "ride_recommends";
  const sizing =
    mode === "fixed"
      ? t(
          `固定 ${a.fixed_margin_usdc ?? "未设置"} USDC`,
          `Fixed ${a.fixed_margin_usdc ?? "unset"} USDC`,
        )
      : `${mode === "proportional" ? t("比例", "Proportional") : t("自动", "Auto")} ×${a.proportional_multiplier ?? 1}`;
  return `${sizing} · ${
    a.trader.market === "prediction"
      ? "1x"
      : a.leverage_cap == null
        ? t("源杠杆，无额外上限", "source leverage, no extra cap")
        : t(`保留 ${a.leverage_cap}x 上限`, `saved ${a.leverage_cap}x cap`)
  }`;
}

function briefCopySummary(plan: Plan, options: AnalysisOptions) {
  const t = (zh: string, en: string) => localized(options.locale, zh, en);
  const proportional = plan.allocations.filter((a) => a.copy_mode !== "fixed");
  const fixed = plan.allocations.filter((a) => a.copy_mode === "fixed");
  const perps = plan.allocations.filter((a) => a.trader.market === "perps");
  const multipliers = [
    ...new Set(proportional.map((a) => a.proportional_multiplier ?? 1)),
  ];
  const margins = [
    ...new Set(fixed.map((a) => a.fixed_margin_usdc ?? t("未设置", "unset"))),
  ];
  const caps = [...new Set(perps.map((a) => a.leverage_cap))];
  const clauses = [
    ...(proportional.length
      ? [
          t(
            `按分配资金占核实源权益的比例跟随仓位${multipliers.length === 1 && multipliers[0] !== 1 ? `，再乘 ${multipliers[0]} 倍` : multipliers.length > 1 ? "，倍率见表" : ""}`,
            `scale source positions by allocated USDC / verified source equity${multipliers.length === 1 && multipliers[0] !== 1 ? `, then ×${multipliers[0]}` : multipliers.length > 1 ? ", multipliers in table" : ""}`,
          ),
        ]
      : []),
    ...(fixed.length
      ? [
          t(
            `固定模式每次核实源开仓用${margins.length === 1 ? ` ${margins[0]} USDC` : "表内"}保证金，减仓跟随源成交比例`,
            `fixed mode uses ${margins.length === 1 ? `${margins[0]} USDC` : "table-listed"} margin per verified source opening; reductions follow source fills proportionally`,
          ),
        ]
      : []),
    ...(perps.length
      ? [
          caps.length === 1
            ? caps[0] == null
              ? t(
                  "跟核实源杠杆，无额外上限",
                  "follow verified source leverage, no extra user cap",
                )
              : t(`保留 ${caps[0]}x 用户上限`, `saved ${caps[0]}x user cap`)
            : t("逐人杠杆设置见表", "saved leverage settings in table"),
        ]
      : []),
    ...(plan.allocations.some((a) => a.trader.market === "prediction")
      ? [t("预测市场 1x", "prediction markets 1x")]
      : []),
    t(
      "交易所/预算/风控约束，未达最小下单额跳过",
      "venue, budget and risk limits apply; skip below-minimum orders",
    ),
  ];
  return `${clauses.join(t("；", "; "))}${t("。", ".")}`;
}

function briefPlanMarkdown(
  plan: Plan,
  previous: Plan | undefined,
  options: AnalysisOptions,
) {
  const t = (zh: string, en: string) => localized(options.locale, zh, en);
  let unknownPeriod = false;
  const metric = (c: Candidate, name: "roi" | "drawdown") => {
    const value = name === "roi" ? c.source_roi_pct : c.source_drawdown_pct;
    const unverified =
      typeof value === "number" &&
      Number.isFinite(value) &&
      !verifiedWindow(c, name);
    unknownPeriod ||= unverified;
    return `${pct(value, options.locale)}${unverified ? "†" : ""}`;
  };
  const settings = plan.allocations.map((a) => briefSetting(a, options.locale));
  const showSettings = new Set(settings).size > 1;
  const rows = plan.allocations.map(
    (a, index) =>
      `| ${cell(a.trader.handle)} | ${cell(a.amount_usdc)} | ${cell(a.trader.score)} | ${metric(a.trader, "roi")} | ${metric(a.trader, "drawdown")} |${showSettings ? ` ${cell(settings[index])} |` : ""}`,
  );
  const limitations = [
    copyabilitySummary(options, true),
    plan.risk_selection?.status === "insufficient_evidence" ||
    plan.risk_selection?.status === "unsupported"
      ? t(
          "风险偏好匹配证据不足",
          "risk-preference matching lacks sufficient evidence",
        )
      : null,
  ].filter(Boolean);
  const historyLimit = unknownPeriod
    ? t("†周期未核实，非跟单收益", "† periods unverified; not follower returns")
    : t("来源表现非跟单收益", "source performance is not follower returns");
  const limitation = limitations.length
    ? `${t("限制：", "Limit: ")}${[...limitations, historyLimit].join(t("；", "; "))}`
    : historyLimit;
  const triggerAmount = cash(
    D(plan.preferences.budget_usdc)
      .times(plan.preferences.loss_trigger_pct)
      .div(100),
  );
  const triggerSource =
    plan.preference_sources?.loss_trigger_pct === "user"
      ? t("你设置", "set by you")
      : plan.preference_sources?.loss_trigger_pct === "recommended"
        ? t("建议，待确认", "suggested, unconfirmed")
        : t("来源未核实", "source unverified");
  const change = previous ? planChange(previous, plan, options) : null;
  return [
    t(
      `${plan.allocations.length}人预览 · ${cell(plan.id.slice(-8))} · ${cell(plan.preferences.budget_usdc)} USDC${plan.expires_at <= Date.now() ? "（已过期，需刷新）" : ""}`,
      `${plan.allocations.length}-trader preview · ${cell(plan.id.slice(-8))} · ${cell(plan.preferences.budget_usdc)} USDC${plan.expires_at <= Date.now() ? " (expired; refresh required)" : ""}`,
    ),
    `${t("| Trader | USDC | Score | 来源收益 | 来源回撤 |", "| Trader | USDC | Score | Source return | Source drawdown |")}${showSettings ? t(" 跟单设置 |", " Copy settings |") : ""}`,
    `| --- | ---: | ---: | ---: | ---: |${showSettings ? " --- |" : ""}`,
    ...rows,
    `${t("跟单：", "Copy: ")}${briefCopySummary(plan, options)}`,
    t(
      `组合退出（${triggerSource}）：${plan.preferences.loss_trigger_pct}% / ${triggerAmount} USDC；尝试退出，不保证亏损上限。`,
      `Portfolio exit (${triggerSource}): ${plan.preferences.loss_trigger_pct}% / ${triggerAmount} USDC; attempts an exit, not a guaranteed loss cap.`,
    ),
    `${limitation}${t("。", ".")}`,
    ...(change
      ? [
          t(
            `相对 ${previous!.id.slice(-8)}：${change.before_count} 人 → ${change.after_count} 人，移出 ${change.removed_trader_ids.length} 位、加入 ${change.added_trader_ids.length} 位；原方案保留。`,
            `From ${previous!.id.slice(-8)}: ${change.before_count} → ${change.after_count} traders, ${change.removed_trader_ids.length} removed, ${change.added_trader_ids.length} added; original preserved.`,
          ),
        ]
      : []),
  ];
}

export function copyRule(a: Allocation, options: AnalysisOptions = {}) {
  const t = (zh: string, en: string) => localized(options.locale, zh, en);
  const evidence = options.copy_evidence?.[a.trader.id];
  const mode = a.copy_mode ?? "ride_recommends";
  const multiplier = a.proportional_multiplier ?? 1;
  const sizing =
    mode === "fixed"
      ? t(
          `每个核实的初始源仓位及后续源开仓成交使用 ${a.fixed_margin_usdc ?? "未设置"} USDC 保证金；减仓按源成交比例跟随。`,
          `Use ${a.fixed_margin_usdc ?? "unset"} USDC margin for each verified initial source position and subsequent source opening fill; follow reductions in proportion to source fills.`,
        )
      : t(
          `按分配资金与源账户权益的比例缩放源仓位${multiplier === 1 ? "" : `，再乘 ${multiplier} 倍`}。`,
          `Scale source positions by the allocation relative to verified source equity${multiplier === 1 ? "" : `, then apply the saved ${multiplier}x multiplier`}.`,
        );
  const limits =
    a.trader.market === "perps"
      ? t(
          `${a.leverage_cap == null ? "跟随核实的源杠杆，无额外用户上限" : `额外杠杆上限 ${a.leverage_cap}x`}，同时受交易所限制、预算和风控约束；较低杠杆限制和分配保证金预算会压低目标，不足最小下单额则跳过，不自动加钱或加杠杆。`,
          `${a.leverage_cap == null ? "Follow verified source leverage without an extra user cap" : `Apply the saved ${a.leverage_cap}x extra leverage cap`}, subject to venue limits, budget and risk checks. Lower permitted leverage and the allocated margin budget can reduce targets. Skip below-minimum orders without automatically adding funds or leverage.`,
        )
      : t(
          "预测市场按对应结果仓位跟随，杠杆为 1x；受可用抵押品、预算和交易限制约束。",
          "Follow the matching prediction outcome position at 1x, subject to available collateral, budget and trading limits.",
        );
  return {
    mode,
    label:
      mode === "fixed"
        ? t("固定保证金", "Fixed margin")
        : mode === "proportional"
          ? t("比例跟单", "Proportional copying")
          : t("自动比例跟单", "Automatic proportional copying"),
    sizing,
    summary: [sizing, limits].join(
      resolveLocale(options.locale) === "en" ? " " : "",
    ),
    allocated_usdc: a.amount_usdc,
    fixed_margin_usdc: a.fixed_margin_usdc ?? null,
    proportional_multiplier: multiplier,
    leverage_cap: a.leverage_cap,
    sizing_basis:
      mode === "fixed"
        ? "verified_source_open_fills"
        : "allocation_over_verified_source_equity",
    source_equity_usdc: evidence?.source_equity_usdc ?? null,
    source_equity_status: !evidence
      ? "not_inspected"
      : evidence.source_equity_usdc == null
        ? "unverified"
        : "verified_current_base_perps",
    next_order_size_status: !evidence
      ? "not_inspected"
      : evidence.next_order_size == null
        ? "unverified"
        : "inspection_available",
    next_order_size:
      evidence?.next_order_size == null
        ? null
        : structuredClone(evidence.next_order_size),
    leverage_cap_meaning:
      a.trader.market === "perps"
        ? t(
            "额外用户杠杆上限不代表源交易员的实际杠杆或逐币交易所上限；产品可设置上限为 40x。",
            "An extra user leverage cap is not actual source-trader leverage or a per-asset venue limit; the product permits settings up to 40x.",
          )
        : null,
    ...(options.include_calculations
      ? {
          details:
            mode === "fixed"
              ? t(
                  "固定开仓数量依据经核实的源成交、固定保证金、允许杠杆及价格计算；不靠仓位变化猜测新成交。",
                  "Fixed opening quantity uses verified source fills, fixed margin, permitted leverage and price; a position change alone is not treated as a new fill.",
                )
              : t(
                  `目标数量 = 源仓位数量 × 分配资金 / 核实的源账户权益 × 杠杆修正 × ${multiplier}；Perps 杠杆修正为允许杠杆 / max(1, 源杠杆)。预测市场为 1x。实际还须按精度取整、净额合并并检查下单限制。`,
                  `Target quantity = source quantity × allocation / verified source equity × leverage adjustment × ${multiplier}; the Perps leverage adjustment is permitted leverage / max(1, source leverage). Prediction markets use 1x. Precision rounding, netting and order limits still apply.`,
                ),
        }
      : {}),
  };
}

export function planChange(
  previous: Plan,
  plan: Plan,
  options: { locale?: Locale } = {},
) {
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
    explanation: localized(
      options.locale,
      "仅比较资金权重和资产、方向、风格重叠标记；人数、单人金额或标记变化不能证明组合风险降低。历史组合回撤和亏损相关性未测得。",
      "This compares capital weights and asset, direction and style overlap flags only. Changes in trader count, slot amounts or flags do not establish lower portfolio risk. Historical portfolio drawdown and loss correlation have not been measured.",
    ),
    original_plan_unchanged: true,
    execution_authorized: false,
  };
}

const componentLabels: Record<string, [string, string]> = {
  stability: ["稳定性", "Stability"],
  pathSmoothness: ["收益路径平滑度", "Return-path smoothness"],
  drawdownRecovery: ["回撤恢复", "Drawdown recovery"],
  positionLeverageStability: ["杠杆稳定性", "Leverage stability"],
  profitQuality: ["盈利质量", "Profit quality"],
  copyability: ["可复制性", "Copyability"],
  stability_floor: ["稳定性相关分项的短板", "Stability component floor"],
  opportunity_floor: [
    "盈利质量与可复制性的短板",
    "Profit-quality and copyability floor",
  ],
  balanced_floor: [
    "稳定性与盈利质量的均衡",
    "Stability and profit-quality balance",
  ],
  copy_score: ["Copy Score", "Copy Score"],
};
const componentLabel = (key: string, locale?: Locale) => {
  const labels = componentLabels[key];
  return labels
    ? localized(locale, ...labels)
    : localized(locale, "模型分项", "Model component");
};
const riskLabels = {
  low: ["稳健", "conservative"],
  medium: ["平衡", "balanced"],
  high: ["进取", "aggressive"],
} as const;
const riskLabel = (
  profile: keyof typeof riskLabels | undefined,
  locale?: Locale,
) =>
  profile
    ? localized(locale, riskLabels[profile][0], riskLabels[profile][1])
    : localized(locale, "当前", "current");
const modelMetric = (c: Candidate, key: string) => {
  const value = c.components?.[key];
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : null;
};

export function riskSelectionReasons(
  plan: Plan,
  traderId: string,
  options: { locale?: Locale } = {},
) {
  const selected = plan.risk_selection?.selected.find(
    (row) => row.trader_id === traderId,
  );
  if (!selected) return [];
  if (plan.risk_selection?.status !== "applied")
    return [analysisSummary(plan, undefined, options).conclusion];
  return plan.risk_selection.priorities.flatMap((key) => {
    const value = selected.metrics[key];
    return typeof value === "number" && Number.isFinite(value)
      ? [
          localized(
            options.locale,
            `${componentLabel(key, options.locale)}模型分数 ${value.toFixed(2)}`,
            `${componentLabel(key, options.locale)} model score ${value.toFixed(2)}`,
          ),
        ]
      : [];
  });
}

export function riskSelectionView(
  plan: Plan,
  options: { locale?: Locale } = {},
) {
  const selection = plan.risk_selection;
  if (!selection) return null;
  if (!options.locale) return selection;
  return {
    ...selection,
    explanation: analysisSummary(plan, undefined, options).conclusion,
    selected: selection.selected.map((row) => ({
      ...row,
      reasons: riskSelectionReasons(plan, row.trader_id, options),
    })),
  };
}

function comparableModelVersions(plan: Plan) {
  const version = plan.allocations[0]?.trader.score_version;
  return (
    typeof version === "string" &&
    version.trim().length > 0 &&
    !["unknown", "unavailable"].includes(version.toLowerCase()) &&
    plan.allocations.every((a) => a.trader.score_version === version)
  );
}

function analysisSummary(
  plan: Plan,
  previous?: Plan,
  options: AnalysisOptions = {},
) {
  const t = (zh: string, en: string) => localized(options.locale, zh, en);
  const risk = plan.risk_selection;
  const profile = plan.preferences.risk_tolerance;
  const profileLabel = riskLabel(profile, options.locale);
  const change = previous ? planChange(previous, plan, options) : null;
  const conclusion =
    risk?.status === "applied"
      ? t(
          `这组 trader 已按${profileLabel}偏好进行模型分项匹配，资金分配和退出设置以本方案为准。`,
          `These traders were matched to your ${profileLabel} preference using model components; this plan's allocations and exit settings apply.`,
        )
      : plan.selection_source === "explicit"
        ? t(
            "这份预览保留你指定的交易员；调整偏好不会自动替换这些成员。",
            "This preview retains your selected traders; changing preferences does not automatically replace them.",
          )
        : risk?.status === "preserved_selection"
          ? t(
              "本次刷新保留原名单，未重新系统选人。",
              "This refresh preserves the original traders without a new system selection.",
            )
          : risk?.status === "insufficient_evidence" ||
              risk?.status === "unsupported"
            ? t(
                "当前证据不足以确认这组 trader 已完成所选风险偏好的匹配。",
                "The available evidence does not establish that these traders were matched to the selected risk preference.",
              )
            : t(
                `这是一份 ${plan.allocations.length} 人跟单预览，是否实际成交仍取决于每笔订单条件。`,
                `This is a ${plan.allocations.length}-trader copying preview; actual fills still depend on each order's conditions.`,
              );
  const equalAmounts = plan.allocations.every((a) =>
    D(a.amount_usdc).eq(plan.allocations[0]?.amount_usdc ?? 0),
  );
  const evidence: string[] = [
    equalAmounts && plan.allocations.length
      ? t(
          `每人分配 ${plan.allocations[0].amount_usdc} USDC；这是资金配置，不能据此确定能复制多少笔交易。`,
          `Each trader is allocated ${plan.allocations[0].amount_usdc} USDC; an allocation alone does not establish how many trades can be copied.`,
        )
      : t(
          "各人的资金配置见上表；不能仅凭分配金额确定实际成交覆盖率。",
          "Allocations are listed above; amounts alone do not establish actual fill coverage.",
        ),
  ];
  if (risk?.status === "applied") {
    const priorities = risk.priorities
      .map((key) => componentLabel(key, options.locale))
      .slice(0, 3);
    evidence.push(
      t(
        `本次选人优先考虑${priorities.map(cell).join("、")}，Copy Score 的原始含义保持不变。`,
        `Selection prioritizes ${priorities.map(cell).join(", ")}; the meaning of Copy Score is unchanged.`,
      ),
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
          ? t(
              `${cell(leaders[0].a.trader.handle)} 的杠杆稳定性模型分数为 ${maximum.toFixed(2)}，在这组中最高。`,
              `${cell(leaders[0].a.trader.handle)} has the highest leverage-stability model score in this group: ${maximum.toFixed(2)}.`,
            )
          : t(
              `这组有 ${leaders.length} 人的杠杆稳定性模型分数并列最高（${maximum.toFixed(2)}）。`,
              `${leaders.length} traders tie for the highest leverage-stability model score in this group (${maximum.toFixed(2)}).`,
            ),
      );
    }
  }
  if (change) {
    evidence.push(
      t(
        `相对原方案，移出 ${change.removed_trader_ids.length} 位、加入 ${change.added_trader_ids.length} 位；人数 ${change.before_count} → ${change.after_count}，原方案保留。`,
        `Compared with the original plan, ${change.removed_trader_ids.length} traders were removed and ${change.added_trader_ids.length} added; count ${change.before_count} → ${change.after_count}. The original plan is preserved.`,
      ),
    );
  } else if (
    plan.allocations.some((a) => a.trader.score_explanation?.cap_applied)
  ) {
    evidence.push(
      t(
        "部分展示分数受等级封顶影响；同分不代表交易行为或盈利质量相同。",
        "Some displayed scores are capped by tier; equal scores do not imply identical trading behavior or profit quality.",
      ),
    );
  }
  return { conclusion, evidence: evidence.slice(0, 3) };
}

function planDisplayView(
  plan: Plan,
  detail: Detail = "brief",
  previous?: Plan,
  options: AnalysisOptions = {},
) {
  const t = (zh: string, en: string) => localized(options.locale, zh, en);
  const depth = options.analysis_depth ?? "summary";
  const rules = plan.allocations.map((a) => ({
    trader_id: a.trader.id,
    ...copyRule(a, options),
  }));
  const uniqueRules = [...new Set(rules.map((r) => r.summary))];
  const mixedSummary = [
    ...(rules.some((r) => r.mode !== "fixed")
      ? [
          t(
            "按分配资金与源账户权益的比例缩放源仓位，并应用各自保存的倍率。",
            "Scale source positions by allocation relative to verified source equity and apply each saved multiplier.",
          ),
        ]
      : []),
    ...(rules.some((r) => r.mode === "fixed")
      ? [
          t(
            "固定模式按逐人设定的保证金跟随核实的源开仓。",
            "Fixed mode uses each trader's saved margin for verified source openings.",
          ),
        ]
      : []),
    t(
      "杠杆按逐人保存值及交易所限制执行；受预算、风控及最小下单限制约束。",
      "Saved leverage settings, venue limits, budget, risk checks and minimum order sizes apply.",
    ),
  ].join(resolveLocale(options.locale) === "en" ? " " : "");
  const change = previous ? planChange(previous, plan, options) : null;
  const analysis =
    detail === "detailed" ? analysisSummary(plan, previous, options) : null;
  const triggerSource =
    plan.preference_sources?.loss_trigger_pct === "user"
      ? t("你设置的", "set by you")
      : plan.preference_sources?.loss_trigger_pct === "recommended"
        ? t("系统建议，待确认", "suggested, awaiting confirmation")
        : t("设置来源未核实", "setting source unverified");
  const triggerAmount = cash(
    D(plan.preferences.budget_usdc)
      .times(plan.preferences.loss_trigger_pct)
      .div(100),
  );
  const copyability = copyabilitySummary(options);
  const markdown = [
    t(
      `${plan.allocations.length} 人方案 · ${cell(plan.id.slice(-8))} · 预算 ${cell(plan.preferences.budget_usdc)} USDC${plan.expires_at <= Date.now() ? "（已过期，需刷新后确认）" : ""}`,
      `${plan.allocations.length}-trader plan · ${cell(plan.id.slice(-8))} · Budget ${cell(plan.preferences.budget_usdc)} USDC${plan.expires_at <= Date.now() ? " (expired; refresh before confirming)" : ""}`,
    ),
    t(
      "| Trader | USDC | Score | 来源收益 | 来源回撤 |",
      "| Trader | USDC | Score | Source return | Source drawdown |",
    ),
    "| --- | ---: | ---: | ---: | ---: |",
    ...plan.allocations.map(
      (a) =>
        `| ${cell(a.trader.handle)} | ${cell(a.amount_usdc)} | ${cell(a.trader.score)} | ${pct(a.trader.source_roi_pct, options.locale)} | ${pct(a.trader.source_drawdown_pct, options.locale)} |`,
    ),
    ...(plan.risk_selection
      ? [
          plan.risk_selection.status === "applied"
            ? t(
                `选人：已按${riskLabel(plan.preferences.risk_tolerance, options.locale)}偏好匹配同版模型分项；不是组合收益或风险改善的实测结论。`,
                `Selection: matched to your ${riskLabel(plan.preferences.risk_tolerance, options.locale)} preference using same-version model components; this is not measured portfolio return or risk improvement.`,
              )
            : plan.risk_selection.status === "insufficient_evidence" ||
                plan.risk_selection.status === "unsupported"
              ? t(
                  "选人：风险分项证据不足或不适用，本次未完成风险偏好匹配。",
                  "Selection: risk-component evidence is insufficient or inapplicable; risk-preference matching was not completed.",
                )
              : plan.risk_selection.status === "preserved_selection"
                ? plan.selection_source === "explicit"
                  ? t(
                      "选人：保留你指定的名单，本次没有重新系统选人。",
                      "Selection: your chosen traders are preserved without a new system selection.",
                    )
                  : t(
                      "选人：保留原名单，本次没有重新系统选人。",
                      "Selection: the original traders are preserved without a new system selection.",
                    )
                : t(
                    "选人：未指定低、中、高风险偏好。",
                    "Selection: no low, medium or high risk preference was specified.",
                  ),
        ]
      : []),
    `${t("跟单：", "Copying: ")}${uniqueRules.length === 1 ? uniqueRules[0] : mixedSummary}`,
    t(
      `组合退出触发（${triggerSource}）：${plan.preferences.loss_trigger_pct}%（按预算为 ${triggerAmount} USDC），触发后尝试退出，不保证最大亏损。`,
      `Portfolio exit trigger (${triggerSource}): ${plan.preferences.loss_trigger_pct}% (${triggerAmount} USDC of the budget). An exit is attempted when triggered; this is not a guaranteed maximum loss.`,
    ),
    ...(copyability ? [copyability] : []),
    t(
      "来源历史的统计周期可能未核实，不代表跟单收益；尚无实测组合风险改善结论。",
      "Source-history periods may be unverified and do not represent follower returns; measured portfolio risk improvement is unavailable.",
    ),
    ...(change
      ? [
          t(
            `相对 ${previous!.id.slice(-8)}：${change.before_count} 人 → ${change.after_count} 人；${change.added_trader_ids.length || change.removed_trader_ids.length ? `移出 ${change.removed_trader_ids.length} 位、加入 ${change.added_trader_ids.length} 位` : "成员保持不变"}。原方案保留。`,
            `Compared with ${previous!.id.slice(-8)}: ${change.before_count} → ${change.after_count} traders; ${change.added_trader_ids.length || change.removed_trader_ids.length ? `${change.removed_trader_ids.length} removed, ${change.added_trader_ids.length} added` : "members unchanged"}. The original plan is preserved.`,
          ),
        ]
      : []),
  ];
  if (detail === "brief")
    markdown.splice(
      0,
      markdown.length,
      ...briefPlanMarkdown(plan, previous, options),
    );
  markdown.push(
    t(
      "模式可改：自动比例 / 比例倍率 / Perps 固定保证金（需每笔 USDC）；修改后重新预览再确认。",
      "Mode choices: automatic proportional / custom multiplier / Perps fixed USDC per entry. Preview edits before confirming.",
    ),
  );
  if (analysis) {
    markdown.push(
      `${t("分析结论：", "Analysis: ")}${analysis.conclusion}`,
      ...analysis.evidence.map((line) => `- ${line}`),
    );
    if (depth === "extended") {
      const sameVersion = comparableModelVersions(plan);
      markdown.push(
        t(
          `模型分项${sameVersion ? "（同一评分版本）" : "（评分版本未核实或不同，不作直接高低比较）"}：`,
          `Model components ${sameVersion ? "(same scoring version)" : "(scoring versions unverified or different; do not compare directly)"}:`,
        ),
        t(
          "| Trader | 稳定性 | 杠杆稳定性 | 盈利质量 | 可复制性 |",
          "| Trader | Stability | Leverage stability | Profit quality | Copyability |",
        ),
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
                return value == null
                  ? t("未提供", "Unavailable")
                  : value.toFixed(2);
              })
              .join(" | ")} |`,
        ),
      );
      const selected =
        plan.risk_selection?.status === "applied"
          ? plan.risk_selection.selected
          : [];
      for (const a of plan.allocations) {
        const reasons = selected.length
          ? riskSelectionReasons(plan, a.trader.id, options).slice(0, 2)
          : [];
        if (reasons?.length)
          markdown.push(
            `${cell(a.trader.handle)}${t("：", ": ")}${reasons.map(cell).join(t("；", "; "))}${t("。", ".")}`,
          );
      }
      const assessment = compatibility(plan);
      markdown.push(
        t(
          `资产、方向和风格重叠标记 ${assessment.warnings} 项；模型分项不等于实时杠杆或实际跟单收益。`,
          `${assessment.warnings} asset, direction and style overlap flags; model components are not live leverage or actual follower returns.`,
        ),
      );
    }
  }
  if (options.include_calculations) {
    markdown.push(
      t("计算方法（按你的请求）：", "Calculation method (as requested):"),
      ...new Set(rules.flatMap((rule) => (rule.details ? [rule.details] : []))),
    );
  }
  markdown.push(
    detail === "brief"
      ? t(
          "需本人确认；可分析这组 trader",
          "Requires your confirmation · Analyze traders",
        )
      : depth === "summary" && !options.include_calculations
        ? t(
            "可选：进一步分析 · 查看其他 trader",
            "Options: further analysis · browse alternatives",
          )
        : t(
            "可选：简短分析结论 · 查看其他 trader",
            "Options: brief analysis · browse alternatives",
          ),
  );
  const nextActions = [
    {
      id: "browse_alternatives",
      label: t("查看其他 trader", "Browse alternatives"),
      tool: "browse_traders",
      arguments: {
        plan_id: plan.id,
        exclude_selected: true,
        detail: "brief",
        ...(options.locale ? { locale: options.locale } : {}),
      },
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
          ? t("分析这组 trader", "Analyze these traders")
          : depth === "summary" && !options.include_calculations
            ? t("进一步分析", "Further analysis")
            : t("简短分析结论", "Brief analysis"),
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
        ...(options.locale ? { locale: options.locale } : {}),
      },
    },
    ...(detail === "detailed"
      ? [
          {
            id: "collapse",
            label: t("收起说明", "Collapse details"),
            tool: "get_portfolio",
            arguments: {
              plan_id: plan.id,
              detail: "brief",
              include_calculations: false,
              ...(options.locale ? { locale: options.locale } : {}),
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
    instruction: t(
      "直接展示此 markdown，保持用户语言。分析先给结论，只有进一步分析才展开模型分项；仅在用户明确询问计算方法时 include_calculations:true。不得自动补充公式、接口评价、其他方案或未验证的成交金额、收益与风险改善。方案仍需本人另行确认。",
      "Show this Markdown directly in English. Lead analysis with its conclusion and expand model components only for further analysis. Use include_calculations:true only when calculation methods are explicitly requested. Do not append formulas, interface audits, other plans or unverified fills, returns or risk improvements. The user must separately confirm the plan.",
    ),
    next_actions: nextActions,
  };
}

export function planDisplay(
  plan: Plan,
  detail: Detail = "brief",
  previous?: Plan,
  options: AnalysisOptions = {},
) {
  const view = planDisplayView(plan, detail, previous, options);
  return {
    ...view,
    ...(options.locale
      ? {}
      : {
          markdown_by_locale: {
            zh: view.markdown,
            en: planDisplayView(plan, detail, previous, {
              ...options,
              locale: "en",
            }).markdown,
          },
          instruction:
            "按用户当前语言，从 markdown_by_locale.zh 或 markdown_by_locale.en 仅选择一份展示，禁止同时展示两份；未缓存 locale 参数的旧客户端也使用相应语言版本，不要求重新登录。保持简短，方案仍需本人另行确认。 For an English request, show only markdown_by_locale.en; for Chinese, show only markdown_by_locale.zh. Do not display both variants or require reconnection. " +
            view.instruction,
        }),
  };
}

export interface CandidateDisplayOptions {
  historical_metrics?: ("roi" | "drawdown")[];
  locale?: Locale;
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
  locale?: Locale,
) {
  const period = c.metric_periods?.[metric];
  const bounds = verifiedWindow(c, metric);
  if (bounds) {
    return localized(
      locale,
      `${periodDay.format(new Date(bounds.start_at))} 至 ${periodDay.format(new Date(bounds.end_at))}（上海）`,
      `${periodDay.format(new Date(bounds.start_at))} to ${periodDay.format(new Date(bounds.end_at))} (Shanghai)`,
    );
  }
  return metric === "roi" && period?.period === "source_month"
    ? localized(
        locale,
        "来源月收益，起止未核实",
        "Source monthly return; dates unverified",
      )
    : metric === "drawdown"
      ? localized(
          locale,
          "统计周期未核实，不可视为同周期比较",
          "Period unverified; not a same-period comparison",
        )
      : localized(locale, "统计周期未核实", "Period unverified");
}
function historicalMetricCell(
  c: Candidate,
  metric: "roi" | "drawdown",
  locale?: Locale,
) {
  const value = metric === "roi" ? c.source_roi_pct : c.source_drawdown_pct;
  const reported =
    typeof value === "number" &&
    Number.isFinite(value) &&
    (metric !== "drawdown" || value >= 0)
      ? value
      : null;
  return `${pct(reported, locale)} · ${historicalPeriodLabel(c, metric, locale)}`;
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
  const t = (zh: string, en: string) => localized(options.locale, zh, en);
  const metrics = [...new Set(options.historical_metrics ?? [])];
  const columns = [
    "Trader",
    "Score",
    t("资产", "Assets"),
    ...metrics.map((metric) =>
      metric === "roi"
        ? t("来源收益（周期）", "Source return (period)")
        : t("来源回撤（周期）", "Source drawdown (period)"),
    ),
  ];
  return {
    detail,
    availability,
    historical_metrics: metrics,
    base_plan_id: plan?.id ?? null,
    markdown: [
      plan
        ? t(
            `其他候选 · 原 ${plan.allocations.length} 人方案 ${plan.id.slice(-8)} 保持不变`,
            `Alternatives · original ${plan.allocations.length}-trader plan ${plan.id.slice(-8)} unchanged`,
          )
        : t("候选 trader", "Candidate traders"),
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
                      : t("未提供", "Unavailable"),
                  ),
                  cell(c.assets.join("/")),
                  ...metrics.map((metric) =>
                    historicalMetricCell(c, metric, options.locale),
                  ),
                ].join(" | ")} |`,
            ),
          ]
        : [
            availability === "source_empty"
              ? t(
                  "来源暂未返回可用 trader 数据，不能据此认定市场没有 trader。稍后可刷新候选；原方案保持不变，不因此缩减人数或调整预算和风险。",
                  "The source returned no available trader data; this does not establish that the market has no traders. Retry later. The original plan, count, budget and risk settings are unchanged.",
                )
              : availability === "end_of_results"
                ? t(
                    "本页已到候选边界，原方案保持不变。可从首页重新浏览。",
                    "This is the end of the candidate list; the original plan is unchanged. You can browse again from the first page.",
                  )
                : t(
                    "当前没有符合原条件的其他候选；原方案保持不变。可保留方案，或明确调整筛选条件后再浏览。",
                    "No other candidates currently match the saved conditions; the original plan is unchanged. Keep it, or explicitly adjust the filters before browsing again.",
                  ),
          ]),
      ...(candidates.length
        ? [
            t(
              "这里只浏览候选，不生成新组合。选择替换对象后，一换一保留人数、金额和风险设置。",
              "Browsing does not create a new portfolio. An explicitly chosen one-for-one replacement preserves trader count, slot amounts and risk settings.",
            ),
          ]
        : []),
      ...(detail === "detailed"
        ? [
            t(
              "候选排名与降低风险是不同的判断；来源历史周期须单独核对，未测得历史亏损相关性。",
              "Candidate ranking does not establish lower risk. Source-history periods need separate verification; historical loss correlation has not been measured.",
            ),
          ]
        : []),
    ].join("\n"),
    instruction: t(
      "简短展示候选和原方案未变；不创建两人方案、不调整预算或风险。让用户明确选择换出和换入的 trader 后，再调用 recalculate_plan.replacements。",
      "Briefly show candidates and state that the original plan is unchanged. Do not create a two-trader plan or change budget or risk. Call recalculate_plan.replacements only after the user explicitly chooses the outgoing and incoming traders.",
    ),
  };
}
