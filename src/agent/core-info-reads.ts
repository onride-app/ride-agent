import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
  type VenueReadFetcher,
} from "./venue-read-transport.js";

const errorCodes: Record<string, string> = {
  data_provider_rate_limited: "VENUE_RATE_LIMITED",
  local_budget: "VENUE_READ_BUDGET_EXHAUSTED",
  deadline: "VENUE_READ_DEADLINE",
  unavailable: "VENUE_UNAVAILABLE",
  invalid: "VENUE_RESPONSE_INVALID",
  unsupported: "VENUE_READ_UNSUPPORTED",
};

export function coreInfoFetcher(
  coreUrl: string,
  token: string,
  request: typeof fetch = (...args) => fetch(...args),
  clock = Date.now,
): VenueReadFetcher {
  const endpoint = new URL("/internal/agent-core/perps_info_read", coreUrl);
  if (
    endpoint.protocol !== "https:" &&
    !(
      endpoint.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)
    )
  )
    throw new Error("Core Info reads require a private HTTPS endpoint");
  return async (url, init, context) => {
    // Testnet has no compatible managed provider; keep its existing gate/path.
    if (url === "https://api.hyperliquid-testnet.xyz/info")
      return request(url, init);
    if (url !== "https://api.hyperliquid.xyz/info" || init.method !== "POST")
      throw new CoordinatedReadError("VENUE_READ_UNSUPPORTED", false);
    const started = clock();
    if (
      !context ||
      !Number.isSafeInteger(context.deadline_ms) ||
      context.deadline_ms <= started ||
      context.deadline_ms > started + 12000
    )
      throw new CoordinatedReadError("VENUE_READ_DEADLINE", false);
    if (init.signal?.aborted) throw init.signal.reason;
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        request: JSON.parse(String(init.body)),
        deadline_ms: context.deadline_ms,
      }),
      signal: init.signal,
      redirect: "error",
    });
    const body = (await response.json()) as any;
    if (init.signal?.aborted) throw init.signal.reason;
    if (!response.ok) {
      const error = body?.error;
      const code =
        error && Object.hasOwn(errorCodes, error.code)
          ? errorCodes[error.code]
          : undefined;
      const retry = error?.retry_after_ms;
      if (
        response.status !== 503 ||
        !code ||
        typeof error.upstream_request_sent !== "boolean" ||
        (retry !== undefined &&
          (!Number.isSafeInteger(retry) || retry < 1 || retry > 60000))
      )
        throw new Error("Core Info read returned an unverified error receipt");
      throw new CoordinatedReadError(code, error.upstream_request_sent, retry);
    }
    if (
      !body ||
      !Object.hasOwn(body, "data") ||
      !Number.isSafeInteger(body.observed_at) ||
      body.observed_at <= 0
    )
      throw new Error("Core Info read returned invalid evidence");
    const value = Response.json(body.data);
    // Include the private hop and any coordination delay. Never re-age data
    // using a later server stamp or the time JSON finished downloading.
    recordCoordinatedEvidence(value, Math.min(started, body.observed_at));
    return value;
  };
}
