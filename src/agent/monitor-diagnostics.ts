import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AgentError } from "./contracts.js";

export interface MonitorTimingRecord {
  event: "agent_monitor_timing";
  tick_ref: string;
  kind: "tick" | "phase" | "operation" | "account_age" | "source_age";
  phase: string;
  parent_phase?: string;
  operation?: string;
  duration_ms: number;
  outcome: "ok" | "error";
  error_category?: string;
  account_age_ms?: number;
  source_slot?: number;
  source_checked_at_ms?: number;
  source_observed_at_ms?: number;
  source_positions_min_observed_at_ms?: number;
  source_age_ms?: number;
  source_positions_max_age_ms?: number;
}
interface TraceOptions {
  clock?: () => number;
  report?: (record: MonitorTimingRecord) => void;
  thresholdMs?: number;
}
interface Trace {
  ref: string;
  phase: string;
  parentPhase?: string;
  clock: () => number;
  report: (record: MonitorTimingRecord) => void;
  thresholdMs: number;
}
const traces = new AsyncLocalStorage<Trace>();
const phases = new Set([
  "tick",
  "audit_control",
  "observe_plan",
  "durable_notify",
  "notification_dispatch",
  "notification_claim",
  "notification_ack",
  "account_observation",
  "account_binding",
  "db_state_read",
  "db_callback",
  "db_commit",
]);
const operations = new Set([
  "account",
  "bind",
  "preflight",
  "source",
  "source_fills",
  "profile",
  "execution",
  "notify",
  "fence",
  "cancel_increasing",
  "release",
  "submit",
  "candidates",
  "read_plan_evidence",
  "activation_check",
  "deposit_options",
  "deposit_address",
  "deposit_status",
  "funding_quote",
  "funding_submit",
  "funding_activate_quote",
  "funding_activate_submit",
  "notification_status",
]);
const errorCategories = new Set([
  "VENUE_READ_BUDGET_EXHAUSTED",
  "VENUE_RATE_LIMITED",
  "VENUE_READ_TIMEOUT",
  "VENUE_READ_DEADLINE",
  "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_RESPONSE_INVALID",
  "EXECUTOR_REQUEST_TOO_LARGE",
  "SOURCE_NOT_FOUND",
  "SOURCE_STALE",
  "SCORE_UNAVAILABLE",
  "SOURCE_SCOPE_UNAVAILABLE",
  "SOURCE_IDENTITY_UNAVAILABLE",
  "SOURCE_IDENTITY_CONFLICT",
  "SOURCE_IDENTITY_INVALID",
  "NOT_FOUND",
  "PUSH_NOT_REGISTERED",
  "PUSH_NOT_CONFIGURED",
  "PUSH_UNAVAILABLE",
  "PUSH_RESPONSE_INVALID",
  "PUSH_RECEIPT_UNAVAILABLE",
  "PUSH_EVENT_MISMATCH",
  "PUSH_DELIVERY_TIMEOUT",
  "PUSH_DELIVERY_CANCELLED",
]);
function elapsed(trace: Trace, start: number): number {
  const value = trace.clock() - start;
  return Number.isFinite(value) ? Math.round(Math.max(0, value)) : 0;
}
function category(error: unknown): string {
  if (error instanceof AgentError && errorCategories.has(error.code))
    return error.code;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "other";
}
function emit(
  trace: Trace,
  record: Omit<MonitorTimingRecord, "event" | "tick_ref">,
): void {
  // Diagnostics must never change transaction, execution or retry behavior.
  try {
    trace.report({
      event: "agent_monitor_timing",
      tick_ref: trace.ref,
      ...(trace.parentPhase === undefined
        ? {}
        : { parent_phase: trace.parentPhase }),
      ...record,
    });
  } catch {}
}
async function timed<T>(
  trace: Trace,
  kind: "tick" | "phase" | "operation",
  phase: string,
  work: () => Promise<T>,
  operation?: string,
): Promise<T> {
  const start = trace.clock();
  let outcome: "ok" | "error" = "ok";
  let errorCategory: string | undefined;
  try {
    return await work();
  } catch (error) {
    outcome = "error";
    errorCategory = category(error);
    throw error;
  } finally {
    const duration = elapsed(trace, start);
    if (kind === "tick" || outcome === "error" || duration >= trace.thresholdMs)
      emit(trace, {
        kind,
        phase,
        ...(operation === undefined ? {} : { operation }),
        duration_ms: duration,
        outcome,
        ...(errorCategory === undefined
          ? {}
          : { error_category: errorCategory }),
      });
  }
}
/** One random, ephemeral reference per monitor tick; never derived from an owner. */
export async function runMonitorTrace<T>(
  work: () => Promise<T>,
  options: TraceOptions = {},
): Promise<T> {
  if (traces.getStore()) return work();
  const trace: Trace = {
    ref: randomUUID(),
    phase: "tick",
    clock: options.clock ?? (() => performance.now()),
    report:
      options.report ?? ((record) => console.info(JSON.stringify(record))),
    thresholdMs: options.thresholdMs ?? 250,
  };
  return traces.run(trace, () => timed(trace, "tick", "tick", work));
}
/** Notification delivery has its own reference and never extends a financial tick. */
export async function runNotificationTrace<T>(
  work: () => Promise<T>,
): Promise<T> {
  const parent = traces.getStore();
  const trace: Trace = {
    ref: randomUUID(),
    phase: "notification_dispatch",
    clock: parent?.clock ?? (() => performance.now()),
    report:
      parent?.report ?? ((record) => console.info(JSON.stringify(record))),
    thresholdMs: parent?.thresholdMs ?? 250,
  };
  return traces.run(trace, () =>
    timed(trace, "phase", "notification_dispatch", work),
  );
}
export async function monitorPhase<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const trace = traces.getStore();
  if (!trace) return work();
  const phase = phases.has(name) ? name : "other";
  const child = { ...trace, phase, parentPhase: trace.phase };
  return traces.run(child, () => timed(child, "phase", phase, work));
}
export async function monitorOperation<T>(
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const trace = traces.getStore();
  if (!trace) return work();
  return timed(
    trace,
    "operation",
    trace.phase,
    work,
    operations.has(name) ? name : "other",
  );
}
export function noteMonitorAccountAge(
  observedAt: number,
  stage: "returned" | "published" = "returned",
): void {
  const trace = traces.getStore();
  const age = Date.now() - observedAt;
  if (!trace || !Number.isFinite(age)) return;
  emit(trace, {
    kind: "account_age",
    phase: stage === "published" ? "audit_control" : trace.phase,
    ...(stage === "published" ? { parent_phase: "tick" } : {}),
    duration_ms: 0,
    outcome: "ok",
    account_age_ms: Math.round(Math.max(0, age)),
  });
}

// Evidence at the existing consumption guard, distinct from historical
// last_source_at stamps. Only numbers and the existing random tick_ref escape.
export function noteMonitorSourceEvidence(
  observedAt: number,
  minimumPositionObservedAt: number,
  checkedAt: number,
  slot: number,
): void {
  const trace = traces.getStore();
  if (
    !trace ||
    ![observedAt, minimumPositionObservedAt, checkedAt].every(
      Number.isSafeInteger,
    ) ||
    !Number.isInteger(slot) ||
    slot < 1 ||
    slot > 1000
  )
    return;
  const age = checkedAt - observedAt;
  const positionAge = checkedAt - minimumPositionObservedAt;
  const valid = age >= 0 && age <= 5000 && positionAge >= 0 && positionAge <= 5000;
  emit(trace, {
    kind: "source_age",
    phase: trace.phase,
    duration_ms: 0,
    outcome: valid ? "ok" : "error",
    ...(valid ? {} : { error_category: "SOURCE_STALE" }),
    source_slot: slot,
    source_checked_at_ms: checkedAt,
    source_observed_at_ms: observedAt,
    source_positions_min_observed_at_ms: minimumPositionObservedAt,
    source_age_ms: age,
    source_positions_max_age_ms: positionAge,
  });
}
