import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  style = {};
  disabled = false;
  hidden = false;
  id = "";
  value = "";
  className = "";
  textContent = "";
  onclick?: () => Promise<void>;
  listeners: Record<string, () => void> = {};
  constructor(public tag: string) {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  addEventListener(name: string, handler: () => void) {
    this.listeners[name] = handler;
  }
  setAttribute() {}
  remove() {}
  querySelectorAll(selector: string): Element[] {
    const matches = (n: Element) =>
      selector.startsWith('[data-action="')
        ? n.dataset.action === selector.slice(14, -2)
        : selector.split(",").includes(n.tag);
    return this.children.flatMap((n) => [
      ...(matches(n) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

async function fixture(
  options: {
    expired?: boolean;
    serverExpired?: boolean;
    lost?: boolean;
    embedded?: boolean;
    signature?: boolean;
    provider?: string;
    oauthCallback?: boolean;
  } = {},
) {
  const ids = Object.fromEntries(
    ["status", "content", "login", "sign-in", "sign-in-apple"].map((id) => [
      id,
      new Element("div"),
    ]),
  );
  let funding: any = {
    id: "funding_fixture_12345678",
    deposit_id: "deposit_" + "a".repeat(32),
    amount_usdc: "30.000000",
    account_suffix: "877f1d",
    status: "requires_confirmation",
    preview_hash: "a".repeat(64),
    expires_at: Date.now() + (options.expired ? -1000 : 300000),
    requires_signature: !!options.signature,
    signing_challenge: { private: "never send into host context" },
  };
  const calls: string[] = [],
    messages: any[] = [],
    listeners: any[] = [];
  const source = readFileSync("public/fund-view.js", "utf8").replace(
    "const query = new URL(location.href).searchParams;",
    "if (globalThis.authClient) client = globalThis.authClient; const query = new URL(location.href).searchParams;",
  );
  const stored = new Map<string, string>(
    options.provider ? [["ride:auth:provider", options.provider]] : [],
  );
  const oauthCalls: any[] = [];
  const user = {
    id: "did:privy:fixture",
    linkedAccounts: [
      {
        type: "wallet",
        chainType: "ethereum",
        walletClientType: "privy",
        address: "0xfixture",
        id: "fixture_wallet",
      },
    ],
  };
  const authClient = {
    user: { get: async () => ({ user }) },
    getAccessToken: async () => "fixture-token",
    auth: {
      oauth: {
        generateURL: async (...args: any[]) => {
          oauthCalls.push(["generateURL", ...args]);
          return { url: "https://auth.privy.test/start" };
        },
        loginWithCode: async (...args: any[]) => {
          oauthCalls.push(["loginWithCode", ...args]);
          return { user };
        },
      },
    },
  };
  const opened: string[] = [],
    bodies: any[] = [],
    intervals: Array<() => void> = [];
  const popup = {
    closed: false,
    close() {
      this.closed = true;
    },
  };
  const api = await vm.runInNewContext(
    `(async () => { ${source}\nreturn { display, check, getFunding: () => funding, setAuthClient: (c) => { client = c; } }; })()`,
    {
      config: { deposit_id: funding.deposit_id, embedded: options.embedded },
      authClient: options.oauthCallback ? authClient : undefined,
      document: {
        getElementById: (id: string) =>
          ids[id] ??
          ids.content.querySelectorAll("input").find((n) => n.id === id),
        createElement: (tag: string) => new Element(tag),
        body: new Element("body"),
      },
      window: {
        parent: { postMessage: (m: any) => messages.push(m) },
        open(url: string) {
          opened.push(url);
          return popup;
        },
        addEventListener: (_: string, h: any) => listeners.push(h),
      },
      URL,
      URLSearchParams,
      crypto: webcrypto,
      AbortSignal,
      Date,
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: (callback: () => void) => intervals.push(callback),
      clearInterval() {},
      history: { replaceState() {} },
      location: {
        href:
          "https://ride.test/agent/fund/" +
          funding.deposit_id +
          (options.oauthCallback
            ? "?privy_oauth_code=fixture-code&privy_oauth_state=fixture-state"
            : ""),
        origin: "https://ride.test",
        assign: (url: string) => opened.push(url),
      },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      fetch: async (path: string, request: any) => {
        const operation = path.split("/").at(-1)!;
        bodies.push({ operation, ...JSON.parse(request.body) });
        calls.push(operation);
        if (operation === "login")
          return { ok: true, json: async () => ({ csrf: "fixture-csrf" }) };
        if (operation === "session")
          return { ok: true, json: async () => ({ csrf: "fixture-csrf" }) };
        if (operation === "funding_confirm") {
          if (options.lost)
            throw Error("Connection lost after possible broadcast");
          if (options.serverExpired)
            return {
              ok: false,
              json: async () => ({
                error: {
                  code: "FUNDING_QUOTE_EXPIRED",
                  message: "Review a fresh funding quote.",
                },
              }),
            };
          funding = {
            ...funding,
            status: "submitted",
            transaction_hash: "fixture-receipt",
          };
        }
        if (operation === "funding_prepare")
          funding = {
            ...funding,
            preview_hash: "b".repeat(64),
            expires_at: Date.now() + 300000,
          };
        return {
          ok: true,
          json: async () =>
            operation === "funding_status"
              ? {
                  data: {
                    deposit_status: {
                      funding_status: funding.status,
                      trading_balance_usdc: "5",
                      wallet_balance_usdc: "30",
                    },
                  },
                }
              : { data: { funding: structuredClone(funding) } },
        };
      },
    },
  );
  const action = (name: string) =>
    ids.content.querySelector(`[data-action="${name}"]`)!;
  return {
    ...api,
    ids,
    calls,
    messages,
    action,
    opened,
    bodies,
    stored,
    oauthCalls,
    authClient,
    closeWallet() {
      popup.close();
      intervals.at(-1)?.();
    },
    async signature(overrides: any = {}) {
      const params = new URLSearchParams(new URL(opened.at(-1)!).hash.slice(1));
      const event = {
        source: popup,
        origin: "https://ride.test",
        data: {
          type: "ride:funding-signature",
          deposit_id: funding.deposit_id,
          challenge: params.get("challenge"),
          preview_hash: params.get("preview_hash"),
          signature: "0x" + "a".repeat(130),
        },
        ...overrides,
      };
      for (const listener of listeners) await listener(event);
    },
  };
}

it("restores the human cookie before loading a wallet SDK and requires a fresh explicit approval after expiry", async () => {
  const f = await fixture({ expired: true });
  assert.equal(f.ids.login.hidden, true);
  assert.equal(f.action("confirm-funding").disabled, true);
  assert.match(f.ids.status.textContent, /expired.*Refresh/);
  await f.action("confirm-funding").onclick!();
  assert(!f.calls.includes("funding_confirm"));
  await f.action("refresh-quote").onclick!();
  assert.equal(f.action("confirm-funding").disabled, false);
  assert.match(f.ids.status.textContent, /Fresh quote ready/);
  assert(!f.calls.includes("funding_confirm"));
  await f.action("confirm-funding").onclick!();
  assert.equal(
    f.calls.filter((x: string) => x === "funding_confirm").length,
    1,
  );
  assert.match(f.ids.status.textContent, /submitted.*pending/);
});

it("server expiry stops stale confirmation and offers renewal without submitting a fresh quote", async () => {
  const f = await fixture({ serverExpired: true });
  await f.action("confirm-funding").onclick!();
  assert.equal(f.action("confirm-funding").disabled, true);
  assert.equal(f.action("refresh-quote").disabled, false);
  assert.match(f.ids.status.textContent, /expired/);
  assert.equal(
    f.calls.filter((x: string) => x === "funding_prepare").length,
    0,
  );
});

it("a lost submission response locks both approval and renewal; a read of the unchanged quote cannot resubmit", async () => {
  const f = await fixture({ lost: true });
  await Promise.all([
    f.action("confirm-funding").onclick!(),
    f.action("confirm-funding").onclick!(),
  ]);
  await f.check();
  assert.equal(f.action("confirm-funding").disabled, true);
  assert.equal(f.action("refresh-quote").disabled, true);
  await f.action("confirm-funding").onclick!();
  assert.equal(
    f.calls.filter((x: string) => x === "funding_confirm").length,
    1,
  );
  assert.match(f.ids.status.textContent, /unverified/);
});

it("starts Apple and Google funding sign-in and preserves the chosen provider on callback without submitting funds", async () => {
  for (const provider of ["GOOGLE", "APPLE"]) {
    const f = await fixture();
    f.setAuthClient(f.authClient);
    await f.ids[provider === "APPLE" ? "sign-in-apple" : "sign-in"].onclick!();
    assert.equal(f.stored.get("ride:auth:provider"), provider);
    assert.deepEqual(f.oauthCalls[0], [
      "generateURL",
      provider.toLowerCase(),
      "https://ride.test/auth/privy/oauth/callback",
    ]);
    const callback = await fixture({ provider, oauthCallback: true });
    assert.deepEqual(callback.oauthCalls[0], [
      "loginWithCode",
      "fixture-code",
      "fixture-state",
      provider.toLowerCase(),
    ]);
    assert.equal(
      callback.bodies.find((b: any) => b.operation === "login").authProvider,
      provider,
    );
    assert(!callback.calls.includes("funding_confirm"));
    assert(!callback.calls.includes("funding_activate"));
  }
  const html = readFileSync("public/fund.html", "utf8");
  assert.doesNotMatch(
    html.split('<script type="module">')[0],
    /access-code|Access code/,
  );
  assert.match(html.split('<script type="module">')[0], /sign-in-apple/);
});
