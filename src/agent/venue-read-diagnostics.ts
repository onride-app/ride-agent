import { Buffer } from "node:buffer";
import { Console } from "node:console";
import type { Writable } from "node:stream";

export const VENUE_READ_DIAGNOSTICS_MAX_BYTES = 16 * 1024;
const MAX_ROWS = 200;
const COUNTERS = [
  "calls",
  "cache_hit",
  "flight_join",
  "actual_fetch",
  "http_429",
  "http_failure",
  "transport_failure",
  "local_budget_denied",
  "local_deadline_denied",
  "local_cooldown_denied",
  "coordinated_denied",
  "coordinated_no_upstream",
  "coordinated_rate_limited",
  "unsupported_method",
  "invalid_response",
  "reserved_weight",
  "charged_weight",
  "unknown_fetch",
  "unknown_uncertain",
  "unknown_overrun",
  "unknown_debt_weight",
] as const;
const PLANS = [
  "loaded_valid",
  "loaded_cold",
  "load_failed",
  "claimed",
  "restored_admitted",
  "claim_failed",
  "persisted",
  "persist_failed",
  "invalidated",
] as const;
const FRAMES = [
  "admitted",
  "denied",
  "capacity_trials",
  "released",
  "release_failed",
] as const;
const BUDGET = [
  "capacity",
  "window_ms",
  "used",
  "source_used",
  "source_pacing_loans",
  "debt",
  "provider_cooldown_ms",
  "quarantine_ms",
  "account_active",
  "source_active",
  "account_queued",
  "source_queued",
  "observation_queued",
  "observation_reserved",
  "observation_pacing_ms",
] as const;
const OBSERVATIONS = ["started", "completed", "deferred", "growth"] as const;
const METHODS = new Set([
  "l2Book",
  "allMids",
  "clearinghouseState",
  "orderStatus",
  "spotClearinghouseState",
  "exchangeStatus",
  "meta",
  "spotMeta",
  "metaAndAssetCtxs",
  "spotMetaAndAssetCtxs",
  "perpDexs",
  "perpCategories",
  "userAbstraction",
  "userDexAbstraction",
  "frontendOpenOrders",
  "openOrders",
  "userNonFundingLedgerUpdates",
  "maxBuilderFee",
  "userRateLimit",
  "userFills",
  "userFillsByTime",
  "historicalOrders",
  "userTwapSliceFills",
  "candleSnapshot",
  "recentTrades",
  "fundingHistory",
  "userFunding",
  "nonUserFundingUpdates",
  "twapHistory",
  "userTwapSliceFillsByTime",
  "delegatorHistory",
  "delegatorRewards",
  "validatorStats",
  "userRole",
  "unsupported",
]);
type Row = Record<string, unknown>;
const row = (): Row => Object.create(null) as Row;
const record = (value: unknown): value is Row =>
  value !== null && typeof value === "object" && !Array.isArray(value);
// Read only own data properties. Getters, toJSON and unknown fields never run.
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
}
function number(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}
function numbers(value: unknown, keys: readonly string[]): Row | undefined {
  if (!record(value)) return undefined;
  const result = row();
  for (const key of keys) {
    const item = own(value, key);
    if (number(item)) result[key] = item;
  }
  return result;
}
function purpose(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80) return false;
  const parts = value.split(":");
  return (
    parts.length === 2 &&
    ["account", "source"].includes(parts[0]!) &&
    METHODS.has(parts[1]!)
  );
}
function classification(
  value: unknown,
  allowed: readonly string[],
): value is string {
  return typeof value === "string" && allowed.includes(value);
}
function response(value: unknown): Row | undefined {
  if (!record(value) || !purpose(own(value, "purpose_method")))
    return undefined;
  const result = row();
  result.purpose_method = own(value, "purpose_method");
  const kinds: Record<string, readonly string[]> = {
    content_kind: ["json", "html", "text", "other", "missing"],
    retry_after_kind: ["seconds", "date", "invalid", "missing"],
    server_family: [
      "cloudflare",
      "cloudfront",
      "nginx",
      "envoy",
      "other",
      "missing",
    ],
  };
  for (const key of Object.keys(kinds)) {
    const item = own(value, key);
    if (!classification(item, kinds[key]!)) return undefined;
    result[key] = item;
  }
  for (const key of ["retry_after_ms", "count"]) {
    const item = own(value, key);
    if (!number(item)) return undefined;
    result[key] = item;
  }
  for (const key of ["cloudfront_header", "cloudflare_header"]) {
    const item = own(value, key);
    if (typeof item !== "boolean") return undefined;
    result[key] = item;
  }
  return result;
}
function rows(value: unknown, project: (item: unknown) => Row | undefined) {
  const result: Row[] = [];
  if (!Array.isArray(value)) return { result, omitted: 0 };
  const length = own(value, "length");
  if (!Number.isSafeInteger(length) || (length as number) < 0)
    return { result, omitted: 0 };
  let omitted = Math.max(0, (length as number) - MAX_ROWS);
  for (let index = 0; index < Math.min(length as number, MAX_ROWS); index++) {
    const item = project(own(value, String(index)));
    if (item) result.push(item);
    else omitted++;
  }
  return { result, omitted };
}

