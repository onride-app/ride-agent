import { AgentError, type Preferences } from "./contracts.js";
import {
  recommend,
  eligibleCandidates,
  fingerprint,
  now,
  uid,
  cash,
  D,
  maximumUserLeverage,
  type Candidate,
  type Plan,
} from "./domain.js";
import { compatibility } from "./conversational.js";
import {
  candidateDisplay,
  copyRule,
  historicalPeriodLabel,
  planDisplay,
  riskSelectionReasons,
  riskSelectionView,
  type Detail,
  type AnalysisOptions,
} from "./conversation-presentation.js";
import type { State, Cursor } from "./repository.js";
import { preferenceCollectionDisplay } from "./preferences.js";
import {
  candidateMetricValue,
  filterCandidates,
  metricPeriodsComparable,
  normalizeCandidateQuery,
  type CandidateFilters,
  type MetricWindow,
} from "./candidate-filters.js";
import { localized, type Locale } from "./locale.js";

export function choosePlanPreferences(
  p: Preferences,
  pool: Candidate[],
  selected?: string[],
): Preferences {
  if (selected)
    return {
      ...p,
      portfolio_kind: selected.length === 1 ? "single" : "basket",
      basket_size: selected.length,
    };
  if (p.portfolio_kind === "single" || p.basket_size != null)
    return {
      ...p,
      portfolio_kind:
        p.portfolio_kind === "single" || p.basket_size === 1
          ? "single"
          : "basket",
    };
  // Prefer up to four feasible sleeves. This is a disclosed suggestion, never a minimum count.
  for (let count = 4; count >= 1; count--) {
    const trial: Preferences = {
      ...p,
      portfolio_kind: count === 1 ? "single" : "basket",
      basket_size: count,
    };
    try {
      recommend(trial, pool);
      return trial;
    } catch (e) {
      if (!(e instanceof AgentError) || e.code !== "NO_EXECUTABLE_PLAN")
        throw e;
    }
  }
  return { ...p, portfolio_kind: "single", basket_size: 1 };
}

