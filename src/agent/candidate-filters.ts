import { AgentError } from "./contracts.js";
import type { Candidate } from "./domain.js";

export interface CandidateFilters {
  min_score?: number;
  max_drawdown_pct?: number;
  min_roi_pct?: number;
  max_roi_pct?: number;
}
export interface MetricWindow {
  start_at: number;
  end_at: number;
}
type HistoricalMetric = "roi" | "drawdown";
const filterKeys = [
  "min_score",
  "max_drawdown_pct",
  "min_roi_pct",
  "max_roi_pct",
] as const;

const invalidQuery = (message: string): never => {
  throw new AgentError("INVALID_BROWSE", message);
};

/** Canonical query values also bind pagination to the complete filter query. */
export function normalizeCandidateQuery(
  filters?: CandidateFilters,
  window?: MetricWindow,
): { filters: CandidateFilters; metric_window: MetricWindow | null } {
  if (
    filters !== undefined &&
    (filters === null || typeof filters !== "object" || Array.isArray(filters))
  )
    invalidQuery("Candidate filters must be an object.");
  if (
    filters &&
    Object.keys(filters).some(
      (key) => !filterKeys.includes(key as (typeof filterKeys)[number]),
    )
  )
    invalidQuery("Unsupported candidate filter.");
  const normalized: CandidateFilters = {};
  for (const key of filterKeys) {
    const value = filters?.[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value))
      invalidQuery("Candidate filter values must be finite numbers.");
    normalized[key] = Object.is(value, -0) ? 0 : value;
  }
  if (
    normalized.min_score != null &&
    (normalized.min_score < 0 || normalized.min_score > 100)
  )
    invalidQuery("Minimum score must be between 0 and 100.");
  if (normalized.max_drawdown_pct != null && normalized.max_drawdown_pct < 0)
    invalidQuery("Maximum drawdown must be a non-negative percentage.");
  if (
    normalized.min_roi_pct != null &&
    normalized.max_roi_pct != null &&
    normalized.min_roi_pct > normalized.max_roi_pct
  )
    invalidQuery("Minimum ROI cannot exceed maximum ROI.");
  if (window === undefined) return { filters: normalized, metric_window: null };
  if (
    window === null ||
    typeof window !== "object" ||
    Array.isArray(window) ||
    Object.keys(window).some((key) => key !== "start_at" && key !== "end_at") ||
    !Number.isSafeInteger(window.start_at) ||
    !Number.isSafeInteger(window.end_at) ||
    window.start_at <= 0 ||
    window.end_at <= window.start_at
  )
    invalidQuery(
      "Metric window requires positive integer start/end timestamps with start before end.",
    );
  return {
    filters: normalized,
    metric_window: { start_at: window.start_at, end_at: window.end_at },
  };
}

function historicalMetrics(
  filters: CandidateFilters,
  window: MetricWindow | null,
  sortBy: "score" | "roi" | "drawdown",
): HistoricalMetric[] {
  const metrics: HistoricalMetric[] = [];
  if (
    filters.min_roi_pct != null ||
    filters.max_roi_pct != null ||
    sortBy === "roi"
  )
    metrics.push("roi");
  if (filters.max_drawdown_pct != null || sortBy === "drawdown")
    metrics.push("drawdown");
  // A general requested window applies to both displayed historical metrics.
  if (window && !metrics.length) return ["roi", "drawdown"];
  return metrics;
}

export function verifiedWindow(
  c: Candidate,
  metric: HistoricalMetric,
): MetricWindow | null {
  const period = c.metric_periods?.[metric];
  if (period) {
    if (
      typeof period.period !== "string" ||
      !period.period.trim() ||
      /unknown|unavailable|unverified|missing|unsupported|not[_ -]?available/i.test(
        period.period,
      )
    )
      return null;
    const { start_at, end_at } = period;
    return Number.isSafeInteger(start_at) &&
      Number.isSafeInteger(end_at) &&
      start_at! > 0 &&
      end_at! > start_at! &&
      end_at! <= Date.now()
      ? { start_at: start_at!, end_at: end_at! }
      : null;
  }
  const window = c.metric_window;
  // The common historical window is authoritative only with non-estimated
  // source provenance. An explicit unavailable per-metric period wins above.
  return window &&
    c.metric_provenance?.estimated === false &&
    typeof c.metric_provenance.source === "string" &&
    c.metric_provenance.source.trim() &&
    Number.isSafeInteger(window.start_at) &&
    Number.isSafeInteger(window.end_at) &&
    window.start_at > 0 &&
    window.end_at > window.start_at &&
    window.end_at <= Date.now()
    ? { start_at: window.start_at, end_at: window.end_at }
    : null;
}

