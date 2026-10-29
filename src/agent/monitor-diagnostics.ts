import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { AgentError } from "./contracts.js";

export interface MonitorTimingRecord {
  event: "agent_monitor_timing";
  tick_ref: string;
  kind: "tick" | "phase" | "operation" | "account_age";
  phase: string;
  parent_phase?: string;
  operation?: string;
  duration_ms: number;
  outcome: "ok" | "error";
  error_category?: string;
  account_age_ms?: number;
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
  "observe_plan",
  "durable_notify",
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
  "NOT_FOUND",
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
export function noteMonitorAccountAge(observedAt: number): void {
  const trace = traces.getStore();
  const age = Date.now() - observedAt;
  if (!trace || !Number.isFinite(age)) return;
  emit(trace, {
    kind: "account_age",
    phase: trace.phase,
    duration_ms: 0,
    outcome: "ok",
    account_age_ms: Math.round(Math.max(0, age)),
  });
}
