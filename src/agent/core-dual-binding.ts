import {
  dualEgressAuthorityFromEnv,
  exactKeys,
  validateDualRuntimeBinding,
  type DualBinding,
} from "./dual-egress-contract.js";

/** App-only binding discovery. No quota, provider or financial request here. */
export function coreDualBindingReader(
  coreUrl: string,
  token: string,
  network: "mainnet" | "testnet",
  infoReadRoute: "official" | "core",
  env: NodeJS.ProcessEnv,
  request: typeof fetch = (...args) => fetch(...args),
) {
  const configured = dualEgressAuthorityFromEnv(env);
  if (!configured) return;
  const target = new URL(coreUrl);
  if (
    network !== "mainnet" ||
    infoReadRoute !== "core" ||
    target.origin !== configured.authority.core_origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error(
      "Dual reads require the original mainnet Core origin and transport",
    );
  const endpoint = new URL("/internal/ride-info/binding-status", coreUrl);
  const currentBinding = async (signal: AbortSignal): Promise<DualBinding> => {
    signal.throwIfAborted();
    const response = await request(endpoint, {
      method: "GET",
      redirect: "error",
      signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Read binding unavailable");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Read binding unavailable");
    let complete = false,
      bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        signal.throwIfAborted();
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        bytes += next.value.byteLength;
        if (bytes > 4096) throw new Error("Read binding response is invalid");
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      if (!exactKeys(value, ["binding"]))
        throw new Error("Read binding response is invalid");
      return validateDualRuntimeBinding(value.binding, {
        authority_id: configured.authorityId,
        binding_generation: configured.authority.binding_generation,
        account_bank_id: configured.authority.account_bank_id,
        gateway_bank_id: configured.authority.gateway_bank_id,
      });
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  return { ...configured, currentBinding };
}
