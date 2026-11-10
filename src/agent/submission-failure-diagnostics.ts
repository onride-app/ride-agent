import { AgentError } from "./contracts.js";
import type { Execution } from "./domain.js";

const codes = [
  "VENUE_READ_BUDGET_EXHAUSTED",
  "VENUE_RATE_LIMITED",
  "VENUE_READ_DEADLINE",
  "VENUE_READ_TIMEOUT",
  "VENUE_UNAVAILABLE",
  "VENUE_RESPONSE_INVALID",
  "VENUE_READ_UNSUPPORTED",
  "VENUE_COST_PLAN_UNAVAILABLE",
  "EXECUTOR_UNAVAILABLE",
  "EXECUTOR_RESPONSE_INVALID",
  "EXECUTOR_REQUEST_TOO_LARGE",
  "EXECUTION_REJECTED",
  "EXECUTION_UNCERTAIN",
  "IDEMPOTENCY_MISMATCH",
  "SOURCE_STALE",
  "SOURCE_SCOPE_UNAVAILABLE",
  "SOURCE_IDENTITY_UNAVAILABLE",
  "SOURCE_IDENTITY_CONFLICT",
  "SOURCE_IDENTITY_INVALID",
  "SOURCE_FILL_EVIDENCE_MISSING",
  "ACCOUNT_STALE",
  "OWNERSHIP_CONFLICT",
  "CORE_UNAVAILABLE",
  "AUTH_REQUIRED",
  "PERMISSION_DENIED",
] as const;
const reasons = [
  "READ_LOCAL_BUDGET_UNSENT",
  "READ_FRAME_PENDING",
  "READ_FRAME_POLLING",
  "READ_FRAME_IN_USE",
  "READ_FRAME_QUEUE_FULL",
  "READ_FRAME_IDENTITY_CHANGED",
  "READ_FRAME_PACING",
  "READ_LOCAL_PACING",
  "READ_LOCAL_BUSY",
  "READ_LOCAL_FIFO",
  "READ_LOCAL_QUOTA",
  "READ_LOCAL_EXCLUSIVE",
  "READ_LOCAL_QUARANTINE",
  "READ_LOCAL_TICKET_STALE",
  "READ_CORE_BUDGET_SENT",
  "READ_FRAME_CAPACITY",
  "SOURCE_POSITION_EVIDENCE_GUARD",
  "CORE_UNAVAILABLE",
  "POLICY_REVISION_CHANGED",
  "ACCOUNT_IDENTITY_CHANGED",
  "OWNERSHIP_CONFLICT",
  "ACCOUNT_COVERAGE_INCOMPLETE",
  "RISK_LIMIT_EXCEEDED",
] as const;
export type FirstSubmissionFailure = Readonly<{
  code: (typeof codes)[number] | "OTHER";
  reason_code: (typeof reasons)[number] | "OTHER";
  retryable: boolean;
  at: number;
  elapsed_ms: number;
}>;

/** Diagnostic timing only. No evidence timestamp or operation deadline uses it. */
export function submissionDiagnosticStart(): number {
  try {
    return performance.now();
  } catch {
    return NaN;
  }
}

/** Best effort, first only; never used as acceptance, absence or retry proof. */
export function recordFirstSubmissionFailure(
  execution: Execution,
  error: unknown,
  started: number,
  diagnosticClock: () => number,
  monotonicClock = () => performance.now(),
): void {
  try {
    if (execution.first_submission_failure !== undefined) return;
    const trusted = error instanceof AgentError;
    const code =
      trusted && codes.includes(error.code as (typeof codes)[number])
        ? (error.code as (typeof codes)[number])
        : "OTHER";
    const reason =
      code !== "OTHER" &&
      trusted &&
      reasons.includes(error.details?.reason_code as (typeof reasons)[number])
        ? (error.details!.reason_code as (typeof reasons)[number])
        : "OTHER";
    const at = diagnosticClock(),
      elapsed = monotonicClock() - started;
    execution.first_submission_failure = {
      code,
      reason_code: reason,
      retryable: trusted && error.retryable === true,
      at: Number.isSafeInteger(at) && at > 0 ? at : 0,
      elapsed_ms:
        Number.isFinite(elapsed) && elapsed >= 0
          ? Math.min(60000, Math.round(elapsed))
          : 0,
    };
  } catch {
    // Diagnostics cannot mask the original exception or change financial work.
  }
}
