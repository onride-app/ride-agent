import assert from "node:assert/strict";
import { it } from "node:test";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import { failure } from "./contracts.js";
import { CoreBridge } from "./core_bridge.js";
import { SourceFeed } from "./source-feed.js";

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
class FakeTime {
  at = 0;
  fired = 0;
  private sequence = 0;
  private events = new Map<number, { at: number; run(): void }>();
  clock = () => this.at;
  timers: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    },
    clearTimeout: (id) => {
      this.events.delete(id as number);
    },
  };
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    for (;;) {
      const first = [...this.events]
        .filter(([_, e]) => e.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.at = first[1].at;
      this.events.delete(first[0]);
      this.fired++;
      first[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
  async resolve<T>(work: Promise<T>, maxMs = 12000): Promise<T> {
    let done = false,
      value!: T,
      error: unknown;
    void work.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (let i = 0; !done && i <= maxMs; i += 5) await this.advance(5);
    assert.equal(done, true, "bounded mock-time work must settle");
    if (error) throw error;
    return value;
  }
}
function setup(limit = 1000, fetcher?: typeof fetch) {
  const time = new FakeTime(),
    budget = new VenueReadBudget({
      limit,
      clock: time.clock,
      timers: time.timers,
    });
  const attempts: { at: number; type: string; url: string }[] = [],
    reports: Record<string, unknown>[] = [];
  const reads = new VenueReads(
    fetcher ??
      (async (url, init) => {
        const p = JSON.parse(String(init?.body));
        attempts.push({ at: time.at, type: p.type, url: String(url) });
        return new Response(
          JSON.stringify(
            p.type === "userFunding" ||
              p.type === "userFillsByTime" ||
              p.type === "candleSnapshot"
              ? []
              : {},
          ),
        );
      }),
    time.clock,
    2,
    { budget, timers: time.timers, report: (x) => reports.push(x) },
  );
  return { time, budget, reads, attempts, reports };
}

it("reserves complete documented response costs before fetch and refunds only unused surcharge", async () => {
  const time = new FakeTime(),
    budget = new VenueReadBudget({
      limit: 130,
      clock: time.clock,
      timers: time.timers,
    });
  let finish!: (response: Response) => void,
    calls = 0;
  const reads = new VenueReads(
    (async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as typeof fetch,
    time.clock,
    2,
    { budget, timers: time.timers },
  );
  const work = reads.read("https://venue.test/info", {
    type: "userFillsByTime",
    user: "fixture",
  });
  await flush();
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().used, 120);
  const denied = reads
    .read(
      "https://venue.test/info",
      { type: "userRole", user: "other" },
      0,
      "source",
    )
    .catch((e) => e);
  await time.advance(12000);
  assert.equal((await denied).code, "VENUE_READ_BUDGET_EXHAUSTED");
  await assert.rejects(work, /deadline/);
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().used, 120);
  finish(new Response("[]"));
  await flush();
  assert.equal(
    budget.snapshot().used,
    120,
    "late responses cannot refund timed-out attempts",
  );
});

it("cache and joined flights cost no extra, while completed account evidence is read again", async () => {
  const f = setup();
  const p = { type: "meta" };
  const [a, b] = await f.time.resolve(
    Promise.all([
      f.reads.read("https://venue.test/info", p, 30000),
      f.reads.read("https://venue.test/info", p, 30000),
    ]),
  );
  assert.deepEqual(a, b);
  assert.equal(f.attempts.length, 1);
  assert.equal(f.budget.snapshot().used, 20);
  await f.reads.read("https://venue.test/info", p, 30000);
  assert.equal(f.attempts.length, 1);
  await f.time.resolve(
    f.reads.read("https://venue.test/info", {
      type: "clearinghouseState",
      user: "fixture",
    }),
  );
  await f.time.resolve(
    f.reads.read("https://venue.test/info", {
      type: "clearinghouseState",
      user: "fixture",
    }),
  );
  assert.equal(f.attempts.length, 3);
  assert.equal(f.budget.snapshot().used, 24);
  assert.equal(f.reads.diagnostics().counts.flight_join, 1);
  assert.equal(f.reads.diagnostics().counts.cache_hit, 1);
});

it("uses a rolling window across minute boundaries and counts failed attempts", async () => {
  const f = setup(20);
  await f.time.resolve(
    f.reads.read("https://venue.test/info", {
      type: "frontendOpenOrders",
      user: "a",
    }),
  );
  await f.time.advance(59989);
  const blocked = f.reads.read("https://venue.test/info", {
    type: "clearinghouseState",
    user: "b",
  });
  await f.time.advance(1);
  assert.equal(f.attempts.length, 1);
  await f.time.advance(20);
  await blocked;
  assert.equal(f.attempts.length, 2);
  assert.ok(f.attempts[1].at >= f.attempts[0].at + 60000);
  const g = setup(
    20,
    (async () => new Response("failure", { status: 503 })) as typeof fetch,
  );
  await assert.rejects(
    g.time.resolve(
      g.reads.read("https://venue.test/info", { type: "frontendOpenOrders" }),
    ),
  );
  assert.equal(g.budget.snapshot().used, 20);
  const denied = g.reads
    .read("https://venue.test/info", { type: "clearinghouseState" })
    .catch((e) => e);
  await g.time.advance(12000);
  assert.equal((await denied).code, "VENUE_READ_BUDGET_EXHAUSTED");
});

it("keeps pending reservations across a full window and ignores repeated or late ticket transitions", async () => {
  const time = new FakeTime(),
    budget = new VenueReadBudget({
      limit: 120,
      clock: time.clock,
      timers: time.timers,
    }),
    controller = new AbortController();
  const ticket = await budget.acquire("account", 120, "a", controller.signal);
  ticket.sent();
  const waiting = new AbortController();
  const queued = budget
    .acquire("source", 2, "b", waiting.signal)
    .catch((e) => e);
  await time.advance(61000);
  assert.equal(budget.snapshot().used, 120);
  assert.equal(budget.snapshot().source_queued, 1);
  assert.ok(
    time.fired < 20,
    "pending reservations must not poll an expired sent timestamp",
  );
  waiting.abort();
  assert.equal((await queued).code, "VENUE_READ_BUDGET_EXHAUSTED");
  ticket.settle(20);
  ticket.release();
  assert.equal(budget.snapshot().used, 20);
  ticket.settle(0);
  ticket.release();
  ticket.sent();
  assert.equal(budget.snapshot().used, 20);
  await time.advance(59999);
  assert.equal(budget.snapshot().used, 20);
  await time.advance(1);
  assert.equal(budget.snapshot().used, 0);
});

it("unknown surcharge waits for all in-flight reads, owns only currently-free budget, and blocks known backfill", async () => {
  const time = new FakeTime(),
    budget = new VenueReadBudget({
      limit: 100,
      clock: time.clock,
      timers: time.timers,
    });
  const known = await budget.acquire(
    "source",
    20,
    "source",
    new AbortController().signal,
  );
  known.sent();
  let unknownDone = false,
    knownDone = false;
  const unknown = budget
    .acquire("account", 20, "account", new AbortController().signal, true)
    .then((t) => {
      unknownDone = true;
      return t;
    });
  const later = budget
    .acquire("source", 2, "other", new AbortController().signal)
    .then((t) => {
      knownDone = true;
      return t;
    });
  await time.advance(1);
  assert.equal(unknownDone, false);
  assert.equal(knownDone, false);
  known.settle(20);
  known.release();
  await flush();
  const held = await unknown;
  held.sent();
  assert.equal(held.reservation, 80);
  assert.equal(budget.snapshot().used, 100);
  assert.equal(knownDone, false);
  held.settle(20);
  held.release();
  await time.advance(5);
  const last = await later;
  last.sent();
  last.settle(2);
  last.release();
  assert.equal(budget.snapshot().used, 42);
});

it("records the entire unknown response debt without clamping, then recovers after its window", async () => {
  let held!: () => void;
  const f = setup(100, (async (_url, init) => {
    const p = JSON.parse(String(init?.body));
    if (p.type === "userFunding")
      return new Promise<Response>((resolve) => {
        held = () =>
          resolve(new Response(JSON.stringify(Array(50000).fill(0))));
      });
    return new Response("{}");
  }) as typeof fetch);
  await f.time.resolve(
    f.reads.read("https://venue.test/info", { type: "userRole", user: "a" }),
  );
  const work = f.reads.read("https://venue.test/info", {
    type: "userFunding",
    user: "a",
  });
  await f.time.advance(5);
  assert.equal(f.budget.snapshot().used, 100);
  assert.equal(f.budget.snapshot().unknown_exclusive, true);
  held();
  await f.time.resolve(work);
  assert.equal(f.budget.snapshot().used, 2580);
  assert.equal(f.budget.snapshot().debt, 2480);
  assert.equal(f.reads.diagnostics().counts.charged_weight, 2580);
  assert.equal(f.reads.diagnostics().counts.unknown_debt_weight, 2480);
  const denied = f.reads
    .read("https://venue.test/info", { type: "clearinghouseState", user: "b" })
    .catch((e) => e);
  await f.time.advance(12000);
  assert.equal((await denied).code, "VENUE_READ_BUDGET_EXHAUSTED");
  await f.time.advance(60001);
  await f.time.resolve(
    f.reads.read("https://venue.test/info", {
      type: "clearinghouseState",
      user: "b",
    }),
  );
  assert.equal(f.budget.snapshot().used, 2);
});

for (const problem of ["transport", "malformed", "deadline"])
  it(`unknown ${problem} consumes its held reservation and stays uncertain without fresh or empty evidence`, async () => {
    const f = setup(100, (async () => {
      if (problem === "transport") throw new Error("offline");
      if (problem === "malformed") return new Response("{}");
      return new Promise<Response>(() => {});
    }) as typeof fetch);
    const work = f.reads.read("https://venue.test/info", {
      type: "userFunding",
      user: "a",
    });
    await assert.rejects(f.time.resolve(work));
    assert.equal(f.budget.snapshot().used, 100);
    assert.equal(f.reads.diagnostics().counts.unknown_uncertain, 1);
    const denied = f.reads
      .read("https://venue.test/info", { type: "allMids" })
      .catch((e) => e);
    await f.time.advance(12000);
    assert.equal((await denied).code, "VENUE_READ_BUDGET_EXHAUSTED");
  });

it("shares long Retry-After across instances and hosts while serializing a bounded wire retry hint", async () => {
  const time = new FakeTime(),
    budget = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return calls === 1
      ? new Response("", { status: 429, headers: { "retry-after": "120" } })
      : new Response("{}");
  }) as typeof fetch;
  const a = new VenueReads(fetcher, time.clock, 2, {
      budget,
      timers: time.timers,
    }),
    b = new VenueReads(fetcher, time.clock, 2, { budget, timers: time.timers });
  const err = await time.resolve(
    a
      .read("https://api.hyperliquid.xyz/info", { type: "allMids" })
      .catch((e) => e),
  );
  assert.equal((failure(err).error as any).details.retry_after_ms, 60000);
  await assert.rejects(
    b.read("https://api.hyperliquid-testnet.xyz/info", { type: "allMids" }),
    { code: "VENUE_RATE_LIMITED" },
  );
  await time.advance(119999 - time.at);
  await assert.rejects(
    b.read("https://api.hyperliquid-testnet.xyz/info", { type: "allMids" }),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(calls, 1);
  await time.advance(1);
  await time.resolve(
    b.read("https://api.hyperliquid-testnet.xyz/info", { type: "allMids" }),
  );
  assert.equal(calls, 2);
  assert.equal(a.diagnostics().counts.http_429, 1);
  assert.equal(b.diagnostics().counts.http_429, 0);
});

