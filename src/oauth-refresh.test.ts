import assert from "node:assert/strict";
import { it } from "node:test";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InMemoryOAuthStateStore, RideOAuthProvider } from "./oauth.js";
import { AgentError } from "./agent/contracts.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createRideHttpApp } from "./http_security.js";
import type { AddressInfo } from "node:net";
import {
  auth as sdkAuth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";

const client: OAuthClientInformationFull = {
  client_id: "fixture-client",
  redirect_uris: ["https://client.test/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};
async function fixture(coreToken = "fixture-core-token") {
  const store = new InMemoryOAuthStateStore();
  let verify = async () => ({ subject: "fixture-owner" });
  const calls: string[] = [];
  const provider = new RideOAuthProvider({
    store,
    validateRideToken: async (token) => {
      calls.push(token);
      return verify();
    },
    exchangePrivyToken: async () =>
      assert.fail("OAuth refresh cannot mint a new Core credential"),
    authPage: {
      privyAppId: "fixture",
      privyClientId: "fixture",
      jsSdkUrl: "https://fixture.invalid",
      manualTokenAuthEnabled: false,
    },
  });
  await provider.clientsStore.registerClient!(client);
  const code = await provider.completeAuthorization({
    clientId: client.client_id,
    redirectUri: client.redirect_uris[0],
    codeChallenge: "fixture",
    rideAuthToken: coreToken,
    resource: "https://ride.test/mcp",
  });
  const tokens = await provider.exchangeAuthorizationCode(client, code);
  assert(tokens.refresh_token);
  return {
    store,
    provider,
    tokens,
    calls,
    verify: (next: typeof verify) => {
      verify = next;
    },
  };
}

it("revalidates the bound Core owner and atomically rotates one OAuth refresh grant once", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    [0, 1].map(() =>
      f.provider.exchangeRefreshToken(
        client,
        f.tokens.refresh_token!,
        ["ride:read"],
        new URL("https://ride.test/mcp"),
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const success = results.find((result) => result.status === "fulfilled")!;
  assert.equal(success.status, "fulfilled");
  const info = await f.provider.verifyAccessToken(success.value.access_token);
  assert.equal(info.extra?.rideAuthToken, "fixture-core-token");
  assert.equal(info.extra?.subject, "fixture-owner");
  assert.deepEqual(info.scopes, ["ride:read"]);
  assert.equal(info.resource?.toString(), "https://ride.test/mcp");
  assert(f.calls.every((token) => token === "fixture-core-token"));
  await assert.rejects(
    f.provider.exchangeRefreshToken(client, f.tokens.refresh_token!),
    { name: "InvalidGrantError" },
  );
});

it("requires the host connection flow when the stored Core JWT has expired instead of faking renewal", async () => {
  const f = await fixture();
  f.verify(async () => {
    throw new AgentError(
      "AUTH_REQUIRED",
      "private upstream detail",
      false,
      401,
      { reason_code: "ACCESS_TOKEN_EXPIRED" },
    );
  });
  const before = await f.store.getStats();
  await assert.rejects(
    f.provider.exchangeRefreshToken(client, f.tokens.refresh_token!),
    (error: any) =>
      error.name === "InvalidGrantError" &&
      /Reconnect Rider/.test(error.message) &&
      !error.message.includes("private"),
  );
  const after = await f.store.getStats();
  assert.equal(after.activeAccessTokens, before.activeAccessTokens);
  assert.equal(after.activeRefreshTokens, before.activeRefreshTokens);
});

it("preserves a refresh grant during a genuine Core outage and allows the same grant to recover", async () => {
  const f = await fixture();
  f.verify(async () => {
    throw new AgentError("BACKEND_UNAVAILABLE", "private endpoint", true, 503);
  });
  await assert.rejects(
    f.provider.exchangeRefreshToken(client, f.tokens.refresh_token!),
    (error: any) =>
      error.name === "TemporarilyUnavailableError" &&
      !error.message.includes("private"),
  );
  assert(await f.store.getRefreshToken(f.tokens.refresh_token!));
  f.verify(async () => ({ subject: "fixture-owner" }));
  const next = await f.provider.exchangeRefreshToken(
    client,
    f.tokens.refresh_token!,
  );
  assert(next.access_token);
});

it("never uses a newly verified different Core subject to renew a saved owner's grant", async () => {
  const f = await fixture();
  f.verify(async () => ({ subject: "different-owner" }));
  await assert.rejects(
    f.provider.exchangeRefreshToken(client, f.tokens.refresh_token!),
    { name: "InvalidGrantError" },
  );
  assert.equal((await f.store.getStats()).activeAccessTokens, 1);
});

it("does not turn a Core client-upgrade requirement into repeated login or consume the grant", async () => {
  const f = await fixture();
  f.verify(async () => {
    throw new AgentError("UPGRADE_REQUIRED", "private detail", false, 403);
  });
  await assert.rejects(
    f.provider.exchangeRefreshToken(client, f.tokens.refresh_token!),
    { name: "InvalidRequestError" },
  );
  assert(await f.store.getRefreshToken(f.tokens.refresh_token!));
});

it("does not consume a refresh record replaced during Core owner validation", async () => {
  const f = await fixture();
  const original = (await f.store.getRefreshToken(f.tokens.refresh_token!))!;
  f.verify(async () => {
    await f.store.setRefreshToken(f.tokens.refresh_token!, {
      ...original,
      identity: { subject: "replacement-owner" },
    });
    return { subject: "fixture-owner" };
  });
  await assert.rejects(
    f.provider.exchangeRefreshToken(client, f.tokens.refresh_token!),
    { name: "InvalidGrantError" },
  );
  assert.equal(
    (await f.store.getRefreshToken(f.tokens.refresh_token!))?.identity.subject,
    "replacement-owner",
  );
});

it("keeps unknown or malformed stored expiry hints subject to the Core guard instead of using decoded identity claims", async () => {
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: "0", sub: "other-owner" })).toString("base64url")}.signature`;
  const f = await fixture(token);
  const auth = await f.provider.verifyAccessToken(f.tokens.access_token);
  assert.equal(auth.extra?.subject, "fixture-owner");
  assert.deepEqual(auth.scopes, ["ride:read"]);
  assert.equal(f.calls.length, 1);
});

it("challenges an outer-valid session whose stored Core JWT expired, then rejects fake refresh at the real HTTP token endpoint", async (t) => {
  let time = Date.now();
  t.mock.method(Date, "now", () => time);
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const coreToken = `${encode({ alg: "HS256" })}.${encode({
    exp: Math.floor(time / 1000) + 60,
    sub: "untrusted-other-owner",
    scopes: ["ride:admin"],
  })}.fixture-signature`;
  const f = await fixture(coreToken);
  let protectedCalls = 0;
  const app = createRideHttpApp("127.0.0.1");
  app.use(
    mcpAuthRouter({
      provider: f.provider,
      issuerUrl: new URL("https://ride.test"),
      scopesSupported: ["ride:read", "ride:trade"],
    }),
  );
  app.post(
    "/mcp",
    requireBearerAuth({
      verifier: f.provider,
      resourceMetadataUrl:
        "https://ride.test/.well-known/oauth-protected-resource/mcp",
    }),
    (_req, res) => {
      protectedCalls++;
      res.json({ ok: true });
    },
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const valid = await fetch(url + "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${f.tokens.access_token}` },
  });
  assert.equal(valid.status, 200);
  const auth = await f.provider.verifyAccessToken(f.tokens.access_token);
  assert.equal(auth.extra?.subject, "fixture-owner");
  assert.deepEqual(
    auth.scopes,
    ["ride:read"],
    "decoded Core JWT claims never grant scopes",
  );
  assert.equal(
    f.calls.length,
    1,
    "ordinary requests must not add a Core GraphQL round trip",
  );
  time += 120000;
  const expired = await fetch(url + "/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${f.tokens.access_token}` },
  });
  assert.equal(expired.status, 401);
  assert.match(expired.headers.get("www-authenticate")!, /invalid_token/);
  assert.equal(protectedCalls, 1);
  f.verify(async () => {
    throw new AgentError("AUTH_REQUIRED", "private detail", false, 401, {
      reason_code: "ACCESS_TOKEN_EXPIRED",
    });
  });
  const refresh = await fetch(url + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: f.tokens.refresh_token!,
    }),
  });
  assert.equal(refresh.status, 400);
  const failure = await refresh.json();
  assert.equal(failure.error, "invalid_grant");
  assert.match(failure.error_description, /Reconnect Rider/);
  assert(!JSON.stringify(failure).includes(coreToken));
  assert(!failure.access_token);
  assert.equal((await f.store.getStats()).activeAccessTokens, 1);

  let hostTokens: any = { ...f.tokens, issuer: url },
    invalidated = 0,
    redirects = 0;
  const host: OAuthClientProvider = {
    redirectUrl: client.redirect_uris[0],
    clientMetadata: {
      redirect_uris: client.redirect_uris,
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    },
    clientInformation: () => ({ ...client, issuer: url }),
    tokens: () => hostTokens,
    saveTokens: (tokens) => {
      hostTokens = tokens;
    },
    saveClientInformation: () => {},
    redirectToAuthorization: (authorization) => {
      assert.equal(authorization.origin, url);
      redirects++;
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => "fixture",
    invalidateCredentials: (scope) => {
      assert.equal(scope, "tokens");
      hostTokens = undefined;
      invalidated++;
    },
    discoveryState: () => ({
      authorizationServerUrl: url,
      resourceMetadata: {
        resource: "https://ride.test/mcp",
        authorization_servers: [url],
      },
      authorizationServerMetadata: {
        issuer: url,
        authorization_endpoint: url + "/authorize",
        token_endpoint: url + "/token",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
      },
    }),
  };
  f.verify(async () => {
    throw new AgentError("BACKEND_UNAVAILABLE", "private outage", true, 503);
  });
  await assert.rejects(sdkAuth(host, { serverUrl: "https://ride.test/mcp" }), {
    name: "TemporarilyUnavailableError",
  });
  assert.equal(invalidated, 0);
  assert.equal(redirects, 0);
  assert(hostTokens);
  f.verify(async () => {
    throw new AgentError("AUTH_REQUIRED", "private expired", false, 401);
  });
  assert.equal(
    await sdkAuth(host, { serverUrl: "https://ride.test/mcp" }),
    "REDIRECT",
  );
  assert.equal(invalidated, 1);
  assert.equal(
    redirects,
    1,
    "only a verified expired grant enters the human connection flow",
  );
});
