import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  style = {};
  hidden = false;
  disabled = false;
  id = "";
  value = "";
  textContent = "";
  src = "";
  onclick?: () => Promise<void>;
  posted: Array<{ data: string; origin: string }> = [];
  contentWindow = {
    postMessage: (data: string, origin: string) =>
      this.posted.push({ data, origin }),
  };
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
    const match = (n: Element) =>
      selector.startsWith('[data-action="')
        ? n.dataset.action === selector.slice(14, -2)
        : selector.startsWith('[id="')
          ? n.id === selector.slice(5, -2)
          : selector.split(",").includes(n.tag);
    return this.children.flatMap((n) => [
      ...(match(n) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(signatureTimeout = false) {
  const ids = Object.fromEntries(
    ["content", "status", "login", "sign-in", "access-code"].map((id) => [
      id,
      new Element("div"),
    ]),
  );
  const body = new Element("body"),
    listeners: Array<(e: any) => unknown> = [],
    timers = new Map<number, { callback: () => void; ms: number }>();
  let timerId = 0,
    pings = 0,
    providers = 0,
    signatures = 0,
    submits = 0,
    reloads = 0,
    pingResult: ((ready: boolean) => void) | undefined,
    poster: any;
  const address = "0x" + "5".repeat(40);
  let funding: any = {
    id: "funding_wallet_fixture",
    deposit_id: "deposit_" + "a".repeat(32),
    amount_usdc: "5.000000",
    status: "requires_confirmation",
    account_suffix: "555555",
    expires_at: Date.now() + 300000,
    preview_hash: "a".repeat(64),
    requires_signature: true,
    signing_challenge: {
      primaryType: "Permit",
      domain: {
        chainId: 42161,
        verifyingContract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      },
      message: {
        owner: address,
        spender: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
        value: "5000000",
      },
    },
  };
  const wallet = {
    type: "wallet",
    chain_type: "ethereum",
    wallet_client_type: "privy",
    address,
  };
  class Privy {
    constructor(options: any) {
      poster = options.embeddedWalletMessagePoster;
    }
    initialize = async () => {};
    user = { get: async () => ({ user: { linked_accounts: [wallet] } }) };
    embeddedWallet = {
      getURL: () => "https://wallet.test/embedded-wallets",
      ping: async (_timeout: number) => {
        pings++;
        poster.postMessage(
          JSON.stringify({
            id: "ping-" + pings,
            event: "privy:iframe:ready",
            data: {},
          }),
          "*",
        );
        return new Promise<boolean>((resolve) => {
          pingResult = resolve;
        });
      },
      onMessage: (event: any) => {
        if (
          event.id === "ping-" + pings &&
          event.event === "privy:iframe:ready"
        )
          pingResult?.(true);
      },
      reload: () => {
        reloads++;
        poster.reload();
      },
      getProvider: async () => {
        providers++;
        return {
          request: async () => {
            signatures++;
            if (signatureTimeout)
              throw Error("Operation reached timeout: user-signer:sign");
            return "0x" + "b".repeat(130);
          },
        };
      },
    };
  }
  const source = readFileSync("public/fund-view.js", "utf8").replace(
    "await import(config.privy_sdk)",
    "await testLoadSdk()",
  );
  const api = await vm.runInNewContext(
    `(async()=>{${source}\nreturn {init, sign, getFunding:()=>funding};})()`,
    {
      config: { deposit_id: funding.deposit_id, embedded: false },
      testLoadSdk: async () => ({ default: Privy, LocalStorage: class {} }),
      document: {
        body,
        createElement: (tag: string) => new Element(tag),
        getElementById: (id: string) =>
          ids[id] ?? ids.content.querySelector(`[id="${id}"]`),
      },
      window: {
        addEventListener: (_: string, handler: any) => listeners.push(handler),
        removeEventListener() {},
      },
      location: {
        origin: "https://ride.test",
        href: "https://ride.test/agent/fund/" + funding.deposit_id,
      },
      sessionStorage: {
        getItem() {
          return null;
        },
        removeItem() {},
      },
      URL,
      URLSearchParams,
      Date,
      AbortSignal,
      crypto: webcrypto,
      setTimeout: (callback: () => void, ms: number) => {
        timers.set(++timerId, { callback, ms });
        return timerId;
      },
      clearTimeout: (id: number) => timers.delete(id),
      setInterval: () => 1,
      clearInterval() {},
      fetch: async (path: string) => {
        const operation = path.split("/").at(-1);
        if (operation === "session")
          return { ok: true, json: async () => ({ csrf: "fixture" }) };
        if (operation === "funding_confirm") {
          submits++;
          funding = { ...funding, status: "submitted" };
        }
        return {
          ok: true,
          json: async () =>
            operation === "funding_status"
              ? {
                  data: {
                    deposit_status: {
                      wallet_balance_usdc: "5",
                      trading_balance_usdc: "36",
                    },
                  },
                }
              : { data: { funding: structuredClone(funding) } },
        };
      },
    },
  );
  await api.init();
  await tick();
  const frame = body.querySelector("iframe")!;
  assert(frame, "wallet initialization should prewarm a frame without signing");
  const action = (name: string) =>
    ids.content.querySelector(`[data-action="${name}"]`)!;
  return {
    ...api,
    ids,
    frame,
    action,
    counts: () => ({ pings, providers, signatures, submits, reloads }),
    async load() {
      frame.listeners.load();
      await tick();
    },
    async reply(overrides: any = {}) {
      const event = {
        origin: "https://wallet.test",
        source: frame.contentWindow,
        data: JSON.stringify({
          id: "ping-" + pings,
          event: "privy:iframe:ready",
          data: {},
        }),
        ...overrides,
      };
      for (const l of listeners) await l(event);
      await tick();
    },
    async timeoutLoad() {
      const t = [...timers.values()].find((t) => t.ms === 45000);
      assert(t);
      t.callback();
      await tick();
    },
  };
}

it("waits for frame load and an origin-bound ready response before enabling funding; no signature is requested during connection", async () => {
  const f = await fixture();
  assert.equal(f.action("confirm-funding").disabled, true);
  assert.deepEqual(f.counts(), {
    pings: 0,
    providers: 0,
    signatures: 0,
    submits: 0,
    reloads: 0,
  });
  await f.load();
  assert.equal(f.counts().pings, 1);
  assert.equal(f.frame.posted[0].origin, "https://wallet.test");
  await f.reply({ origin: "https://evil.test" });
  await f.reply({ source: {} });
  assert.equal(f.action("confirm-funding").disabled, true);
  await f.reply();
  assert.equal(f.action("confirm-funding").disabled, false);
  assert.equal(f.counts().signatures, 0);
  await f.action("confirm-funding").onclick!();
  assert.equal(f.counts().signatures, 1);
  assert.equal(f.counts().submits, 1);
});

it("a frame load timeout leaves funding unsubmitted and an explicit reconnect can restore readiness without signing", async () => {
  const f = await fixture();
  await f.timeoutLoad();
  assert.equal(f.action("confirm-funding").disabled, true);
  assert.match(f.ids.status.textContent, /Secure wallet could not load/);
  const retry = f.action("connect-wallet").onclick!();
  await tick();
  await f.load();
  await f.reply();
  await retry;
  assert.equal(f.action("confirm-funding").disabled, false);
  assert.deepEqual(f.counts(), {
    pings: 1,
    providers: 0,
    signatures: 0,
    submits: 0,
    reloads: 1,
  });
});

it("expiry during wallet connection still requires quote renewal and never requests a signature", async () => {
  const f = await fixture();
  await f.load();
  f.getFunding().expires_at = 0;
  await f.reply();
  assert.equal(f.action("confirm-funding").disabled, true);
  await assert.rejects(
    f.sign(f.getFunding().signing_challenge),
    /quote expired/i,
  );
  assert.equal(f.counts().providers, 0);
  assert.equal(f.counts().submits, 0);
});

it("a signer timeout requires a fresh wallet connection and never retries signing or submits funds automatically", async () => {
  const f = await fixture(true);
  await f.load();
  await f.reply();
  await f.action("confirm-funding").onclick!();
  assert.equal(f.action("confirm-funding").disabled, true);
  assert.match(
    f.ids.status.textContent,
    /signing timed out before a funding submission/,
  );
  assert.equal(f.counts().signatures, 1);
  assert.equal(f.counts().submits, 0);
  const retry = f.action("connect-wallet").onclick!();
  await tick();
  await f.load();
  await f.reply();
  await retry;
  assert.equal(f.action("confirm-funding").disabled, false);
  assert.equal(f.counts().signatures, 1);
  assert.equal(f.counts().submits, 0);
});
