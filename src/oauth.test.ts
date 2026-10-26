import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { Response } from "express";
import { afterEach, describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  createRideOAuthApprovalRouter,
  RideOAuthProvider,
  type PrivyAuthorizationInput,
} from "./oauth.js";
import { createRideHttpApp, requestBodyErrorHandler } from "./http_security.js";

const client: OAuthClientInformationFull = {
  client_id: "test-client",
  client_name: "Test client",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

function createProvider(onExchange?: (input: PrivyAuthorizationInput) => void) {
  return new RideOAuthProvider({
    validateRideToken: async (token) => ({ subject: token }),
    exchangePrivyToken: async (input) => {
      onExchange?.(input);
      return {
        rideAuthToken: input.privyAccessToken,
        identity: { subject: input.privyId },
      };
    },
    authPage: {
      privyAppId: "public-app-id",
      privyClientId: "public-client-id",
      jsSdkUrl: "https://example.invalid/privy.js",
      manualTokenAuthEnabled: false,
    },
  });
}

it("retries a failed Privy initialization with a fresh client and deduplicates concurrent retries", async () => {
  let html = "";
  const response = {
    status() {
      return this;
    },
    type() {
      return this;
    },
    send(value: string) {
      html = value;
    },
  } as unknown as Response;
  await createProvider().authorize(
    client,
    {
      redirectUri: client.redirect_uris[0],
      codeChallenge: "challenge",
      scopes: ["ride:read"],
    },
    response,
  );
  const script = html
    .match(/<script type="module">([\s\S]*?)<\/script>/)![1]
    .replace(/^\s*import Privy[^\n]*\n/m, "");
  let attempts = 0;
  class MockPrivy {
    async initialize() {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error("signal is aborted without reason"), {
          name: "AbortError",
        });
    }
  }
  const element = {
    value: "",
    classList: { toggle() {} },
    addEventListener() {},
  };
  const context: any = {
    Privy: MockPrivy,
    LocalStorage: class {},
    URL,
    document: { getElementById: () => element },
    window: {
      location: {
        href: "https://ride.test/authorize",
        origin: "https://ride.test",
      },
    },
    sessionStorage: {
      getItem() {
        return null;
      },
    },
  };
  runInNewContext(
    script + "\nglobalThis.testAuth = { initPrivy, formatAuthError };",
    context,
  );
  await assert.rejects(context.testAuth.initPrivy(), /aborted/);
  const [one, two] = await Promise.all([
    context.testAuth.initPrivy(),
    context.testAuth.initPrivy(),
  ]);
  assert.equal(one, two);
  assert.equal(attempts, 2);
  assert.match(
    context.testAuth.formatAuthError({
      name: "AbortError",
      message: "signal is aborted without reason",
    }),
    /Privy timed out/,
  );
});

