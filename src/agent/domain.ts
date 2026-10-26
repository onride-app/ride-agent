import { Decimal } from "decimal.js";
import { createHash, randomUUID } from "node:crypto";
import { AgentError, type Preferences } from "./contracts.js";

Decimal.set({ precision: 48, rounding: Decimal.ROUND_DOWN });
export const D = Object.assign((v: Decimal.Value) => new Decimal(v), {
  min: Decimal.min.bind(Decimal),
  max: Decimal.max.bind(Decimal),
});
export const cash = (v: Decimal.Value) => D(v).toFixed(6);
export const uid = (kind: string) =>
  `${kind}_${randomUUID().replaceAll("-", "")}`;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const now = () => Date.now();
export const fresh = (at: number, ttl = 30_000) =>
  Number.isFinite(at) && at <= now() + 1000 && now() - at <= ttl;
export type Venue = "perps" | "prediction";
// Match the existing App's editable Perps Auto-Ride setting.
export const PERPS_COPY_MAX_LEVERAGE = 40;
export interface Candidate {
  metric_periods?: {
    roi: {
      period: string;
      start_at: number | null;
      end_at: number | null;
      basis: string;
    };
    drawdown: {
      period: string;
      start_at: number | null;
      end_at: number | null;
      basis: string;
    };
  };
  score_explanation?: {
    tier: string | null;
    raw_quality_score: number | null;
    display_cap: number | null;
    cap_applied: boolean | null;
    note: string;
  };
  metric_window?: { start_at: number; end_at: number; basis: string };
  metric_provenance?: {
    source: string;
    sampling: "daily";
    estimated: boolean;
    cashflow_adjusted: boolean;
    flow_timing: string;
    reconciliation_difference_pct: number;
    inventory_start_block?: number;
    inventory_end_block?: number;
    inventory_end_block_hash?: string;
    token_count?: number;
    transfer_count?: number;
    max_price_age_seconds?: number;
    price_bucket_seconds?: number;
    fallback_price_sources?: string[];
  };
  metric_unavailable_reason?: string;
  id: string;
  handle: string;
  market: Venue;
  score: number;
  score_version: string;
  components: Record<string, number | null>;
  scored_at: number;
  expires_at: number;
  eligibility: "PASS" | "REJECT";
  assets: string[];
  style: string;
  direction: "long" | "short" | "mixed";
  median_hold_hours: number | null;
  source_roi_pct: number | null;
  source_drawdown_pct: number | null;
  atr_pct: number | null;
  venue_max_leverage: number;
  min_notional_usdc: string;
  last_trade_at: number | null;
  asset_category?: "crypto" | "rwa" | "mixed" | "unknown";
  execution_supported?: boolean;
  asset_categories?: Record<string, "crypto" | "rwa" | "unknown">;
}
export interface Allocation {
  copy_id: string;
  trader: Candidate;
  amount_usdc: string;
  leverage_cap: number | null;
  leverage_cap_source?: "inherited" | "user" | "default";
  leverage_cap_inherited_from_plan_id?: string;
  // Missing on frozen/approved capped plans; never infer a policy upgrade.
  leverage_mode?: "follow_source" | "custom_cap";
  stop_loss_pct: number;
  copy_mode?: "ride_recommends" | "fixed" | "proportional";
  fixed_margin_usdc?: string;
  proportional_multiplier?: number;
  loss_policy?: "exit" | "pause_then_exit";
  emergency_exit_pct?: number;
}
export interface Plan {
  previous_plan_id?: string;
  preference_sources?: Partial<
    Record<keyof Preferences, "user" | "default" | "recommended">
  >;
  asset_filter_version?: 2;
  id: string;
  created_at: number;
  expires_at: number;
  preferences: Preferences;
  allocations: Allocation[];
  source_version: string;
}
export interface PositionIntent {
  key: string;
  asset: string;
  market: Venue;
  quantity: string;
  price: string;
  source_entry_price: string | null;
  source_leverage: number;
  source_leverage_verified?: boolean;
  observed_at: number;
  source_revision: string;
}
export interface Lot {
  key: string;
  asset: string;
  market: Venue;
  quantity: string;
  cost: string;
  realized: string;
  fees: string;
  funding: string;
}
export interface Sleeve extends Allocation {
  state:
    | "active"
    | "wind_down"
    | "closing"
    | "closed"
    | "loss_triggered"
    | "risk_off";
  lots: Record<string, Lot>;
  intents: Record<string, PositionIntent>;
  initialized: boolean;
  suppressed: string[];
  source_revision: string | null;
  last_source_at: number | null;
  replaced_at: number | null;
  reviewed_at?: number;
  leverage_rules_revision?: string;
  source_quantities?: Record<string, string>;
  fixed_targets?: Record<string, string>;
  fixed_seen_fills?: string[];
  fixed_last_fill_at?: number;
}
export interface Aggregate {
  position_id: string;
  key: string;
  asset: string;
  market: Venue;
  quantity: string;
  gross_notional_usdc: string;
  net_notional_usdc: string;
  margin_usdc: string;
  concentration_pct: string | null;
  sleeve_ids: string[];
}
export interface AccountSnapshot {
  account_id: string;
  observed_at: number;
  account_value_usdc: string;
  available_usdc: string;
  dedicated: boolean;
  eligible: boolean;
  positions: Record<string, string>;
  prices: Record<string, string>;
  quantity_decimals?: Record<string, number>;
  venue_accounts?: Record<string, string>;
  available_by_market?: Partial<Record<Venue, string>>;
  available_by_scope?: Record<string, string>;
  chain_block?: number;
  max_leverages: Record<string, number>;
  min_notionals: Record<string, string>;
  orders: { id: string; key: string; increases_risk: boolean }[];
  fills: Fill[];
  funding: Funding[];
  flows: Flow[];
  coverage_complete: boolean;
}
export interface Fill {
  id: string;
  order_id: string;
  task_id: string;
  key: string;
  quantity: string;
  price: string;
  fee_usdc: string;
  at: number;
}
export interface Funding {
  id: string;
  key: string;
  amount_usdc: string;
  at: number;
}
export interface Flow {
  id: string;
  amount_usdc: string;
  at: number;
}
export interface Execution {
  id: string;
  key: string;
  target_quantity: string;
  allocations: Record<string, string>;
  unfilled_allocations?: Record<string, string>;
  status:
    | "queued"
    | "submitted"
    | "partially_filled"
    | "settling"
    | "completed"
    | "failed"
    | "uncertain"
    | "superseded";
  revision: number;
  fingerprint: string;
  created_at: number;
  expires_at: number;
  task_id: string | null;
  observed_quantity: string | null;
  reserve_usdc: string;
  error: string | null;
}
export interface Portfolio {
  asset_filter_version?: 2;
  id: string;
  account_id: string | null;
  revision: number;
  state:
    | "activating"
    | "active"
    | "loss_triggered"
    | "closing"
    | "closed"
    | "attention";
  preferences: Preferences;
  sleeves: Sleeve[];
  executions: Execution[];
  snapshot: AccountSnapshot | null;
  initial_equity: string | null;
  created_at: number;
  ledger_started_at: number | null;
  seen_fills: string[];
  seen_funding: string[];
  seen_flows: string[];
  flow_total: string;
  reconciliation: "pending" | "complete" | "incomplete";
  loss_latched: boolean;
  control_id?: string;
  venue_accounts?: Record<string, string>;
  ledger_chain_block?: number;
  receipts?: import("./analytics.js").Receipt[];
  decisions?: import("./analytics.js").Decision[];
  configurations?: {
    at: number;
    copy_id: string;
    config: ReturnType<typeof import("./analytics.js").configAt>;
  }[];
  audit_started_at?: number;
  audit_verified_at?: number;
  funding_receipts?: {
    copy_id: string;
    id: string;
    key: string;
    at: number;
    amount_usdc: string;
  }[];
}