export function saveDiscovery(s: State, pref: Preferences, pool: Candidate[]) {
  const at = now();
  s.discovery = {
    id: uid("discovery"),
    preference_hash: fingerprint(pref),
    created_at: at,
    expires_at: Math.min(
      at + 5 * 60_000,
      ...pool.filter((c) => c.expires_at > at).map((c) => c.expires_at),
    ),
    candidates: pool,
  };
}
export function traderRow(c: Candidate, locale?: Locale) {
  return {
    trader_id: c.id,
    nickname: c.handle,
    market: c.market,
    score: c.score,
    score_version: c.score_version,
    assets: c.assets,
    style: c.style,
    historical_roi_pct: c.source_roi_pct,
    historical_drawdown_pct: c.source_drawdown_pct,
    metric_window: c.metric_window ?? null,
    metric_provenance: c.metric_provenance ?? null,
    metric_unavailable_reason: c.metric_unavailable_reason ?? null,
    metric_periods: c.metric_periods ?? null,
    metric_period_labels: {
      roi: historicalPeriodLabel(c, "roi", locale),
      drawdown: historicalPeriodLabel(c, "drawdown", locale),
    },
    score_explanation: c.score_explanation ?? null,
    last_trade_at: c.last_trade_at,
    eligibility: c.eligibility,
    scored_at: c.scored_at,
  };
}
export function browse(
  s: State,
  pref: Preferences,
  args: {
    plan_id?: string;
    exclude_selected?: boolean;
    detail?: Detail;
    sort_by?: "score" | "drawdown" | "roi";
    direction?: "asc" | "desc";
    limit?: number;
    cursor?: string;
    compare_ids?: string[];
    filters?: CandidateFilters;
    metric_window?: MetricWindow;
    locale?: Locale;
  },
  user: string,
  cursor: Cursor,
) {
  const t = (zh: string, en: string) => localized(args.locale, zh, en);
  const metadata = (zh: string, en: string) =>
    localized(args.locale ?? "en", zh, en);
  const snapshot = s.discovery;
  if (
    !snapshot ||
    snapshot.expires_at <= now() ||
    snapshot.preference_hash !== fingerprint(pref)
  )
    throw new AgentError(
      "DISCOVERY_REFRESH_REQUIRED",
      "The candidate snapshot expired or preferences changed. Call browse_traders without a cursor to refresh candidates; your choices and saved plan remain unchanged.",
      true,
    );
  const plan = args.plan_id
    ? s.plans.find((p) => p.id === args.plan_id)
    : s.plans.at(-1);
  if ((args.plan_id || args.exclude_selected) && !plan)
    throw new AgentError(
      "NOT_FOUND",
      "Saved plan not found for this account.",
      false,
      404,
    );
  if (
    args.compare_ids &&
    (args.filters !== undefined || args.metric_window !== undefined)
  )
    throw new AgentError(
      "INVALID_BROWSE",
      "Choose explicit comparison or candidate filters/window, not both; comparison never silently removes requested traders.",
    );
  if (args.exclude_selected && args.compare_ids)
    throw new AgentError(
      "INVALID_BROWSE",
      "Choose alternative browsing or explicit comparison, not both.",
    );
  const selected = new Set(plan?.allocations.map((a) => a.trader.id) ?? []);
  const sort = args.sort_by ?? "score",
    direction = args.direction ?? (sort === "drawdown" ? "asc" : "desc");
  const normalizedQuery = normalizeCandidateQuery(
    args.filters,
    args.metric_window,
  );
  const query = fingerprint({
    snapshot: snapshot.id,
    sort,
    direction,
    compare_ids: args.compare_ids,
    filters: normalizedQuery.filters,
    metric_window: normalizedQuery.metric_window,
    ...(args.exclude_selected
      ? { exclude_selected: [...selected], plan_id: plan!.id }
      : {}),
  });
  const decoded = args.cursor ? cursor.decode(user, args.cursor) : null;
  if (decoded && (decoded.id !== query || decoded.at < 0))
    throw new AgentError(
      "INVALID_CURSOR",
      "Restart this sort or comparison without a cursor; the saved plan is unchanged.",
    );
  const allowed = eligibleCandidates(pref, snapshot.candidates);
  const ids = args.compare_ids;
  const beforeFilters = ids
    ? snapshot.candidates.filter((c) => ids.includes(c.id))
    : allowed.filter((c) => !args.exclude_selected || !selected.has(c.id));
  const filtered = filterCandidates(
    beforeFilters,
    normalizedQuery.filters,
    normalizedQuery.metric_window,
    sort,
  );
  const rows = filtered.rows;
  const metric = (c: Candidate) => candidateMetricValue(c, sort);
  rows.sort((a, b) => {
    const av = metric(a),
      bv = metric(b);
    if (av == null && bv == null) return a.id.localeCompare(b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (
      (direction === "asc" ? av - bv : bv - av) || a.id.localeCompare(b.id)
    );
  });
  const offset = decoded?.at ?? 0,
    limit = args.limit ?? 5,
    page = rows.slice(offset, offset + limit);
  const next = offset + page.length;
  const display = candidateDisplay(
    page,
    plan,
    args.detail,
    page.length
      ? "available"
      : !snapshot.candidates.length
        ? "source_empty"
        : rows.length
          ? "end_of_results"
          : "no_matching_candidates",
    {
      historical_metrics: filtered.metric_basis.applied_to_metrics,
      locale: args.locale,
    },
  );
  const f = normalizedQuery.filters;
  const filterLabels = [
    f.min_score == null
      ? null
      : t(`评分 ≥ ${f.min_score}`, `Score ≥ ${f.min_score}`),
    f.max_drawdown_pct == null
      ? null
      : t(
          `来源回撤 ≤ ${f.max_drawdown_pct}%`,
          `Source drawdown ≤ ${f.max_drawdown_pct}%`,
        ),
    f.min_roi_pct == null
      ? null
      : t(`来源收益 ≥ ${f.min_roi_pct}%`, `Source return ≥ ${f.min_roi_pct}%`),
    f.max_roi_pct == null
      ? null
      : t(`来源收益 ≤ ${f.max_roi_pct}%`, `Source return ≤ ${f.max_roi_pct}%`),
  ].filter(Boolean);
  if (filterLabels.length || normalizedQuery.metric_window) {
    const window = normalizedQuery.metric_window;
    display.markdown += t(
      `\n筛选：${filterLabels.join("；") || "指定统计窗口"}。符合 ${rows.length} 人，本页 ${page.length} 人。`,
      `\nFilters: ${filterLabels.join("; ") || "requested period"}. ${rows.length} matching traders; ${page.length} on this page.`,
    );
    const windowDate = new Intl.DateTimeFormat(
      args.locale === "en" ? "sv-SE" : "zh-CN",
      {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "short",
        hour12: false,
      },
    );
    display.markdown += window
      ? t(
          `\n统计窗口：${windowDate.format(window.start_at)} 至 ${windowDate.format(window.end_at)}（上海）；仅采用已核实且完全匹配的指标。周期缺失 ${filtered.counts.unavailable_window_count} 人，周期不符 ${filtered.counts.mismatched_window_count} 人。`,
          `\nPeriod: ${windowDate.format(window.start_at)} to ${windowDate.format(window.end_at)} (Shanghai); only verified exact-window metrics are used. ${filtered.counts.unavailable_window_count} traders have unavailable periods; ${filtered.counts.mismatched_window_count} have mismatched periods.`,
        )
      : t(
          "\n按来源报告值筛选；统计周期未核实时，不代表同周期收益或风险比较。",
          "\nFilters use source-reported values; unverified periods do not establish same-period return or risk comparisons.",
        );
    if (filtered.counts.missing_metric_count)
      display.markdown += t(
        ` 指标缺失 ${filtered.counts.missing_metric_count} 人，已排除。`,
        ` ${filtered.counts.missing_metric_count} traders with missing metrics were excluded.`,
      );
    display.markdown += t(
      " 范围为当前已验证候选快照，Perps 最多 30 人。",
      " Scope: the current verified candidate snapshot, with at most 30 Perps traders.",
    );
  }
  const availability = page.length
    ? "available"
    : !snapshot.candidates.length
      ? "source_empty"
      : rows.length
        ? "end_of_results"
        : "no_matching_candidates";
  return {
    view_kind: "candidate_browse",
    conversation_display: display,
    candidate_availability: {
      status: availability,
      source_count: snapshot.candidates.length || null,
      eligible_count: snapshot.candidates.length ? allowed.length : null,
      matching_count: snapshot.candidates.length ? rows.length : null,
      instruction: t(
        "来源未返回可用数据时，不将其解释为预算不足或市场没有 trader；保留原方案，稍后只刷新候选。",
        "Missing source data does not mean the budget is too small or the market has no traders. Preserve the original plan and refresh only the candidates later.",
      ),
    },
    applied_filters: filtered.applied_filters,
    metric_basis: {
      ...filtered.metric_basis,
      explanation: normalizedQuery.metric_window
        ? metadata(
            "仅已核实且起止时间与请求完全一致的指标通过；周期未知或不同均排除，不替换成其他周期。",
            filtered.metric_basis.explanation,
          )
        : metadata(
            "按来源报告的百分比值筛选；未知周期仍未知，数值筛选不构成同周期风险或收益比较。",
            filtered.metric_basis.explanation,
          ),
    },
    filter_counts: {
      source_count: snapshot.candidates.length,
      eligible_count: allowed.length,
      selected_excluded_count: ids ? 0 : allowed.length - beforeFilters.length,
      ...filtered.counts,
    },
    base_plan_id: plan?.id ?? null,
    base_trader_ids: [...selected],
    excluded_selected_traders: args.exclude_selected ?? false,
    preferences_unchanged: true,
    candidates: page,
    candidate_table: page.map((c) => traderRow(c, args.locale)),
    candidates_meta: {
      total: rows.length,
      returned: page.length,
      offset,
      has_more: next < rows.length,
      next_cursor: next < rows.length ? cursor.encode(user, next, query) : null,
      sort_by: sort,
      sort_warning:
        sort === "score"
          ? null
          : t(
              "按来源数值排序，不代表同周期比较，也不是收益或风险预测；请同时展示每行统计周期。",
              "Sorting uses source-reported values, not same-period comparisons or return/risk forecasts. Show each row's metric period.",
            ),
      direction,
      snapshot_at: snapshot.created_at,
      expires_at: snapshot.expires_at,
      scope: metadata(
        "范围为当前完整的已验证来源池，而非仅本页；线上 Perps 来源最多覆盖按 Copy Score 排序的前 30 人，并非市场全部交易员。",
        "Entire current verified source pool, not just this page. The production Perps source profiles at most the top 30 by Copy Score; this is not all market traders.",
      ),
      historical_metric_note: metadata(
        "来源历史不代表跟单收益；结论前须核对周期与评分版本，未知周期不得默认相同。",
        "Source history is not follower profit. Compare periods and score versions before drawing conclusions; unknown periods are unavailable, never assumed equal.",
      ),
      score_tie_note: metadata(
        "展示分数相同可能来自等级封顶；应查看逐行评分说明，等级证据缺失仍为未知。公开 trader ID 仅用于确定性同分排序，不是收益预测。",
        "Equal display scores can result from tier caps. Use each row's score_explanation; missing tier evidence remains unavailable. Public trader ID is the deterministic tie-breaker, not a return forecast.",
      ),
      period_comparable: metricPeriodsComparable(page),
      period_comparable_by_metric: {
        roi: metricPeriodsComparable(page, "roi"),
        drawdown: metricPeriodsComparable(page, "drawdown"),
      },
    },
    missing_trader_ids:
      ids?.filter((id) => !rows.some((c) => c.id === id)) ?? [],
    selected_trader_ids: s.selected_trader_ids ?? [],
    saved_plan_id: s.plans.at(-1)?.id ?? null,
    plan_unchanged: true,
    comparison: ids
      ? {
          rows: page.map((c) => ({
            ...traderRow(c, args.locale),
            matches_preferences: allowed.some((a) => a.id === c.id),
          })),
          overlaps: compatibility({
            allocations: rows.map((c) => ({ trader: c, amount_usdc: "1" })),
          } as Plan).pairs,
          historical_loss_correlation: null,
        }
      : null,
  };
}
export function conversationView(
  plan: Plan | null,
  collection: Record<string, unknown>,
  candidates: Candidate[],
  selectedByUser: boolean,
  detail: Detail = "brief",
  previous?: Plan,
  analysisOptions: AnalysisOptions = {},
) {
  const t = (zh: string, en: string) =>
    localized(analysisOptions.locale, zh, en);
  const metadata = (zh: string, en: string) =>
    localized(analysisOptions.locale ?? "en", zh, en);
  return {
    presentation: "native_conversation",
    conversation_display: plan
      ? planDisplay(plan, detail, previous, analysisOptions)
      : null,
    risk_selection: plan ? riskSelectionView(plan, analysisOptions) : null,
    preference_collection: preferenceCollectionDisplay(
      collection,
      analysisOptions.locale,
    ),
    recommended_portfolio:
      plan?.allocations.map((a) => ({
        ...traderRow(a.trader, analysisOptions.locale),
        amount_usdc: a.amount_usdc,
        leverage_mode: a.leverage_mode ?? "cap",
        leverage_cap: a.leverage_cap,
        leverage_cap_source:
          a.leverage_cap_source ??
          (a.leverage_cap != null &&
          a.trader.market === "perps" &&
          !a.leverage_mode
            ? "inherited"
            : "default"),
        leverage_cap_inherited_from_plan_id:
          a.leverage_cap_inherited_from_plan_id ?? null,
        maximum_leverage_cap: maximumUserLeverage(a.trader),
        maximum_leverage_cap_basis:
          a.trader.market === "perps"
            ? "product_planning_envelope"
            : "prediction_fixed_1x",
        risk_selection_reasons: analysisOptions.locale
          ? riskSelectionReasons(plan, a.trader.id, analysisOptions)
          : (plan.risk_selection?.selected.find(
              (r) => r.trader_id === a.trader.id,
            )?.reasons ?? []),
        reason:
          t(
            `Copy Score ${a.trader.score}；${a.trader.style}；${a.trader.assets.join("/")}；${plan.allocations.length === 1 ? "单人集中配置" : `资金分配给 ${plan.allocations.length} 位选定交易员`}。`,
            `Copy Score ${a.trader.score}; ${a.trader.style}; ${a.trader.assets.join("/")}; ${plan.allocations.length === 1 ? "single-trader concentration" : `capital spread across ${plan.allocations.length} selected traders`}.`,
          ) +
          (a.leverage_cap_source === "inherited" ||
          (a.trader.market === "perps" &&
            a.leverage_cap != null &&
            !a.leverage_mode)
            ? a.leverage_cap == null
              ? t(
                  " 保留原设置：跟随源杠杆，无额外上限，无需再次清除。",
                  " The saved setting follows source leverage without an extra user cap; there is no cap to clear.",
                )
              : t(
                  ` 保留原杠杆上限 ${a.leverage_cap}x；可明确选择取消额外上限。`,
                  ` The saved ${a.leverage_cap}x extra leverage cap is preserved; you may explicitly choose to clear it.`,
                )
            : ""),
      })) ?? [],
    // Compare the same immutable selection in the same order. The candidate
    // ranking can contain other traders and must not stand in for this table.
    recommended_trader_comparison:
      plan?.allocations.map((a) =>
        traderRow(a.trader, analysisOptions.locale),
      ) ?? [],
    recommended_comparison_meta: {
      plan_id: plan?.id ?? null,
      source: "plan_allocations",
    },
    candidate_table: candidates
      .slice(0, 5)
      .map((c) => traderRow(c, analysisOptions.locale)),
    selection_origin:
      plan?.selection_source === "system"
        ? "system_recommendation"
        : plan?.selection_source === "explicit"
          ? "user"
          : plan?.selection_source === "legacy_unknown"
            ? "legacy_unknown"
            : selectedByUser
              ? "user"
              : "system_recommendation",
    planning_constraints: {
      max_traders: 8,
      minimum_allocation_usdc:
        candidates.length && candidates.every((c) => c.market === "prediction")
          ? "50"
          : null,
      perps_product_minimum_usdc: null,
      prediction_product_minimum_usdc: "50",
      type: metadata(
        "Perps 只要求正数 USDC 分配；实际交易所最小下单额应用于计算后的订单，而非分配保证金。预测市场分配规则保持不变。",
        "Positive Perps USDC allocation; live venue minimums apply to each sized order, not to allocated collateral. Prediction allocation rules are unchanged.",
      ),
      order_minimum_validation:
        "after_netting_and_quantity_rounding_at_execution",
      leverage_mode: plan?.allocations.some(
        (a) => a.leverage_mode === "follow_source",
      )
        ? "follow_source"
        : "cap",
      follow_source_leverage_supported: true,
      follow_source_requires_risk_cap: false,
      follow_source_requires_venue_limits: true,
      risk_controls_required: true,
      maximum_agent_leverage: null,
      maximum_custom_leverage_cap: 40,
      maximum_custom_leverage_cap_meaning: t(
        "40x 是产品可设置的额外用户上限，不是源交易员的实际杠杆或逐币交易所上限。",
        "40x is the product's maximum configurable extra user cap, not actual source-trader leverage or a per-asset venue limit.",
      ),
      default_perps_leverage_cap: null,
      custom_leverage_cap_supported: true,
    },
    final_review: plan
      ? {
          budget_usdc: plan.preferences.budget_usdc,
          allocated_usdc: cash(
            plan.allocations.reduce((n, a) => n.plus(a.amount_usdc), D(0)),
          ),
          unallocated_usdc: cash(
            D(plan.preferences.budget_usdc).minus(
              plan.allocations.reduce((n, a) => n.plus(a.amount_usdc), D(0)),
            ),
          ),
          market: plan.preferences.market,
          selected_markets: [
            ...new Set(plan.allocations.map((a) => a.trader.market)),
          ],
          portfolio_loss_trigger_pct: plan.preferences.loss_trigger_pct,
          risk_setting_source:
            plan.preference_sources?.loss_trigger_pct ?? "unknown",
          risk_setting_explanation: t(
            `${plan.preference_sources?.loss_trigger_pct === "user" ? "使用你之前明确选择的" : plan.preference_sources?.loss_trigger_pct === "recommended" ? "系统建议，待你确认：" : "当前方案设置，来源未核实："}${plan.preferences.loss_trigger_pct}% 组合退出触发值；按预算 ${plan.preferences.budget_usdc} USDC，触发金额为 ${cash(D(plan.preferences.budget_usdc).times(plan.preferences.loss_trigger_pct).div(100))} USDC。触发后尝试退出，不保证最大亏损。单个交易员的暂停和紧急退出设置见高级详情。`,
            `${plan.preference_sources?.loss_trigger_pct === "user" ? "Use your previously selected" : plan.preference_sources?.loss_trigger_pct === "recommended" ? "Suggested, awaiting your confirmation:" : "Current setting; source unverified:"} ${plan.preferences.loss_trigger_pct}% portfolio exit trigger; for a ${plan.preferences.budget_usdc} USDC budget, the trigger amount is ${cash(D(plan.preferences.budget_usdc).times(plan.preferences.loss_trigger_pct).div(100))} USDC. An exit is attempted when triggered; this is not a guaranteed maximum loss. Per-trader pause and emergency-exit settings are in advanced details.`,
          ),
          portfolio_loss_trigger_usdc: cash(
            D(plan.preferences.budget_usdc)
              .times(plan.preferences.loss_trigger_pct)
              .div(100),
          ),
          traders: plan.allocations.map((a) => ({
            trader_id: a.trader.id,
            copy_rule: copyRule(a, analysisOptions),
            amount_usdc: a.amount_usdc,
            copy_mode: a.copy_mode ?? "ride_recommends",
            leverage_cap: a.leverage_cap,
            leverage_mode: a.leverage_mode ?? "cap",
            maximum_leverage_cap: maximumUserLeverage(a.trader),
            maximum_leverage_cap_basis:
              a.trader.market === "perps"
                ? "product_planning_envelope"
                : "prediction_fixed_1x",
            stop_loss_pct: a.stop_loss_pct,
            loss_policy: a.loss_policy ?? "exit",
            emergency_exit_pct: a.emergency_exit_pct ?? null,
          })),
          funds_verified: false,
          execution_authorized: false,
          requires_ride_confirmation: true,
        }
      : null,
    instruction: metadata(
      "默认展示 conversation_display.markdown；如有 markdown_by_locale，只选择用户语言对应的一份：同一组交易员的一张表、简短跟单与退出规则、至多一句真实复制性限制；实际风控受阻原因必须保留。首次分析先结论和至多三条证据，只在明确进一步分析或计算请求时展开。不要追加接口审计、公式或其他方案；没有实盘样本不能声称成交覆盖率或风险改善。候选排名与推荐组合分开。查看 alternatives 不改原方案；明确一换一才生成保留人数、逐人金额、控制和风险的新预览。follow_source 且 leverage_cap 为 null 表示无额外用户上限，40x 只是产品可设置上限；真实源杠杆和逐币交易所规则须核实。预览不需要入金，不授权执行，仍需本人另行确认。",
      "Use conversation_display.markdown, or exactly one matching markdown_by_locale variant when present: one table for the same selected traders, concise copy and exit rules, and at most one factual copyability limitation. Preserve actual risk-blocking reasons. First analysis gives a conclusion and at most three evidence points; expand only for explicit further analysis or calculation requests. Do not append interface audits, formulas or other plans; without real execution samples, do not claim fill coverage or risk improvement. Keep candidate ranking separate from the recommended portfolio. Browsing alternatives preserves the original plan; only an explicit one-for-one replacement creates a preview retaining count, slot amounts, controls and risk. follow_source with leverage_cap:null has no extra user cap; 40x is the product setting ceiling, not verified source leverage or per-asset venue limits. Previews need no funding and authorize no execution; separate human confirmation is required.",
    ),
  };
}
