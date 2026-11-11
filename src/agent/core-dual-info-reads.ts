import { coreInfoFetcher } from "./core-info-reads.js";
import { canonicalUuid, hash64, type DualBinding } from "./dual-egress-contract.js";
import { CoordinatedReadError, recordCoordinatedEvidence, type VenueReadFetcher } from "./venue-read-transport.js";

const codes: Record<string, string> = { data_provider_rate_limited: "VENUE_RATE_LIMITED", local_budget: "VENUE_READ_BUDGET_EXHAUSTED", deadline: "VENUE_READ_DEADLINE", unavailable: "VENUE_UNAVAILABLE", invalid: "VENUE_RESPONSE_INVALID", unsupported: "VENUE_READ_UNSUPPORTED" };

/** V3 is selected only by private prepared/public-source runtime stages. */
export function coreDualInfoFetcher(
  coreUrl: string,
  token: string,
  currentBinding: (signal: AbortSignal) => Promise<DualBinding>,
  request: typeof fetch = (...args) => fetch(...args),
  clock = Date.now,
): VenueReadFetcher {
  const legacy = coreInfoFetcher(coreUrl, token, request, clock);
  const endpoint = new URL("/internal/agent-core/perps_info_v3_read", coreUrl);
  return async (url, init, context) => {
    if (!context?.dual) return legacy(url, init, context);
    const started = clock(), dual = context.dual;
    if (url !== "https://api.hyperliquid.xyz/info" || init.method !== "POST" || !init.signal || init.signal.aborted ||
      !Number.isSafeInteger(context.deadline_ms) || context.deadline_ms <= started || context.deadline_ms > started + 12000)
      throw new CoordinatedReadError("VENUE_READ_UNSUPPORTED", true);
    const framed = context.frame_id !== undefined || context.frame_owner !== undefined;
    if ((framed && (!canonicalUuid(context.frame_id) || !hash64(context.frame_owner) || !dual.binding)) ||
      (!framed && dual.stage !== "source") ||
      (dual.stage === "history" && (typeof dual.history_source !== "string" || !/^[\x21-\x7e]{1,256}$/.test(dual.history_source))) ||
      (dual.stage !== "history" && dual.history_source !== undefined))
      throw new CoordinatedReadError("VENUE_READ_UNSUPPORTED", true);
    // A bound parent never adopts a new boot/authority after any failed stage.
    // Only genuinely unframed source reads discover a binding for their new call.
    const binding = dual.binding ?? await currentBinding(init.signal);
    if (init.signal.aborted || clock() >= context.deadline_ms) throw init.signal.reason ?? new Error("Original source deadline expired");
    const response = await request(endpoint, {
      method: "POST", redirect: "error", signal: init.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ protocol_version: 3, binding_id: binding.binding_id, deadline_ms: context.deadline_ms,
        stage: dual.stage, request: JSON.parse(String(init.body)),
        ...(framed ? { frame_id: context.frame_id, frame_owner: context.frame_owner } : {}),
        ...(dual.stage === "history" ? { history_source: dual.history_source } : {}),
      }),
    });
    const value = await response.json() as any;
    if (init.signal.aborted) throw init.signal.reason;
    if (response.status !== 200) {
      const code = value?.error && codes[value.error.code];
      const retry = value?.error?.retry_after_ms;
      if (response.status !== 503 || !code || (retry !== undefined && (!Number.isSafeInteger(retry) || retry < 1 || retry > 60000)))
        throw new Error("Unverified V3 read error");
      // Initial V3 deliberately has NO zero-refund error receipt. Even a local
      // denial stays conservative until a future explicit CAS fence protocol.
      throw new CoordinatedReadError(code, true, retry);
    }
    const bank = dual.stage === "account" ? binding.account_bank_id : binding.gateway_bank_id;
    if (!value || !Object.hasOwn(value, "data") || value.bank_id !== bank || !canonicalUuid(value.read_id) ||
      !Number.isSafeInteger(value.observed_at) || value.observed_at <= 0 ||
      !Number.isSafeInteger(value.retain_until_ms) || value.retain_until_ms < context.deadline_ms + 60000)
      throw new Error("Invalid V3 bank evidence");
    const result = Response.json(value.data);
    recordCoordinatedEvidence(result, Math.min(started, value.observed_at));
    return result;
  };
}
