import type { SourceSnapshot } from "./adapter.js";
import { D, fresh, type PositionIntent, type Sleeve } from "./domain.js";
import { sourceEvidenceReady } from "./source-observations.js";

export const SOURCE_POSITION_GUARD_REASONS = [
  "SOURCE_GUARD_FRAME_NOT_READY",
  "SOURCE_GUARD_POSITION_MISSING",
  "SOURCE_GUARD_POSITION_STALE",
  "SOURCE_GUARD_POSITION_REVISION",
  "SOURCE_GUARD_FRAME_REVISION",
  "SOURCE_GUARD_ASSET_CHANGED",
  "SOURCE_GUARD_MARKET_CHANGED",
  "SOURCE_GUARD_ZERO_QUANTITY",
  "SOURCE_GUARD_LEVERAGE_NONINTEGER",
  "SOURCE_GUARD_LEVERAGE_NONPOSITIVE",
  "SOURCE_GUARD_EFFECTIVE_LEVERAGE",
  "SOURCE_GUARD_LEVERAGE_UNVERIFIED",
  "SOURCE_GUARD_RAW_QUANTITY_CHANGED",
] as const;

export type SourcePositionGuardReason =
  (typeof SOURCE_POSITION_GUARD_REASONS)[number];

/** First failing original predicate only; no evidence, values or identity escape. */
export function sourcePositionGuardFailure(
  source: SourceSnapshot,
  currentSource: PositionIntent | undefined,
  intent: PositionIntent,
  sleeve: Pick<Sleeve, "leverage_cap" | "leverage_mode">,
  maximumLeverage: () => number | undefined,
  rawQuantity: string | undefined,
): SourcePositionGuardReason | undefined {
  // Keep the original OR's order, short-circuiting, thresholds and exceptions.
  if (!sourceEvidenceReady(source)) return "SOURCE_GUARD_FRAME_NOT_READY";
  if (!currentSource) return "SOURCE_GUARD_POSITION_MISSING";
  if (!fresh(currentSource.observed_at)) return "SOURCE_GUARD_POSITION_STALE";
  if (currentSource.source_revision !== intent.source_revision)
    return "SOURCE_GUARD_POSITION_REVISION";
  if (source.revision !== intent.source_revision)
    return "SOURCE_GUARD_FRAME_REVISION";
  if (currentSource.asset !== intent.asset) return "SOURCE_GUARD_ASSET_CHANGED";
  if (currentSource.market !== intent.market)
    return "SOURCE_GUARD_MARKET_CHANGED";
  if (D(currentSource.quantity).isZero()) return "SOURCE_GUARD_ZERO_QUANTITY";
  if (!Number.isInteger(currentSource.source_leverage))
    return "SOURCE_GUARD_LEVERAGE_NONINTEGER";
  if (currentSource.source_leverage < 1)
    return "SOURCE_GUARD_LEVERAGE_NONPOSITIVE";
  if (
    Math.min(
      currentSource.source_leverage,
      sleeve.leverage_cap ?? Number.POSITIVE_INFINITY,
      maximumLeverage() ?? 1,
    ) !== intent.source_leverage
  )
    return "SOURCE_GUARD_EFFECTIVE_LEVERAGE";
  if (
    sleeve.leverage_mode != null &&
    currentSource.source_leverage_verified === false
  )
    return "SOURCE_GUARD_LEVERAGE_UNVERIFIED";
  if (rawQuantity != null && !D(rawQuantity).eq(currentSource.quantity))
    return "SOURCE_GUARD_RAW_QUANTITY_CHANGED";
  return undefined;
}
