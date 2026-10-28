import { AgentError } from "./contracts.js";

export interface ReadCost {
  method: string;
  base: number;
  reserve: number;
  rows?: { maximum?: number; divisor: number };
  unknownSurcharge?: boolean;
}

// Official per-IP weights and response surcharges:
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
const cheap = new Set([
  "l2Book", "allMids", "clearinghouseState", "orderStatus",
  "spotClearinghouseState", "exchangeStatus",
]);
const flat = new Set([
  "meta", "spotMeta", "metaAndAssetCtxs", "spotMetaAndAssetCtxs",
  "perpDexs", "perpCategories", "userAbstraction", "userDexAbstraction",
  "frontendOpenOrders", "openOrders", "userNonFundingLedgerUpdates",
  "maxBuilderFee", "userRateLimit",
]);

// These limits are explicit item counts in the corresponding info endpoint.
// https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
// The generic "500 elements or distinct blocks" pagination statement is NOT
// an item bound for userFunding. Unbounded surcharges are handled separately.
const bounded = new Map<string, { maximum: number; divisor: number }>([
  ["userFills", { maximum: 2000, divisor: 20 }],
  ["userFillsByTime", { maximum: 2000, divisor: 20 }],
  ["historicalOrders", { maximum: 2000, divisor: 20 }],
  ["userTwapSliceFills", { maximum: 2000, divisor: 20 }],
  ["candleSnapshot", { maximum: 5000, divisor: 60 }],
]);

// The rate-limit page explicitly names these methods and their per-20-item
// surcharge, but supplies no hard item bound. Admission must exclusively hold
// available capacity, then account for the ENTIRE real response (including
// debt above the hold). A base-only request must not be treated as bounded.
const unknownRows = new Set([
  "recentTrades", "fundingHistory", "userFunding", "nonUserFundingUpdates",
  "twapHistory", "userTwapSliceFillsByTime", "delegatorHistory",
  "delegatorRewards", "validatorStats",
]);

function unsupported() {
  return new AgentError(
    "VENUE_READ_UNSUPPORTED",
    "Venue read method has no verified weight contract.",
    false,
    503,
  );
}

function invalid() {
  return new AgentError(
    "VENUE_RESPONSE_INVALID",
    "Venue response exceeds its verified weight or shape contract.",
    true,
    503,
  );
}

export function readCost(payload: unknown): ReadCost {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw unsupported();
  const method = (payload as { type?: unknown }).type;
  if (typeof method !== "string") throw unsupported();
  const rows = bounded.get(method);
  if (rows)
    return {
      method,
      base: 20,
      reserve: 20 + Math.ceil(rows.maximum / rows.divisor),
      rows: { ...rows },
    };
  if (unknownRows.has(method))
    return { method, base: 20, reserve: 20, rows: { divisor: 20 }, unknownSurcharge: true };
  if (cheap.has(method)) return { method, base: 2, reserve: 2 };
  if (method === "userRole") return { method, base: 60, reserve: 60 };
  if (flat.has(method)) return { method, base: 20, reserve: 20 };
  throw unsupported();
}

export function responseCost(cost: ReadCost, data: unknown): number {
  if (!cost.rows) return cost.base;
  if (!Array.isArray(data) ||
      (cost.rows.maximum !== undefined && data.length > cost.rows.maximum)) throw invalid();
  // Ceiling conservatively charges a partial group. Admission has already
  // reserved bounded responses in full; unknown surcharges are never clamped
  // to the held capacity and may create debt in the exclusive admission gate.
  return cost.base + Math.ceil(data.length / cost.rows.divisor);
}
