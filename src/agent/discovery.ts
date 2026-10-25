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
import type { State, Cursor } from "./repository.js";

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
export function traderRow(c: Candidate) {
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
      roi:
        c.metric_periods?.roi?.start_at != null &&
        c.metric_periods?.roi?.end_at != null
          ? `${new Date(c.metric_periods.roi.start_at).toISOString()} — ${new Date(c.metric_periods.roi.end_at).toISOString()}`
          : c.metric_periods?.roi?.period === "source_month"
            ? "来源标注月收益，具体起止日期未核实"
            : "收益统计周期未核实",
      drawdown:
        c.metric_periods?.drawdown?.start_at != null &&
        c.metric_periods?.drawdown?.end_at != null
          ? `${new Date(c.metric_periods.drawdown.start_at).toISOString()} — ${new Date(c.metric_periods.drawdown.end_at).toISOString()}`
          : "回撤统计周期未核实，不可视为同周期比较",
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
    sort_by?: "score" | "drawdown" | "roi";
    direction?: "asc" | "desc";
    limit?: number;
    cursor?: string;
    compare_ids?: string[];
  },
  user: string,
  cursor: Cursor,
) {
  const snapshot = s.discovery;
  if (
    !snapshot ||
    snapshot.expires_at <= now() ||
    snapshot.preference_hash !== fingerprint(pref)
  )
    throw new AgentError(
      "DISCOVERY_REFRESH_REQUIRED",
      "The candidate snapshot expired or preferences changed. Call recommend_traders to refresh; your choices and saved plan remain available.",
      true,
    );
  const sort = args.sort_by ?? "score",
    direction = args.direction ?? (sort === "drawdown" ? "asc" : "desc");
  const query = fingerprint({
    snapshot: snapshot.id,
    sort,
    direction,
    compare_ids: args.compare_ids,
  });
  const decoded = args.cursor ? cursor.decode(user, args.cursor) : null;
  if (decoded && (decoded.id !== query || decoded.at < 0))
    throw new AgentError(
      "INVALID_CURSOR",
      "Restart this sort or comparison without a cursor; the saved plan is unchanged.",
    );
  const allowed = eligibleCandidates(pref, snapshot.candidates);
  const ids = args.compare_ids;
  const rows = ids
    ? snapshot.candidates.filter((c) => ids.includes(c.id))
    : allowed;
  const metric = (c: Candidate) =>
    sort === "score"
      ? c.score
      : sort === "drawdown"
        ? c.source_drawdown_pct
        : c.source_roi_pct;
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
  return {
    candidates: page,
    candidate_table: page.map(traderRow),
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
          : "按来源数值排序，不代表同周期比较，也不是收益或风险预测；请同时展示每行统计周期。",
      direction,
      snapshot_at: snapshot.created_at,
      expires_at: snapshot.expires_at,
      scope:
        "Entire current verified source pool, not just this page. The production Perps source profiles at most the top 30 by Copy Score; this is not all market traders.",
      historical_metric_note:
        "Source history is not follower profit. Compare periods and score versions before drawing conclusions; unknown periods are unavailable, never assumed equal.",
      score_tie_note:
        "Equal display scores can result from tier caps. Use each row's score_explanation; missing tier evidence remains unavailable. Public trader ID is the deterministic tie-breaker, not a return forecast.",
      period_comparable:
        page.length > 0 &&
        page.every((c) => c.metric_window != null) &&
        new Set(page.map((c) => fingerprint(c.metric_window))).size === 1,
    },
    missing_trader_ids:
      ids?.filter((id) => !rows.some((c) => c.id === id)) ?? [],
    selected_trader_ids: s.selected_trader_ids ?? [],
    saved_plan_id: s.plans.at(-1)?.id ?? null,
    plan_unchanged: true,
    comparison: ids
      ? {
          rows: page.map((c) => ({
            ...traderRow(c),
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
) {
  return {
    presentation: "native_conversation",
    preference_collection: collection,
    recommended_portfolio:
      plan?.allocations.map((a) => ({
        ...traderRow(a.trader),
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
        reason: `Copy Score ${a.trader.score}; ${a.trader.style}; ${a.trader.assets.join("/")}; ${plan.allocations.length === 1 ? "single-trader concentration" : `capital spread across ${plan.allocations.length} selected traders`}.${a.leverage_cap_source === "inherited" || (a.trader.market === "perps" && a.leverage_cap != null && !a.leverage_mode) ? (a.leverage_cap == null ? " 保留原设置：跟随源杠杆，无额外上限，无需再次清除。" : ` 保留原杠杆上限 ${a.leverage_cap}x；可明确选择取消额外上限。`) : ""}`,
      })) ?? [],
    // Compare the same immutable selection in the same order. The candidate
    // ranking can contain other traders and must not stand in for this table.
    recommended_trader_comparison:
      plan?.allocations.map((a) => traderRow(a.trader)) ?? [],
    recommended_comparison_meta: {
      plan_id: plan?.id ?? null,
      source: "plan_allocations",
    },
    candidate_table: candidates.slice(0, 5).map(traderRow),
    selection_origin: selectedByUser ? "user" : "system_recommendation",
    planning_constraints: {
      max_traders: 8,
      minimum_allocation_usdc:
        candidates.length && candidates.every((c) => c.market === "prediction")
          ? "50"
          : null,
      perps_product_minimum_usdc: null,
      prediction_product_minimum_usdc: "50",
      type: "Positive Perps USDC allocation; live venue minimums apply to each sized order, not to allocated collateral. Prediction allocation rules are unchanged.",
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
          risk_setting_explanation: `${plan.preference_sources?.loss_trigger_pct === "user" ? "使用你之前明确选择的" : plan.preference_sources?.loss_trigger_pct === "recommended" ? "系统建议，待你确认：" : "当前方案设置，来源未核实："}${plan.preferences.loss_trigger_pct}% 组合退出触发值；按预算 ${plan.preferences.budget_usdc} USDC，触发金额为 ${cash(D(plan.preferences.budget_usdc).times(plan.preferences.loss_trigger_pct).div(100))} USDC。触发后尝试退出，不保证最大亏损。单个交易员的暂停和紧急退出设置见高级详情。`,
          portfolio_loss_trigger_usdc: cash(
            D(plan.preferences.budget_usdc)
              .times(plan.preferences.loss_trigger_pct)
              .div(100),
          ),
          traders: plan.allocations.map((a) => ({
            trader_id: a.trader.id,
            amount_usdc: a.amount_usdc,
            copy_mode: a.copy_mode ?? "ride_recommends",
            leverage_cap: a.leverage_cap,
            leverage_mode: a.leverage_mode ?? "cap",
            maximum_leverage_cap: maximumUserLeverage(a.trader),
            stop_loss_pct: a.stop_loss_pct,
            loss_policy: a.loss_policy ?? "exit",
            emergency_exit_pct: a.emergency_exit_pct ?? null,
          })),
          funds_verified: false,
          execution_authorized: false,
          requires_ride_confirmation: true,
        }
      : null,
    instruction:
      "When a plan exists, show two compact chat tables: recommended_portfolio (trader, amount, reason) and recommended_trader_comparison (the same selected trader IDs in the same order, with score, assets, style and source history/periods). Never replace the recommended performance comparison with candidate_table or the top five ranking. Use this same plan selection for any following portfolio analysis or final review. On older responses without recommended_trader_comparison, use the metrics already in recommended_portfolio. Candidate discovery is separate: label candidate_table as the eligible candidate ranking and show it when the user asks for candidates, or when no plan is feasible; do not call it the recommended portfolio's performance comparison. The first browse request starts without a cursor unless a candidate page was actually displayed. A follow_source allocation with leverage_cap null follows verified source leverage without an extra user cap by default; say this explicitly. A numeric cap is user-editable independently of the recommendation (Perps 1–40x), and null clears it. Actual leverage still respects the approved optional cap, fresh venue limits, budget and risk checks. Never invent a 3x or 10x default cap. Disclose defaults and risk settings. Offer accept/customize; browse_traders pages or compares without replacing the plan. No funding needed for this preview. Missing history is unavailable. Best means prioritized within current conditions, not highest guaranteed returns.",
  };
}
