import { AgentError } from "./contracts.js";
import {
  aggregate,
  assetAllowed,
  cash,
  D,
  fingerprint,
  fresh,
  now,
  risk,
  type Plan,
  type Portfolio,
  type PositionIntent,
  type AccountSnapshot,
} from "./domain.js";
import { checkPerpsOrder } from "./order_rules.js";
import type { PlanReadEvidence, PlanSourceEvidence } from "./read-evidence.js";
import { localized, type Locale } from "./locale.js";
import { copyabilityReason } from "./conversation-presentation.js";
import { describeRiskBlocker, type TargetBlocker } from "./risk-status.js";

export interface InspectedPosition {
  key: string;
  target_quantity: string | null;
  target_notional_usdc: string | null;
  basket_net_quantity: string | null;
  order_notional_usdc: string | null;
  minimum_notional_usdc: string | null;
  status: "within_rules" | "blocked" | "skipped" | "not_evaluated" | "flat";
  reason_code: string | null;
}
export interface SleevePrecheck {
  trader_id: string;
  amount_usdc: string;
  source_equity_usdc: string | null;
  observed_at: number | null;
  status: "checked" | "blocked" | "incomplete" | "not_evaluated" | "flat";
  reason_code: string | null;
  scope: "hypothetical_initial_target";
  positions: InspectedPosition[];
}

export function unavailablePlanEvidence(
  plan: Plan,
  reason = "EVIDENCE_READER_UNAVAILABLE",
): PlanReadEvidence {
  return {
    observed_at: now(),
    read_only: true,
    execution_authorized: false,
    sources: plan.allocations.map((a) => ({
      trader_id: a.trader.id,
      status: "unavailable",
      snapshot: null,
      equity_basis: "unavailable",
      equity_verified: false,
      account_mode: "unknown",
      scope: "base_perps",
      coverage_complete: false,
      timestamp_basis: null,
      reason_code: reason,
    })),
    market: {
      observed_at: now(),
      prices: {},
      max_leverages: {},
      quantity_decimals: {},
      min_notionals: {},
      coverage_complete: false,
      scope: "base_perps",
      product_planning_max_leverage: 40,
      legacy_candidate_venue_max_leverage_basis: "product_planning_envelope",
      reason_codes: [reason],
    },
  };
}

const sourceProblem = (s: PlanSourceEvidence | undefined): string | null => {
  if (!s?.snapshot || !Array.isArray(s.snapshot.positions))
    return s?.reason_code ?? "SOURCE_UNAVAILABLE";
  if (s.account_mode === "unified") return "UNIFIED_DEX_COVERAGE_UNVERIFIED";
  if (
    s.account_mode !== "standard" ||
    s.equity_basis !== "standard_clearinghouse_account_value" ||
    s.scope !== "base_perps" ||
    s.timestamp_basis == null
  )
    return "SOURCE_EQUITY_UNVERIFIED";
  if (!fresh(s.snapshot.observed_at)) return "SOURCE_STALE";
  if (s.equity_verified !== true) return "SOURCE_EQUITY_UNVERIFIED";
  if (
    s.status !== "available" ||
    s.coverage_complete !== true ||
    s.snapshot.complete !== true
  )
    return s.reason_code ?? "SOURCE_INCOMPLETE";
  try {
    const equity = D(s.snapshot.account_value_usdc);
    if (
      !equity.isFinite() ||
      equity.lt(0) ||
      (equity.isZero() && s.snapshot.positions.length)
    )
      return "SOURCE_EQUITY_UNVERIFIED";
  } catch {
    return "SOURCE_EQUITY_UNVERIFIED";
  }
  return null;
};

