import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { coreInfoFetcher } from "./core-info-reads.js";
import { CoreBridge } from "./core_bridge.js";
import { AgentError } from "./contracts.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import { SourceFeed } from "./source-feed.js";

const initialTime = 1_700_000_000_000;
const mainnet = "https://api.hyperliquid.xyz/info";
const testnet = "https://api.hyperliquid-testnet.xyz/info";
const serviceToken = "synthetic-core-service-token";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
const failure = (code: string, sent: boolean, retry = 1000, status = 503) =>
  Response.json(
    { error: { code, upstream_request_sent: sent, retry_after_ms: retry } },
    { status },
  );

function fakeTime() {
  let at = initialTime;
  let sequence = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const timers: BudgetTimers = {
    setTimeout(callback, ms) {
      const id = ++sequence;
      tasks.set(id, { at: at + ms, callback });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id as number);
    },
  };
  return {
    clock: () => at,
    timers,
    advance: async (ms: number) => {
      const until = at + ms;
      await flush();
      for (;;) {
        const next = [...tasks]
          .filter(([, task]) => task.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        at = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
        await flush();
      }
      at = until;
      await flush();
    },
  };
}
type Call = {
  url: string;
  headers: Headers;
  body: any;
  signal: AbortSignal | null | undefined;
  redirect: RequestRedirect | undefined;
};
function fixture(
  handler: (call: Call) => Promise<Response>,
  options: { signal?: AbortSignal } = {},
) {
  const time = fakeTime();
  const calls: Call[] = [];
  const request: typeof fetch = async (url, init) => {
    const call: Call = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
      signal: init?.signal,
      redirect: init?.redirect,
    };
    calls.push(call);
    return handler(call);
  };
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const reads = new VenueReads(
    coreInfoFetcher(
      "https://core.test/base?ignored=1",
      serviceToken,
      request,
      time.clock,
    ),
    time.clock,
    2,
    {
      budget,
      timers: time.timers,
      signal: options.signal,
      report: () => {},
      transport: "core_shared_info",
    },
  );
  return { time, calls, budget, reads };
}

it("does not trust a same-shaped no-attempt receipt at HTTP401 instead of the agreed HTTP503", async () => {
  const clock = () => initialTime;
  const budget = new VenueReadBudget({ clock });
  const reads = new VenueReads(
    coreInfoFetcher(
      "https://core.test",
      serviceToken,
      async () => failure("local_budget", false, 1000, 401),
      clock,
    ),
    clock,
    2,
    { budget, report: () => {}, transport: "core_shared_info" },
  );
  await assert.rejects(
    reads.read(
      mainnet,
      { type: "userFillsByTime", user: "synthetic-owner" },
      0,
      "source",
    ),
    { code: "VENUE_UNAVAILABLE" },
  );
  assert.equal(budget.snapshot().used, 120);
  assert.equal(reads.diagnostics().counts.charged_weight, 120);
});

it("late confirmed no-upstream receipts cannot make a reset reporting interval negative", async () => {
  let at = initialTime;
  const clock = () => at;
  const pending = deferred<Response>();
  const reports: ReturnType<VenueReads["diagnostics"]>[] = [];
  const budget = new VenueReadBudget({ clock });
  const request: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return body.request.type === "userFillsByTime"
      ? pending.promise
      : Response.json({ data: {}, observed_at: clock() });
  };
  const reads = new VenueReads(
    coreInfoFetcher("https://core.test", serviceToken, request, clock),
    clock,
    2,
    {
      budget,
      report: (record) =>
        reports.push(record as ReturnType<VenueReads["diagnostics"]>),
      transport: "core_shared_info",
    },
  );
  at += 59000;
  const first = reads.read(
    mainnet,
    { type: "userFillsByTime", user: "synthetic-owner" },
    0,
    "source",
  );
  await flush();
  at += 1000;
  await reads.read(mainnet, { type: "allMids" });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].transport, "core_shared_info");
  at += 1000;
  pending.resolve(failure("local_budget", false));
  await assert.rejects(first, { code: "VENUE_READ_BUDGET_EXHAUSTED" });
  const counts = reads.diagnostics().counts;
  assert.ok(counts.actual_fetch >= 0);
  assert.equal(counts.coordinated_no_upstream, 1);
  assert.equal(counts.charged_weight, 0);
  assert.equal(budget.snapshot().used, 2);
});

