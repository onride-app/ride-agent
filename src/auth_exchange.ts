import { AgentError } from "./agent/contracts.js";
import type { PrivyAuthorizationInput } from "./oauth.js";

// Keep account setup failures distinct from expired credentials. Sending every
// upstream failure back as 401 makes the host discard a valid Privy session and
// sends the user through sign-in again without fixing the actual blocker.
function exchangeError(code: unknown): AgentError {
  switch (code) {
    case "PRIVY_ACCESS_TOKEN_INVALID":
    case "PRIVY_ACCESS_TOKEN_REQUIRED":
    case "PRIVY_AUTH_PROVIDER_MISMATCH":
    case "WALLET_LOGIN_REQUIRES_PRIVY_AUTH":
      return new AgentError(
        "AUTH_REQUIRED",
        "Sign in again to continue with Rider.",
        false,
        401,
      );
    case "USER_REGISTRATION_DISABLED":
      return new AgentError(
        "USER_REGISTRATION_DISABLED",
        "New Rider account registration is temporarily unavailable. Existing accounts can still sign in.",
        false,
        403,
      );
    case "ACCESS_CODE_REQUIRED":
    case "INVALID_ACCESS_CODE":
      return new AgentError(
        "REGISTRATION_RESTRICTED",
        "New Rider account registration is currently restricted. Sign in with an existing account.",
        false,
        403,
      );
    case "PRIVY_AUTH_UNAVAILABLE":
      return new AgentError(
        "AUTH_SERVICE_UNAVAILABLE",
        "Rider sign-in is temporarily unavailable. Please retry shortly.",
        true,
        503,
      );
    default:
      return new AgentError(
        "ACCOUNT_SETUP_FAILED",
        "Rider could not finish account setup. Please retry shortly.",
        true,
        502,
      );
  }
}

export async function exchangePrivyForRide(
  input: PrivyAuthorizationInput,
  graphql: string,
  request: typeof fetch = fetch,
) {
  let response: Response;
  let data: any;
  try {
    response = await request(graphql, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query:
          "mutation AgentLogin($input:SyncPrivyUserInput!){syncPrivyUser(input:$input){accessToken user{id username}}}",
        variables: {
          input: {
            ...input,
            authProvider: input.authProvider ?? "GOOGLE",
            appVersion: "1.0.0",
            platform: "WEB",
            deviceName: "Rider",
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    data = await response.json();
  } catch {
    throw exchangeError("PRIVY_AUTH_UNAVAILABLE");
  }
  const errorCode = data?.errors?.[0]?.extensions?.code;
  if (errorCode) throw exchangeError(errorCode);
  if (!response.ok) {
    throw exchangeError(
      response.status >= 500 ? "PRIVY_AUTH_UNAVAILABLE" : undefined,
    );
  }
  const login = data?.data?.syncPrivyUser;
  if (
    data?.errors?.length ||
    typeof login?.accessToken !== "string" ||
    !login.accessToken ||
    typeof login.user?.id !== "string" ||
    !login.user.id
  )
    throw exchangeError(undefined);
  return {
    rideAuthToken: login.accessToken as string,
    identity: {
      subject: login.user.id as string,
      displayName: login.user.username ?? "Rider user",
    },
  };
}
