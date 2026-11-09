import { D, type Execution } from "./domain.js";

/** Identity already durable in Agent state; never reconstructed submit fields. */
export type PerpsRecoveryRequest = {
  user_id: string;
  account_id: string;
  execution_id: string;
  fingerprint: string;
  asset: string;
  target_quantity: string;
  created_at: number;
  expires_at: number;
};

export type PerpsRecovery =
  { kind: "accepted"; task_id: string } | { kind: "unknown" };

const identityFields = [
  "user_id",
  "account_id",
  "execution_id",
  "fingerprint",
  "asset",
  "target_quantity",
  "created_at",
  "expires_at",
] as const;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonnilUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  uuid.test(value) &&
  value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * An original identity is sufficient to ask for positive Core evidence. It is
 * never sufficient to conclude that an absent local outbox was not submitted.
 */
export function perpsRecoveryRequest(
  user: string,
  account: string | null | undefined,
  execution: Execution,
): PerpsRecoveryRequest | null {
  if (
    !nonnilUuid(user) ||
    !nonnilUuid(account) ||
    typeof execution.id !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,160}$/.test(execution.id) ||
    typeof execution.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(execution.fingerprint) ||
    typeof execution.key !== "string" ||
    !execution.key.startsWith("perps:") ||
    !/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(execution.key.slice(6)) ||
    execution.key.slice(6).length > 128 ||
    !Number.isSafeInteger(execution.created_at) ||
    execution.created_at <= 0 ||
    !Number.isSafeInteger(execution.expires_at) ||
    execution.expires_at <= execution.created_at
  )
    return null;
  try {
    if (
      typeof execution.target_quantity !== "string" ||
      execution.target_quantity.length > 128 ||
      !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(execution.target_quantity) ||
      !D(execution.target_quantity).isFinite()
    )
      return null;
  } catch {
    return null;
  }
  return {
    user_id: user,
    account_id: account,
    execution_id: execution.id,
    fingerprint: execution.fingerprint,
    asset: execution.key.slice(6),
    target_quantity: execution.target_quantity,
    created_at: execution.created_at,
    expires_at: execution.expires_at,
  };
}

/**
 * Only positive, same-original identity evidence can recover a missing local
 * receipt. Not-found, expiry, empty holdings and negative responses never
 * release an unknown execution through this protocol.
 *
 * Core owns the actual admission serialization and wallet/epoch comparison;
 * its receipt must contain the original values, not caller-supplied defaults.
 */
export function perpsExecutionRecovery(
  request: PerpsRecoveryRequest,
  value: unknown,
  startedAt: number,
  completedAt: number,
): PerpsRecovery {
  const unknown = { kind: "unknown" } as const;
  if (
    !object(value) ||
    value.protocol_version !== 1 ||
    value.acceptance !== "accepted" ||
    value.reason_code !== "ORIGINAL_TASK_FOUND" ||
    !nonnilUuid(value.task_id) ||
    !object(value.proof) ||
    !Number.isSafeInteger(startedAt) ||
    !Number.isSafeInteger(completedAt) ||
    startedAt <= 0 ||
    completedAt < startedAt
  )
    return unknown;
  const proof = value.proof;
  if (
    !identityFields.every((field) => proof[field] === request[field]) ||
    proof.network !== "mainnet" ||
    !nonnilUuid(proof.intent_id) ||
    !Number.isSafeInteger(proof.observed_at) ||
    (proof.observed_at as number) <= 0 ||
    (proof.observed_at as number) < startedAt - 1000 ||
    (proof.observed_at as number) > completedAt + 1000 ||
    completedAt - (proof.observed_at as number) > 30_000 ||
    request.created_at > (proof.observed_at as number) ||
    !nonnilUuid(proof.current_execution_epoch) ||
    proof.original_execution_epoch !== proof.current_execution_epoch ||
    !Number.isSafeInteger(proof.wallet_generation) ||
    (proof.wallet_generation as number) <= 0 ||
    proof.original_wallet_generation !== proof.wallet_generation ||
    proof.serialized_identity_check !== true
  )
    return unknown;
  return { kind: "accepted", task_id: value.task_id };
}
