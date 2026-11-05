import { randomUUID } from "node:crypto";
import { AgentError } from "./agent/contracts.js";
import { coreAuthenticationError } from "./core_auth.js";
import { requestContext } from "./request_diagnostics.js";

export async function validateCoreIdentity(
  token: string,
  graphqlUrl: string,
): Promise<string> {
  const contextId = requestContext.getStore()?.request_id;
  const requestId =
    contextId && /^[0-9a-f-]{36}$/i.test(contextId) ? contextId : randomUUID();
  const fail = (
    error: AgentError,
    category: "auth" | "http" | "network" | "response" | "graphql",
    reason: string,
    status?: number,
  ): never => {
    // This record is deliberately constructed only from fixed classifications,
    // an internally generated request ID and a numeric HTTP status. No upstream
    // message, token, account, URL, GraphQL document or response is serialized.
    try {
      console.error(
        JSON.stringify({
          event: "core_identity_failure",
          request_id: requestId,
          category,
          reason_code: reason,
          error_code: error.code,
          ...(status === undefined ? {} : { upstream_status: status }),
        }),
      );
    } catch {
      /* Diagnostics cannot replace the original request outcome. */
    }
    throw error;
  };
  const unavailable = (reason: string) =>
    new AgentError(
      "BACKEND_UNAVAILABLE",
      "Ride identity verification is temporarily unavailable. Retry without signing in again.",
      true,
      503,
      { operation: "core_identity", reason_code: reason },
    );
  let response: Response;
  try {
    response = await fetch(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query:
          "query AgentIdentity { copyTradeSummary { totalConfigs } me { id } }",
      }),
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
  } catch (error) {
    const reason =
      error instanceof Error &&
      ["AbortError", "TimeoutError"].includes(error.name)
        ? "CORE_REQUEST_TIMEOUT"
        : "CORE_NETWORK_UNAVAILABLE";
    return fail(unavailable(reason), "network", reason);
  }
  const httpAuthentication = coreAuthenticationError(response.status);
  if (httpAuthentication)
    return fail(
      httpAuthentication,
      "auth",
      "CORE_HTTP_UNAUTHORIZED",
      response.status,
    );
  if (!response.ok)
    return fail(
      unavailable("CORE_HTTP_FAILURE"),
      "http",
      "CORE_HTTP_FAILURE",
      response.status,
    );
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    return fail(
      unavailable("CORE_INVALID_JSON"),
      "response",
      "CORE_INVALID_JSON",
      response.status,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return fail(
      unavailable("CORE_INVALID_RESPONSE"),
      "response",
      "CORE_INVALID_RESPONSE",
      response.status,
    );
  if (payload.errors !== undefined && !Array.isArray(payload.errors))
    return fail(
      unavailable("CORE_INVALID_ERRORS"),
      "response",
      "CORE_INVALID_ERRORS",
      response.status,
    );
  const authentication = coreAuthenticationError(
    response.status,
    payload.errors,
  );
  if (authentication)
    return fail(
      authentication,
      "auth",
      authentication.details!.reason_code!,
      response.status,
    );
  if (payload.errors?.length) {
    const reason = payload.errors.some(
      (error: any) => error?.path?.[0] === "copyTradeSummary",
    )
      ? "CORE_SUMMARY_RESOLVER_ERROR"
      : payload.errors.some((error: any) => error?.path?.[0] === "me")
        ? "CORE_IDENTITY_RESOLVER_ERROR"
        : "CORE_GRAPHQL_ERROR";
    return fail(unavailable(reason), "graphql", reason, response.status);
  }
  const user = payload.data?.me?.id;
  if (typeof user !== "string" || !user.trim())
    return fail(
      unavailable("CORE_IDENTITY_MISSING"),
      "response",
      "CORE_IDENTITY_MISSING",
      response.status,
    );
  // Keep both original identity checks. Missing summary is never a logged-in
  // empty account, and a resolver outage cannot be fixed by reauthentication.
  if (!payload.data?.copyTradeSummary)
    return fail(
      unavailable("CORE_SUMMARY_MISSING"),
      "response",
      "CORE_SUMMARY_MISSING",
      response.status,
    );
  return user;
}
