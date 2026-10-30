import { AgentError } from "./contracts.js";

export type VenueReadFetcher = (
  url: string,
  init: RequestInit,
  context?: { deadline_ms: number },
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
      retryAfterMs === undefined ? undefined : { retry_after_ms: retryAfterMs },
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
