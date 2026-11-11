import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
  type VenueReadFetcher,
} from "./agent/venue-read-transport.js";
import {
  canonicalUuid,
  exactKeys,
  hash64,
  payloadHash,
  type DualBinding,
} from "./agent/dual-egress-contract.js";
import {
  boundedGatewayJson,
  GatewayPendingCallers,
  validGatewayInfoRequest,
} from "./gateway-info-relay.js";

const unavailable = (): never => {
  throw new CoordinatedReadError("VENUE_UNAVAILABLE", true);
};

/** Only the two existing public HL balance reads use this narrow client. */
export function createGatewayInfoClient(options: {
  coreOrigin: string;
  readClientToken: string;
  pendingCallers: GatewayPendingCallers;
  currentBinding: (signal: AbortSignal) => Promise<DualBinding>;
  requestToCore?: typeof fetch;
  monotonic?: () => number;
  wallClock?: () => number;
}): VenueReadFetcher {
  const monotonic = options.monotonic ?? (() => performance.now()),
    wallClock = options.wallClock ?? Date.now;
  const request = options.requestToCore ?? fetch;
  return async (url, init, context) => {
    const at = wallClock(),
      start = monotonic();
    const uri = new URL(url);
    if (
      uri.href !== "https://api.hyperliquid.xyz/info" ||
      init.method !== "POST" ||
      typeof init.body !== "string" ||
      !context ||
      !Number.isSafeInteger(context.deadline_ms) ||
      context.deadline_ms <= at ||
      !validGatewayInfoRequest(JSON.parse(init.body), true)
    )
      return unavailable();
    // Keep the original VenueReads wire deadline and this call's own signal.
    // Binding discovery and both additional hops consume that same ten seconds.
    const end = start + Math.min(10_000, context.deadline_ms - at);
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.floor(end - monotonic())),
    );
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;
    const id = options.pendingCallers.register(
      payloadHash(init.body),
      end,
      signal,
    );
    try {
      const binding = await options.currentBinding(signal);
      if (
        binding.gateway_boot_nonce !== options.pendingCallers.bootNonce ||
        signal.aborted
      )
        return unavailable();
      const remaining = Math.floor(end - monotonic());
      if (remaining <= 0) return unavailable();
      const response = await request(
        `${options.coreOrigin}/internal/ride-info/gateway-read`,
        {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.readClientToken}`,
          },
          body: JSON.stringify({
            protocol_version: 3,
            binding_id: binding.binding_id,
            binding_generation: binding.binding_generation,
            gateway_boot_nonce: binding.gateway_boot_nonce,
            caller_id: id,
            remaining_ms: remaining,
            request: JSON.parse(init.body),
          }),
        },
      );
      if (response.status !== 200) {
        // No negative HTTP response alone is authoritative UNSENT evidence.
        if (response.status === 503) {
          const failure = await boundedGatewayJson(response, 4096);
          if (
            exactKeys(failure, ["error"]) &&
            exactKeys(failure.error, [
              "code",
              "upstream_request_sent",
              "retry_after_ms",
            ]) &&
            failure.error.code === "data_provider_rate_limited" &&
            typeof failure.error.upstream_request_sent === "boolean" &&
            Number.isSafeInteger(failure.error.retry_after_ms) &&
            Number(failure.error.retry_after_ms) >= 1 &&
            Number(failure.error.retry_after_ms) <= 60_000
          ) {
            // Even a cooldown denial is conservative here: classification can
            // cool this physical bank, but can never refund an unknown claim.
            throw new CoordinatedReadError(
              "VENUE_RATE_LIMITED",
              true,
              Number(failure.error.retry_after_ms),
            );
          }
        } else void response.body?.cancel().catch(() => {});
        return unavailable();
      }
      const body = await boundedGatewayJson(response);
      if (
        !exactKeys(body, [
          "data",
          "observed_at",
          "bank_id",
          "read_id",
          "retain_until_ms",
        ]) ||
        !hash64(body.bank_id) ||
        body.bank_id !== binding.gateway_bank_id ||
        !canonicalUuid(body.read_id) ||
        !Number.isSafeInteger(body.observed_at) ||
        Number(body.observed_at) <= 0 ||
        !Number.isSafeInteger(body.retain_until_ms) ||
        Number(body.retain_until_ms) <= 0 ||
        !options.pendingCallers.completed(id, body.read_id) ||
        signal.aborted ||
        monotonic() >= end
      )
        return unavailable();
      const official = Response.json(body.data);
      recordCoordinatedEvidence(
        official,
        Math.min(at, Number(body.observed_at)),
      );
      return official;
    } catch (error) {
      if (
        error instanceof CoordinatedReadError &&
        error.code === "VENUE_RATE_LIMITED" &&
        error.upstreamRequestSent === true
      )
        throw error;
      return unavailable();
    } finally {
      options.pendingCallers.remove(id);
    }
  };
}
