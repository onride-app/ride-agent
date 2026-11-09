import type { PerpsRecoveryRequest } from "./execution-core-recovery.js";

export type PerpsRetirementReceipt = {
  protocol_version: 1;
  retirement: "original_absence_retired";
  reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED";
  proof: PerpsRecoveryRequest & {
    network: "mainnet";
    observed_at: number;
    current_execution_epoch: string;
    retirement_epoch: string;
    tombstone_id: string;
    retired_at: number;
    serialized_absence_check: true;
    permanent_original_id_fence: true;
    historical_bindings_checked: true;
  };
};

const fields = [
  "user_id",
  "account_id",
  "execution_id",
  "fingerprint",
  "asset",
  "target_quantity",
  "created_at",
  "expires_at",
] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const nonnilUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  ) &&
  value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";

/** Verify a previously committed permanent receipt without issuing another write. */
export function persistedPerpsRetirement(
  request: PerpsRecoveryRequest,
  value: unknown,
  at: number,
): PerpsRetirementReceipt | null {
  if (
    !object(value) ||
    value.protocol_version !== 1 ||
    value.retirement !== "original_absence_retired" ||
    value.reason_code !== "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED" ||
    !object(value.proof) ||
    !Number.isSafeInteger(at) ||
    at <= 0
  )
    return null;
  const proof = value.proof;
  if (
    !fields.every((field) => proof[field] === request[field]) ||
    proof.network !== "mainnet" ||
    !nonnilUuid(proof.current_execution_epoch) ||
    !nonnilUuid(proof.retirement_epoch) ||
    !nonnilUuid(proof.tombstone_id) ||
    !Number.isSafeInteger(proof.observed_at) ||
    (proof.observed_at as number) <= 0 ||
    (proof.observed_at as number) > at + 1000 ||
    !Number.isSafeInteger(proof.retired_at) ||
    (proof.retired_at as number) < request.expires_at ||
    (proof.retired_at as number) > (proof.observed_at as number) ||
    proof.serialized_absence_check !== true ||
    proof.permanent_original_id_fence !== true ||
    proof.historical_bindings_checked !== true
  )
    return null;
  // Keep only the typed permanent evidence, never a response's other payload.
  return {
    protocol_version: 1,
    retirement: "original_absence_retired",
    reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED",
    proof: {
      ...request,
      network: "mainnet",
      observed_at: proof.observed_at as number,
      current_execution_epoch: proof.current_execution_epoch,
      retirement_epoch: proof.retirement_epoch,
      tombstone_id: proof.tombstone_id,
      retired_at: proof.retired_at as number,
      serialized_absence_check: true,
      permanent_original_id_fence: true,
      historical_bindings_checked: true,
    },
  };
}

/** Fresh response to the explicit Core WRITE; never a fill or submit receipt. */
export function perpsExecutionRetirement(
  request: PerpsRecoveryRequest,
  value: unknown,
  startedAt: number,
  completedAt: number,
): PerpsRetirementReceipt | null {
  if (
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0 ||
    completedAt < startedAt
  )
    return null;
  const receipt = persistedPerpsRetirement(request, value, completedAt);
  if (
    !receipt ||
    receipt.proof.observed_at < startedAt - 1000 ||
    completedAt - receipt.proof.observed_at > 30_000
  )
    return null;
  return receipt;
}
