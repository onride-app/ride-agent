import { AgentError } from "./contracts.js";

const endpoint = "https://data-api.polymarket.com/v2/positions";
const incomplete = (reason: string): never => {
  throw new AgentError(
    "PREDICTION_DATA_INCOMPLETE",
    "Prediction position evidence could not be completely verified.",
    true,
    503,
    { reason_code: reason },
  );
};
const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export type PredictionDataPosition = Record<string, any> & {
  asset: string;
  conditionId: string;
  size: number;
  curPrice: number;
  currentValue: number;
  avgPrice?: number | null;
};

// Positive holdings read only. Even a terminal v2 walk omits inactive markets;
// it is never independent flatness, empty-wallet or full-equity evidence.
export async function readPredictionPositionsV2(
  wallet: string,
  options: {
    request?: typeof fetch;
    signal?: AbortSignal;
    maxPages?: number;
  } = {},
): Promise<{
  rows: PredictionDataPosition[];
  coverage_complete: false;
  coverage_scope: "servable_markets_only";
}> {
  if (!/^0x[0-9a-f]{40}$/i.test(wallet))
    return incomplete("PM_V2_INVALID_WALLET");
  const request = options.request ?? fetch;
  const deadline = AbortSignal.timeout(12000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100)
    return incomplete("PM_V2_INVALID_PAGE_LIMIT");
  const rows = new Map<string, PredictionDataPosition>();
  for (const status of ["OPEN", "REDEEMABLE_LOST"] as const) {
    const seen = new Set<string>();
    let cursor: string | undefined,
      complete = false;
    for (let page = 0; page < maxPages; page++) {
      signal.throwIfAborted();
      const url = new URL(endpoint);
      for (const [key, value] of Object.entries({
        user: wallet,
        status,
        filter_type: "TOKENS",
        filter_amount: "0",
        include_archived: "true",
        limit: "500",
        sort_by: "TOKENS",
        sort_direction: "DESC",
        ...(cursor ? { cursor } : {}),
      }))
        url.searchParams.set(key, value);
      const response = await request(url, { signal, redirect: "error" });
      if (!response.ok) return incomplete("PM_V2_HTTP_FAILURE");
      let body: any;
      try {
        body = await response.json();
      } catch {
        return incomplete("PM_V2_INVALID_JSON");
      }
      if (
        !Array.isArray(body?.data) ||
        body.data.length > 500 ||
        typeof body.pagination?.has_more !== "boolean"
      )
        return incomplete("PM_V2_INVALID_ENVELOPE");
      const next = body.pagination.next_cursor;
      if (
        !(next === null || (typeof next === "string" && next.trim())) ||
        body.pagination.has_more !== (next !== null)
      )
        return incomplete("PM_V2_INVALID_CURSOR");
      for (const row of body.data) {
        if (
          typeof row?.proxy_wallet !== "string" ||
          row.proxy_wallet.toLowerCase() !== wallet.toLowerCase()
        )
          return incomplete("PM_V2_WALLET_MISMATCH");
        if (
          typeof row.token_id !== "string" ||
          !/^(0|[1-9]\d{0,77})$/.test(row.token_id) ||
          BigInt(row.token_id) >= 1n << 256n ||
          typeof row.condition_id !== "string" ||
          !/^0x[0-9a-f]{64}$/i.test(row.condition_id)
        )
          return incomplete("PM_V2_INVALID_IDENTITY");
        if (
          !(status === "OPEN"
            ? ["OPEN", "REDEEMABLE"].includes(row.status)
            : row.status === "REDEEMABLE")
        )
          return incomplete("PM_V2_STATUS_MISMATCH");
        if (
          !numeric(row.current_size) ||
          !numeric(row.current_value) ||
          !numeric(row.current_price) ||
          row.current_price > 1 ||
          (row.avg_price !== null &&
            row.avg_price !== undefined &&
            (!numeric(row.avg_price) || row.avg_price > 1))
        )
          return incomplete("PM_V2_INVALID_ECONOMICS");
        const normalized = { ...row };
        for (const [modern, legacy] of [
          ["proxy_wallet", "proxyWallet"],
          ["token_id", "asset"],
          ["condition_id", "conditionId"],
          ["current_size", "size"],
          ["current_value", "currentValue"],
          ["current_price", "curPrice"],
          ["avg_price", "avgPrice"],
          ["negative_risk", "negativeRisk"],
          ["outcome_index", "outcomeIndex"],
        ]) {
          if (Object.hasOwn(row, modern)) {
            if (Object.hasOwn(row, legacy) && row[legacy] !== row[modern])
              return incomplete("PM_V2_CONFLICTING_ALIASES");
            normalized[legacy] = row[modern];
          }
        }
        const previous = rows.get(row.token_id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(normalized))
          return incomplete("PM_V2_CHANGED_POSITION");
        rows.set(row.token_id, normalized as PredictionDataPosition);
      }
      if (next === null) {
        complete = true;
        break;
      }
      if (seen.has(next)) return incomplete("PM_V2_REPEATED_CURSOR");
      seen.add(next);
      cursor = next;
    }
    if (!complete) return incomplete("PM_V2_PAGE_LIMIT");
  }
  return {
    rows: [...rows.values()],
    coverage_complete: false,
    coverage_scope: "servable_markets_only",
  };
}
