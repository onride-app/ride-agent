import { randomUUID, timingSafeEqual } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Router } from "express";
import {
  canonicalUuid,
  exactKeys,
  hash64,
  payloadHash,
  runtimeBindingId,
  verifyGatewayCapability,
  type GatewayCapability,
} from "./agent/dual-egress-contract.js";

export type GatewayRelayAuthority = Readonly<{
  authority_id: string;
  binding_generation: string;
  account_bank_id: string;
  gateway_bank_id: string;
  core_origin: string;
  gateway_origin: string;
  gateway_service_id: string;
  gateway_deployment_id: string;
}>;
export type GatewayOfficialReply = {
  upstream_status: number;
  body_json: string;
  retry_after: string | null;
};
const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const fail = (): never => {
  throw new Error("Gateway info read unavailable");
};
const address = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const safeTime = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const onlyKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((k) => keys.includes(k));
const dex = (value: unknown) =>
  value === undefined ||
  (typeof value === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(value));
const windowValid = (r: Record<string, unknown>) =>
  safeTime(r.startTime) &&
  (r.endTime === undefined ||
    (safeTime(r.endTime) && r.endTime >= r.startTime));

export async function boundedGatewayJson(
  response: Response,
  maximum = MAX_REPLY_BYTES,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return fail();
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    complete = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > maximum) return fail();
      chunks.push(next.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Mirrors the fixed Core /info read schema; no destination or action exists. */
export function validGatewayInfoRequest(
  value: unknown,
  balancesOnly = false,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (
    balancesOnly &&
    !["spotClearinghouseState", "spotMetaAndAssetCtxs"].includes(String(r.type))
  )
    return false;
  switch (r.type) {
    case "allMids":
    case "meta":
    case "metaAndAssetCtxs":
      return onlyKeys(r, ["type", "dex"]) && dex(r.dex);
    case "spotMeta":
    case "spotMetaAndAssetCtxs":
    case "perpDexs":
    case "perpCategories":
      return onlyKeys(r, ["type"]);
    case "clearinghouseState":
    case "frontendOpenOrders":
    case "openOrders":
      return (
        onlyKeys(r, ["type", "user", "dex"]) && address(r.user) && dex(r.dex)
      );
    case "spotClearinghouseState":
    case "userAbstraction":
    case "userDexAbstraction":
      return onlyKeys(r, ["type", "user"]) && address(r.user);
    case "userFillsByTime":
      return (
        onlyKeys(r, [
          "type",
          "user",
          "startTime",
          "endTime",
          "aggregateByTime",
        ]) &&
        address(r.user) &&
        windowValid(r) &&
        (r.aggregateByTime === undefined ||
          typeof r.aggregateByTime === "boolean")
      );
    case "userFunding":
    case "userNonFundingLedgerUpdates":
      return (
        onlyKeys(r, ["type", "user", "startTime", "endTime"]) &&
        address(r.user) &&
        windowValid(r)
      );
    case "candleSnapshot": {
      if (
        !onlyKeys(r, ["type", "req"]) ||
        !r.req ||
        typeof r.req !== "object" ||
        Array.isArray(r.req)
      )
        return false;
      const q = r.req as Record<string, unknown>;
      return (
        onlyKeys(q, ["coin", "interval", "startTime", "endTime"]) &&
        typeof q.coin === "string" &&
        /^[A-Za-z0-9_.:@/-]{1,128}$/.test(q.coin) &&
        [
          "1m",
          "3m",
          "5m",
          "15m",
          "30m",
          "1h",
          "2h",
          "4h",
          "8h",
          "12h",
          "1d",
          "3d",
          "1w",
          "1M",
        ].includes(String(q.interval)) &&
        windowValid(q)
      );
    }
    default:
      return false;
  }
}

type PendingCaller = {
  payload: string;
  end: number;
  signal: AbortSignal;
  consumed: boolean;
  readId?: string;
  completed?: boolean;
};
export class GatewayPendingCallers {
  private readonly callers = new Map<string, PendingCaller>();
  constructor(
    readonly bootNonce = randomUUID(),
    private readonly monotonic = () => performance.now(),
    private readonly maximum = 256,
  ) {
    if (
      !canonicalUuid(bootNonce) ||
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > 1024
    )
      fail();
  }
  register(payload: string, end: number, signal: AbortSignal): string {
    // Do not evict a live caller to accept another one, or accept a later hop's clock.
    if (
      !hash64(payload) ||
      !Number.isFinite(end) ||
      end <= this.monotonic() ||
      signal.aborted ||
      this.callers.size >= this.maximum
    )
      return fail();
    const id = randomUUID();
    this.callers.set(id, { payload, end, signal, consumed: false });
    return id;
  }
  claim(
    id: string,
    payload: string,
    readId: string,
  ): { end: number; signal: AbortSignal } {
    const caller = this.callers.get(id);
    if (
      !caller ||
      caller.consumed ||
      caller.payload !== payload ||
      caller.signal.aborted ||
      caller.end <= this.monotonic()
    )
      return fail();
    if (!canonicalUuid(readId)) return fail();
    caller.consumed = true;
    caller.readId = readId;
    return caller;
  }
  complete(id: string, readId: string): void {
    const caller = this.callers.get(id);
    if (
      !caller ||
      !caller.consumed ||
      caller.readId !== readId ||
      caller.signal.aborted ||
      caller.end <= this.monotonic()
    )
      return fail();
    caller.completed = true;
  }
  completed(id: string, readId: string): boolean {
    const caller = this.callers.get(id);
    return (
      !!caller &&
      caller.completed === true &&
      caller.readId === readId &&
      !caller.signal.aborted &&
      caller.end > this.monotonic()
    );
  }
  remove(id: string): void {
    this.callers.delete(id);
  }
  get size(): number {
    return this.callers.size;
  }
}

/** Fixed official HTTPS/IPv4 destination. No URL, headers, redirect or retry input. */
export function requestOfficialGatewayInfo(
  requestJson: string,
  signal: AbortSignal,
): Promise<GatewayOfficialReply> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Gateway info read unavailable"));
      return;
    }
    const req = httpsRequest(
      {
        hostname: "api.hyperliquid.xyz",
        port: 443,
        path: "/info",
        method: "POST",
        family: 4,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(requestJson),
        },
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_REPLY_BYTES) {
            res.destroy(new Error("Gateway info read unavailable"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const retry = res.headers["retry-after"];
          try {
            resolve({
              upstream_status: res.statusCode ?? 502,
              body_json: new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              ),
              retry_after:
                typeof retry === "string" && retry.length <= 128 ? retry : null,
            });
          } catch {
            reject(new Error("Gateway info read unavailable"));
          }
        });
      },
    );
    req.on("error", reject);
    req.end(requestJson);
  });
}

function bearerMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${token}`),
    actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const CAP_KEYS = [
  "protocol_version",
  "binding_id",
  "binding_generation",
  "gateway_boot_nonce",
  "read_id",
  "bank_id",
  "stage",
  "deadline_ms",
  "payload_sha256",
  "caller_id",
] as const;
const REDEEM_KEYS = [...CAP_KEYS, "accepted", "remaining_ms"];

export function createGatewayInfoRelay(options: {
  template: GatewayRelayAuthority;
  readClientToken: string;
  forwardKey: Buffer;
  pendingCallers?: GatewayPendingCallers;
  requestToCore?: typeof fetch;
  officialRequest?: typeof requestOfficialGatewayInfo;
  monotonic?: () => number;
}) {
  if (
    Buffer.byteLength(options.readClientToken) < 32 ||
    !Buffer.isBuffer(options.forwardKey) ||
    options.forwardKey.length !== 32 ||
    options.readClientToken === options.forwardKey.toString("hex") ||
    options.readClientToken === options.forwardKey.toString("utf8")
  )
    fail();
  const router = Router(),
    monotonic = options.monotonic ?? (() => performance.now());
  const pending =
    options.pendingCallers ?? new GatewayPendingCallers(undefined, monotonic);
  const request = options.requestToCore ?? fetch,
    official = options.officialRequest ?? requestOfficialGatewayInfo;
  const template = Object.freeze({ ...options.template });
  const forwardKey = Buffer.from(options.forwardKey);
  router.get("/internal/ride-info/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!bearerMatches(req.headers.authorization, options.readClientToken)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({
      protocol_version: 3,
      authority_id: template.authority_id,
      gateway_boot_nonce: pending.bootNonce,
      gateway_service_id: template.gateway_service_id,
      gateway_deployment_id: template.gateway_deployment_id,
      forward_enabled: true,
    });
  });
  router.post("/internal/ride-info/forward", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once("aborted", disconnected);
    res.once("close", disconnected);
    const disconnectedAlready = () =>
      controller.signal.aborted ||
      req.aborted ||
      res.destroyed ||
      res.writableEnded ||
      req.socket?.destroyed === true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body: unknown = req.body;
      if (disconnectedAlready()) {
        controller.abort();
        return fail();
      }
      if (!exactKeys(body, [...CAP_KEYS, "capability", "request_json"]))
        return fail();
      const cap = Object.fromEntries(
        CAP_KEYS.map((key) => [key, body[key]]),
      ) as GatewayCapability;
      if (
        !verifyGatewayCapability(cap, body.capability, forwardKey) ||
        cap.gateway_boot_nonce !== pending.bootNonce ||
        cap.binding_id !==
          runtimeBindingId(template.authority_id, pending.bootNonce) ||
        cap.binding_generation !== template.binding_generation ||
        cap.bank_id !== template.gateway_bank_id ||
        typeof body.request_json !== "string" ||
        Buffer.byteLength(body.request_json) > 64 * 1024 ||
        payloadHash(body.request_json) !== cap.payload_sha256 ||
        !validGatewayInfoRequest(
          JSON.parse(body.request_json),
          cap.stage === "gateway_balance",
        )
      )
        return fail();
      // Capture the private initial caller BEFORE the Core round trip. A request
      // delivered to another replica or boot can never manufacture that caller.
      const caller =
        cap.stage === "gateway_balance"
          ? pending.claim(cap.caller_id!, cap.payload_sha256, cap.read_id)
          : undefined;
      const redeemStart = monotonic();
      const maxEnd = Math.min(redeemStart + 12_000, caller?.end ?? Infinity);
      if (
        maxEnd <= redeemStart ||
        disconnectedAlready() ||
        caller?.signal.aborted
      )
        return fail();
      timer = setTimeout(
        () => controller.abort(),
        Math.max(1, Math.floor(maxEnd - monotonic())),
      );
      const signal = caller
        ? AbortSignal.any([controller.signal, caller.signal])
        : controller.signal;
      const redemption = await request(
        `${template.core_origin}/internal/ride-info/redeem`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.readClientToken}`,
          },
          body: JSON.stringify({ ...cap, capability: body.capability }),
          redirect: "error",
          signal,
        },
      );
      if (redemption.status !== 200) {
        void redemption.body?.cancel().catch(() => {});
        fail();
      }
      const ack = await boundedGatewayJson(redemption, 4096);
      if (!exactKeys(ack, REDEEM_KEYS)) return fail();
      if (
        ack.accepted !== true ||
        !Number.isSafeInteger(ack.remaining_ms) ||
        Number(ack.remaining_ms) <= 0 ||
        Number(ack.remaining_ms) > 12_000 ||
        CAP_KEYS.some((key) => ack[key] !== cap[key])
      )
        return fail();
      // Subtract the entire redeem RTT, including response parsing. Neither
      // remote clock nor completion time can start a new wire deadline.
      const end = Math.min(maxEnd, redeemStart + Number(ack.remaining_ms));
      const left = Math.floor(end - monotonic());
      if (left <= 0 || signal.aborted || disconnectedAlready()) return fail();
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), left);
      const result = await official(body.request_json, signal);
      if (
        signal.aborted ||
        monotonic() >= end ||
        !exactKeys(result, ["upstream_status", "body_json", "retry_after"]) ||
        !Number.isSafeInteger(result.upstream_status) ||
        result.upstream_status < 100 ||
        result.upstream_status > 599 ||
        typeof result.body_json !== "string" ||
        Buffer.byteLength(result.body_json) > MAX_REPLY_BYTES ||
        !(
          result.retry_after === null ||
          (typeof result.retry_after === "string" &&
            result.retry_after.length <= 128)
        )
      )
        fail();
      if (cap.stage === "gateway_balance")
        pending.complete(cap.caller_id!, cap.read_id);
      res.json({
        protocol_version: 3,
        read_id: cap.read_id,
        binding_id: cap.binding_id,
        bank_id: cap.bank_id,
        ...result,
      });
    } catch {
      // This is deliberately NOT an UNSENT/refund receipt. Core retains its
      // original claim on every ambiguous failure and never retries elsewhere.
      if (!res.headersSent && !res.destroyed)
        res.status(503).json({ error: "gateway_info_unavailable" });
    } finally {
      if (timer) clearTimeout(timer);
      req.removeListener("aborted", disconnected);
      res.removeListener("close", disconnected);
    }
  });
  return {
    router,
    pendingCallers: pending,
    bootNonce: pending.bootNonce,
    template,
  };
}
