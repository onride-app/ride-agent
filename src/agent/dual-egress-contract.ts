import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isIPv4 } from "node:net";

export const DUAL_PROTOCOL = 3 as const;
export const DUAL_SEQ_MAX = 1_000_000_000;
export const canonicalUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) &&
  value !== "00000000-0000-0000-0000-000000000000";
export const hash64 = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (): never => { throw new Error("Dual egress binding or read capability is invalid"); };
const origin = (value: unknown): string => {
  if (typeof value !== "string") return fail();
  const u = new URL(value);
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash || u.pathname !== "/" || u.origin !== value) return fail();
  return u.origin;
};
function publicIps(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256 || new Set(value).size !== value.length ||
    value.some((ip) => typeof ip !== "string" || !isIPv4(ip)) || [...value].sort().some((v, i) => v !== value[i])) return fail();
  for (const ip of value as string[]) {
    const [a,b,c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return fail();
  }
  return Object.freeze([...value]);
}
export type DualPhysicalAuthority = Readonly<{
  protocol_version: 3;
  binding_generation: string;
  coordination_scope: string;
  account_bank_id: string;
  gateway_bank_id: string;
  account_ipv4: readonly string[];
  gateway_ipv4: readonly string[];
  core_origin: string;
  gateway_origin: string;
  gateway_service_id: string;
  physical_manifest_sha256: string;
  physical_verified: true;
  all_writers_verified: true;
  prior_gateway_drained: true;
}>;
export function parseDualPhysicalAuthority(raw: string): { authority: DualPhysicalAuthority; authorityId: string } {
  if (Buffer.byteLength(raw) > 32 * 1024) return fail();
  const v: unknown = JSON.parse(raw);
  const keys = ["protocol_version", "binding_generation", "coordination_scope", "account_bank_id", "gateway_bank_id", "account_ipv4", "gateway_ipv4", "core_origin", "gateway_origin", "gateway_service_id", "physical_manifest_sha256", "physical_verified", "all_writers_verified", "prior_gateway_drained"];
  if (!exactKeys(v, keys) || v.protocol_version !== 3 || !canonicalUuid(v.binding_generation) || !canonicalUuid(v.gateway_service_id) ||
    !hash64(v.account_bank_id) || !hash64(v.gateway_bank_id) || v.account_bank_id === v.gateway_bank_id || !hash64(v.physical_manifest_sha256) ||
    typeof v.coordination_scope !== "string" || !/^[a-z0-9_-]{1,128}$/.test(v.coordination_scope) ||
    v.physical_verified !== true || v.all_writers_verified !== true || v.prior_gateway_drained !== true) return fail();
  const account = publicIps(v.account_ipv4), gateway = publicIps(v.gateway_ipv4);
  if (gateway.some((ip) => account.includes(ip))) return fail();
  const coreOrigin = origin(v.core_origin), gatewayOrigin = origin(v.gateway_origin);
  if (coreOrigin === gatewayOrigin) return fail();
  const authority = Object.freeze({ ...v, account_ipv4: account, gateway_ipv4: gateway, core_origin: coreOrigin, gateway_origin: gatewayOrigin }) as DualPhysicalAuthority;
  return { authority, authorityId: payloadHash(raw) };
}
export function dualEgressAuthorityFromEnv(env: NodeJS.ProcessEnv) {
  if (env.RIDE_AGENT_INFO_FRAME_V3_ENABLED !== "true") return;
  const raw = env.RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON;
  if (!raw) return fail();
  return parseDualPhysicalAuthority(raw);
}
export const payloadHash = (json: string) => createHash("sha256").update(json, "utf8").digest("hex");

/** Stable operator authority plus the actual boot; NEVER a bank ledger key. */
export function runtimeBindingId(authorityId: string, bootNonce: string): string {
  if (!hash64(authorityId) || !canonicalUuid(bootNonce)) return fail();
  return payloadHash(`ride-info-binding-v3\n${authorityId}\n${bootNonce}\n`);
}
export type DualBinding = Readonly<{
  protocol_version: 3;
  authority_id: string;
  binding_id: string;
  binding_generation: string;
  gateway_boot_nonce: string;
  account_bank_id: string;
  gateway_bank_id: string;
}>;
export function validateDualRuntimeBinding(
  value: unknown,
  expected: Pick<DualBinding, "authority_id" | "binding_generation" | "account_bank_id" | "gateway_bank_id">,
): DualBinding {
  if (!exactKeys(value, ["protocol_version", "authority_id", "binding_id", "binding_generation", "gateway_boot_nonce", "account_bank_id", "gateway_bank_id"]) ||
    value.protocol_version !== 3 || !hash64(expected.authority_id) || !canonicalUuid(expected.binding_generation) ||
    !hash64(expected.account_bank_id) || !hash64(expected.gateway_bank_id) || expected.account_bank_id === expected.gateway_bank_id ||
    Object.entries(expected).some(([key, item]) => value[key] !== item) || !canonicalUuid(value.gateway_boot_nonce) ||
    value.binding_id !== runtimeBindingId(expected.authority_id, value.gateway_boot_nonce)) return fail();
  return Object.freeze({ ...value }) as DualBinding;
}

export type GatewayReadStage = "source" | "history" | "gateway_balance";
export type GatewayCapability = {
  protocol_version: 3;
  binding_id: string;
  binding_generation: string;
  gateway_boot_nonce: string;
  read_id: string;
  bank_id: string;
  stage: GatewayReadStage;
  deadline_ms: number;
  payload_sha256: string;
  caller_id: string | null;
};
export function capabilityBytes(value: GatewayCapability): Buffer {
  if (value.protocol_version !== 3 || !hash64(value.binding_id) || !hash64(value.bank_id) || !hash64(value.payload_sha256) ||
    !canonicalUuid(value.binding_generation) || !canonicalUuid(value.gateway_boot_nonce) || !canonicalUuid(value.read_id) ||
    !["source", "history", "gateway_balance"].includes(value.stage) || !Number.isSafeInteger(value.deadline_ms) || value.deadline_ms <= 0 ||
    (value.stage === "gateway_balance" ? !canonicalUuid(value.caller_id) : value.caller_id !== null)) return fail();
  return Buffer.from(["ride-info-v3", value.binding_id, value.binding_generation, value.gateway_boot_nonce, value.read_id, value.bank_id, value.stage, String(value.deadline_ms), value.payload_sha256, value.caller_id ?? "-", ""].join("\n"), "ascii");
}
export function signGatewayCapability(value: GatewayCapability, key: string | Buffer): string {
  if (Buffer.byteLength(key) < 32) return fail();
  return createHmac("sha256", key).update(capabilityBytes(value)).digest("base64url");
}
export function verifyGatewayCapability(value: GatewayCapability, capability: unknown, key: string | Buffer): boolean {
  if (typeof capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(capability)) return false;
  try {
    const decoded = Buffer.from(capability, "base64url");
    if (decoded.toString("base64url") !== capability) return false;
    return timingSafeEqual(Buffer.from(signGatewayCapability(value, key), "base64url"), decoded);
  }
  catch { return false; }
}
