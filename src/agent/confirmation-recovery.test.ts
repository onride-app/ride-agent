import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const proposalId = "proposal_fixture_12345678";
const origin = "https://ride.test";
const baseUrl = `${origin}/agent/confirm/${proposalId}`;
const response = (payload: unknown, httpStatus = 200) => ({
  ok: httpStatus >= 200 && httpStatus < 300,
  status: httpStatus,
  json: async () => structuredClone(payload),
});
const denied = (code = "AUTH_REQUIRED", httpStatus = 401) =>
  response(
    { error: { code, message: `${code} fixture rejection` } },
    httpStatus,
  );
const ownedProposal = (patch: Record<string, unknown> = {}) => ({
  data: {
    proposal: {
      id: proposalId,
      expires_at: Date.now() + 10 * 60_000,
      status: "requires_confirmation",
      execution_state: "not_submitted",
      preview_hash: "fixture-preview-hash",
      ...patch,
    },
  },
});

class Element {
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  children: Element[] = [];
  parentElement?: Element;
  onclick?: () => Promise<void> | void;
  constructor(readonly tag = "div") {}
  append(...children: Element[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (c) => c !== this,
      );
  }
  querySelectorAll(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  querySelector(tag: string) {
    return this.querySelectorAll(tag)[0];
  }
  get firstElementChild() {
    return this.children[0];
  }
}

type Request = {
  operation: string;
  body: any;
  headers: Record<string, string>;
};
async function fixture(
  options: {
    href?: string;
    embedded?: boolean;
    opener?: { postMessage: (message: any, target: string) => void } | null;
    provider?: string;
    storedUser?: boolean;
    route?: (request: Request) => any;
  } = {},
) {
  const elements = new Map<string, Element>();
  for (const id of [
    "status",
    "content",
    "login",
    "actions",
    "sign-in",
    "sign-in-apple",
    "approve",
    "reject",
  ])
    elements.set(
      id,
      new Element(
        ["sign-in", "sign-in-apple", "approve", "reject"].includes(id)
          ? "button"
          : "div",
      ),
    );
  elements
    .get("login")!
    .append(
      new Element("h1"),
      new Element("p"),
      elements.get("sign-in")!,
      elements.get("sign-in-apple")!,
    );
  elements
    .get("actions")!
    .append(elements.get("approve")!, elements.get("reject")!);
  const requests: Request[] = [],
    navigations: string[] = [],
    opened: string[] = [],
    rendered: any[] = [],
    announcements: any[] = [];
  const providerCalls: any[] = [],
    listeners = new Map<string, (event: any) => Promise<void>>();
  const storage = new Map<string, string>(
    options.provider ? [["ride:auth:provider", options.provider]] : [],
  );
  const location = {
    href: options.href ?? baseUrl,
    origin,
    assign(url: string) {
      navigations.push(url);
      this.href = url;
    },
  };
  const popup = {
    closed: false,
    focuses: 0,
    close() {
      this.closed = true;
    },
    focus() {
      this.focuses++;
    },
  };
  const user = {
    id: "fixture-owner",
    linkedAccounts: [
      {
        type: "wallet",
        chainType: "ethereum",
        walletClientType: "privy",
        address: "fixture-wallet",
        id: "fixture-wallet-id",
      },
    ],
  };
  class Privy {
    initialize = async () => {};
    user = {
      get: async () => ({ user: options.storedUser === false ? null : user }),
    };
    getAccessToken = async () => "fixture-privy-token";
    auth = {
      oauth: {
        generateURL: async (provider: string, redirect: string) => {
          providerCalls.push(["generate", provider, redirect]);
          return { url: `https://auth.test/${provider}` };
        },
        loginWithCode: async (...args: string[]) => {
          providerCalls.push(["callback", ...args]);
          return { user };
        },
      },
    };
  }
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Date,
    AbortSignal,
    crypto: webcrypto,
    location,
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        location.href = url;
      },
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: {
      getElementById: (id: string) => elements.get(id),
      body: { scrollHeight: 600 },
    },
    window: {
      opener: options.opener ?? null,
      parent: { postMessage: (value: any) => announcements.push(value) },
      addEventListener: (name: string, listener: any) =>
        listeners.set(name, listener),
      open: (url: string) => {
        opened.push(url);
        return popup;
      },
    },
    __loadPrivy: async () => ({ default: Privy, LocalStorage: class {} }),
    fetch: async (url: string, input: any) => {
      const request = {
        operation: url.split("/").at(-1)!,
        body: JSON.parse(input.body),
        headers: input.headers,
      };
      requests.push(request);
      const overridden = options.route?.(request);
      if (overridden !== undefined) return await overridden;
      if (request.operation === "session")
        return response({ csrf: "fixture-csrf" });
      if (request.operation === "login")
        return response({ csrf: "fixture-csrf" });
      if (request.operation === "proposal") return response(ownedProposal());
      throw Error(`Unexpected operation: ${request.operation}`);
    },
    render: (_target: Element, value: any) => {
      rendered.push(structuredClone(value));
      elements.get("content")!.replaceChildren(new Element("section"));
    },
    el: (tag: string, text: string, cls: string) => {
      const element = new Element(tag);
      element.textContent = text;
      element.className = cls;
      return element;
    },
    card: () => new Element(),
    row: () => new Element(),
  });
  const source = readFileSync("public/confirm-host.js", "utf8")
    .replace(
      "const config = /*CONFIG*/ {};",
      `const config = ${JSON.stringify({ proposal_id: proposalId, embedded: !!options.embedded, privy_app_id: "fixture", privy_sdk: "fixture-sdk" })};`,
    )
    .replace("await import(config.privy_sdk)", "await globalThis.__loadPrivy()")
    .replace(/start\(\);\s*$/, "globalThis.__started = start();");
  vm.runInContext(source, context);
  await (context as any).__started;
  return {
    requests,
    navigations,
    opened,
    rendered,
    announcements,
    providerCalls,
    storage,
    location,
    popup,
    node: (id: string) => elements.get(id)!,
    click: async (id: string) => {
      await elements.get(id)!.onclick?.();
    },
    refresh: async () => {
      const button = elements
        .get("content")!
        .querySelectorAll("button")
        .find((b) => /Refresh this proposal/.test(b.textContent));
      assert.ok(button);
      await button.onclick?.();
    },
    receive: async (data: any, source: any = popup) =>
      listeners.get("message")?.({ origin, source, data }),
  };
}