async function consentHtml(scopes = ["ride:read", "ride:trade"]) {
  let html = "";
  await createProvider().authorize(
    client,
    {
      redirectUri: client.redirect_uris[0],
      codeChallenge: "challenge",
      scopes,
    },
    {
      status() {
        return this;
      },
      type() {
        return this;
      },
      send(value: string) {
        html = value;
      },
    } as unknown as Response,
  );
  return html;
}
function consentPage(html: string, store: Map<string, string>, href: string) {
  const elements = new Map<string, any>();
  const generated: any[] = [],
    completed: any[] = [],
    approved: any[] = [],
    redirects: string[] = [];
  const currentUser = {
    id: "did:privy:fixture",
    linkedAccounts: [
      {
        type: "wallet",
        chainType: "ethereum",
        walletClientType: "privy",
        address: "0xfixture",
        id: "wallet_fixture",
      },
      { type: "apple_oauth", email: "fixture@privaterelay.appleid.com" },
    ],
  };
  class MockPrivy {
    async initialize() {}
    async getAccessToken() {
      return "fixture-privy-token";
    }
    user = { get: async () => ({ user: currentUser }) };
    auth = {
      oauth: {
        generateURL: async (...args: any[]) => {
          generated.push(args);
          return { url: "https://auth.privy.test/start" };
        },
        loginWithCode: async (...args: any[]) => {
          completed.push(args);
          return { user: currentUser };
        },
      },
    };
  }
  const context: any = {
    URL,
    Privy: MockPrivy,
    LocalStorage: class {},
    document: {
      getElementById(id: string) {
        if (!elements.has(id))
          elements.set(id, {
            textContent: "",
            disabled: false,
            style: {},
            classList: { toggle() {} },
            listeners: {} as any,
            addEventListener(name: string, handler: any) {
              this.listeners[name] = handler;
            },
          });
        return elements.get(id);
      },
    },
    window: {
      location: {
        href,
        origin: new URL(href).origin,
        assign(url: string) {
          redirects.push(url);
        },
      },
    },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    },
    fetch: async (url: string, request: any) => {
      assert.equal(url, "/auth/privy/approve");
      approved.push(JSON.parse(request.body));
      return {
        ok: true,
        json: async () => ({
          redirectUrl: "https://client.example/callback?code=fixture",
        }),
      };
    },
  };
  const script = html
    .match(/<script type="module">([\s\S]*?)<\/script>/)![1]
    .replace(/^\s*import Privy[^\n]*\n/m, "")
    .replace(
      "handleOAuthCallback().catch",
      "globalThis.callbackPromise = handleOAuthCallback().catch",
    );
  runInNewContext(script, context);
  return {
    elements,
    generated,
    completed,
    approved,
    redirects,
    callback: context.callbackPromise,
  };
}
it("keeps Google and Apple provider choices through authorization redirects without exposing developer fields", async () => {
  const html = await consentHtml();
  assert.doesNotMatch(html, /id="access-code"|name="access-code"|Scopes:/);
  assert.match(html, /View your Ride account/);
  assert.match(html, /Orders require Ride confirmation/);
  for (const provider of ["GOOGLE", "APPLE"]) {
    const store = new Map<string, string>();
    const start = consentPage(
      html,
      store,
      "https://ride.test/authorize?client_id=test-client",
    );
    await start.callback;
    await start.elements
      .get(provider === "APPLE" ? "apple-login" : "google-login")
      .listeners.click();
    assert.equal(start.generated.length, 1);
    assert.equal(start.generated[0][0], provider.toLowerCase());
    assert.equal(
      start.generated[0][1],
      "https://ride.test/auth/privy/oauth/callback",
    );
    assert.equal(store.get("ride:auth:provider"), provider);
    assert.equal(start.redirects[0], "https://auth.privy.test/start");
    const returned = consentPage(
      html,
      store,
      "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
    );
    await returned.callback;
    assert.equal(returned.completed.length, 1);
    assert.deepEqual(
      [...returned.completed[0]],
      ["code", "state", provider.toLowerCase()],
    );
    assert.equal(returned.approved.length, 1);
    assert.equal(returned.approved[0].auth_provider, provider);
    assert.equal(
      returned.approved[0].email,
      "fixture@privaterelay.appleid.com",
    );
    assert.equal(returned.approved[0].access_code, undefined);
    assert.equal(returned.approved[0].scope, "ride:read ride:trade");
    assert.equal(
      returned.redirects[0],
      "https://client.example/callback?code=fixture",
    );
  }
});
it("keeps old Google callbacks working while rejecting unsupported stored providers before exchange", async () => {
  const html = await consentHtml();
  const legacy = consentPage(
    html,
    new Map(),
    "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
  );
  await legacy.callback;
  assert.equal(legacy.approved[0].auth_provider, "GOOGLE");
  const invalid = consentPage(
    html,
    new Map([["ride:auth:provider", "GITHUB"]]),
    "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
  );
  await invalid.callback;
  assert.equal(invalid.completed.length, 0);
  assert.equal(invalid.approved.length, 0);
  assert.match(
    invalid.elements.get("status").textContent,
    /Choose Google or Apple/,
  );
});

describe("Ride OAuth scope enforcement", () => {
  it("rejects unsupported scopes before rendering consent", async () => {
    await assert.rejects(
      createProvider().authorize(
        client,
        {
          redirectUri: client.redirect_uris[0],
          codeChallenge: "challenge",
          scopes: ["ride:unknown"],
        },
        {} as Response,
      ),
      { name: "InvalidScopeError" },
    );
  });

  it("rejects unsupported scopes during authorization", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);

    await assert.rejects(
      provider.completeAuthorization({
        clientId: client.client_id,
        redirectUri: client.redirect_uris[0],
        codeChallenge: "challenge",
        scope: "ride:read ride:admin",
        rideAuthToken: "ride-token",
      }),
      { name: "InvalidScopeError" },
    );
  });

  it("defaults to read-only and prevents refresh scope escalation", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);
    const code = await provider.completeAuthorization({
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0],
      codeChallenge: "challenge",
      rideAuthToken: "ride-token",
    });
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);

    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    assert.deepEqual(authInfo.scopes, ["ride:read"]);

    await assert.rejects(
      provider.exchangeRefreshToken(client, tokens.refresh_token, [
        "ride:read",
        "ride:trade",
      ]),
      { name: "InvalidScopeError" },
    );

    const refreshed = await provider.exchangeRefreshToken(
      client,
      tokens.refresh_token,
      ["ride:read"],
    );
    const refreshedAuth = await provider.verifyAccessToken(
      refreshed.access_token,
    );
    assert.deepEqual(refreshedAuth.scopes, ["ride:read"]);
  });
});