export function allocate(budget: Decimal.Value, count: number): string[] {
  const micros = D(budget).times(1e6);
  if (!micros.isInteger() || count < 1)
    throw new AgentError(
      "INVALID_AMOUNT",
      "USDC requires at most six decimal places.",
    );
  const base = micros.div(count).floor(),
    remainder = micros.minus(base.times(count)).toNumber();
  return Array.from({ length: count }, (_, i) =>
    base
      .plus(i < remainder ? 1 : 0)
      .div(1e6)
      .toFixed(6),
  );
}
export function defaultLeverageMode(p: Preferences, c: Candidate) {
  return c.market === "perps" && p.portfolio_kind != null
    ? ("follow_source" as const)
    : ("cap" as const);
}
// A suggestion is not the maximum a user may explicitly approve.
export function maximumUserLeverage(c: Candidate): number | null {
  if (c.market === "prediction") return 1;
  return PERPS_COPY_MAX_LEVERAGE;
}
export function recommendedLeverage(
  p: Preferences,
  c: Candidate,
  mode: "cap" | "follow_source" = defaultLeverageMode(p, c),
): number | null {
  const drawdown = c.source_drawdown_pct;
  if (drawdown == null || !Number.isFinite(drawdown) || drawdown < 0)
    return null;
  const riskCap =
    drawdown === 0 ? 8 : Math.floor(p.loss_trigger_pct / drawdown);
  if (c.market === "prediction") return riskCap >= 1 ? 1 : null;
  const toleranceCap =
    p.risk_tolerance === "low" ? 3 : p.risk_tolerance === "medium" ? 5 : 8;
  if (mode === "follow_source") {
    if (!Number.isFinite(c.venue_max_leverage) || c.venue_max_leverage < 1)
      return null;
    // Validate planning evidence only. New allocations have no extra user cap;
    // runtime verifies each source position and fresh per-asset venue limit.
    const cap = Math.floor(c.venue_max_leverage);
    return cap >= 1 ? cap : null;
  }
  // Preserve existing capped plans and explicitly selected copy modes.
  const atrCap =
    c.atr_pct == null
      ? 3
      : Math.max(3, Math.min(8, Math.floor(12 / Math.max(c.atr_pct, 0.01))));
  const cap = Math.min(c.venue_max_leverage, atrCap, riskCap, toleranceCap);
  return cap >= 3 ? cap : null;
}
// Asset category and symbol restrictions are independent of the market selector.
// Empty symbols + allow_altcoins means unrestricted assets, including BTC/ETH.
export function assetAllowed(
  p: Preferences,
  asset: string,
  category?: string,
  version = 2,
): boolean {
  if (version !== 2) {
    if (p.asset_category === "any") return true;
    if (p.asset_category === "rwa") return category === "rwa";
    return p.allow_altcoins || p.assets.includes(asset);
  }
  if (
    p.asset_category &&
    p.asset_category !== "any" &&
    category !== p.asset_category
  )
    return false;
  if (!p.assets.length) return p.allow_altcoins;
  return (
    p.assets.some((a) => a.toLowerCase() === asset.toLowerCase()) ||
    (p.allow_altcoins && !["BTC", "ETH"].includes(asset.toUpperCase()))
  );
}
export function matchesAssets(
  p: Preferences,
  c: Candidate,
  version = 2,
): boolean {
  if (version !== 2)
    return (
      c.assets.length > 0 &&
      (!p.asset_category ||
        p.asset_category === "any" ||
        c.asset_category === p.asset_category) &&
      (c.market === "prediction" ||
        c.assets.every(
          (a) =>
            (p.asset_category === "rwa" && c.asset_category === "rwa") ||
            p.asset_category === "any" ||
            p.assets.includes(a) ||
            (p.allow_altcoins && !["BTC", "ETH"].includes(a)),
        ))
    );
  return (
    c.assets.length > 0 &&
    (c.market === "prediction" ||
      c.assets.every((a) =>
        assetAllowed(p, a, c.asset_categories?.[a] ?? c.asset_category),
      ))
  );
}
export function eligibleCandidates(
  p: Preferences,
  candidates: Candidate[],
  version = 2,
): Candidate[] {
  return candidates
    .filter(
      (c) =>
        c.eligibility === "PASS" &&
        c.execution_supported !== false &&
        c.expires_at > now() &&
        fresh(c.scored_at, 36 * 3600_000) &&
        (p.market === "both" || c.market === p.market) &&
        matchesAssets(p, c, version) &&
        recommendedLeverage(p, c) !== null &&
        !(p.copy_mode === "fixed" && c.market === "prediction"),
    )
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export const minimumAllocation = (p: Preferences, c: Candidate) =>
  // Perps collateral is not order notional. New Agent plans accept any
  // positive micro-USDC allocation; each sized order is checked at execution.
  // Keep Prediction and legacy plan allocation rules unchanged.
  p.portfolio_kind && c.market === "perps"
    ? D("0.000001")
    : p.portfolio_kind
      ? D.max(50, c.min_notional_usdc)
      : D(c.min_notional_usdc);
export function requestedTraderCount(p: Preferences): number {
  return p.portfolio_kind === "single"
    ? 1
    : (p.basket_size ?? (p.portfolio_kind === "basket" ? 4 : 6));
}
function selectForCount(
  p: Preferences,
  candidates: Candidate[],
  count: number,
): Candidate[] {
  const amount = D(p.budget_usdc)
    .div(count)
    .toDecimalPlaces(6, Decimal.ROUND_DOWN);
  const allowed = eligibleCandidates(p, candidates).filter((c) =>
    amount.gte(minimumAllocation(p, c)),
  );
  const chosen: Candidate[] = [];
  while (chosen.length < count && allowed.length) {
    allowed.sort(
      (a, b) =>
        diversity(b, chosen) - diversity(a, chosen) || a.id.localeCompare(b.id),
    );
    chosen.push(allowed.shift()!);
  }
  return chosen;
}
export function recommend(p: Preferences, candidates: Candidate[]): Plan {
  const maximum = requestedTraderCount(p);
  const minimum =
    p.portfolio_kind === "single" ? 1 : p.portfolio_kind === "basket" ? 2 : 3;
  if (maximum < minimum || maximum > (p.portfolio_kind ? 8 : 6))
    throw new AgentError(
      "INVALID_BASKET",
      `Select ${minimum}–${p.portfolio_kind ? 8 : 6} traders for this plan.`,
      false,
      400,
    );
  let chosen: Candidate[] = [];
  // An explicit count is never silently reduced. Return feasible alternatives instead.
  for (
    let count = maximum;
    count >= (p.portfolio_kind ? maximum : minimum);
    count--
  ) {
    const selection = selectForCount(p, candidates, count);
    if (selection.length === count) {
      chosen = selection;
      break;
    }
  }
  if (!chosen.length)
    throw new AgentError(
      "NO_EXECUTABLE_PLAN",
      `The requested ${maximum}-trader plan is unavailable. Review the returned rules and feasible counts.`,
    );
  // 'both' is an allowed search universe, not a mandatory cross-market allocation.
  const amounts = allocate(p.budget_usdc, chosen.length);
  return {
    asset_filter_version: 2,
    id: uid("plan"),
    created_at: now(),
    expires_at: now() + 10 * 60_000,
    preferences: p,
    source_version: [...new Set(chosen.map((c) => c.score_version))].join("+"),
    allocations: chosen.map((c, i) => ({
      copy_id: uid("copy"),
      trader: c,
      amount_usdc: amounts[i],
      leverage_cap_source: "default",
      leverage_cap:
        defaultLeverageMode(p, c) === "follow_source"
          ? null
          : recommendedLeverage(p, c)!,
      ...(defaultLeverageMode(p, c) === "follow_source"
        ? { leverage_mode: "follow_source" as const }
        : {}),
      stop_loss_pct: 30,
      ...(p.copy_mode ? { copy_mode: p.copy_mode } : {}),
      ...(p.fixed_margin_usdc
        ? { fixed_margin_usdc: cash(p.fixed_margin_usdc) }
        : {}),
      ...(p.proportional_multiplier
        ? { proportional_multiplier: p.proportional_multiplier }
        : {}),
      ...(p.loss_policy
        ? {
            loss_policy: p.loss_policy,
            emergency_exit_pct: p.emergency_exit_pct ?? 70,
          }
        : {}),
    })),
  };
}

export function recommendationDiagnostics(
  p: Preferences,
  candidates: Candidate[],
) {
  const requested = requestedTraderCount(p);
  const minimum =
    p.portfolio_kind === "single" ? 1 : p.portfolio_kind === "basket" ? 2 : 3;
  const marketRows = candidates.filter(
    (c) => p.market === "both" || c.market === p.market,
  );
  const freshRows = marketRows.filter(
    (c) => c.expires_at > now() && fresh(c.scored_at, 36 * 3600_000),
  );
  const qualified = freshRows.filter((c) => c.eligibility === "PASS");
  const assets = qualified.filter((c) => matchesAssets(p, c));
  const eligible = eligibleCandidates(p, candidates);
  const amount = D(p.budget_usdc)
    .div(requested)
    .toDecimalPlaces(6, Decimal.ROUND_DOWN);
  const affordable = eligible.filter((c) =>
    amount.gte(minimumAllocation(p, c)),
  );
  const feasible = Array.from({ length: 8 }, (_, i) => i + 1).filter(
    (count) => {
      const alternative = {
        ...p,
        portfolio_kind: count === 1 ? ("single" as const) : ("basket" as const),
        basket_size: count,
      };
      return selectForCount(alternative, candidates, count).length === count;
    },
  );
  const blocker = !candidates.length
    ? "source_data_unavailable"
    : !marketRows.length
      ? "market_source_data_unavailable"
      : !freshRows.length
        ? "stale_source_scores"
        : !qualified.length
          ? "source_eligibility"
          : !assets.length
            ? "asset_preferences"
            : !eligible.length
              ? "risk_execution_or_copy_mode"
              : affordable.length < Math.min(minimum, eligible.length)
                ? "budget_minimums"
                : eligible.length < requested
                  ? "eligible_trader_supply"
                  : affordable.length < requested
                    ? "budget_minimums"
                    : null;
  const evaluations = candidates.map((c) => {
    const rules: {
      rule: string;
      field: string;
      current: unknown;
      required: unknown;
      message: string;
    }[] = [];
    const add = (
      rule: string,
      field: string,
      current: unknown,
      required: unknown,
      message: string,
    ) => rules.push({ rule, field, current, required, message });
    if (p.market !== "both" && c.market !== p.market)
      add(
        "market",
        "market",
        c.market,
        p.market,
        "Trader belongs to another market.",
      );
    if (c.expires_at <= now() || !fresh(c.scored_at, 36 * 3600_000))
      add(
        "stale_score",
        "scored_at",
        c.scored_at,
        "fresh score within 36 hours",
        "Score expired or its data is unavailable.",
      );
    if (c.eligibility !== "PASS")
      add(
        "source_eligibility",
        "eligibility",
        c.eligibility,
        "PASS",
        "Source qualification did not pass.",
      );
    if (!matchesAssets(p, c))
      add(
        "asset_preferences",
        "asset_category/assets",
        { category: c.asset_category, assets: c.assets },
        {
          category: p.asset_category,
          assets: p.assets,
          allow_altcoins: p.allow_altcoins,
        },
        "Trader assets do not match the saved asset preference.",
      );
    if (c.execution_supported === false)
      add(
        "execution_unsupported",
        "execution_supported",
        false,
        true,
        "Venue/account execution is unsupported.",
      );
    if (recommendedLeverage(p, c) === null)
      add(
        c.source_drawdown_pct == null ? "missing_risk_data" : "risk_limit",
        "loss_trigger_pct",
        {
          loss_trigger_pct: p.loss_trigger_pct,
          source_drawdown_pct: c.source_drawdown_pct,
        },
        c.market === "prediction"
          ? "at least 1x within the requested loss trigger"
          : "at least 3x within the requested loss trigger",
        "Missing risk evidence or loss/risk/venue caps prevent executable leverage. Review trader risk data; raising risk is not automatic.",
      );
    if (p.copy_mode === "fixed" && c.market === "prediction")
      add(
        "copy_mode",
        "copy_mode",
        "fixed",
        "Perps trader or another copy mode",
        "Prediction does not support Fixed margin mode.",
      );
    if (amount.lt(minimumAllocation(p, c)))
      add(
        "allocation_minimum",
        "budget_usdc/basket_size",
        {
          budget_usdc: p.budget_usdc,
          count: requested,
          per_trader_usdc: cash(amount),
        },
        {
          per_trader_usdc: cash(minimumAllocation(p, c)),
          venue_minimum_usdc: c.min_notional_usdc,
          policy_minimum_usdc:
            p.portfolio_kind && c.market === "prediction" ? "50.000000" : null,
        },
        "Allocation is below the applicable positive-USDC, legacy venue or Prediction product minimum. Perps order minimums are checked separately after sizing.",
      );
    return {
      trader_id: c.id,
      eligible: eligible.some((e) => e.id === c.id),
      budget_eligible: affordable.some((e) => e.id === c.id),
      rules,
    };
  });
  return {
    diagnostic_id: uid("diag"),
    stage: !blocker
      ? "plan_ready"
      : ({
          source_data_unavailable: "source_candidates",
          market_source_data_unavailable: "market_filter",
          stale_source_scores: "score_freshness",
          source_eligibility: "source_qualification",
          asset_preferences: "asset_filter",
          risk_execution_or_copy_mode: "risk_execution_and_copy_mode",
          budget_minimums: "allocation_minimums",
          eligible_trader_supply: "requested_trader_count",
        }[blocker] ?? "plan_allocation"),
    count_semantics:
      "Sequential filters; each count is a subset of the preceding count. Budget qualification uses the requested count.",
    source_candidates: candidates.length,
    market_candidates: marketRows.length,
    fresh_candidates: freshRows.length,
    qualified_candidates: qualified.length,
    asset_matching_candidates: assets.length,
    eligible_candidates: eligible.length,
    budget_eligible_candidates: affordable.length,
    minimum_basket_size: minimum,
    requested_basket_size: requested,
    feasible_basket_sizes: feasible,
    blocker,
    funding_required: false,
    execution_available: false,
    market_counts: {
      perps: eligible.filter((c) => c.market === "perps").length,
      prediction: eligible.filter((c) => c.market === "prediction").length,
    },
    rules: [
      ...(blocker && eligible.length && affordable.length < requested
        ? [
            {
              trader_id: "plan",
              rule: blocker,
              field: "basket_size",
              current: requested,
              required: feasible,
              message: `Requested ${requested} traders; ${eligible.length} qualify and ${affordable.length} meet the per-trader minimum at this count. ${feasible.length ? `Review a ${feasible.join(" or ")}-trader plan with the same risk settings.` : "No supported count is executable; inspect the trader minimums and eligibility rules."}`,
            },
          ]
        : []),
      ...evaluations.flatMap((e) =>
        e.rules.map((r) => ({ ...r, trader_id: e.trader_id })),
      ),
    ],
    candidate_evaluations: evaluations,
    adjustments: feasible
      .filter((n) => n !== requested)
      .map((count) => ({
        label: `Review ${count}-trader plan`,
        field: "basket_size",
        current: requested,
        required: count,
        preferences: {
          ...p,
          portfolio_kind: count === 1 ? "single" : "basket",
          basket_size: count,
        },
      })),
  };
}
function diversity(c: Candidate, chosen: Candidate[]): number {
  return (
    c.score -
    chosen.reduce(
      (n, x) =>
        n +
        (x.style === c.style ? 8 : 0) +
        (x.direction === c.direction ? 5 : 0) +
        6 * assetOverlap(x.assets, c.assets) +
        (x.market === c.market ? 2 : 0),
      0,
    )
  );
}
function assetOverlap(a: string[], b: string[]) {
  const left = new Set(a.map((asset) => asset.toUpperCase())),
    right = new Set(b.map((asset) => asset.toUpperCase()));
  const union = new Set([...left, ...right]);
  return union.size
    ? [...left].filter((asset) => right.has(asset)).length / union.size
    : 0;
}
export function aggregate(
  p: Portfolio,
  prices: Record<string, string>,
  book: "intent" | "actual" = "intent",
): Aggregate[] {
  const out = new Map<string, Aggregate>();
  for (const s of p.sleeves) {
    const rows =
      book === "intent" ? Object.values(s.intents) : Object.values(s.lots);
    for (const x of rows) {
      if (D(x.quantity).isZero()) continue;
      const price = prices[x.key];
      if (price == null || !D(price).gt(0))
        throw new AgentError(
          "STALE_PRICE",
          "A fresh price is required for every owned position.",
          true,
        );
      const a = out.get(x.key) ?? {
        position_id: `pos_${fingerprint([p.id, x.key]).slice(0, 32)}`,
        key: x.key,
        asset: x.asset,
        market: x.market,
        quantity: "0",
        gross_notional_usdc: "0",
        net_notional_usdc: "0",
        margin_usdc: "0",
        concentration_pct: null,
        sleeve_ids: [],
      };
      const notional = D(x.quantity).abs().times(price);
      const leverage =
        book === "intent"
          ? (x as PositionIntent).source_leverage
          : (s.intents[x.key]?.source_leverage ?? 1);
      a.quantity = D(a.quantity).plus(x.quantity).toString();
      a.gross_notional_usdc = D(a.gross_notional_usdc)
        .plus(notional)
        .toString();
      a.margin_usdc = D(a.margin_usdc)
        .plus(
          notional.div(
            Math.max(1, Math.min(s.leverage_cap ?? leverage, leverage)),
          ),
        )
        .toString();
      a.sleeve_ids.push(s.copy_id);
      out.set(x.key, a);
    }
  }
  const total = [...out.values()].reduce(
    (n, a) => n.plus(a.gross_notional_usdc),
    D(0),
  );
  const byAsset = new Map<string, Decimal>();
  for (const a of out.values())
    byAsset.set(
      a.asset,
      (byAsset.get(a.asset) ?? D(0)).plus(a.gross_notional_usdc),
    );
  return [...out.values()].map((a) => ({
    ...a,
    gross_notional_usdc: cash(a.gross_notional_usdc),
    net_notional_usdc: cash(D(a.quantity).times(prices[a.key])),
    margin_usdc: cash(a.margin_usdc),
    concentration_pct: total.isZero()
      ? null
      : byAsset.get(a.asset)!.div(total).times(100).toFixed(6),
  }));
}
export function risk(
  p: Portfolio,
  prices: Record<string, string>,
  allowReduction = false,
): Aggregate[] {
  const next = aggregate(p, prices),
    prior = aggregate(p, prices, "actual");
  const gross = next.reduce((n, a) => n.plus(a.gross_notional_usdc), D(0));
  const margin = next.reduce((n, a) => n.plus(a.margin_usdc), D(0));
  const budget = D(p.preferences.budget_usdc);
  // A sleeve reserves its gross margin even when another sleeve offsets it.
  const uncapped = p.sleeves.some(
    (s) => s.leverage_mode === "follow_source" && s.leverage_cap == null,
  );
  const approvedLeverage = p.sleeves.some((s) => s.leverage_mode != null)
    ? Math.max(1, ...p.sleeves.map((s) => s.leverage_cap ?? 1))
    : 8;
  if (
    (!uncapped && gross.gt(budget.times(approvedLeverage))) ||
    margin.gt(budget)
  )
    throw new AgentError(
      "BUDGET_EXCEEDED",
      "Target gross exposure or gross margin exceeds the approved budget.",
    );
  if (p.snapshot?.available_by_scope) {
    const scopeMargin = new Map<string, ReturnType<typeof D>>(),
      oldMargin = new Map<string, ReturnType<typeof D>>();
    for (const a of next.filter((a) => a.market === "perps")) {
      const scope = a.asset.includes(":") ? a.asset.split(":")[0] : "core";
      scopeMargin.set(
        scope,
        (scopeMargin.get(scope) ?? D(0)).plus(a.margin_usdc),
      );
    }
    for (const a of prior.filter((a) => a.market === "perps")) {
      const scope = a.asset.includes(":") ? a.asset.split(":")[0] : "core";
      oldMargin.set(scope, (oldMargin.get(scope) ?? D(0)).plus(a.margin_usdc));
    }
    for (const [scope, target] of scopeMargin)
      if (
        target.gt(
          (oldMargin.get(scope) ?? D(0)).plus(
            p.snapshot.available_by_scope[scope] ?? 0,
          ),
        )
      )
        throw new AgentError(
          "SCOPED_COLLATERAL_REQUIRED",
          "Fresh available collateral in the selected DEX is insufficient; another DEX's balance cannot fund this target.",
        );
  }
  for (const a of next) {
    const old = prior.find((x) => x.key === a.key);
    const reduces =
      allowReduction &&
      D(a.net_notional_usdc)
        .abs()
        .lte(D(old?.net_notional_usdc ?? 0).abs()) &&
      D(a.gross_notional_usdc).lte(old?.gross_notional_usdc ?? 0);
    if (
      D(a.concentration_pct ?? 0).gt(
        p.preferences.portfolio_kind === "single" ? 100 : 60,
      ) &&
      !reduces
    )
      throw new AgentError(
        "ASSET_CONCENTRATION",
        "An asset exceeds 60% of total gross sleeve exposure.",
      );
    if (a.market === "prediction" && D(a.quantity).lt(0))
      throw new AgentError(
        "INVALID_OUTCOME_POSITION",
        "Prediction outcome tokens cannot have negative inventory.",
      );
  }
  return next;
}
export function pnl(p: Portfolio): {
  net_usdc: string | null;
  sleeves: { copy_id: string; net_usdc: string | null }[];
  external_flows_usdc: string;
} {
  const quantitiesMatch =
    p.snapshot &&
    [
      ...new Set([
        ...Object.keys(p.snapshot.positions),
        ...p.sleeves.flatMap((s) => Object.keys(s.lots)),
      ]),
    ].every((key) =>
      p.sleeves
        .reduce((n, s) => n.plus(s.lots[key]?.quantity ?? 0), D(0))
        .eq(p.snapshot!.positions[key] ?? 0),
    );
  if (
    !p.snapshot ||
    p.reconciliation !== "complete" ||
    !p.snapshot.coverage_complete ||
    !fresh(p.snapshot.observed_at) ||
    !quantitiesMatch ||
    p.sleeves.some((s) =>
      Object.values(s.lots).some(
        (l) => !D(l.quantity).isZero() && !p.snapshot!.prices[l.key],
      ),
    )
  )
    return {
      net_usdc: null,
      sleeves: p.sleeves.map((s) => ({ copy_id: s.copy_id, net_usdc: null })),
      external_flows_usdc: cash(p.flow_total),
    };
  const rawSleeves = p.sleeves.map((s) => ({
    copy_id: s.copy_id,
    net_usdc: Object.values(s.lots).reduce(
      (n, l) =>
        n
          .plus(l.realized)
          .minus(l.fees)
          .plus(l.funding)
          .plus(
            D(l.quantity)
              .times(p.snapshot!.prices[l.key] ?? 0)
              .minus(l.cost),
          ),
      D(0),
    ),
  }));
  const total = rawSleeves.reduce((n, s) => n.plus(s.net_usdc), D(0));
  const accountDelta = D(p.snapshot.account_value_usdc)
    .minus(p.initial_equity ?? 0)
    .minus(p.flow_total);
  if (total.minus(accountDelta).abs().gt("0.000001"))
    return {
      net_usdc: null,
      sleeves: rawSleeves.map((s) => ({ copy_id: s.copy_id, net_usdc: null })),
      external_flows_usdc: cash(p.flow_total),
    };
  // Validate unrounded attribution, then conserve the verified account delta
  // when presenting each sleeve at micro-USDC precision.
  const shares = rawSleeves.map((s) => s.net_usdc.toDecimalPlaces(6));
  const remainder = D(cash(accountDelta)).minus(
    shares.reduce((n, share) => n.plus(share), D(0)),
  );
  if (!remainder.isZero() && shares.length) {
    const owner = rawSleeves.reduce(
      (best, s, i) =>
        s.net_usdc.abs().gt(rawSleeves[best].net_usdc.abs()) ? i : best,
      0,
    );
    shares[owner] = shares[owner].plus(remainder);
  }
  const sleeves = rawSleeves.map((s, i) => ({
    copy_id: s.copy_id,
    net_usdc: cash(shares[i].isZero() ? 0 : shares[i]),
  }));
  return {
    net_usdc: cash(accountDelta),
    sleeves,
    external_flows_usdc: cash(p.flow_total),
  };
}