it("lost popup opener or challenge recovers the exact owned proposal in the current page without another jump or submission", async () => {
  for (const href of [
    `${baseUrl}?card_login=1#challenge=${"a".repeat(64)}`,
    `${baseUrl}?card_login=1`,
  ]) {
    const f = await fixture({
      href,
      opener: href.includes("#")
        ? null
        : {
            postMessage() {
              throw Error("Invalid challenge must not hand off");
            },
          },
    });
    assert.equal(f.node("login").hidden, true);
    assert.equal(f.node("actions").hidden, false);
    assert.equal(f.node("approve").disabled, false);
    assert.match(
      f.node("status").textContent,
      /Review and confirm this same proposal here/,
    );
    assert.equal(f.location.href, baseUrl);
    assert.equal(
      f.requests.filter((r) => r.operation === "proposal").length,
      1,
    );
    assert.equal(
      f.requests.every((r) => ["session", "proposal"].includes(r.operation)),
      true,
    );
    assert.equal(
      f.requests.find((r) => r.operation === "proposal")!.body.proposal_id,
      proposalId,
    );
    assert.equal(f.opened.length, 0);
    assert.equal(f.navigations.length, 0);
  }
});

it("a lost handoff never reveals or enables a proposal belonging to another account", async () => {
  const f = await fixture({
    href: `${baseUrl}?card_login=1`,
    route: (r) =>
      r.operation === "proposal" ? denied("NOT_FOUND", 404) : undefined,
  });
  assert.equal(f.node("login").hidden, false);
  assert.equal(f.node("actions").hidden, true);
  assert.equal(f.rendered.length, 0);
  assert.match(f.node("status").textContent, /account that created it/);
  assert.equal(
    f.requests.some((r) => ["confirm", "reject"].includes(r.operation)),
    false,
  );
});