/** Fixed diagnostic fields only; never a financial or provider evidence packet. */
export function sanitizeVenueReadDiagnostics(value: unknown): Row | undefined {
  try {
    if (!record(value) || own(value, "event") !== "venue_read_budget")
      return undefined;
    const result = row();
    result.event = "venue_read_budget";
    if (own(value, "scope") === "shared_VenueReads_instances_and_HL_hosts_only")
      result.scope = "shared_VenueReads_instances_and_HL_hosts_only";
    const transport = own(value, "transport");
    if (classification(transport, ["official", "core_shared_info"]))
      result.transport = transport;
    const interval = own(value, "interval_ms");
    if (number(interval)) result.interval_ms = interval;
    const budget = own(value, "budget"),
      projectedBudget = numbers(budget, BUDGET);
    if (projectedBudget) {
      for (const key of ["unknown_exclusive", "observation_active"]) {
        const item = own(budget, key);
        if (typeof item === "boolean") projectedBudget[key] = item;
      }
      const observations = numbers(own(budget, "observations"), OBSERVATIONS);
      if (observations) projectedBudget.observations = observations;
      result.budget = projectedBudget;
    }
    for (const [key, keys] of [
      ["counts", COUNTERS],
      ["cost_plans", PLANS],
      ["frames", FRAMES],
    ] as const) {
      const projected = numbers(own(value, key), keys);
      if (projected) result[key] = projected;
    }
    const seen = new Set<string>();
    const methods = rows(own(value, "methods"), (item) => {
      if (!record(item)) return undefined;
      const label = own(item, "purpose_method");
      if (!purpose(label) || seen.has(label)) return undefined;
      seen.add(label);
      return Object.assign(
        row(),
        { purpose_method: label },
        numbers(item, COUNTERS),
      );
    });
    const responses = rows(own(value, "rate_limit_responses"), response);
    result.methods = methods.result;
    result.rate_limit_responses = responses.result;
    const omissions = () => {
      if (methods.omitted || responses.omitted) {
        result.truncated = true;
        result.omitted_method_rows = methods.omitted;
        result.omitted_rate_limit_rows = responses.omitted;
      }
    };
    omissions();
    for (;;) {
      if (
        Buffer.byteLength(JSON.stringify(result), "utf8") + 1 <=
        VENUE_READ_DIAGNOSTICS_MAX_BYTES
      )
        return result;
      // Keep counters and method totals before optional response classifications.
      if (responses.result.length) {
        responses.result.pop();
        responses.omitted++;
      } else if (methods.result.length) {
        methods.result.pop();
        methods.omitted++;
      } else return undefined;
      omissions();
    }
  } catch {
    // A malformed/proxy diagnostic cannot alter the read that produced it.
    return undefined;
  }
}

export function createVenueReadDiagnosticsReporter(
  stderr: Writable,
): (value: unknown) => void {
  // A dedicated Console isolates synchronous writes and asynchronous EPIPE via
  // Node's ignoreErrors handling, without changing the application's logger.
  const output = new Console({ stdout: stderr, stderr, ignoreErrors: true });
  return (value) => {
    try {
      const projected = sanitizeVenueReadDiagnostics(value);
      if (!projected) return;
      const line = JSON.stringify(projected);
      if (
        Buffer.byteLength(line, "utf8") + 1 <=
        VENUE_READ_DIAGNOSTICS_MAX_BYTES
      )
        output.error(line);
    } catch {
      // Diagnostics are best effort, never a read/admission failure.
    }
  };
}

export const reportVenueReadDiagnostics = createVenueReadDiagnosticsReporter(
  process.stderr,
);