describe("Ride OAuth approval redirects", () => {
  const servers: Array<
    ReturnType<ReturnType<typeof createRideHttpApp>["listen"]>
  > = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  async function startApprovalServer(provider: RideOAuthProvider) {
    const app = createRideHttpApp("127.0.0.1");
    app.use(createRideOAuthApprovalRouter(provider));
    app.use(requestBodyErrorHandler);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function postChunkedJson(url: string, body: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      const midpoint = Math.floor(body.length / 2);
      req.write(body.slice(0, midpoint));
      req.end(body.slice(midpoint));
    });
  }

  it("does not redirect a denied request to an unregistered URI", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);
    const baseUrl = await startApprovalServer(provider);
    const body = new URLSearchParams({
      action: "deny",
      client_id: client.client_id,
      redirect_uri: "https://attacker.example/callback",
      state: "opaque-state",
    });

    const response = await fetch(`${baseUrl}/auth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });

    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null);
  });

  it("redirects a denied request only to its registered URI", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);
    const baseUrl = await startApprovalServer(provider);
    const body = new URLSearchParams({
      action: "deny",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      state: "opaque-state",
    });

    const response = await fetch(`${baseUrl}/auth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });

    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.origin + location.pathname, client.redirect_uris[0]);
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("state"), "opaque-state");
  });

  it("accepts OAuth JSON and form bodies below 32 KiB", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);
    const baseUrl = await startApprovalServer(provider);
    const token = "x".repeat(30 * 1024);

    const jsonResponse = await fetch(`${baseUrl}/auth/privy/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: "challenge",
        privy_id: "privy-user",
        privy_access_token: token,
      }),
      redirect: "manual",
    });
    assert.equal(jsonResponse.status, 200);
    assert.equal(
      new URL((await jsonResponse.json()).redirectUrl).origin,
      new URL(client.redirect_uris[0]).origin,
    );

    const formResponse = await fetch(`${baseUrl}/auth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "approve",
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: "challenge",
        ride_token: token,
      }),
      redirect: "manual",
    });
    assert.equal(formResponse.status, 302);
  });

  it("accepts only supported providers and defaults existing OAuth clients to Google", async () => {
    const seen: PrivyAuthorizationInput[] = [];
    const provider = createProvider((input) => seen.push(input));
    await provider.clientsStore.registerClient!(client);
    const baseUrl = await startApprovalServer(provider);
    const payload = {
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: "challenge",
      privy_id: "fixture",
      privy_access_token: "fixture-token",
      access_code: "legacy-code",
    };
    for (const choice of [undefined, "GOOGLE", "APPLE"]) {
      const response = await fetch(`${baseUrl}/auth/privy/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, auth_provider: choice }),
      });
      assert.equal(response.status, 200);
      assert.equal(seen.at(-1)!.authProvider, choice ?? "GOOGLE");
      assert.equal(seen.at(-1)!.accessCode, "legacy-code");
    }
    for (const choice of ["GITHUB", "apple", null, 1]) {
      const count = seen.length;
      const response = await fetch(`${baseUrl}/auth/privy/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, auth_provider: choice }),
      });
      assert.equal(response.status, 400);
      assert.equal(seen.length, count);
    }
  });

  it("rejects oversized chunked OAuth JSON before SDK parsing", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);
    const baseUrl = await startApprovalServer(provider);
    const response = await postChunkedJson(
      `${baseUrl}/auth/privy/approve`,
      JSON.stringify({
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        code_challenge: "challenge",
        privy_id: "privy-user",
        privy_access_token: "x".repeat(33 * 1024),
      }),
    );

    assert.equal(response.status, 413);
    assert.deepEqual(JSON.parse(response.body), {
      error: "payload_too_large",
    });
  });

  it("rejects oversized OAuth approval forms", async () => {
    const provider = createProvider();
    await provider.clientsStore.registerClient!(client);
    const baseUrl = await startApprovalServer(provider);
    const body = new URLSearchParams({
      action: "approve",
      client_id: client.client_id,
      redirect_uri: client.redirect_uris[0],
      code_challenge: "challenge",
      ride_token: "x".repeat(33 * 1024),
    });

    const response = await fetch(`${baseUrl}/auth/approve`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "payload_too_large" });
  });
});
