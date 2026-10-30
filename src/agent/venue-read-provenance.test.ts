import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";

const initialTime = 1_700_000_000_000;
const mainnet = "https://api.hyperliquid.xyz/info";
const testnet = "https://api.hyperliquid-testnet.xyz/info";

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
function setup(
  fetcher: typeof fetch,
  report: (record: Record<string, unknown>) => void = () => {},
) {
  const time = fakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const reads = new VenueReads(fetcher, time.clock, 2, {
    budget,
    timers: time.timers,
    report,
  });
  return { time, budget, reads };
}

it("read and readWithEvidence join one wire/JSON flight while returning isolated compatible values", async () => {
  const headers = deferred<Response>();
  const json = deferred<unknown>();
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return calls === 1 ? headers.promise : new Response('{"BTC":"101"}');
  });
  const payload = { type: "allMids" };
  const rich = f.reads.readWithEvidence(mainnet, payload, 1000);
  await flush();
  await f.time.advance(100);
  const plain = f.reads.read(mainnet, payload, 1000);
  await f.time.advance(100);
  headers.resolve({
    ok: true,
    status: 200,
    json: () => json.promise,
  } as Response);
  await flush();
  await f.time.advance(300);
  json.resolve({ BTC: "100" });
  const [evidence, value] = await Promise.all([rich, plain]);
  assert.equal(calls, 1);
  assert.equal(evidence.observed_at, initialTime);
  assert.deepEqual(value, { BTC: "100" });
  assert.deepEqual(evidence.value, value);
  assert.equal(f.time.clock() - evidence.observed_at, 500);
  evidence.value.BTC = "mutated";
  assert.equal(value.BTC, "100");
  assert.equal(f.budget.snapshot().used, 2);
  assert.equal(f.reads.diagnostics().counts.flight_join, 1);

  await f.time.advance(100);
  const cached = await f.reads.readWithEvidence(mainnet, payload, 1000);
  assert.equal(calls, 1);
  assert.equal(cached.observed_at, initialTime);
  assert.deepEqual(cached.value, { BTC: "100" });
  await f.time.advance(900);
  const refreshed = await f.reads.readWithEvidence(mainnet, payload, 1000);
  assert.equal(calls, 2);
  assert.equal(refreshed.observed_at, initialTime + 1500);
  assert.deepEqual(refreshed.value, { BTC: "101" });
});

it("timestamps admission after the local queue and never reuses completed account evidence", async () => {
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return new Response('{"assetPositions":[]}');
  });
  const owner = "synthetic-owner";
  const blocker = await f.budget.acquire(
    "source",
    2,
    owner,
    new AbortController().signal,
  );
  blocker.sent();
  const pending = f.reads.readWithEvidence(
    mainnet,
    { type: "clearinghouseState", user: owner },
    0,
    "source",
  );
  await flush();
  assert.equal(calls, 0);
  await f.time.advance(6001);
  blocker.settle(2);
  blocker.release();
  const first = await pending;
  assert.equal(first.observed_at, initialTime + 6001);
  await f.time.advance(100);
  const second = await f.reads.readWithEvidence(
    mainnet,
    { type: "clearinghouseState", user: owner },
    0,
    "source",
  );
  assert.equal(calls, 2);
  assert.equal(second.observed_at, initialTime + 6101);
});

it("keeps source/account flights separate and associates each result with its own dispatch", async () => {
  const replies = [deferred<Response>(), deferred<Response>()];
  let calls = 0;
  const f = setup(async () => replies[calls++].promise);
  const account = f.reads.readWithEvidence(
    mainnet,
    { type: "allMids" },
    0,
    "account",
  );
  await flush();
  await f.time.advance(100);
  const source = f.reads.readWithEvidence(
    mainnet,
    { type: "allMids" },
    0,
    "source",
  );
  await flush();
  assert.equal(calls, 2);
  replies[1].resolve(new Response('{"lane":"source"}'));
  replies[0].resolve(new Response('{"lane":"account"}'));
  const [a, s] = await Promise.all([account, source]);
  assert.equal(a.observed_at, initialTime);
  assert.equal(s.observed_at, initialTime + 100);
  assert.equal(a.value.lane, "account");
  assert.equal(s.value.lane, "source");
});

it("does not publish or cache evidence whose JSON completed after the original deadline", async () => {
  const json = deferred<unknown>();
  let calls = 0;
  const f = setup(async () =>
    ++calls === 1
      ? ({ ok: true, status: 200, json: () => json.promise } as Response)
      : new Response('{"BTC":"101"}'),
  );
  const first = f.reads.readWithEvidence(mainnet, { type: "allMids" }, 1000);
  const rejected = assert.rejects(first, { code: "VENUE_READ_DEADLINE" });
  await f.time.advance(12000);
  await rejected;
  json.resolve({ BTC: "late" });
  await flush();
  const next = await f.reads.readWithEvidence(
    mainnet,
    { type: "allMids" },
    1000,
  );
  assert.equal(calls, 2);
  assert.deepEqual(next.value, { BTC: "101" });
  assert.equal(next.observed_at, initialTime + 12000);
  assert.equal(f.reads.diagnostics().counts.cache_hit, 0);
});

