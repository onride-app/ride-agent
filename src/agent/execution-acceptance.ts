import { D, PERPS_COPY_MAX_LEVERAGE, type Execution } from "./domain.js";

export type PerpsAcceptanceRequest = {
  user_id: string;
  account_id: string;
  execution_id: string;
  fingerprint: string;
  asset: string;
  direction: "flat" | "long" | "short";
  target_position_pct: string;
  leverage: number;
  created_at: number;
  expires_at: number;
  policy_revision: number;
};
export type PerpsAcceptance =
  | { kind: "accepted"; task_id: string }
  | { kind: "not_accepted_expired" }
  | { kind: "unknown" };

const fields = [
  "user_id",
  "account_id",
  "execution_id",
  "fingerprint",
  "asset",
  "direction",
  "target_position_pct",
  "leverage",
  "created_at",
  "expires_at",
  "policy_revision",
] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nonnilUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  uuid.test(value) &&
  value.toLowerCase() !== "00000000-0000-0000-0000-000000000000";
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Select only the original frozen admission fields; never synthesize expiry. */
export function perpsAcceptanceRequest(
  user: string,
  account: string | null | undefined,
  execution: Execution,
  saved: unknown,
): PerpsAcceptanceRequest | null {
  if (!object(saved) || !execution.key.startsWith("perps:")) return null;
  try {
    const quantity = D(execution.target_quantity);
    const direction = quantity.isZero()
      ? "flat"
      : quantity.isPositive()
        ? "long"
        : "short";
    if (
      !quantity.isFinite() ||
      saved.user_id !== user ||
      saved.account_id !== account ||
      saved.execution_id !== execution.id ||
      saved.fingerprint !== execution.fingerprint ||
      saved.asset !== execution.key.slice(6) ||
      saved.direction !== direction ||
      saved.created_at !== execution.created_at ||
      saved.expires_at !== execution.expires_at ||
      !fields
        .slice(0, 5)
        .every(
          (key) =>
            typeof saved[key] === "string" && (saved[key] as string).length > 0,
        ) ||
      typeof saved.target_position_pct !== "string" ||
      !/^\d+(?:\.\d+)?$/.test(saved.target_position_pct) ||
      !D(saved.target_position_pct).isFinite() ||
      !Number.isInteger(saved.leverage) ||
      (saved.leverage as number) < 1 ||
      (saved.leverage as number) > PERPS_COPY_MAX_LEVERAGE ||
      !Number.isSafeInteger(saved.created_at) ||
      (saved.created_at as number) <= 0 ||
      !Number.isSafeInteger(saved.expires_at) ||
      (saved.expires_at as number) <= (saved.created_at as number) ||
      !Number.isSafeInteger(saved.policy_revision) ||
      (saved.policy_revision as number) < 0 ||
      (saved.target_quantity !== undefined &&
        saved.target_quantity !== execution.target_quantity)
    )
      return null;
    return Object.fromEntries(
      fields.map((key) => [key, saved[key]]),
    ) as PerpsAcceptanceRequest;
  } catch {
    return null;
  }
}

/** A read-only Core admission proof is not an execution or fill receipt. */
export function perpsExecutionAcceptance(
  request: PerpsAcceptanceRequest,
  value: unknown,
  startedAt: number,
  completedAt: number,
): PerpsAcceptance {
  const unknown = { kind: "unknown" } as const;
  if (!object(value) || value.protocol_version !== 1 || !object(value.proof))
    return unknown;
  const proof = value.proof;
  if (
    !fields.every((key) => proof[key] === request[key]) ||
    proof.network !== "mainnet" ||
    !Number.isSafeInteger(proof.observed_at) ||
    (proof.observed_at as number) <= 0 ||
    (proof.observed_at as number) < startedAt - 1000 ||
    (proof.observed_at as number) > completedAt + 1000 ||
    completedAt - (proof.observed_at as number) > 30_000 ||
    !(
      proof.current_execution_epoch === null ||
      nonnilUuid(proof.current_execution_epoch)
    )
  )
    return unknown;
  if (
    value.acceptance === "accepted" &&
    value.reason_code === "ORIGINAL_TASK_FOUND" &&
    nonnilUuid(value.task_id) &&
    proof.serialized_expiry_check === false
  )
    return { kind: "accepted", task_id: value.task_id };
  if (
    value.acceptance === "not_accepted_expired" &&
    value.reason_code === "EXPIRED_ABSENT_UNDER_ADMISSION_LOCK" &&
    value.task_id === null &&
    proof.serialized_expiry_check === true &&
    nonnilUuid(proof.current_execution_epoch) &&
    request.expires_at - request.created_at === 60_000 &&
    request.expires_at <= completedAt &&
    request.expires_at <= (proof.observed_at as number)
  )
    return { kind: "not_accepted_expired" };
  return unknown;
}
