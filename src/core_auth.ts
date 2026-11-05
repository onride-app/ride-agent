import { AgentError } from "./agent/contracts.js";

// Core TokenValidation::error_code and GraphQL Context::require_auth. Never
// classify an arbitrary resolver failure or upstream message as expired login.
const authCodes = new Set([
  "UNAUTHENTICATED",
  "UNAUTHORIZED",
  "NO_TOKEN",
  "ACCESS_TOKEN_EXPIRED",
  "REFRESH_TOKEN_EXPIRED",
  "EPOCH_OUTDATED",
  "INVALID_SIGNATURE",
  "MALFORMED_TOKEN",
  "INVALID_TOKEN_USE",
  "SESSION_REVOKED",
  "SESSION_NOT_FOUND",
]);

export function coreAuthenticationError(
  httpStatus: number,
  errors?: unknown,
): AgentError | undefined {
  if (httpStatus === 401)
    return new AgentError(
      "AUTH_REQUIRED",
      "A valid Ride session is required.",
      false,
      401,
      { reason_code: "CORE_HTTP_UNAUTHORIZED" },
    );
  // A genuine HTTP outage stays an outage, even if its body resembles auth data.
  if (httpStatus < 200 || httpStatus >= 300 || !Array.isArray(errors)) return;
  const code = errors.find((error) => authCodes.has(error?.extensions?.code))
    ?.extensions?.code;
  if (code)
    return new AgentError(
      "AUTH_REQUIRED",
      "A valid Ride session is required.",
      false,
      401,
      { reason_code: code },
    );
  if (errors.some((error) => error?.extensions?.code === "UPGRADE_REQUIRED"))
    return new AgentError(
      "UPGRADE_REQUIRED",
      "Ride requires an updated client before this session can be used.",
      false,
      403,
      { reason_code: "UPGRADE_REQUIRED" },
    );
}

export function isCoreAuthenticationError(error: unknown): error is AgentError {
  return (
    error instanceof AgentError &&
    (error.code === "AUTH_REQUIRED" || error.code === "UPGRADE_REQUIRED")
  );
}