it("unknown or malformed methods never fetch and telemetry contains no payload, user, URL or header", async () => {
  const f = setup();
  const secret = "0x" + "a".repeat(40);
  for (const payload of [
    null,
    [],
    { type: "unrecognized_" + secret },
    { type: 12 },
  ])
    await assert.rejects(
      f.reads.read("https://venue.test/info?token=" + secret, payload),
    );
  await f.time.resolve(
    f.reads.read("https://venue.test/info?token=" + secret, {
      type: "allMids",
      user: secret,
    }),
  );
  await f.time.advance(60001);
  await f.time.resolve(
    f.reads.read("https://venue.test/info", { type: "allMids", user: secret }),
  );
  const text = JSON.stringify(f.reports);
  assert.ok(!text.includes(secret));
  assert.ok(!text.includes("https://"));
  assert.ok(!text.includes("token="));
  assert.equal(f.attempts.length, 2);
});

it("three high-DEX actual account pipelines and six sources recover complete observations across rolling windows", async (context) => {
  const time = new FakeTime(),
    base = 1793200000000;
  context.mock.method(Date, "now", () => base + time.at);
  const old = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  context.after(() => {
    if (old === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = old;
  });
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const trace: {
      at: number;
      type: string;
      user?: string;
      dex?: string;
      cost: number;
      round?: number;
    }[] = [],
    rounds = new Map<string, number>();
  const completed = [0, 0, 0],
    denied = [0, 0, 0];
  const durations: number[] = [];
  let sourceComplete = 0;
  const fetcher = (async (_url, init) => {
    const p = JSON.parse(String(init?.body));
    let data: unknown;
    switch (p.type) {
      case "clearinghouseState":
        data = {
          marginSummary: {
            accountValue: p.user.startsWith("source") ? "100" : "0",
          },
          withdrawable: "0",
          assetPositions: [],
        };
        break;
      case "frontendOpenOrders":
      case "userFillsByTime":
      case "userFunding":
      case "userNonFundingLedgerUpdates":
        data = [];
        break;
      case "allMids":
        data = { BTC: "100" };
        break;
      case "meta":
        data = {
          collateralToken: 0,
          universe: [{ name: "BTC", maxLeverage: 10, szDecimals: 3 }],
        };
        break;
      case "userAbstraction":
        data = "unifiedAccount";
        break;
      case "userDexAbstraction":
        data = false;
        break;
      case "spotClearinghouseState":
        data = {
          balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }],
        };
        break;
      case "perpDexs":
        data = [
          null,
          ...Array.from({ length: 10 }, (_, i) => ({ name: `dex${i}` })),
        ];
        break;
      default:
        assert.fail("Unexpected provider type " + p.type);
    }
    trace.push({
      at: time.at,
      type: p.type,
      user: p.user,
      dex: p.dex,
      cost: responseCost(readCost(p), data),
      round: rounds.get(p.user),
    });
    assert.ok(budget.snapshot().used <= 1000);
    return new Promise<Response>((resolve) =>
      time.timers.setTimeout(
        () => resolve(new Response(JSON.stringify(data))),
        1,
      ),
    );
  }) as typeof fetch;
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any;
  stub.venueReads = new VenueReads(fetcher, () => base + time.at, 2, {
    budget,
    timers: time.timers,
    report: () => {},
  });
  stub.core = async (op: string, input: any) => {
    assert.equal(op, "perps_account");
    return { master: input.account_id, status: 4 };
  };
  stub.resolve = async (id: string) => ({ address: id, tags: [] });
  const intervalHandles = new Set<{ id: unknown; stopped: boolean }>();
  stub.sourceFeed.close();
  stub.sourceFeed = new SourceFeed((id: string) => stub.readSource(id), {
    clock: () => base + time.at,
    timers: {
      setInterval(run, ms) {
        const h = { id: undefined as unknown, stopped: false, unref() {} };
        const repeat = () => {
          if (h.stopped) return;
          run();
          h.id = time.timers.setTimeout(repeat, ms);
        };
        h.id = time.timers.setTimeout(repeat, ms);
        intervalHandles.add(h);
        return h;
      },
      clearInterval(h) {
        const x = h as unknown as { id: unknown; stopped: boolean };
        x.stopped = true;
        time.timers.clearTimeout(x.id);
      },
    },
  });
  const sleep = (ms: number) =>
    new Promise<void>((r) => time.timers.setTimeout(r, ms));
  const accountLoops = [0, 1, 2].map(async (i) => {
    const user = `account${i}`,
      p = {
        account_id: user,
        venue_accounts: { perps: user },
        sleeves: [],
        executions: [],
        ledger_started_at: base - 1000,
      } as any;
    while (time.at < 130000) {
      const round = (rounds.get(user) ?? 0) + 1;
      rounds.set(user, round);
      const started = time.at;
      try {
        const snap = await bridge.perpsAccount(user, p);
        assert.equal(snap.coverage_complete, true);
        assert.equal(snap.observed_at, base + time.at);
        assert.equal(snap.account_value_usdc, "100.000000");
        durations.push(time.at - started);
        assert.ok(
          time.at - started <= 20000,
          "complete account evidence must arrive inside the existing bridge transport deadline",
        );
        const calls = trace.filter((x) => x.user === user && x.round === round);
        for (let dex = 0; dex < 10; dex++)
          for (const type of ["clearinghouseState", "frontendOpenOrders"])
            assert.ok(
              calls.some((x) => x.type === type && x.dex === `dex${dex}`),
              "a completed snapshot must include every foreign scope",
            );
        for (const type of [
          "userFillsByTime",
          "userFunding",
          "userNonFundingLedgerUpdates",
        ])
          assert.ok(
            calls.some((x) => x.type === type),
            "history cannot be skipped",
          );
        if (i === 0) {
          const observation = await bridge.source("source0");
          const history = (await bridge.operation("source_fills", {
            trader_id: "source0",
            market: "perps",
            start_at: base - 1000,
            end_at: observation.observed_at,
          })) as { complete: boolean };
          assert.equal(
            history.complete,
            true,
            "the fixed source history must also complete without advancing a fabricated cursor",
          );
        }
        completed[i]++;
      } catch (error: any) {
        assert.ok(
          ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(
            error.code,
          ),
          String(error),
        );
        denied[i]++;
      }
      await sleep(5000);
    }
  });
  const sourceLoop = (async () => {
    while (time.at < 130000) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          bridge.source(`source${i}`).then(
            () => {
              sourceComplete++;
            },
            () => {},
          ),
        ),
      );
      await sleep(5000);
    }
  })();
  try {
    await time.advance(160000);
    await Promise.all([...accountLoops, sourceLoop]);
    assert.ok(
      completed.every((x) => x > 0),
      JSON.stringify({
        completed,
        denied,
        sourceComplete,
        budget: budget.snapshot(),
      }),
    );
    assert.ok(sourceComplete >= 6);
    context.diagnostic(
      JSON.stringify({
        completed,
        denied,
        sourceComplete,
        maximumSnapshotMs: Math.max(...durations),
        providerAttempts: trace.length,
      }),
    );
    for (const request of trace) {
      const inWindow = trace
        .filter((x) => x.at > request.at - 60000 && x.at <= request.at)
        .reduce((n, x) => n + x.cost, 0);
      assert.ok(inWindow <= 1000, JSON.stringify({ at: request.at, inWindow }));
    }
    assert.ok(budget.snapshot().account_queued <= 256);
    assert.ok(budget.snapshot().source_queued <= 256);
  } finally {
    await bridge.close();
  }
});

