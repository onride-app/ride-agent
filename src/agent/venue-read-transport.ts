import { AgentError } from "./contracts.js";
import type { DualBinding } from "./dual-egress-contract.js";

// Proof about this read's admission only, never financial non-acceptance.
export const UNSENT_READ_BUDGET_REASON = "READ_LOCAL_BUDGET_UNSENT";
export function isUnsentReadBudgetDenial(error: unknown): error is AgentError {
  return (
    error instanceof AgentError &&
    error.code === "VENUE_READ_BUDGET_EXHAUSTED" &&
    error.retryable === true &&
    error.details?.reason_code === UNSENT_READ_BUDGET_REASON
  );
}

export type VenueReadFetcher = (
  url: string,
  init: RequestInit,
  context?: {
    deadline_ms: number;
    frame_id?: string;
    frame_owner?: string;
    /** Private runtime stage. Logical source lanes inside A remain A. */
    dual?: { stage: "account" | "source" | "history"; binding?: DualBinding; history_source?: string };
  },
) => Promise<Response>;

// Only the authenticated Core adapter creates these receipts. Ordinary HTTP
// headers and ambiguous transport failures cannot prove that no read was sent.
export class CoordinatedReadError extends AgentError {
  constructor(
    code: string,
    readonly upstreamRequestSent: boolean,
    retryAfterMs?: number,
  ) {
    super(
      code,
      "Coordinated venue read is unavailable; fresh evidence is required.",
      code !== "VENUE_READ_UNSUPPORTED",
      503,
      retryAfterMs === undefined && code !== "VENUE_READ_BUDGET_EXHAUSTED"
        ? undefined
        : {
            ...(retryAfterMs === undefined
              ? {}
              : { retry_after_ms: retryAfterMs }),
            ...(code === "VENUE_READ_BUDGET_EXHAUSTED"
              ? {
                  reason_code:
                    upstreamRequestSent === false
                      ? UNSENT_READ_BUDGET_REASON
                      : "READ_CORE_BUDGET_SENT",
                }
              : {}),
          },
    );
  }
}

const originalEvidence = new WeakMap<Response, number>();
export function recordCoordinatedEvidence(response: Response, at: number) {
  originalEvidence.set(response, at);
}
export function coordinatedEvidence(response: Response): number | undefined {
  return originalEvidence.get(response);
}
