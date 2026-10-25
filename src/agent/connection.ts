// Explicit allowlist: a POST transport does not imply that replay is safe.
const replayableReads = new Set([
  "get_preferences",
  "get_portfolio",
  "get_my_copies",
  "get_trader_profile",
  "browse_traders",
  "get_deposit_options",
  "check_deposit_status",
  "get_notification_preferences",
  "get_performance",
  "proposal",
]);
const transientCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function connectionReason(error: unknown): string {
  const e = error as {
    name?: string;
    code?: string;
    cause?: { code?: string };
  } | null;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "deadline";
  const code = e?.cause?.code ?? e?.code;
  return code && transientCodes.has(code) ? code : "response_unavailable";
}

export async function fetchAgentResponse(
  fetcher: typeof fetch,
  url: URL,
  init: RequestInit,
  operation: string,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetcher(url, init);
    } catch (error) {
      // One retry within the original deadline, only before receiving headers.
      // Never replay mutations, previews, HTTP errors, or malformed bodies.
      if (
        attempt ||
        init.signal?.aborted ||
        !replayableReads.has(operation) ||
        !transientCodes.has(connectionReason(error))
      )
        throw error;
    }
  }
}