it("shared metadata floods do not starve private owners and expired turns wake without new requests", async () => {
  const f = setup();
  let ownerA = 0,
    ownerB = 0;
  const flood = Array.from({ length: 80 }, (_, i) =>
    f.reads
      .read("https://venue.test/info", { type: "meta", nonce: i }, 0, "source")
      .catch(() => {}),
  );
  const a = Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      f.reads
        .read(
          "https://venue.test/info",
          { type: "userAbstraction", user: "a", nonce: i },
          0,
          "source",
        )
        .then(
          () => {
            ownerA++;
          },
          () => {},
        ),
    ),
  );
  const b = Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      f.reads
        .read(
          "https://venue.test/info",
          { type: "userAbstraction", user: "b", nonce: i },
          0,
          "source",
        )
        .then(
          () => {
            ownerB++;
          },
          () => {},
        ),
    ),
  );
  await f.time.advance(12001);
  await Promise.all([...flood, a, b]);
  assert.equal(ownerA, 5);
  assert.equal(ownerB, 5);
  const time = new FakeTime(),
    budget = new VenueReadBudget({
      limit: 120,
      clock: time.clock,
      timers: time.timers,
    });
  const first = await budget.acquire(
    "account",
    20,
    "a",
    new AbortController().signal,
  );
  first.sent();
  first.settle(20);
  first.release();
  await time.advance(10000);
  const ca = new AbortController(),
    cb = new AbortController();
  const larger = budget.acquire("account", 120, "a", ca.signal).catch((e) => e);
  let smallDone = false;
  const smaller = budget.acquire("account", 2, "b", cb.signal).then((t) => {
    smallDone = true;
    return t;
  });
  await time.advance(2001);
  assert.equal(
    smallDone,
    true,
    "turn expiry must make progress even without incoming traffic",
  );
  const ticket = await smaller;
  ticket.sent();
  ticket.settle(2);
  ticket.release();
  ca.abort();
  await larger;
});