const mappedCodes = [
  ["local_budget", "VENUE_READ_BUDGET_EXHAUSTED"],
  ["deadline", "VENUE_READ_DEADLINE"],
  ["unavailable", "VENUE_UNAVAILABLE"],
  ["invalid", "VENUE_RESPONSE_INVALID"],
  ["unsupported", "VENUE_READ_UNSUPPORTED"],
  ["data_provider_rate_limited", "VENUE_RATE_LIMITED"],
] as const;
for (const [remote, code] of mappedCodes)
  it(`trusted ${remote} no-upstream receipts refund the full hold without erasing the real Core transport attempt`, async () => {
    const f = fixture(async () => failure(remote, false, 1200));
    await assert.rejects(
      f.reads.read(
        mainnet,
        { type: "userFillsByTime", user: "synthetic-owner" },
        0,
        "source",
      ),
      { code, details: { retry_after_ms: 1200 } },
    );
    const diag = f.reads.diagnostics();
    assert.equal(f.calls.length, 1);
    assert.equal(diag.transport, "core_shared_info");
    assert.equal(diag.counts.actual_fetch, 1);
    assert.equal(diag.counts.coordinated_no_upstream, 1);
    assert.equal(diag.counts.charged_weight, 0);
    assert.equal(diag.counts.coordinated_denied, 1);
    assert.equal(diag.counts.http_429, 0);
    assert.equal(
      diag.counts.coordinated_rate_limited,
      remote === "data_provider_rate_limited" ? 1 : 0,
    );
    assert.equal(f.budget.snapshot().used, 0);
    assert.equal(f.budget.snapshot().source_used, 0);
    assert.equal(
      f.budget.cooldownRemaining(),
      remote === "data_provider_rate_limited" ? 60000 : 0,
    );
  });

it("refunds an explicitly unsent unknown surcharge without quarantine or retained capacity", async () => {
  const f = fixture(async () => failure("local_budget", false));
  await assert.rejects(
    f.reads.read(
      mainnet,
      { type: "userFunding", user: "synthetic-owner" },
      0,
      "source",
    ),
    { code: "VENUE_READ_BUDGET_EXHAUSTED" },
  );
  const d = f.reads.diagnostics();
  assert.equal(d.counts.reserved_weight, 1000);
  assert.equal(d.counts.actual_fetch, 1);
  assert.equal(d.counts.unknown_fetch, 1);
  assert.equal(d.counts.unknown_uncertain, 0);
  assert.equal(d.counts.charged_weight, 0);
  assert.equal(d.counts.coordinated_no_upstream, 1);
  assert.equal(d.budget.used, 0);
  assert.equal(d.budget.unknown_exclusive, false);
  assert.equal(d.budget.quarantine_ms, 0);
});

for (const [type, expected] of [
  ["userFillsByTime", 120],
  ["userFunding", 1000],
] as const)
  it(`retains the entire ${type} reservation when Core confirms a failed upstream attempt`, async () => {
    const f = fixture(async () => failure("unavailable", true));
    await assert.rejects(
      f.reads.read(mainnet, { type, user: "synthetic-owner" }, 0, "source"),
      { code: "VENUE_UNAVAILABLE" },
    );
    const d = f.reads.diagnostics();
    assert.equal(d.budget.used, expected);
    assert.equal(d.counts.charged_weight, expected);
    assert.equal(d.counts.actual_fetch, 1);
    assert.equal(d.counts.coordinated_no_upstream, 0);
    assert.equal(d.counts.unknown_uncertain, type === "userFunding" ? 1 : 0);
    assert.equal(d.budget.quarantine_ms, type === "userFunding" ? 60000 : 0);
    await f.time.advance(59999);
    assert.equal(f.budget.snapshot().used, expected);
    await f.time.advance(1);
    assert.equal(f.budget.snapshot().used, 0);
  });

