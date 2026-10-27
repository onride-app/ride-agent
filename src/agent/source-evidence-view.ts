import { D } from "./domain.js";
import {
  isPlanReadEvidence,
  type PlanReadEvidence,
  type PlanSourceEvidence,
  type ReadEvidencePosition,
  type ReadEvidenceSnapshot,
} from "./read-evidence.js";

export interface SourcePositionEvidenceView extends ReadEvidencePosition {
  position_leverage_setting: number | null;
  base_perps_position_notional_to_equity: string | null;
}

export interface SourceSnapshotEvidenceView extends ReadEvidenceSnapshot {
  positions: SourcePositionEvidenceView[];
}

export interface SourceEvidenceView extends Omit<
  PlanSourceEvidence,
  "snapshot"
> {
  snapshot: SourceSnapshotEvidenceView | null;
  source_position_leverage_basis: "venue_position_leverage_setting";
  base_perps_gross_exposure_to_equity: string | null;
}

export interface PlanSourceEvidenceView extends Omit<
  PlanReadEvidence,
  "sources"
> {
  sources: SourceEvidenceView[];
  field_semantics: {
    product_planning_max_leverage: string;
    market_max_leverages: string;
    source_leverage: string;
    base_perps_exposure_to_equity: string;
  };
}

const fieldSemantics: PlanSourceEvidenceView["field_semantics"] = {
  product_planning_max_leverage:
    "market.product_planning_max_leverage is the product planning envelope (40), not source leverage or a per-asset exchange limit.",
  market_max_leverages:
    "market.max_leverages contains current exchange maximum leverage by base-perps asset, not a trader's leverage setting or exposure.",
  source_leverage:
    "Legacy source_leverage and verified position_leverage_setting represent the venue-reported position leverage setting, not account exposure divided by equity.",
  base_perps_exposure_to_equity:
    "Current base-perps position notional divided by verified source equity; gross exposure sums absolute position notionals. These ratios are neither historical leverage distributions nor margin-based leverage.",
};

const freshAt = (timestamp: number, observedAt: number): boolean =>
  Number.isSafeInteger(timestamp) &&
  timestamp >= 0 &&
  timestamp <= observedAt &&
  observedAt - timestamp <= 30_000;

const nonnegative = (value: string | null) => {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
    return null;
  try {
    const amount = D(value);
    return amount.isFinite() && amount.gte(0) ? amount : null;
  } catch {
    return null;
  }
};

/** Pure display projection; its cloned fields must never feed execution sizing. */
export function sourceEvidenceView(
  evidence: PlanReadEvidence,
  observedAt = Date.now(),
): PlanSourceEvidenceView {
  const valid =
    Number.isSafeInteger(observedAt) &&
    observedAt >= 0 &&
    isPlanReadEvidence(evidence) &&
    freshAt(evidence.observed_at, observedAt) &&
    freshAt(evidence.market.observed_at, observedAt);
  const view = structuredClone(evidence);
  return {
    ...view,
    field_semantics: { ...fieldSemantics },
    sources: view.sources.map((source): SourceEvidenceView => {
      const snapshot = source.snapshot;
      const equity = snapshot ? nonnegative(snapshot.account_value_usdc) : null;
      const notionals = snapshot?.positions.map((position) =>
        nonnegative(position.position_notional_usdc),
      );
      const canMeasure =
        valid &&
        source.status === "available" &&
        source.account_mode === "standard" &&
        source.equity_basis === "standard_clearinghouse_account_value" &&
        source.equity_verified === true &&
        source.scope === "base_perps" &&
        source.coverage_complete === true &&
        snapshot?.complete === true &&
        freshAt(snapshot.observed_at, observedAt) &&
        snapshot.positions.every((position) =>
          freshAt(position.observed_at, observedAt),
        ) &&
        equity != null &&
        equity.gt(0) &&
        notionals != null &&
        notionals.every((notional) => notional != null);
      const ratio = (notional: ReturnType<typeof D> | null): string | null =>
        canMeasure && notional != null && equity != null
          ? notional.div(equity).toFixed()
          : null;
      return {
        ...source,
        source_position_leverage_basis: "venue_position_leverage_setting",
        base_perps_gross_exposure_to_equity:
          canMeasure && notionals
            ? ratio(
                notionals.reduce(
                  (total, notional) => total.plus(notional!),
                  D(0),
                ),
              )
            : null,
        snapshot: snapshot
          ? {
              ...snapshot,
              positions: snapshot.positions.map((position, index) => ({
                ...position,
                position_leverage_setting:
                  position.source_leverage_verified === true &&
                  Number.isInteger(position.source_leverage) &&
                  position.source_leverage >= 1
                    ? position.source_leverage
                    : null,
                base_perps_position_notional_to_equity: ratio(
                  notionals?.[index] ?? null,
                ),
              })),
            }
          : null,
      };
    }),
  };
}