it("constant known-cost pressure never earns a refill burst outside a rolling minute", async () => {
  const f = setup(1000);
  const pending: Promise<unknown>[] = [];
  for (let tick = 0; tick < 130; tick++) {
    for (let i = 0; i < 20; i++)
      pending.push(
        f.reads
          .read(
            "https://venue.test/info",
            {
              type: "frontendOpenOrders",
              user: `owner${i % 3}`,
              tick,
              nonce: i,
            },
            0,
            i % 2 ? "account" : "source",
          )
          .catch(() => undefined),
      );
    await f.time.advance(1000);
  }
  await f.time.advance(12001);
  await Promise.all(pending);
  assert.ok(f.attempts.length > 50);
  for (const attempt of f.attempts) {
    const actual =
      f.attempts.filter((x) => x.at > attempt.at - 60000 && x.at <= attempt.at)
        .length * 20;
    assert.ok(actual <= 1000, JSON.stringify({ at: attempt.at, actual }));
  }
  assert.equal(f.budget.snapshot().account_queued, 0);
  assert.equal(f.budget.snapshot().source_queued, 0);
});

it("a late owner does not inherit a large unknown reservation that is refunded to a small actual fee", async () => {
  const time = new FakeTime(),
    budget = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  const first = await budget.acquire(
    "account",
    20,
    "a",
    new AbortController().signal,
    true,
  );
  first.sent();
  assert.equal(first.reservation, 1000);
  const order: string[] = [];
  const b = budget
    .acquire("account", 20, "b", new AbortController().signal)
    .then((t) => {
      order.push("b");
      return t;
    });
  first.settle(20);
  first.release();
  // Keep A's current turn occupied while B and A's next request both wait.
  // A new owner must not inherit the unearned 1000-weight unknown hold.
  const second = await budget.acquire(
    "account",
    20,
    "a",
    new AbortController().signal,
  );
  second.sent();
  const a = budget
    .acquire("account", 20, "a", new AbortController().signal)
    .then((t) => {
      order.push("a");
      return t;
    });
  await time.advance(12001);
  second.settle(20);
  second.release();
  await time.advance(5);
  const bt = await b;
  bt.sent();
  bt.settle(20);
  bt.release();
  await time.advance(5);
  const at = await a;
  at.sent();
  at.settle(20);
  at.release();
  assert.deepEqual(order, ["b", "a"]);
  assert.equal(budget.snapshot().used, 80);
});