it("counts a confirmed provider rate limit separately from an HTTP429 and blocks both hosts without fallback", async () => {
  const f = fixture(async () =>
    failure("data_provider_rate_limited", true, 2000),
  );
  await assert.rejects(
    f.reads.read(mainnet, { type: "userFillsByTime", user: "synthetic-owner" }),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(f.budget.cooldownRemaining(), 60000);
  assert.equal(f.budget.snapshot().used, 120);
  await f.time.advance(2000);
  await assert.rejects(
    f.reads.read(testnet, { type: "allMids" }, 0, "source"),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(f.calls.length, 1);
  const d = f.reads.diagnostics();
  assert.equal(d.transport, "core_shared_info");
  assert.equal(d.counts.coordinated_rate_limited, 1);
  assert.equal(d.counts.http_429, 0);
  assert.deepEqual(d.rate_limit_responses, []);
});

const invalidReceipts = [
  { error: { code: "local_budget", retry_after_ms: 1000 } },
  {
    error: {
      code: "local_budget",
      upstream_request_sent: "false",
      retry_after_ms: 1000,
    },
  },
  {
    error: {
      code: "local_budget",
      upstream_request_sent: false,
      retry_after_ms: 0,
    },
  },
  {
    error: {
      code: "local_budget",
      upstream_request_sent: false,
      retry_after_ms: 60001,
    },
  },
  {
    error: {
      code: "local_budget",
      upstream_request_sent: false,
      retry_after_ms: 1.5,
    },
  },
  { error: { code: "private-unknown-error", upstream_request_sent: false } },
];
for (const [index, body] of invalidReceipts.entries())
  it(`does not refund or retry malformed Core error receipt ${index + 1}`, async () => {
    const f = fixture(async () =>
      Response.json(body, {
        status: 503,
        headers: { "x-upstream-request-sent": "false" },
      }),
    );
    await assert.rejects(f.reads.read(mainnet, { type: "userFillsByTime" }), {
      code: "VENUE_UNAVAILABLE",
    });
    assert.equal(f.calls.length, 1);
    assert.equal(
      f.calls[0].url,
      "https://core.test/internal/agent-core/perps_info_read",
    );
    const d = f.reads.diagnostics();
    assert.equal(d.counts.coordinated_no_upstream, 0);
    assert.equal(d.counts.charged_weight, 120);
    assert.equal(d.budget.used, 120);
    assert.equal(JSON.stringify(d).includes("private-unknown-error"), false);
  });

it("unknown transport errors retain full fee and never trigger a direct-provider second attempt", async () => {
  const f = fixture(async () => {
    throw new Error("private-transport-failure");
  });
  await assert.rejects(f.reads.read(mainnet, { type: "userFillsByTime" }), {
    code: "VENUE_UNAVAILABLE",
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.budget.snapshot().used, 120);
  assert.equal(f.reads.diagnostics().counts.transport_failure, 1);
  assert.equal(
    JSON.stringify(f.reads.diagnostics()).includes("private-transport-failure"),
    false,
  );
});

for (const [name, data] of [
  ["missing data", { observed_at: initialTime }],
  ["string timestamp", { data: {}, observed_at: String(initialTime) }],
  ["zero timestamp", { data: {}, observed_at: 0 }],
  ["fractional timestamp", { data: {}, observed_at: initialTime + 0.5 }],
] as const)
  it(`rejects success with ${name} without manufacturing zero cost or evidence`, async () => {
    const f = fixture(async () => Response.json(data));
    await assert.rejects(
      f.reads.readWithEvidence(mainnet, { type: "userFillsByTime" }),
      { code: "VENUE_UNAVAILABLE" },
    );
    assert.equal(f.calls.length, 1);
    assert.equal(f.budget.snapshot().used, 120);
    assert.equal(f.reads.diagnostics().counts.charged_weight, 120);
  });

it("preserves exact payload/auth/deadline and the earlier trusted evidence through flights and metadata cache", async () => {
  const reply = deferred<Response>();
  const f = fixture(async () => reply.promise);
  const payload = { type: "meta", dex: "xyz" };
  const first = f.reads.readWithEvidence(mainnet, payload, 30000);
  await flush();
  const second = f.reads.read(mainnet, payload, 30000);
  await f.time.advance(300);
  reply.resolve(
    Response.json({
      data: { collateralToken: 0, universe: [] },
      observed_at: initialTime - 1000,
    }),
  );
  const [rich, plain] = await Promise.all([first, second]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, {
    request: payload,
    deadline_ms: initialTime + 12000,
  });
  assert.equal(
    f.calls[0].headers.get("authorization"),
    "Bearer " + serviceToken,
  );
  assert.equal(f.calls[0].headers.get("content-type"), "application/json");
  assert.equal(f.calls[0].redirect, "error");
  assert.equal(rich.observed_at, initialTime - 1000);
  assert.deepEqual(rich.value, plain);
  rich.value.universe.push("caller mutation");
  assert.deepEqual(plain.universe, []);
  await f.time.advance(500);
  const cached = await f.reads.readWithEvidence(mainnet, payload, 30000);
  assert.equal(cached.observed_at, initialTime - 1000);
  assert.deepEqual(cached.value.universe, []);
  assert.equal(f.calls.length, 1);
  const diag = JSON.stringify(f.reads.diagnostics());
  assert.equal(diag.includes(serviceToken), false);
  assert.equal(diag.includes("https://core.test"), false);
});

it("never moves evidence forward when Core returns a future stamp", async () => {
  const f = fixture(async () =>
    Response.json({ data: {}, observed_at: initialTime + 60000 }),
  );
  const result = await f.reads.readWithEvidence(mainnet, { type: "allMids" });
  assert.equal(result.observed_at, initialTime);
});

it("caller abort after a Core dispatch retains unknown full fee and refuses late data/cache", async () => {
  const reply = deferred<Response>();
  const caller = new AbortController();
  const f = fixture(async () => reply.promise, { signal: caller.signal });
  const pending = f.reads.readWithEvidence(
    mainnet,
    { type: "userFillsByTime" },
    1000,
  );
  await flush();
  assert.equal(f.calls.length, 1);
  const reason = new AgentError(
    "VENUE_READ_DEADLINE",
    "synthetic caller cancellation",
    true,
    503,
  );
  caller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  reply.resolve(Response.json({ data: [], observed_at: initialTime }));
  await flush();
  assert.equal(f.budget.snapshot().used, 120);
  assert.equal(f.reads.diagnostics().counts.coordinated_no_upstream, 0);
  assert.equal(f.reads.diagnostics().counts.cache_hit, 0);
  assert.equal(f.calls[0].signal?.aborted, true);
});

it("an already-aborted caller does not dispatch even the private Core request", async () => {
  const caller = new AbortController();
  caller.abort(
    new AgentError("VENUE_READ_DEADLINE", "synthetic cancellation", true, 503),
  );
  const f = fixture(async () => assert.fail("must not dispatch"), {
    signal: caller.signal,
  });
  await assert.rejects(f.reads.read(mainnet, { type: "allMids" }), {
    code: "VENUE_READ_DEADLINE",
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.budget.snapshot().used, 0);
});

it("the private deadline remains inside the original twenty-second account observation", async () => {
  const f = fixture(async () =>
    Response.json({ data: {}, observed_at: initialTime + 15000 }),
  );
  const pending = f.reads.observeAccount(async () => {
    await new Promise<void>((resolve) => {
      f.time.timers.setTimeout(resolve, 15000);
    });
    return f.reads.readWithEvidence(mainnet, { type: "allMids" });
  }, "synthetic-account");
  await f.time.advance(15000);
  const result = await pending;
  assert.equal(f.calls[0].body.deadline_ms, initialTime + 20000);
  assert.equal(result.observed_at, initialTime + 15000);
});

it("the original twelve-second wire/JSON deadline still bounds a stuck Core response", async () => {
  const reply = deferred<Response>();
  const f = fixture(async () => reply.promise);
  const pending = f.reads.read(mainnet, { type: "userFillsByTime" });
  const rejected = assert.rejects(pending, { code: "VENUE_READ_DEADLINE" });
  await f.time.advance(12000);
  await rejected;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.equal(f.budget.snapshot().used, 120);
  reply.resolve(Response.json({ data: [], observed_at: initialTime }));
  await flush();
});

it("testnet keeps the official path without sending the private service token", async () => {
  const f = fixture(async () => Response.json({ assetPositions: [] }));
  const value = await f.reads.read(testnet, { type: "clearinghouseState" });
  assert.deepEqual(value, { assetPositions: [] });
  assert.equal(f.calls[0].url, testnet);
  assert.deepEqual(f.calls[0].body, { type: "clearinghouseState" });
  assert.equal(f.calls[0].headers.get("authorization"), null);
});

it("rejects exchange/unknown read types before any adapter dispatch and refuses arbitrary hosts", async () => {
  const f = fixture(async () => assert.fail("must not dispatch"));
  await assert.rejects(
    f.reads.read(mainnet, { type: "exchange", action: { type: "order" } }),
    { code: "VENUE_READ_UNSUPPORTED" },
  );
  await assert.rejects(
    f.reads.read("https://untrusted.test/info", { type: "allMids" }),
    { code: "VENUE_READ_UNSUPPORTED" },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.budget.snapshot().used, 0);
  assert.throws(
    () => coreInfoFetcher("http://remote.test", serviceToken),
    /private HTTPS/,
  );
});

for (const elapsed of [100, 6001])
  it(`a ${elapsed}ms Core hop preserves source freshness using the conservative original evidence time`, async (context) => {
    const reply = deferred<Response>();
    const f = fixture(async () => reply.promise);
    context.mock.method(Date, "now", f.time.clock);
    const bridge = Object.create(CoreBridge.prototype) as any;
    bridge.network = "testnet";
    bridge.venueReads = f.reads;
    bridge.prediction = { recognizes: async () => false };
    bridge.resolve = async () => ({ address: "0x" + "a".repeat(40), tags: [] });
    const feed = new SourceFeed((id) => bridge.readSource(id), {
      clock: f.time.clock,
      timers: { setInterval: () => 1, clearInterval: () => {} },
    });
    bridge.sourceFeed = feed;
    context.after(() => feed.close());
    const source = bridge.source("synthetic-source");
    await flush();
    await f.time.advance(elapsed);
    reply.resolve(
      Response.json({
        data: { marginSummary: { accountValue: "100" }, assetPositions: [] },
        observed_at: f.time.clock(),
      }),
    );
    if (elapsed > 5000) await assert.rejects(source, { code: "SOURCE_STALE" });
    else {
      const snapshot = await source;
      assert.equal(snapshot.complete, true);
      assert.equal(snapshot.observed_at, initialTime);
      assert.deepEqual(snapshot.perps_dexes, [""]);
    }
    assert.equal(f.calls.length, 1);
  });

for (const route of [undefined, "official", "core"] as const)
  it(`CoreBridge ${route ?? "default"} routing makes exactly the selected read and never leaks the private token to the provider`, async (context) => {
    const calls: { url: string; auth: string | null; body: any }[] = [];
    context.mock.method(
      globalThis,
      "fetch",
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const isCore = String(url).startsWith("https://core.test/");
        calls.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(
          isCore ? { data: "standard", observed_at: Date.now() } : "standard",
        );
      },
    );
    const bridge = new CoreBridge(
      "https://core.test",
      serviceToken,
      "postgresql://127.0.0.1:1/unused",
      "s".repeat(32),
      "mainnet",
      route === undefined ? {} : { infoReadRoute: route },
    );
    context.after(async () => bridge.close());
    const value = await (bridge as any).info({ type: "userAbstraction" });
    assert.equal(value, "standard");
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      route === "core"
        ? "https://core.test/internal/agent-core/perps_info_read"
        : mainnet,
    );
    assert.equal(
      calls[0].auth,
      route === "core" ? "Bearer " + serviceToken : null,
    );
    assert.deepEqual(route === "core" ? calls[0].body.request : calls[0].body, {
      type: "userAbstraction",
    });
    assert.equal(
      (bridge as any).venueReads.diagnostics().transport,
      route === "core" ? "core_shared_info" : "official",
    );
  });

it("CoreBridge with testnet followers still sends mainnet sources through Core while follower reads remain direct testnet", async (context) => {
  const calls: { url: string; auth: string | null; body: any }[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const isCore = String(url).startsWith("https://core.test/");
      calls.push({
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(isCore ? { data: {}, observed_at: Date.now() } : {});
    },
  );
  const bridge = new CoreBridge(
    "https://core.test",
    serviceToken,
    "postgresql://127.0.0.1:1/unused",
    "s".repeat(32),
    "testnet",
    { infoReadRoute: "core" },
  );
  context.after(async () => bridge.close());
  await (bridge as any).info({ type: "clearinghouseState" });
  await (bridge as any).info(
    { type: "clearinghouseState", user: "0x" + "a".repeat(40) },
    true,
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [testnet, "https://core.test/internal/agent-core/perps_info_read"],
  );
  assert.equal(calls[0].auth, null);
  assert.equal(calls[1].auth, "Bearer " + serviceToken);
});

for (const type of [
  "userFunding",
  "userFillsByTime",
  "userNonFundingLedgerUpdates",
])
  it(`actual CoreBridge ${type} history contract preserves full pagination and the original end fence`, async () => {
    const expectedKeys = [
      "type",
      "user",
      "startTime",
      "endTime",
      ...(type === "userFillsByTime" ? ["aggregateByTime"] : []),
    ].sort();
    const f = fixture(async (call) => {
      // These keys are the final Core9c8a097 Info whitelist, not a Node request builder.
      if (
        JSON.stringify(Object.keys(call.body.request).sort()) !==
        JSON.stringify(expectedKeys)
      )
        return failure("unsupported", false);
      const rows =
        call.body.request.startTime === 0
          ? Array.from({ length: 500 }, (_, i) => ({ tid: i + 1, time: i + 1 }))
          : [{ tid: 501, time: 501 }];
      return Response.json({ data: rows, observed_at: f.time.clock() });
    });
    const bridge = Object.create(CoreBridge.prototype) as any;
    bridge.network = "mainnet";
    bridge.venueReads = f.reads;
    const result = await bridge.paged(
      type,
      "0x" + "a".repeat(40),
      0,
      1000,
      true,
    );
    assert.equal(result.complete, true);
    assert.equal(result.events.length, 501);
    assert.equal(f.calls.length, 2);
    for (const [index, call] of f.calls.entries()) {
      assert.deepEqual(Object.keys(call.body.request).sort(), expectedKeys);
      assert.equal(call.body.request.startTime, index === 0 ? 0 : 500);
      assert.equal(call.body.request.endTime, 1000);
      assert.equal(
        call.body.request.aggregateByTime,
        type === "userFillsByTime" ? false : undefined,
      );
    }
  });

async function loopback(
  context: TestContext,
  work: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  const server = createServer((req, res) => {
    void work(req, res).catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

it("real loopback Core transport preserves all history pages and charges their actual row cost", async (context) => {
  const requests: {
    path: string | undefined;
    auth: string | undefined;
    body: any;
  }[] = [];
  const rows = Array.from({ length: 2000 }, (_, i) => ({
    tid: i + 1,
    time: i + 2,
    coin: "BTC",
  }));
  const base = await loopback(context, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url, auth: req.headers.authorization, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: requests.length === 1 ? rows : [],
        observed_at: Date.now(),
      }),
    );
  });
  const budget = new VenueReadBudget();
  const reads = new VenueReads(
    coreInfoFetcher(base, serviceToken),
    Date.now,
    2,
    { budget, report: () => {}, transport: "core_shared_info" },
  );
  const bridge = Object.create(CoreBridge.prototype) as any;
  bridge.network = "mainnet";
  bridge.venueReads = reads;
  const result = await bridge.paged(
    "userFillsByTime",
    "0x" + "a".repeat(40),
    1,
    5000,
    true,
  );
  assert.equal(result.complete, true);
  assert.equal(result.events.length, 2000);
  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(
      (request) =>
        request.path === "/internal/agent-core/perps_info_read" &&
        request.auth === "Bearer " + serviceToken,
    ),
  );
  assert.equal(requests[1].body.request.startTime, 2001);
  assert.equal(requests[1].body.request.endTime, 5000);
  assert.ok(
    requests.every((request) => Number.isSafeInteger(request.body.deadline_ms)),
  );
  assert.equal(reads.diagnostics().counts.reserved_weight, 240);
  assert.equal(reads.diagnostics().counts.charged_weight, 140);
  assert.equal(budget.snapshot().used, 140);
});

it(
  "real loopback Core JSON cancellation closes the wire without refunding an unknown upstream read",
  { timeout: 5000 },
  async (context) => {
    const reached = deferred<void>();
    const closed = deferred<void>();
    let requests = 0;
    const base = await loopback(context, async (req, res) => {
      for await (const _ of req) {
        /* consume the local request */
      }
      requests++;
      res.once("close", () => closed.resolve());
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":');
      reached.resolve();
    });
    const caller = new AbortController();
    const budget = new VenueReadBudget();
    const reads = new VenueReads(
      coreInfoFetcher(base, serviceToken),
      Date.now,
      2,
      {
        budget,
        signal: caller.signal,
        report: () => {},
        transport: "core_shared_info",
      },
    );
    const work = reads.read(mainnet, { type: "userFillsByTime" });
    await reached.promise;
    const reason = new AgentError(
      "VENUE_READ_DEADLINE",
      "synthetic local cancellation",
      true,
      503,
    );
    caller.abort(reason);
    await assert.rejects(work, (error) => error === reason);
    await closed.promise;
    assert.equal(requests, 1);
    assert.equal(reads.diagnostics().counts.coordinated_no_upstream, 0);
    assert.equal(reads.diagnostics().counts.charged_weight, 120);
    assert.equal(budget.snapshot().used, 120);
  },
);
