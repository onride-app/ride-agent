import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./agent/contracts.js";
import { exchangePrivyForRide } from "./auth_exchange.js";

const input = {
  privyId: "did:privy:fixture",
  privyAccessToken: "fixture-privy-token",
  walletAddress: "0x0000000000000000000000000000000000000001",
};

function upstream(data: unknown, status = 200): typeof fetch {
  return (async () => Response.json(data, { status })) as typeof fetch;
}

it("exchanges existing accounts with either provider and preserves the legacy Google default", async () => {
  for (const provider of [undefined, "GOOGLE", "APPLE"] as const) {
    const request: typeof fetch = (async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      assert.equal(body.variables.input.authProvider, provider ?? "GOOGLE");
      assert.equal(
        body.variables.input.privyAccessToken,
        input.privyAccessToken,
      );
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      return Response.json({
        data: {
          syncPrivyUser: {
            accessToken: "fixture-ride-token",
            user: { id: "fixture-account", username: "Fixture" },
          },
        },
      });
    }) as typeof fetch;
    assert.deepEqual(
      await exchangePrivyForRide(
        { ...input, authProvider: provider },
        "https://graphql.example",
        request,
      ),
      {
        rideAuthToken: "fixture-ride-token",
        identity: { subject: "fixture-account", displayName: "Fixture" },
      },
    );
  }
});

it("reports restricted registration without invalidating a valid login", async () => {
  for (const code of [
    "USER_REGISTRATION_DISABLED",
    "ACCESS_CODE_REQUIRED",
    "INVALID_ACCESS_CODE",
  ]) {
    await assert.rejects(
      exchangePrivyForRide(
        input,
        "https://graphql.example",
        upstream({
          errors: [{ message: "private upstream", extensions: { code } }],
        }),
      ),
      (e: unknown) => {
        assert.ok(e instanceof AgentError);
        assert.equal(e.httpStatus, 403);
        assert.notEqual(e.code, "AUTH_REQUIRED");
        assert.equal(e.retryable, false);
        assert.doesNotMatch(e.message, /private upstream/);
        return true;
      },
    );
  }
});

it("requests sign-in again only for typed credential or identity failures", async () => {
  for (const code of [
    "PRIVY_ACCESS_TOKEN_INVALID",
    "PRIVY_ACCESS_TOKEN_REQUIRED",
    "PRIVY_AUTH_PROVIDER_MISMATCH",
    "WALLET_LOGIN_REQUIRES_PRIVY_AUTH",
  ])
    await assert.rejects(
      exchangePrivyForRide(
        input,
        "https://graphql.example",
        upstream({ errors: [{ extensions: { code } }] }),
      ),
      (e: unknown) =>
        e instanceof AgentError &&
        e.code === "AUTH_REQUIRED" &&
        e.httpStatus === 401,
    );
});

it("keeps service failures retryable and hides raw upstream details", async () => {
  const requests: (typeof fetch)[] = [
    upstream({ errors: [{ extensions: { code: "PRIVY_AUTH_UNAVAILABLE" } }] }),
    upstream({ message: "database secret" }, 503),
    (async () => {
      throw new Error("private network error");
    }) as typeof fetch,
    (async () =>
      new Response("private bad gateway", { status: 502 })) as typeof fetch,
  ];
  for (const request of requests)
    await assert.rejects(
      exchangePrivyForRide(input, "https://graphql.example", request),
      (e: unknown) => {
        assert.ok(e instanceof AgentError);
        assert.equal(e.code, "AUTH_SERVICE_UNAVAILABLE");
        assert.equal(e.httpStatus, 503);
        assert.equal(e.retryable, true);
        assert.doesNotMatch(e.message, /private|database secret/);
        return true;
      },
    );
});

it("does not issue a session on partial GraphQL success, missing identity, or unknown setup failures", async () => {
  const data = {
    syncPrivyUser: { accessToken: "fixture-token", user: { id: "fixture" } },
  };
  for (const body of [
    { data, errors: [{ message: "private account setup failure" }] },
    { data, errors: [{ extensions: { code: "UNKNOWN_PRIVATE_ERROR" } }] },
    { data: { syncPrivyUser: { accessToken: "fixture-token", user: {} } } },
    null,
  ])
    await assert.rejects(
      exchangePrivyForRide(input, "https://graphql.example", upstream(body)),
      (e: unknown) =>
        e instanceof AgentError &&
        e.code === "ACCOUNT_SETUP_FAILED" &&
        e.httpStatus === 502,
    );
});