it("a failed chat handoff still allows the authenticated owned proposal to be reviewed in the same window", async () => {
  let posted = false;
  const f = await fixture({
    href: `${baseUrl}?card_login=1#challenge=${"a".repeat(64)}`,
    opener: {
      postMessage() {
        posted = true;
      },
    },
    route: (r) =>
      r.operation === "embed-ticket"
        ? response(
            {
              error: { code: "INTERNAL_ERROR", message: "handoff unavailable" },
            },
            503,
          )
        : undefined,
  });
  assert.equal(posted, false);
  assert.equal(f.node("actions").hidden, false);
  assert.equal(f.node("approve").disabled, false);
  assert.equal(f.location.href, baseUrl);
  assert.equal(f.requests.filter((r) => r.operation === "proposal").length, 1);
  assert.equal(
    f.requests.some((r) => r.operation === "confirm"),
    false,
  );
  assert.equal(f.opened.length, 0);
});

it("an unknown submit is never repeated automatically and a queued read hides approval", async () => {
  let attempts = 0;
  const f = await fixture({
    route: (r) => {
      if (r.operation === "confirm") {
        attempts++;
        throw Error("Load failed");
      }
      if (r.operation === "proposal" && attempts)
        return response(
          ownedProposal({ status: "queued", execution_state: "queued" }),
        );
    },
  });
  await f.click("approve");
  await f.click("approve");
  assert.equal(attempts, 1);
  assert.match(f.node("status").textContent, /result is not yet verified/);
  await f.refresh();
  assert.equal(attempts, 1);
  assert.equal(f.node("actions").hidden, true);
  assert.match(f.node("status").textContent, /Processing is queued/);
  assert.doesNotMatch(f.node("status").textContent, /trading is active/i);
  assert.equal(
    f.requests.every(
      (r) => !r.body.proposal_id || r.body.proposal_id === proposalId,
    ),
    true,
  );
});

it("a verified not-submitted read unlocks only an explicit retry of the same proposal", async () => {
  let attempts = 0;
  const f = await fixture({
    route: (r) => {
      if (r.operation === "confirm") {
        attempts++;
        if (attempts === 1) throw Error("network lost");
        return response(
          ownedProposal({ status: "queued", execution_state: "queued" }),
        );
      }
    },
  });
  await f.click("approve");
  assert.equal(f.node("approve").disabled, true);
  await f.refresh();
  assert.equal(attempts, 1);
  assert.equal(f.node("approve").disabled, false);
  assert.match(f.node("status").textContent, /has not been submitted/);
  await f.click("approve");
  assert.equal(attempts, 2);
  assert.equal(f.node("actions").hidden, true);
  assert.deepEqual(
    f.requests.filter((r) => r.operation === "confirm").map((r) => r.body),
    [
      { proposal_id: proposalId, preview_hash: "fixture-preview-hash" },
      { proposal_id: proposalId, preview_hash: "fixture-preview-hash" },
    ],
  );
});

it("an unknown result stays blocked if an older read cannot verify its execution state", async () => {
  let attempted = false;
  const f = await fixture({
    route: (r) => {
      if (r.operation === "confirm") {
        attempted = true;
        throw Error("network lost");
      }
      if (r.operation === "proposal" && attempted)
        return response(ownedProposal({ execution_state: undefined }));
    },
  });
  await f.click("approve");
  await f.refresh();
  assert.equal(f.node("approve").disabled, true);
  await f.click("approve");
  assert.equal(f.requests.filter((r) => r.operation === "confirm").length, 1);
  assert.match(f.node("status").textContent, /not yet verified/);
});

