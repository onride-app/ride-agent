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
import { AgentError } from "./agent/contracts.js";

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
    .replace(
      /return await import\('[^']+'\);/,
      "return await loadTestPrivySdk();",
    );
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
    loadTestPrivySdk: async () => ({
      default: MockPrivy,
      LocalStorage: class {},
    }),
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
function consentPage(
  html: string,
  store: Map<string, string>,
  href: string,
  options: {
    user?: any;
    create?: (input: any) => Promise<any>;
    loadFrame?: boolean;
    ping?: () => Promise<boolean>;
    sdkError?: Error;
  } = {},
) {
  const elements = new Map<string, any>();
  let sdkLoads = 0;
  const generated: any[] = [],
    completed: any[] = [],
    approved: any[] = [],
    redirects: string[] = [];
  let currentUser = options.user ?? {
    id: "did:privy:fixture",
    linkedAccounts: [
      {
        type: "wallet",
        chainType: "ethereum",
        walletClientType: "privy",
        address: "0x1111111111111111111111111111111111111111",
        id: "wallet_fixture",
      },
      { type: "apple_oauth", email: "fixture@privaterelay.appleid.com" },
    ],
  };
  let token = "fixture-privy-token";
  const created: any[] = [],
    posters: any[] = [],
    frames: any[] = [],
    walletMessages: any[] = [];
  const windowListeners = new Map<string, Set<(event: any) => void>>();
  class MockPrivy {
    async initialize() {}
    async getAccessToken() {
      return token;
    }
    setMessagePoster(poster: any) {
      posters.push(poster);
    }
    embeddedWallet = {
      getURL: () => "https://auth.privy.test/wallet",
      ping: options.ping ?? (async () => true),
      onMessage: (message: any) => walletMessages.push(message),
      add: async () => {
        throw Error("SDK add must never be used to create the first wallet");
      },
      create: async (input: any) => {
        created.push(input);
        if (options.create) return options.create(input);
        currentUser = {
          ...currentUser,
          linkedAccounts: [
            ...(currentUser.linkedAccounts ?? []),
            {
              type: "wallet",
              chainType: "ethereum",
              walletClientType: "privy",
              address: "0x2222222222222222222222222222222222222222",
              id: "wallet_new_fixture",
            },
          ],
        };
        return { user: currentUser };
      },
    };
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
    atob: (value: string) => Buffer.from(value, "base64").toString("utf8"),
    setTimeout,
    clearTimeout,
    Privy: MockPrivy,
    LocalStorage: class {},
    loadTestPrivySdk: async () => {
      sdkLoads++;
      if (options.sdkError) throw options.sdkError;
      return { default: MockPrivy, LocalStorage: class {} };
    },
    document: {
      createElement(tag: string) {
        assert.equal(tag, "iframe");
        const listeners = new Map<string, () => void>();
        return {
          contentWindow: { postMessage() {} },
          listeners,
          removed: false,
          addEventListener: (name: string, listener: () => void) =>
            listeners.set(name, listener),
          remove() {
            this.removed = true;
          },
        };
      },
      body: {
        append(frame: any) {
          frames.push(frame);
          assert.ok(windowListeners.get("message")?.size);
          if (options.loadFrame !== false)
            queueMicrotask(() => frame.listeners.get("load")?.());
        },
      },
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
      addEventListener(name: string, listener: (event: any) => void) {
        if (!windowListeners.has(name)) windowListeners.set(name, new Set());
        windowListeners.get(name)!.add(listener);
      },
      removeEventListener(name: string, listener: (event: any) => void) {
        windowListeners.get(name)?.delete(listener);
      },
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
    .replace(
      /return await import\('[^']+'\);/,
      "return await loadTestPrivySdk();",
    )
    .replace(
      "handleOAuthCallback().catch",
      "globalThis.callbackPromise = handleOAuthCallback().catch",
    );
  runInNewContext(
    script +
      "\nglobalThis.auth = {initPrivy, ensureEmbeddedEthereumWallet, finishPrivySession, formatAuthError};",
    context,
  );
  return {
    elements,
    sdkLoads: () => sdkLoads,
    generated,
    completed,
    approved,
    redirects,
    created,
    frames,
    posters,
    walletMessages,
    windowListeners,
    auth: context.auth,
    setUser: (user: any) => {
      currentUser = user;
    },
    setToken: (next: string) => {
      token = next;
    },
    callback: context.callbackPromise,
  };
}
it("keeps Google and Apple provider choices through authorization redirects without exposing developer fields", async () => {
  const html = await consentHtml();
  assert.doesNotMatch(html, /id="access-code"|name="access-code"|Scopes:/);
  assert.match(
    html,
    /id="auth-entry"[\s\S]*?>Log in<\/button>[\s\S]*?>Sign up<\/button>/,
  );
  assert.match(html, /id="auth-providers"[^>]* hidden/);
  assert.doesNotMatch(html, /Connection permissions/);
  for (const provider of ["GOOGLE", "APPLE"]) {
    const store = new Map<string, string>();
    const start = consentPage(
      html,
      store,
      "https://ride.test/authorize?client_id=test-client",
    );
    await start.callback;
    assert.equal(start.sdkLoads(), 0);
    assert.equal(start.generated.length, 0);
    assert.equal(start.sdkLoads(), 0);
    await start.elements.get("log-in").listeners.click();
    assert.equal(start.elements.get("auth-entry").hidden, true);
    assert.equal(start.elements.get("auth-providers").hidden, false);
    assert.equal(start.generated.length, 0);
    await start.elements
      .get(provider === "APPLE" ? "apple-login" : "google-login")
      .listeners.click();
    assert.equal(start.generated.length, 1);
    assert.equal(start.sdkLoads(), 1);
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
it("lets users choose sign-up and return before contacting an identity provider", async () => {
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize",
  );
  await page.callback;
  assert.equal(page.sdkLoads(), 0);
  await page.elements.get("sign-up").listeners.click();
  assert.equal(
    page.elements.get("auth-heading").textContent,
    "Create your Rider account",
  );
  assert.equal(page.elements.get("auth-entry").hidden, true);
  assert.equal(page.elements.get("auth-providers").hidden, false);
  await page.elements.get("auth-back").listeners.click();
  assert.equal(
    page.elements.get("auth-heading").textContent,
    "Connect your Rider account",
  );
  assert.equal(page.elements.get("auth-entry").hidden, false);
  assert.equal(page.elements.get("auth-providers").hidden, true);
  assert.equal(page.generated.length, 0);
  assert.equal(page.completed.length, 0);
  assert.equal(page.approved.length, 0);
  assert.equal(page.sdkLoads(), 0);
});

it("keeps SDK-load errors visible with provider choices and permits a deliberate retry", async () => {
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize",
    {
      sdkError: Error("network fixture"),
    },
  );
  await page.callback;
  await page.elements.get("log-in").listeners.click();
  await page.elements.get("apple-login").listeners.click();
  assert.equal(page.elements.get("auth-providers").hidden, false);
  assert.match(
    page.elements.get("status").textContent,
    /Could not load Rider sign-in/,
  );
  assert.equal(page.elements.get("apple-login").disabled, false);
  assert.equal(page.elements.get("google-login").disabled, false);
  assert.equal(page.generated.length, 0);
  assert.equal(page.approved.length, 0);
  await page.elements.get("google-login").listeners.click();
  assert.equal(page.sdkLoads(), 2);
  assert.match(
    page.elements.get("status").textContent,
    /Could not load Rider sign-in/,
  );
  assert.equal(page.redirects.length, 0);
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

const newPrivyUser = (id = "did:privy:new-fixture") => ({
  id,
  linkedAccounts: [
    { type: "apple_oauth", email: "new@privaterelay.appleid.com" },
  ],
});
const withEmbeddedWallet = (user: ReturnType<typeof newPrivyUser>) => ({
  ...user,
  linkedAccounts: [
    ...user.linkedAccounts,
    {
      type: "wallet",
      chainType: "ethereum",
      walletClientType: "privy-v2",
      address: "0x3333333333333333333333333333333333333333",
      id: "wallet_recovered_fixture",
    },
  ],
});

it("initializes the first wallet for both social providers before requesting Ride authorization", async () => {
  const html = await consentHtml();
  for (const provider of ["GOOGLE", "APPLE"]) {
    const fresh = newPrivyUser();
    const page = consentPage(
      html,
      new Map([["ride:auth:provider", provider]]),
      "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
      { user: fresh },
    );
    await page.callback;
    assert.equal(page.frames.length, 1);
    assert.equal(page.posters.length, 1);
    assert.equal(page.created.length, 1);
    assert.equal(
      page.created[0].idempotencyKey,
      "ride_embedded_ethereum_" + fresh.id,
    );
    assert.equal(page.approved.length, 1);
    assert.equal(page.approved[0].auth_provider, provider);
    assert.equal(
      page.approved[0].wallet_address,
      "0x2222222222222222222222222222222222222222",
    );
    assert.equal(page.approved[0].privy_wallet_id, "wallet_new_fixture");
  }
});

it("refreshes and reuses existing wallets, including Privy v2, without creating another", async () => {
  const fresh = newPrivyUser();
  const existing = withEmbeddedWallet(fresh);
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize",
    { user: existing },
  );
  await page.callback;
  const client = await page.auth.initPrivy();
  const result = await page.auth.ensureEmbeddedEthereumWallet(client, fresh);
  assert.equal(result.wallet.id, "wallet_recovered_fixture");
  assert.equal(page.created.length, 0);
  assert.equal(page.frames.length, 0);
});

it("blocks malformed linked wallets without creating a replacement or claiming the login expired", async () => {
  for (const address of ["", "0xinvalid"]) {
    const user = withEmbeddedWallet(newPrivyUser());
    Object.assign(user.linkedAccounts[1], { address });
    const page = consentPage(
      await consentHtml(),
      new Map(),
      "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
      { user },
    );
    await page.callback;
    assert.equal(page.created.length, 0);
    assert.equal(page.approved.length, 0);
    assert.match(
      page.elements.get("status").textContent,
      /wallet details could not be verified/,
    );
    assert.doesNotMatch(page.elements.get("status").textContent, /expired/);
  }
});

it("checks for a wallet after an unknown creation response and retries without a second wallet", async () => {
  const fresh = newPrivyUser();
  let page: ReturnType<typeof consentPage>;
  page = consentPage(
    await consentHtml(),
    new Map([["ride:auth:provider", "APPLE"]]),
    "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
    {
      user: fresh,
      create: async () => {
        page.setUser(withEmbeddedWallet(fresh));
        throw Error("Operation reached timeout");
      },
    },
  );
  await page.callback;
  assert.equal(page.created.length, 1);
  assert.equal(page.approved.length, 0);
  assert.match(
    page.elements.get("status").textContent,
    /wallet setup could not be verified/,
  );
  assert.doesNotMatch(
    page.elements.get("status").textContent,
    /expired|account has not been changed/,
  );
  assert.equal(page.elements.get("wallet-setup-retry").hidden, false);
  await page.elements.get("wallet-setup-retry").listeners.click();
  assert.equal(page.created.length, 1);
  assert.equal(page.completed.length, 1);
  assert.equal(page.approved.length, 1);
  assert.equal(
    page.approved[0].wallet_address,
    "0x3333333333333333333333333333333333333333",
  );
});

it("deduplicates concurrent setup and keeps the idempotency key stable across a renewed session", async () => {
  const fresh = newPrivyUser();
  let complete: (value: any) => void = () => {};
  let first = true;
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize",
    {
      user: fresh,
      create: async () => {
        if (first)
          return new Promise((resolve) => {
            complete = resolve;
          });
        return { user: withEmbeddedWallet(fresh) };
      },
    },
  );
  await page.callback;
  const client = await page.auth.initPrivy();
  const one = page.auth.ensureEmbeddedEthereumWallet(client, fresh);
  const two = page.auth.ensureEmbeddedEthereumWallet(client, fresh);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.created.length, 1);
  complete({ user: withEmbeddedWallet(fresh) });
  await Promise.all([one, two]);
  first = false;
  page.setToken("renewed-session-fixture-token");
  await page.auth.ensureEmbeddedEthereumWallet(client, fresh);
  assert.equal(page.created.length, 2);
  assert.equal(page.created[0].idempotencyKey, page.created[1].idempotencyKey);
  assert.equal(page.frames[0].removed, true);
});

it("discards stale setup results when identity changes and isolates the next user's wallet", async () => {
  const original = newPrivyUser("did:privy:original-fixture");
  const other = newPrivyUser("did:privy:other-fixture");
  let complete: (value: any) => void = () => {};
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize",
    {
      user: original,
      create: async (input) =>
        input.idempotencyKey.endsWith(original.id)
          ? new Promise((resolve) => {
              complete = resolve;
            })
          : { user: withEmbeddedWallet(other) },
    },
  );
  await page.callback;
  const finishing = page.auth.finishPrivySession({ user: original }, "APPLE");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.created.length, 1);
  page.setUser(other);
  page.setToken("other-session-token");
  complete({ user: withEmbeddedWallet(original) });
  await assert.rejects(finishing, /account changed during wallet setup/);
  assert.equal(page.approved.length, 0);
  assert.equal(page.frames[0].removed, true);
  await page.auth.finishPrivySession({ user: other }, "GOOGLE");
  assert.equal(page.created.length, 2);
  assert.notEqual(
    page.created[0].idempotencyKey,
    page.created[1].idempotencyKey,
  );
  assert.equal(page.approved.length, 1);
  assert.equal(page.approved[0].privy_id, other.id);
});