it("rejects a cached provenance read after caller cancellation", async () => {
  const signal = new AbortController();
  const time = fakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  let calls = 0;
  const reader = new VenueReads(
    async () => {
      calls++;
      return new Response('{"universe":[]}');
    },
    time.clock,
    2,
    { budget, timers: time.timers, signal: signal.signal, report: () => {} },
  );
  await reader.readWithEvidence(mainnet, { type: "meta" }, 30000);
  const cancelled = new AgentError(
    "VENUE_READ_DEADLINE",
    "synthetic cancellation",
    true,
    503,
  );
  signal.abort(cancelled);
  await assert.rejects(
    reader.readWithEvidence(mainnet, { type: "meta" }, 30000),
    (error) => error === cancelled,
  );
  assert.equal(calls, 1);
  assert.equal(reader.diagnostics().counts.cache_hit, 0);
});

const rateCases = [
  {
    name: "short numeric seconds",
    retry: "2",
    kind: "seconds",
    parsed: 2000,
    wait: 60000,
    content: "application/json",
    contentKind: "json",
    server: "cloudflare",
    family: "cloudflare",
  },
  {
    name: "long numeric seconds",
    retry: "120",
    kind: "seconds",
    parsed: 120000,
    wait: 120000,
    content: "text/html",
    contentKind: "html",
    server: "CloudFront",
    family: "cloudfront",
  },
  {
    name: "future HTTP date",
    retry: new Date(initialTime + 120000).toUTCString(),
    kind: "date",
    parsed: 120000,
    wait: 120000,
    content: "text/plain",
    contentKind: "text",
    server: "nginx",
    family: "nginx",
  },
  {
    name: "past HTTP date",
    retry: new Date(initialTime - 10000).toUTCString(),
    kind: "date",
    parsed: 0,
    wait: 60000,
    content: "application/octet-stream",
    contentKind: "other",
    server: "envoy",
    family: "envoy",
  },
  {
    name: "missing Retry-After",
    kind: "missing",
    parsed: 0,
    wait: 60000,
    contentKind: "missing",
    family: "missing",
  },
  {
    name: "invalid Retry-After",
    retry: "invalid-private-retry-header",
    kind: "invalid",
    parsed: 0,
    wait: 60000,
    content: "application/problem+json",
    contentKind: "json",
    server: "private-server-version",
    family: "other",
  },
] as const;

for (const c of rateCases)
  it(`classifies ${c.name} without weakening provider cooldown across hosts and lanes`, async () => {
    const headers = new Headers();
    if ("retry" in c) headers.set("retry-after", c.retry);
    if ("content" in c) headers.set("content-type", c.content);
    if ("server" in c) headers.set("server", c.server);
    let calls = 0;
    const f = setup(async () =>
      ++calls === 1
        ? new Response(null, { status: 429, headers })
        : new Response('{"resumed":true}'),
    );
    await assert.rejects(
      f.reads.readWithEvidence(mainnet, { type: "userAbstraction" }),
      { code: "VENUE_RATE_LIMITED" },
    );
    assert.equal(f.budget.cooldownRemaining(), c.wait);
    assert.deepEqual(f.reads.diagnostics().rate_limit_responses, [
      {
        purpose_method: "account:userAbstraction",
        content_kind: c.contentKind,
        retry_after_kind: c.kind,
        retry_after_ms: c.parsed,
        server_family: c.family,
        cloudfront_header: false,
        cloudflare_header: false,
        count: 1,
      },
    ]);
    const other = new VenueReads(
      async () => {
        calls++;
        return new Response("{}");
      },
      f.time.clock,
      2,
      { budget: f.budget, timers: f.time.timers, report: () => {} },
    );
    await f.time.advance(c.wait - 1);
    await assert.rejects(
      other.readWithEvidence(testnet, { type: "allMids" }, 0, "source"),
      { code: "VENUE_RATE_LIMITED" },
    );
    assert.equal(calls, 1);
    await f.time.advance(1);
    const resumed = await f.reads.readWithEvidence(mainnet, {
      type: "userAbstraction",
    });
    assert.deepEqual(resumed.value, { resumed: true });
    assert.equal(resumed.observed_at, initialTime + c.wait);
    assert.equal(calls, 2);
  });