it("explicit auth, CSRF and validation rejections recover after an owned read without being called unknown submissions", async () => {
  for (const [code, httpStatus] of [
    ["AUTH_REQUIRED", 401],
    ["CSRF_REQUIRED", 403],
    ["INVALID_INPUT", 400],
  ] as const) {
    let attempts = 0;
    const f = await fixture({
      route: (r) =>
        r.operation === "confirm"
          ? (attempts++, denied(code, httpStatus))
          : undefined,
    });
    await f.click("approve");
    assert.equal(attempts, 1);
    assert.doesNotMatch(
      f.node("status").textContent,
      /result is not yet verified/,
    );
    assert.match(
      f.node("status").textContent,
      code === "INVALID_INPUT"
        ? /request was rejected/
        : /sign-in session expired/,
    );
    await f.refresh();
    assert.equal(attempts, 1);
    assert.equal(f.node("approve").disabled, false);
    assert.equal(f.node("login").hidden, true);
  }
});

it("an HTTP 200 error result is never shown as a successful confirmation", async () => {
  const f = await fixture({
    route: (r) =>
      r.operation === "confirm"
        ? response({
            error: {
              code: "AUTH_REQUIRED",
              message: "authentication rejected",
            },
          })
        : undefined,
  });
  await f.click("approve");
  assert.equal(f.node("login").hidden, false);
  assert.equal(f.node("actions").hidden, true);
  assert.match(f.node("status").textContent, /sign-in session expired/);
  assert.doesNotMatch(f.node("status").textContent, /Processing is queued/);
  assert.equal(f.rendered.length, 1);
});

it("Apple sign-in and its callback use the same stored provider and never submit a proposal", async () => {
  const f = await fixture({
    storedUser: false,
    route: (r) => (r.operation === "session" ? denied() : undefined),
  });
  await f.click("sign-in-apple");
  assert.deepEqual(f.providerCalls, [
    ["generate", "apple", `${origin}/auth/privy/oauth/callback`],
  ]);
  assert.equal(f.storage.get("ride:auth:provider"), "APPLE");
  assert.deepEqual(f.navigations, ["https://auth.test/apple"]);
  const callback = await fixture({
    href: `${baseUrl}?privy_oauth_code=code&privy_oauth_state=state`,
    provider: "APPLE",
  });
  assert.deepEqual(callback.providerCalls, [
    ["callback", "code", "state", "apple"],
  ]);
  assert.equal(
    callback.requests.find((r) => r.operation === "login")!.body.authProvider,
    "APPLE",
  );
  assert.equal(
    callback.requests.some((r) => r.operation === "confirm"),
    false,
  );
  assert.equal(callback.node("actions").hidden, false);
});

it("a card opens at most one sign-in window and retains it when partitioned cookies fail", async () => {
  const f = await fixture({
    embedded: true,
    route: (r) => {
      if (r.operation === "session") return denied();
      if (r.operation === "embed-session")
        return response({ csrf: "embedded-csrf" });
    },
  });
  await f.click("sign-in");
  await f.click("sign-in");
  assert.equal(f.opened.length, 1);
  const url = new URL(f.opened[0]);
  assert.equal(url.searchParams.get("auth_provider"), "GOOGLE");
  await f.receive({
    type: "ride:human-session",
    ticket: "fixture-ticket",
    challenge: new URLSearchParams(url.hash.slice(1)).get("challenge"),
    proposal_id: proposalId,
  });
  assert.equal(f.popup.closed, false);
  assert.equal(f.node("actions").hidden, true);
  assert.match(f.node("status").textContent, /Continue in the Ride window/);
  assert.equal(
    f.requests.some((r) => r.operation === "confirm"),
    false,
  );
  assert.equal(
    JSON.stringify(f.announcements).includes("embedded-csrf"),
    false,
  );
});