/** Comparability requires verified bounds for every displayed metric, not just
 * a window label or matching unknown-period markers. */
export function metricPeriodsComparable(
  candidates: Candidate[],
  metric?: HistoricalMetric,
): boolean {
  if (!candidates.length) return false;
  const metrics: HistoricalMetric[] = metric ? [metric] : ["roi", "drawdown"];
  const windows = candidates.flatMap((c) =>
    metrics.map((key) => verifiedWindow(c, key)),
  );
  const first = windows[0];
  return (
    first != null &&
    windows.every(
      (window) =>
        window != null &&
        window.start_at === first.start_at &&
        window.end_at === first.end_at,
    )
  );
}

export function candidateMetricValue(
  c: Candidate,
  metric: "score" | HistoricalMetric,
): number | null {
  const number =
    metric === "score"
      ? c.score
      : metric === "roi"
        ? c.source_roi_pct
        : c.source_drawdown_pct;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  if (metric === "score" && (number < 0 || number > 100)) return null;
  if (metric === "drawdown" && number < 0) return null;
  return number;
}

/** Pure query filtering; never changes a saved plan, preferences or snapshot. */
export function filterCandidates(
  candidates: Candidate[],
  filters?: CandidateFilters,
  window?: MetricWindow | null,
  sortBy: "score" | "roi" | "drawdown" = "score",
) {
  const normalized = normalizeCandidateQuery(filters, window ?? undefined);
  const f = normalized.filters;
  const target = normalized.metric_window;
  const metrics = historicalMetrics(f, target, sortBy);
  const counts = {
    before_filters_count: candidates.length,
    missing_metric_count: 0,
    unavailable_window_count: 0,
    mismatched_window_count: 0,
    threshold_excluded_count: 0,
    unknown_period_count: candidates.filter((c) =>
      metrics.some((metric) => !verifiedWindow(c, metric)),
    ).length,
    matching_count: 0,
  };
  const rows = candidates.filter((c) => {
    const score = candidateMetricValue(c, "score"),
      roi = candidateMetricValue(c, "roi"),
      dd = candidateMetricValue(c, "drawdown");
    if (
      (f.min_score != null && score == null) ||
      ((f.min_roi_pct != null || f.max_roi_pct != null) && roi == null) ||
      (f.max_drawdown_pct != null && dd == null) ||
      (target &&
        metrics.some((metric) => candidateMetricValue(c, metric) == null))
    ) {
      counts.missing_metric_count++;
      return false;
    }
    if (target) {
      const periods = metrics.map((metric) => verifiedWindow(c, metric));
      if (periods.some((period) => !period)) {
        counts.unavailable_window_count++;
        return false;
      }
      if (
        periods.some(
          (period) =>
            period!.start_at !== target.start_at ||
            period!.end_at !== target.end_at,
        )
      ) {
        counts.mismatched_window_count++;
        return false;
      }
    }
    if (
      (f.min_score != null && score! < f.min_score) ||
      (f.max_drawdown_pct != null && dd! > f.max_drawdown_pct) ||
      (f.min_roi_pct != null && roi! < f.min_roi_pct) ||
      (f.max_roi_pct != null && roi! > f.max_roi_pct)
    ) {
      counts.threshold_excluded_count++;
      return false;
    }
    return true;
  });
  counts.matching_count = rows.length;
  return {
    rows,
    applied_filters: f,
    counts,
    metric_basis: {
      kind: target ? "verified_window" : "source_reported_values",
      requested_window: target,
      applied_to_metrics: metrics,
      unknown_period_count: counts.unknown_period_count,
      explanation: target
        ? "Only metrics with verified exact requested start/end timestamps pass. Unknown or different windows are excluded; no other period is substituted."
        : "Filters use source-reported percentage values. Unknown periods remain unknown; numeric filtering does not establish a same-period risk or return comparison.",
    },
  };
}