it("provider cooldown is checked before another reader can return cached rich metadata", async () => {
  const f = setup(async () => new Response('{"universe":[]}'));
  await f.reads.readWithEvidence(mainnet, { type: "meta" }, 30000);
  const limited = new VenueReads(
    async () => new Response(null, { status: 429 }),
    f.time.clock,
    2,
    { budget: f.budget, timers: f.time.timers, report: () => {} },
  );
  await assert.rejects(
    limited.read(testnet, { type: "allMids" }, 0, "source"),
    { code: "VENUE_RATE_LIMITED" },
  );
  await assert.rejects(
    f.reads.readWithEvidence(mainnet, { type: "meta" }, 30000),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(f.reads.diagnostics().counts.cache_hit, 0);
  assert.equal(f.reads.diagnostics().counts.actual_fetch, 1);
});

it("429 diagnostics emit fixed classifications only and never read or leak response body, raw headers, user or URL", async () => {
  const privateUser = "0x" + "b".repeat(40);
  const privateMarker = "private-diagnostic-marker";
  const privateUrl = mainnet + "?private_url=" + privateMarker;
  const headers = {
    "content-type": "application/problem+json; marker=" + privateMarker,
    server: "nginx " + privateMarker,
    "retry-after": privateMarker,
    "x-amz-cf-id": "private-cloudfront-edge-id",
    "cf-ray": "private-cloudflare-edge-id",
    "set-cookie": "private-cookie=" + privateMarker,
  };
  const response = new Response(
    JSON.stringify({ user: privateUser, secret: privateMarker }),
    { status: 429, headers },
  );
  response.json = async () =>
    assert.fail("429 response body must not be parsed");
  response.text = async () =>
    assert.fail("429 response body must not be read for logging");
  const f = setup(async () => response);
  await assert.rejects(
    f.reads.read(privateUrl, {
      type: "userAbstraction",
      user: privateUser,
      private_input: privateMarker,
    }),
    { code: "VENUE_RATE_LIMITED" },
  );
  const diagnostics = f.reads.diagnostics();
  const row = diagnostics.rate_limit_responses[0];
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "purpose_method",
      "content_kind",
      "retry_after_kind",
      "retry_after_ms",
      "server_family",
      "cloudfront_header",
      "cloudflare_header",
      "count",
    ].sort(),
  );
  assert.equal(row.cloudfront_header, true);
  assert.equal(row.cloudflare_header, true);
  assert.equal(row.server_family, "nginx");
  const output = JSON.stringify(diagnostics);
  for (const secret of [
    privateUser,
    privateMarker,
    privateUrl,
    "private-cloudfront-edge-id",
    "private-cloudflare-edge-id",
    "private-cookie",
  ])
    assert.equal(
      output.includes(secret),
      false,
      "diagnostics must not contain " + secret,
    );
  row.count = 999;
  assert.equal(f.reads.diagnostics().rate_limit_responses[0].count, 1);
});

it("coalesces matching 429 classifications and isolates a throwing diagnostic reporter from cooldown", async () => {
  const reports: Record<string, unknown>[] = [];
  const f = setup(
    async () =>
      new Response(null, { status: 429, headers: { "retry-after": "2" } }),
    (record) => {
      reports.push(record);
      throw new Error("private reporter failure");
    },
  );
  await assert.rejects(f.reads.read(mainnet, { type: "allMids" }), {
    code: "VENUE_RATE_LIMITED",
  });
  await f.time.advance(60000);
  await assert.rejects(f.reads.read(mainnet, { type: "allMids" }), {
    code: "VENUE_RATE_LIMITED",
  });
  assert.equal(f.budget.cooldownRemaining(), 60000);
  assert.equal(reports.length, 1);
  const record = reports[0] as ReturnType<VenueReads["diagnostics"]>;
  assert.equal(record.rate_limit_responses.length, 1);
  assert.equal(record.rate_limit_responses[0].count, 2);
  assert.equal(record.counts.http_429, 2);
  assert.deepEqual(f.reads.diagnostics().rate_limit_responses, []);
});

it("a diagnostic-only header getter failure preserves the typed 429, cooldown and cache invalidation", async () => {
  const response = new Response(null, { status: 429 });
  const originalGet = response.headers.get.bind(response.headers);
  response.headers.get = (name) => {
    if (name === "server") throw new Error("private-header-getter-error");
    return originalGet(name);
  };
  let calls = 0;
  const f = setup(async () => {
    calls++;
    return calls === 2
      ? response
      : new Response(JSON.stringify({ version: calls }));
  });
  await f.reads.readWithEvidence(mainnet, { type: "meta" }, 120000);
  await assert.rejects(f.reads.readWithEvidence(mainnet, { type: "allMids" }), {
    code: "VENUE_RATE_LIMITED",
  });
  assert.equal(f.budget.cooldownRemaining(), 60000);
  await assert.rejects(
    f.reads.readWithEvidence(testnet, { type: "meta" }, 120000),
    {
      code: "VENUE_RATE_LIMITED",
    },
  );
  assert.equal(calls, 2);
  await f.time.advance(60000);
  const refreshed = await f.reads.readWithEvidence(
    mainnet,
    { type: "meta" },
    120000,
  );
  assert.equal(calls, 3);
  assert.deepEqual(refreshed.value, { version: 3 });
  assert.equal(refreshed.observed_at, initialTime + 60000);
  assert.equal(f.reads.diagnostics().counts.cache_hit, 0);
});
