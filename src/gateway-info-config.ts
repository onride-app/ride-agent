import {
  canonicalUuid,
  exactKeys,
  validateDualRuntimeBinding,
  parseDualPhysicalAuthority as parseGatewayPhysicalAuthority,
  type DualPhysicalAuthority as GatewayPhysicalAuthority,
  type DualBinding,
} from "./agent/dual-egress-contract.js";
import {
  boundedGatewayJson,
  type GatewayRelayAuthority,
} from "./gateway-info-relay.js";

export { parseDualPhysicalAuthority as parseGatewayPhysicalAuthority } from "./agent/dual-egress-contract.js";
export type { DualPhysicalAuthority as GatewayPhysicalAuthority } from "./agent/dual-egress-contract.js";
export type GatewayInfoConfig = {
  authority: GatewayPhysicalAuthority;
  authorityId: string;
  relay: GatewayRelayAuthority;
  readClientToken: string;
  forwardKey: Buffer;
};
const fail = (): never => {
  throw new Error("Gateway source read configuration is invalid");
};
export function gatewayInfoConfigFromEnv(
  env: NodeJS.ProcessEnv,
): GatewayInfoConfig | undefined {
  if (env.RIDE_AGENT_SOURCE_FORWARD_ENABLED !== "true") return;
  const raw = env.RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON;
  if (!raw) return fail();
  const { authority, authorityId } = parseGatewayPhysicalAuthority(raw);
  if (
    !canonicalUuid(env.RAILWAY_SERVICE_ID) ||
    env.RAILWAY_SERVICE_ID !== authority.gateway_service_id ||
    !canonicalUuid(env.RAILWAY_DEPLOYMENT_ID)
  )
    return fail();
  const token = env.RIDE_AGENT_SOURCE_READ_CLIENT_TOKEN,
    key = env.RIDE_AGENT_SOURCE_FORWARD_KEY_HEX64;
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token) < 32 ||
    token.length > 4096 ||
    /[\r\n]/.test(token) ||
    typeof key !== "string" ||
    !/^[0-9a-f]{64}$/.test(key) ||
    token === key
  )
    return fail();
  for (const name of [
    "DATABASE_URL",
    "RIDE_AGENT_DATABASE_URL",
    "REDIS_URL",
    "RIDE_AGENT_CORE_SERVICE_TOKEN",
    "RIDE_AGENT_EXECUTOR_TOKEN",
    "PRIVY_APP_SECRET",
  ])
    if (env[name]) return fail();
  const forwardKey = Buffer.from(key, "hex");
  if (token === forwardKey.toString("utf8")) return fail();
  return {
    authority,
    authorityId,
    readClientToken: token,
    forwardKey,
    relay: Object.freeze({
      authority_id: authorityId,
      binding_generation: authority.binding_generation,
      account_bank_id: authority.account_bank_id,
      gateway_bank_id: authority.gateway_bank_id,
      core_origin: authority.core_origin,
      gateway_origin: authority.gateway_origin,
      gateway_service_id: env.RAILWAY_SERVICE_ID,
      gateway_deployment_id: env.RAILWAY_DEPLOYMENT_ID,
    }),
  };
}

export function createGatewayBindingReader(
  config: GatewayInfoConfig,
  request: typeof fetch = fetch,
) {
  return async (signal: AbortSignal): Promise<DualBinding> => {
    const response = await request(
      `${config.authority.core_origin}/internal/ride-info/binding-status`,
      {
        method: "GET",
        redirect: "error",
        signal,
        headers: { Authorization: `Bearer ${config.readClientToken}` },
      },
    );
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return fail();
    }
    const reply = await boundedGatewayJson(response, 4096);
    if (!exactKeys(reply, ["binding"]) || signal.aborted) return fail();
    return validateDualRuntimeBinding(reply.binding, {
      authority_id: config.authorityId,
      binding_generation: config.authority.binding_generation,
      account_bank_id: config.authority.account_bank_id,
      gateway_bank_id: config.authority.gateway_bank_id,
    });
  };
}