/** A fresh, read-only initial-target simulation. No account, task or saved plan is modified. */
export function inspectPlanOrders(
  plan: Plan,
  evidence: PlanReadEvidence,
  locale?: Locale,
) {
  const original = fingerprint(plan);
  const trial: Portfolio = {
    id: plan.id,
    account_id: null,
    revision: 0,
    state: "activating",
    preferences: structuredClone(plan.preferences),
    sleeves: plan.allocations.map((a) => ({
      ...structuredClone(a),
      state: "active",
      lots: {},
      intents: {},
      initialized: false,
      suppressed: [],
      source_revision: null,
      last_source_at: null,
      replaced_at: null,
    })),
    executions: [],
    snapshot: null,
    initial_equity: null,
    created_at: plan.created_at,
    ledger_started_at: null,
    seen_fills: [],
    seen_funding: [],
    seen_flows: [],
    flow_total: "0",
    reconciliation: "pending",
    loss_latched: false,
    asset_filter_version: plan.asset_filter_version,
  };
  const market = evidence.market;
  const marketReady =
    market.scope === "base_perps" &&
    market.coverage_complete === true &&
    fresh(market.observed_at);
  const sleeves: SleevePrecheck[] = plan.allocations.map((a, index) => {
    const source = evidence.sources.find((s) => s.trader_id === a.trader.id);
    const problem = sourceProblem(source);
    const result: SleevePrecheck = {
      trader_id: a.trader.id,
      amount_usdc: a.amount_usdc,
      source_equity_usdc: !problem
        ? (source?.snapshot?.account_value_usdc ?? null)
        : null,
      observed_at: source?.snapshot?.observed_at ?? null,
      scope: "hypothetical_initial_target",
      status: "incomplete",
      reason_code: null,
      positions: [],
    };
    if (problem || !marketReady) {
      result.reason_code = problem ?? "VENUE_RULES_UNAVAILABLE";
      return result;
    }
    if ((a.copy_mode ?? "ride_recommends") === "fixed") {
      result.status = "not_evaluated";
      result.reason_code = "FIXED_FILL_EVIDENCE_REQUIRED";
      return result;
    }
    const snapshot = source!.snapshot!;
    if (!snapshot.positions.length) {
      result.status = "flat";
      return result;
    }
    const raw: PositionIntent[] = [];
    try {
      const keys = new Set<string>();
      for (const p of snapshot.positions) {
        if (
          !p ||
          typeof p.asset !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,30}$/.test(p.asset) ||
          p.key !== `perps:${p.asset}` ||
          keys.has(p.key) ||
          !D(p.quantity).isFinite()
        )
          throw new AgentError(
            "SOURCE_POSITION_EVIDENCE_INCOMPLETE",
            "Unique finite base-Perps positions are required.",
          );
        keys.add(p.key);
        if (p.market !== "perps")
          throw new AgentError(
            "MARKET_PRECHECK_UNSUPPORTED",
            "Only base Perps can be inspected.",
          );
        if (
          !assetAllowed(
            plan.preferences,
            p.asset,
            a.trader.asset_categories?.[p.asset] ??
              (plan.asset_filter_version === 2
                ? a.trader.asset_category
                : undefined),
            plan.asset_filter_version ?? 1,
          )
        )
          continue;
        const price = market.prices[p.key],
          max = market.max_leverages[p.key],
          decimals = market.quantity_decimals[p.key];
        if (
          !price ||
          !D(price).isFinite() ||
          !D(price).gt(0) ||
          !Number.isInteger(max) ||
          max < 1 ||
          !Number.isInteger(decimals) ||
          decimals < 0 ||
          decimals > 8 ||
          !market.min_notionals[p.key]
        )
          throw new AgentError(
            "VENUE_RULES_UNAVAILABLE",
            "Fresh per-asset rules are required.",
          );
        if (!fresh(p.observed_at))
          throw new AgentError("SOURCE_STALE", "Source position is stale.");
        if (
          p.source_leverage_verified !== true ||
          !Number.isInteger(p.source_leverage) ||
          p.source_leverage < 1
        )
          throw new AgentError(
            "SOURCE_LEVERAGE_UNAVAILABLE",
            "Verified source leverage is required.",
          );
        const leverage = Math.min(
          a.leverage_cap ?? Infinity,
          p.source_leverage,
          max,
        );
        const quantity = D(p.quantity)
          .times(D(a.amount_usdc).div(snapshot.account_value_usdc))
          .times(D(leverage).div(Math.max(1, p.source_leverage)))
          .times(a.proportional_multiplier ?? 1);
        raw.push({
          ...p,
          price,
          source_leverage: leverage,
          quantity: quantity.toString(),
        });
      }
      const margin = raw.reduce(
        (n, p) =>
          n.plus(D(p.quantity).abs().times(p.price).div(p.source_leverage)),
        D(0),
      );
      const scale = margin.gt(a.amount_usdc)
        ? D(a.amount_usdc).div(margin)
        : D(1);
      for (const p of raw) {
        const row: InspectedPosition = {
          key: p.key,
          target_quantity: null,
          target_notional_usdc: null,
          basket_net_quantity: null,
          order_notional_usdc: null,
          minimum_notional_usdc: market.min_notionals[p.key],
          status: "not_evaluated",
          reason_code: null,
        };
        result.positions.push(row);
        if (
          !D(p.quantity).isZero() &&
          (p.source_entry_price == null ||
            !D(p.source_entry_price).gt(0) ||
            D(p.price)
              .minus(p.source_entry_price)
              .abs()
              .div(p.source_entry_price)
              .gt("0.002"))
        ) {
          row.status = "skipped";
          row.reason_code = "ENTRY_DEVIATION_OR_MISSING_SOURCE_PRICE";
          continue;
        }
        const quantity = D(p.quantity)
          .times(scale)
          .toDecimalPlaces(market.quantity_decimals[p.key]);
        row.target_quantity = quantity.toString();
        row.target_notional_usdc = cash(quantity.abs().times(p.price));
        // Preserve the historical per-sleeve minimum for approved legacy
        // plans. Only explicit portfolio-kind plans use the net-order path.
        if (
          !plan.preferences.portfolio_kind &&
          !quantity.isZero() &&
          quantity.abs().times(p.price).lt(market.min_notionals[p.key])
        ) {
          row.status = "skipped";
          row.reason_code = "BELOW_MINIMUM_NOTIONAL";
          continue;
        }
        if (!D(p.quantity).isZero() && quantity.isZero()) {
          row.status = "skipped";
          row.reason_code = "BELOW_MINIMUM_QUANTITY";
        } else row.status = quantity.isZero() ? "flat" : "within_rules";
        trial.sleeves[index].intents[p.key] = {
          ...p,
          quantity: quantity.toString(),
        };
      }
      result.status = result.positions.some((p) => p.status === "skipped")
        ? "blocked"
        : result.positions.some((p) => p.status === "within_rules")
          ? "checked"
          : "flat";
      result.reason_code =
        result.positions.find((p) => p.reason_code)?.reason_code ?? null;
    } catch (error) {
      trial.sleeves[index].intents = {};
      result.positions = [];
      result.status = "incomplete";
      result.reason_code =
        error instanceof AgentError
          ? error.code
          : "SOURCE_POSITION_EVIDENCE_INCOMPLETE";
    }
    return result;
  });
  const complete = sleeves.every(
    (s) => !["incomplete", "not_evaluated"].includes(s.status),
  );
  const snapshot: AccountSnapshot = {
    account_id: "readonly_hypothetical",
    observed_at: market.observed_at,
    account_value_usdc: "0",
    available_usdc: "0",
    dedicated: false,
    eligible: false,
    positions: {},
    prices: market.prices,
    max_leverages: market.max_leverages,
    quantity_decimals: market.quantity_decimals,
    min_notionals: market.min_notionals,
    orders: [],
    fills: [],
    funding: [],
    flows: [],
    coverage_complete: false,
  };
  let riskCode: string | null = null;
  let riskReason: TargetBlocker | null = null;
  const orders: {
    key: string;
    target_quantity: string;
    order_notional_usdc: string;
    minimum_notional_usdc: string | null;
    status: string;
    reason_code: string | null;
  }[] = [];
  if (complete) {
    try {
      risk(trial, market.prices);
    } catch (error) {
      riskCode =
        error instanceof AgentError ? error.code : "RISK_EVIDENCE_UNAVAILABLE";
      riskReason = describeRiskBlocker(error, trial, market.prices) ?? null;
    }
    for (const a of aggregate(trial, market.prices)) {
      const check = checkPerpsOrder(snapshot, a.key, a.quantity);
      const reason = riskCode ?? (check.ok ? null : check.code);
      const order = {
        key: a.key,
        target_quantity: a.quantity,
        order_notional_usdc: cash(
          D(a.quantity).abs().times(market.prices[a.key]),
        ),
        minimum_notional_usdc: market.min_notionals[a.key] ?? null,
        status: reason
          ? "blocked"
          : D(a.quantity).isZero()
            ? "flat"
            : "within_rules",
        reason_code: reason,
      };
      orders.push(order);
      for (const s of sleeves)
        for (const p of s.positions.filter(
          (p) => p.key === a.key && p.target_quantity != null,
        )) {
          p.basket_net_quantity = a.quantity;
          p.order_notional_usdc = order.order_notional_usdc;
          if (p.status === "within_rules" && reason) {
            p.status = "blocked";
            p.reason_code = reason;
            s.status = "blocked";
            s.reason_code ??= reason;
          } else if (p.status === "within_rules" && D(a.quantity).isZero())
            p.status = "flat";
        }
    }
  } else {
    for (const s of sleeves) {
      if (s.status === "checked") {
        s.status = "incomplete";
        s.reason_code = "BASKET_EVIDENCE_INCOMPLETE";
      }
      for (const p of s.positions)
        if (p.status === "within_rules") {
          p.status = "not_evaluated";
          p.reason_code = "BASKET_EVIDENCE_INCOMPLETE";
        }
    }
  }
  for (const s of sleeves)
    if (s.status === "checked" && s.positions.every((p) => p.status === "flat"))
      s.status = "flat";
  const status = !complete
    ? "incomplete"
    : riskCode || sleeves.some((s) => s.status === "blocked")
      ? "blocked"
      : "checked";
  const baseSummary =
    status === "incomplete"
      ? localized(
          locale,
          "只读预检尚未完成：部分源账户或交易规则未核实，不能判断实际订单是否满足条件。",
          "Read-only inspection is incomplete: some source or venue evidence is unverified.",
        )
      : status === "blocked"
        ? localized(
            locale,
            "只读预检发现当前目标不满足部分规则；查看具体原因，不会自动增加资金或杠杆。",
            "Read-only inspection found rule blockers for the current targets; see the reasons. No funds or leverage are increased.",
          )
        : localized(
            locale,
            "只读预检已核对当前快照下的初始目标和交易规则；这不代表可用余额已核实或订单能够成交。",
            "Read-only inspection checked initial targets and venue rules at this snapshot; available collateral and fills are not verified.",
          );
  const primaryReason =
    riskCode ?? sleeves.find((s) => s.reason_code)?.reason_code ?? null;
  const summary =
    baseSummary +
    (riskReason
      ? " " + localized(locale, riskReason.message_zh, riskReason.message)
      : primaryReason
        ? " " + copyabilityReason(primaryReason, locale)
        : "");
  return {
    plan_id: plan.id,
    plan_fingerprint: original,
    plan_status: plan.expires_at > now() ? "ready" : "expired",
    status,
    summary,
    observed_at: evidence.observed_at,
    read_only: true as const,
    plan_unchanged: true as const,
    execution_authorized: false as const,
    scope: "hypothetical_initial_target" as const,
    order_scope: "basket_net_from_flat_assumption" as const,
    risk_reason_code: riskCode,
    risk_reason: riskReason,
    account_conditions_verified: false,
    guarantee_of_fill: false,
    not_checked: [
      "owned_account",
      "available_collateral",
      "future_source_fills",
      "venue_acceptance",
      "slippage",
      "historical_copy_success_rate",
    ],
    sleeves: sleeves.map((s) => ({
      ...s,
      reason: s.reason_code ? copyabilityReason(s.reason_code, locale) : null,
      positions: s.positions.map((p) => ({
        ...p,
        reason: p.reason_code ? copyabilityReason(p.reason_code, locale) : null,
      })),
    })),
    orders: orders.map((o) => ({
      ...o,
      reason: o.reason_code ? copyabilityReason(o.reason_code, locale) : null,
    })),
  };
}

export function copyEvidenceOverlay(
  value: ReturnType<typeof inspectPlanOrders>,
) {
  return Object.fromEntries(
    value.sleeves.map((s) => [
      s.trader_id,
      {
        source_equity_usdc: s.source_equity_usdc,
        next_order_size: {
          status: s.status,
          reason_code: s.reason_code,
          observed_at: s.observed_at,
          scope: s.scope,
          positions: s.positions,
        },
      },
    ]),
  );
}