it("accepts wallet frame messages only from its exact secure origin and content window", async () => {
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
    { user: newPrivyUser() },
  );
  await page.callback;
  const frame = page.frames[0];
  const handlers = page.windowListeners.get("message")!;
  const message = { id: "fixture", event: "privy:iframe:ready", data: {} };
  for (const handler of handlers) {
    handler({
      source: frame.contentWindow,
      origin: "https://attacker.test",
      data: message,
    });
    handler({ source: {}, origin: "https://auth.privy.test", data: message });
    handler({
      source: frame.contentWindow,
      origin: "https://auth.privy.test",
      data: "invalid json",
    });
  }
  assert.equal(page.walletMessages.length, 0);
  for (const handler of handlers)
    handler({
      source: frame.contentWindow,
      origin: "https://auth.privy.test",
      data: JSON.stringify(message),
    });
  assert.deepEqual(JSON.parse(JSON.stringify(page.walletMessages)), [message]);
});

it("cleans up a failed secure frame and retries setup without restarting OAuth", async () => {
  let pingCount = 0;
  const page = consentPage(
    await consentHtml(),
    new Map(),
    "https://ride.test/authorize?privy_oauth_code=code&privy_oauth_state=state",
    {
      user: newPrivyUser(),
      ping: async () => pingCount++ > 0,
    },
  );
  await page.callback;
  assert.equal(page.created.length, 0);
  assert.equal(page.approved.length, 0);
  assert.equal(page.frames[0].removed, true);
  assert.equal(page.windowListeners.get("message")!.size, 0);
  await page.elements.get("wallet-setup-retry").listeners.click();
  assert.equal(page.frames.length, 2);
  assert.equal(page.created.length, 1);
  assert.equal(page.completed.length, 1);
  assert.equal(page.approved.length, 1);
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

  it("preserves typed registration, authentication and service failures on OAuth approval", async () => {
    for (const error of [
      new AgentError(
        "USER_REGISTRATION_DISABLED",
        "New account registration is temporarily unavailable.",
        false,
        403,
      ),
      new AgentError(
        "AUTH_SERVICE_UNAVAILABLE",
        "Sign-in is temporarily unavailable.",
        true,
        503,
      ),
      new AgentError("AUTH_REQUIRED", "Sign in again.", false, 401),
    ]) {
      const provider = createProvider(() => {
        throw error;
      });
      await provider.clientsStore.registerClient!(client);
      const baseUrl = await startApprovalServer(provider);
      const response = await fetch(`${baseUrl}/auth/privy/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          code_challenge: "challenge",
          privy_id: "did:privy:fixture",
          privy_access_token: "fixture-token",
        }),
      });
      assert.equal(response.status, error.httpStatus);
      assert.deepEqual(await response.json(), {
        error: "authorization_failed",
        code: error.code,
        retryable: error.retryable,
        message: error.message,
      });
    }
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
