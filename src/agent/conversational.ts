import { AgentError, type Preferences } from "./contracts.js";
import {
  D,
  cash,
  fingerprint,
  type Allocation,
  type Candidate,
  type Plan,
} from "./domain.js";

export function validateCopySettings(a: Allocation): void {
  if (
    a.copy_mode === "fixed" &&
    (!a.fixed_margin_usdc || D(a.fixed_margin_usdc).gt(a.amount_usdc))
  )
    throw new AgentError(
      "INVALID_COPY_MODE",
      "Fixed margin must be positive and within the trader allocation.",
      false,
      400,
    );
  if (
    a.loss_policy === "pause_then_exit" &&
    (a.emergency_exit_pct ?? 70) <= a.stop_loss_pct
  )
    throw new AgentError(
      "INVALID_LOSS_POLICY",
      "Emergency exit must be above the pause threshold.",
      false,
      400,
    );
  if (a.trader.market === "prediction" && a.copy_mode === "fixed")
    throw new AgentError(
      "INVALID_COPY_MODE",
      "Fixed margin is a Perps mode; prediction copies use proportional exposure.",
      false,
      400,
    );
}

export function compatibility(plan: Plan) {
  const allocations = plan.allocations,
    total = allocations.reduce((n, a) => n.plus(a.amount_usdc), D(0));
  const pairs = [];
  for (let i = 0; i < allocations.length; i++)
    for (let j = i + 1; j < allocations.length; j++) {
      const a = allocations[i].trader,
        b = allocations[j].trader;
      const assets = a.assets.filter((x) => b.assets.includes(x));
      const sameDirection =
        a.direction !== "mixed" && a.direction === b.direction;
      const holdingOverlap =
        a.median_hold_hours == null || b.median_hold_hours == null
          ? null
          : Math.max(a.median_hold_hours, b.median_hold_hours) /
              Math.max(1, Math.min(a.median_hold_hours, b.median_hold_hours)) <
            2;
      const flags = [
        assets.length && sameDirection ? "same_asset_and_direction" : null,
        holdingOverlap && a.style === b.style
          ? "similar_holding_and_style"
          : null,
      ].filter(Boolean);
      pairs.push({
        traders: [a.id, b.id],
        shared_assets: assets,
        same_direction: sameDirection,
        similar_holding_period: holdingOverlap,
        flags,
      });
    }
  const warnings = pairs.reduce((n, p) => n + p.flags.length, 0);
  return {
    fingerprint: fingerprint(allocations),
    warnings,
    pairs,
    capital_weights: allocations.map((a) => ({
      trader_id: a.trader.id,
      weight_pct: total.isZero()
        ? null
        : cash(D(a.amount_usdc).div(total).times(100)),
    })),
    portfolio_historical_drawdown_pct: null,
    historical_loss_correlation: null,
    missing_evidence:
      "Historical overlap of losses is unavailable. Shared assets and current direction do not prove future correlation.",
  };
}

export function alternatives(plan: Plan, candidates: Candidate[]) {
  const current = compatibility(plan).warnings;
  const suggestions: {
    outgoing_trader_id: string;
    incoming_trader: Candidate;
    fewer_flags: number;
    base_plan_id: string;
    kind: "one_for_one_replacement";
    trader_count_unchanged: true;
    measured_risk_improvement: null;
    replacement_arguments: {
      plan_id: string;
      replacements: {
        outgoing_trader_id: string;
        incoming_trader_id: string;
      }[];
    };
  }[] = [];
  for (const out of plan.allocations)
    for (const candidate of candidates) {
      if (plan.allocations.some((a) => a.trader.id === candidate.id)) continue;
      const trial = {
        ...plan,
        allocations: plan.allocations.map((a) =>
          a === out ? { ...a, trader: candidate } : a,
        ),
      };
      const improvement = current - compatibility(trial).warnings;
      if (improvement > 0)
        suggestions.push({
          outgoing_trader_id: out.trader.id,
          incoming_trader: candidate,
          fewer_flags: improvement,
          base_plan_id: plan.id,
          kind: "one_for_one_replacement",
          trader_count_unchanged: true,
          measured_risk_improvement: null,
          replacement_arguments: {
            plan_id: plan.id,
            replacements: [
              {
                outgoing_trader_id: out.trader.id,
                incoming_trader_id: candidate.id,
              },
            ],
          },
        });
    }
  return suggestions
    .sort(
      (a, b) =>
        b.fewer_flags - a.fewer_flags ||
        b.incoming_trader.score - a.incoming_trader.score,
    )
    .slice(0, 4);
}

export function basketLimits(p: Preferences): [number, number] {
  return p.portfolio_kind === "single"
    ? [1, 1]
    : p.portfolio_kind === "basket"
      ? [2, 8]
      : [3, 6];
}
