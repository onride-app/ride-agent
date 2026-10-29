import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
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

it("retry advice waits for enough expiring weight to fit the denied reservation", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    limit: 130,
    clock: time.clock,
    timers: time.timers,
  });
  const charge = async (weight: number) => {
    const ticket = await budget.acquire(
      "account",
      weight,
      "a",
      new AbortController().signal,
    );
    ticket.sent();
    ticket.settle(weight);
    ticket.release();
  };
  await charge(2);
  await time.advance(10000);
  await charge(120);
  await time.advance(10000);
  const controller = new AbortController();
  const denied = budget
    .acquire("account", 60, "a", controller.signal)
    .catch((e) => e);
  controller.abort();
  const error = await denied;
  assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
  // The first charge expires in 40s, but only the 120-weight expiry in 50s
  // leaves room for this 60-weight request.
  assert.equal(error.details.retry_after_ms, 50000);
});

it("retry advice includes a response-contract quarantine even when capacity is free", async () => {
  const f = setup();
  f.budget.quarantine();
  const controller = new AbortController();
  const denied = f.budget
    .acquire("account", 2, "a", controller.signal)
    .catch((e) => e);
  controller.abort();
  assert.equal((await denied).details.retry_after_ms, 60000);
});

it("gives healthy unknown-surcharge wire work time after queueing within the original 20-second account boundary", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    limit: 100,
    clock: time.clock,
    timers: time.timers,
  });
  const ticket = await budget.acquire(
    "account",
    100,
    "earlier",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(100);
  ticket.release();
  let fetches = 0;
  const reads = new VenueReads(
    (async () => {
      fetches++;
      return new Promise<Response>((resolve) =>
        time.timers.setTimeout(() => resolve(new Response("[]")), 5),
      );
    }) as typeof fetch,
    time.clock,
    2,
    { budget, timers: time.timers },
  );
  await time.advance(48001);
  const work = reads.observeAccount(() =>
    reads.read("https://venue.test/info", { type: "userFunding", user: "a" }),
  );
  await time.advance(12004);
  assert.deepEqual(await work, []);
  assert.equal(fetches, 1);
  assert.equal(reads.diagnostics().counts.unknown_uncertain, 0);
  assert.equal(budget.snapshot().quarantine_ms, 0);
});

it("ends queued account work at 20 seconds without dispatch or an unknown charge", async () => {
  const f = setup();
  const ticket = await f.budget.acquire(
    "account",
    1000,
    "earlier",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(1000);
  ticket.release();
  await f.time.advance(40000);
  const work = f.reads
    .observeAccount(() =>
      f.reads.read("https://venue.test/info", {
        type: "userFunding",
        user: "a",
      }),
    )
    .catch((e) => e);
  await f.time.advance(20000);
  assert.ok(
    ["VENUE_READ_DEADLINE", "VENUE_READ_BUDGET_EXHAUSTED"].includes(
      (await work).code,
    ),
  );
  assert.equal(f.attempts.length, 0);
  assert.equal(f.budget.snapshot().quarantine_ms, 0);
  assert.equal(f.budget.snapshot().account_queued, 0);
});

it("caps queue plus wire at 20 seconds while a real unknown wire timeout still quarantines", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const ticket = await budget.acquire(
    "account",
    1000,
    "earlier",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(1000);
  ticket.release();
  let sentAt = -1;
  await time.advance(50000);
  const reads = new VenueReads(
    (async () => {
      sentAt = time.at;
      return new Promise<Response>((resolve) =>
        time.timers.setTimeout(() => resolve(new Response("[]")), 11000),
      );
    }) as typeof fetch,
    time.clock,
    2,
    { budget, timers: time.timers },
  );
  const work = reads
    .observeAccount(() =>
      reads.read("https://venue.test/info", { type: "userFunding", user: "a" }),
    )
    .catch((e) => e);
  await time.advance(20000);
  assert.equal((await work).code, "VENUE_READ_DEADLINE");
  assert.equal(sentAt, 60000);
  assert.equal(budget.snapshot().quarantine_ms, 60000);
  assert.equal(reads.diagnostics().counts.unknown_uncertain, 1);
  await time.advance(2000);
  assert.equal(
    budget.snapshot().used,
    1000,
    "late healthy JSON cannot refund a genuine expired observation",
  );
});

it("retains the 12-second wire limit for an already-sent unknown response inside a 20-second frame", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const reads = new VenueReads(
    (async () => new Promise<Response>(() => {})) as typeof fetch,
    time.clock,
    2,
    { budget, timers: time.timers },
  );
  const work = reads
    .observeAccount(() =>
      reads.read("https://venue.test/info", { type: "userFunding", user: "a" }),
    )
    .catch((e) => e);
  await time.advance(12000);
  assert.equal((await work).code, "VENUE_READ_DEADLINE");
  assert.equal(budget.snapshot().quarantine_ms, 60000);
  assert.equal(reads.diagnostics().counts.unknown_uncertain, 1);
  assert.equal(budget.snapshot().used, 1000);
});

it("cancels queued siblings after failure but lets an already-sent unknown response settle", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const types: string[] = [];
  const reads = new VenueReads(
    (async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      types.push(payload.type);
      return new Promise<Response>((resolve) =>
        time.timers.setTimeout(() => resolve(new Response("[]")), 5),
      );
    }) as typeof fetch,
    time.clock,
    2,
    { budget, timers: time.timers },
  );
  const cause = new Error("sibling failed");
  const work = reads
    .observeAccount(() =>
      Promise.all([
        reads.read("https://venue.test/info", {
          type: "userFunding",
          user: "a",
        }),
        reads.read("https://venue.test/info", { type: "meta" }),
        new Promise<never>((_, reject) =>
          time.timers.setTimeout(() => reject(cause), 1),
        ),
      ]),
    )
    .catch((e) => e);
  await time.advance(10);
  assert.equal(await work, cause);
  assert.deepEqual(types, ["userFunding"]);
  assert.equal(budget.snapshot().account_queued, 0);
  assert.equal(budget.snapshot().used, 20);
  assert.equal(budget.snapshot().quarantine_ms, 0);
  assert.equal(reads.diagnostics().counts.unknown_uncertain, 0);
});

it("scope cancellation cannot cancel another caller queued for the same uncached read", async () => {
  const f = setup(100);
  const ticket = await f.budget.acquire(
    "account",
    100,
    "earlier",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(100);
  ticket.release();
  await f.time.advance(59990);
  const cause = new Error("first scope failed");
  const first = f.reads
    .observeAccount(() =>
      Promise.all([
        f.reads.read("https://venue.test/info", { type: "meta" }),
        new Promise<never>((_, reject) =>
          f.time.timers.setTimeout(() => reject(cause), 1),
        ),
      ]),
    )
    .catch((e) => e);
  const second = f.reads.observeAccount(() =>
    f.reads.read("https://venue.test/info", { type: "meta" }),
  );
  await f.time.advance(20);
  assert.equal(await first, cause);
  assert.deepEqual(await second, {});
  assert.equal(f.attempts.length, 1);
  assert.equal(f.budget.snapshot().used, 20);
});

it("an unknown hold cannot switch the owning turn before its small actual cost is refunded", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const first = await budget.acquire(
    "account",
    20,
    "a",
    new AbortController().signal,
    true,
  );
  first.sent();
  const order: string[] = [];
  const b = budget
    .acquire("account", 20, "b", new AbortController().signal)
    .then((t) => {
      order.push("b");
      return t;
    });
  const a = budget
    .acquire("account", 20, "a", new AbortController().signal)
    .then((t) => {
      order.push("a");
      return t;
    });
  first.settle(20);
  first.release();
  const at = await a;
  at.sent();
  at.settle(20);
  at.release();
  await time.advance(3);
  const bt = await b;
  bt.sent();
  bt.settle(20);
  bt.release();
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(budget.snapshot().used, 60);
  await time.advance(60001);
  assert.equal(budget.snapshot().used, 0);
  assert.equal(budget.snapshot().account_active, 0);
  assert.equal(budget.snapshot().account_queued, 0);
});

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

it("a caller deadline cancels queued admission without sending or charging a new read", async () => {
  const f = setup();
  const ticket = await f.budget.acquire(
    "account",
    1000,
    "prior",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(1000);
  ticket.release();
  const controller = new AbortController();
  let calls = 0;
  const reads = new VenueReads(
    (async () => {
      calls++;
      return Response.json({});
    }) as typeof fetch,
    f.time.clock,
    2,
    {
      budget: f.budget,
      timers: f.time.timers,
      signal: controller.signal,
    },
  );
  const work = reads
    .read("https://venue.test/info", { type: "meta" })
    .catch((e) => e);
  await f.time.advance(5);
  const cause = new Error("caller deadline");
  controller.abort(cause);
  await flush();
  assert.equal(await work, cause);
  assert.equal(calls, 0);
  assert.equal(f.budget.snapshot().used, 1000);
  assert.equal(f.budget.snapshot().account_queued, 0);
});

it("a caller deadline also bounds in-flight JSON without publishing a late value", async () => {
  const f = setup();
  const controller = new AbortController();
  const reads = new VenueReads(
    (async () =>
      new Response(new ReadableStream({ start() {} }))) as typeof fetch,
    f.time.clock,
    2,
    {
      budget: f.budget,
      timers: f.time.timers,
      signal: controller.signal,
    },
  );
  const work = reads
    .read("https://venue.test/info", { type: "meta" })
    .catch((e) => e);
  await f.time.advance(5);
  const cause = new Error("caller deadline");
  controller.abort(cause);
  await flush();
  assert.equal(await work, cause);
  assert.equal(f.budget.snapshot().used, 20);
  assert.equal(f.budget.snapshot().account_active, 0);
});

for (const retryAfter of [undefined, "2"]) {
  it(`a 429 with ${retryAfter ?? "no"} Retry-After stops both lanes for a full minute`, async () => {
    const time = new FakeTime();
    const budget = new VenueReadBudget({
      clock: time.clock,
      timers: time.timers,
    });
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return calls === 1
        ? new Response("", {
            status: 429,
            headers: retryAfter ? { "retry-after": retryAfter } : {},
          })
        : new Response("{}");
    }) as typeof fetch;
    const a = new VenueReads(fetcher, time.clock, 2, {
      budget,
      timers: time.timers,
    });
    const b = new VenueReads(fetcher, time.clock, 2, {
      budget,
      timers: time.timers,
    });
    const error = await time.resolve(
      a.read("https://venue.test/info", { type: "allMids" }).catch((e) => e),
    );
    assert.equal(error.code, "VENUE_RATE_LIMITED");
    assert.equal(error.details.retry_after_ms, 60000);
    await time.advance(59999 - time.at);
    await assert.rejects(
      b.read("https://venue.test/info", { type: "meta" }, 0, "source"),
      { code: "VENUE_RATE_LIMITED" },
    );
    assert.equal(
      calls,
      1,
      "neither lane may probe into the rejected IP quota window",
    );
    await time.advance(1);
    await time.resolve(
      b.read("https://venue.test/info", { type: "meta" }, 0, "source"),
    );
    assert.equal(calls, 2);
  });
}

it("a late successful response cannot reopen a quota window rejected by 429", async () => {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    const type = JSON.parse(String(init?.body)).type;
    if (type === "meta")
      return new Promise<Response>((resolve) =>
        time.timers.setTimeout(() => resolve(new Response("{}")), 1500),
      );
    return new Response("", { status: 429 });
  }) as typeof fetch;
  const reads = new VenueReads(fetcher, time.clock, 2, {
    budget,
    timers: time.timers,
  });
  const slowSuccess = reads.read("https://venue.test/info", { type: "meta" });
  const limited = reads
    .read("https://venue.test/info", { type: "allMids" }, 0, "source")
    .catch((e) => e);
  await time.advance(2000);
  assert.equal((await limited).code, "VENUE_RATE_LIMITED");
  assert.deepEqual(await slowSuccess, {});
  await assert.rejects(
    reads.read("https://venue.test/info", { type: "allMids" }),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().provider_cooldown_ms, 58000);
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

async function highDexObservationLoad(context: TestContext, wireMs: number, mode: "unified" | "rwa" = "unified") {
  const time = new FakeTime(),
    base = 1793200000000;
  context.mock.method(Date, "now", () => base + time.at);
  const old = process.env.RIDE_AGENT_UNIFIED_ENABLED,
    oldRwa = process.env.RIDE_AGENT_RWA_ENABLED;
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  context.after(() => {
    if (old === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = old;
    if (oldRwa === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = oldRwa;
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
  const successTimes: number[][] = [[], [], []];
  const sourceSuccessTimes: number[][] = Array.from({ length: 6 }, () => []);
  const horizon = wireMs === 500 ? 650000 : 500000,
    warmup = wireMs === 500 ? 200000 : 140000;
  let sourceComplete = 0, sourceHistoryComplete = 0, sourceHistoryDenied = 0;
  const fetcher = (async (_url, init) => {
    const p = JSON.parse(String(init?.body));
    let data: unknown;
    switch (p.type) {
      case "clearinghouseState":
        data = {
          marginSummary: {
            accountValue: p.user.startsWith("source") || (mode === "rwa" && !p.dex) ? "100" : mode === "rwa" ? "10" : "0",
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
        data = mode === "unified" ? "unifiedAccount" : "disabled";
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
        wireMs,
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
        sleeves: mode === "rwa" ? [{ trader: { market: "perps", assets: ["rwa0:BTC", "rwa1:BTC"] } }] : [],
        executions: [],
        ledger_started_at: base - 1000,
      } as any;
    while (time.at < horizon) {
      let retryDelay = wireMs === 500 ? 90000 : 5000;
      const round = (rounds.get(user) ?? 0) + 1;
      rounds.set(user, round);
      const started = time.at;
      try {
        const snap = await bridge.perpsAccount(user, p);
        assert.equal(snap.coverage_complete, true);
        assert.ok(snap.observed_at >= base + started - 1000,
          "only the existing one-second public price cache may predate this account frame");
        assert.ok(snap.observed_at < base + time.at);
        assert.ok(base + time.at - snap.observed_at <= 20000);
        assert.equal(snap.account_value_usdc, mode === "unified" ? "100.000000" : "120");
        durations.push(time.at - started);
        assert.ok(
          time.at - started <= 20000,
          "complete account evidence must arrive inside the existing bridge transport deadline",
        );
        const calls = trace.filter((x) => x.user === user && x.round === round);
        assert.ok(calls.every(x => x.at >= started), "private account evidence must be fetched during this attempt");
        for (const type of ["clearinghouseState", "frontendOpenOrders", "userAbstraction"])
          assert.ok(calls.some(x => x.type === type && !x.dex), "native account evidence must be fetched during every complete attempt");
        if (mode === "unified")
          assert.ok(calls.some(x => x.type === "spotClearinghouseState"), "unified spot collateral must not be reused from an old frame");
        assert.ok(snap.observed_at <= base + Math.min(...calls.map(x => x.at)) + wireMs,
          "snapshot freshness must use its earliest actual response rather than stamp the end of the frame");
        for (const dex of mode === "unified" ? Array.from({ length: 10 }, (_, j) => `dex${j}`) : ["rwa0", "rwa1"])
          for (const type of ["clearinghouseState", "frontendOpenOrders"])
            assert.ok(
              calls.some((x) => x.type === type && x.dex === dex),
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
        completed[i]++;
        successTimes[i].push(time.at);
        if (i === 0) {
          try {
            const observation = await bridge.source("source0");
            const history = (await bridge.operation("source_fills", {
              trader_id: "source0",
              market: "perps",
              start_at: base - 1000,
              end_at: observation.observed_at,
            })) as { complete: boolean };
            assert.equal(history.complete, true,
              "the fixed source history must complete without advancing a fabricated cursor");
            sourceHistoryComplete++;
          } catch (error: any) {
            assert.ok(["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(error.code), String(error));
            sourceHistoryDenied++;
          }
        }
      } catch (error: any) {
        retryDelay = Math.max(1000, error.details?.retry_after_ms ?? 5000);
        assert.ok(
          ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(
            error.code,
          ),
          String(error),
        );
        denied[i]++;
      }
      // Realistic wire latency uses bounded offered load, not three ~16s
      // frames every 5s from the one-slot account lane.
      await sleep(retryDelay);
    }
  });
  const sourceLoop = (async () => {
    while (time.at < horizon) {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          bridge.source(`source${i}`).then(
            () => {
              sourceComplete++;
              sourceSuccessTimes[i].push(time.at);
            },
            () => {},
          ),
        ),
      );
      await sleep(5000);
    }
  })();
  try {
    await time.advance(horizon + 180000);
    await Promise.all([...accountLoops, sourceLoop]);
    assert.ok(
      completed.every((x) => x >= 3),
      JSON.stringify({
        completed,
        denied,
        successTimes,
        sourceComplete,
        budget: budget.snapshot(),
      }),
    );
    assert.ok(sourceComplete >= 6);
    assert.ok(sourceSuccessTimes.every(times => times.some(at => at >= warmup)),
      "every public source owner must progress after the cold account warmup");
    const steady = successTimes.map(times => times.filter(at => at >= warmup));
    assert.ok(steady.every(times => times.length >= 2), JSON.stringify({ warmup, steady, denied }));
    const steadyGaps = steady.map(times => {
      const bounded = [warmup, ...times.filter(at => at <= horizon), horizon];
      return Math.max(0, ...bounded.slice(1).map((at, j) => at - bounded[j]));
    });
    assert.ok(steadyGaps.every(gap => gap <= 180000), JSON.stringify({ steady, steadyGaps }));
    if (wireMs === 500) assert.ok(sourceHistoryComplete > 0, "bounded offered load must leave the fixed source history live");
    context.diagnostic(
      JSON.stringify({
        completed,
        denied,
        sourceComplete,
        sourceHistoryComplete,
        sourceHistoryDenied,
        mode,
        warmup,
        successTimes,
        steadyGaps,
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
}

for (const wireMs of [1, 500])
  it(`three high-DEX actual account pipelines and six sources recover complete observations at ${wireMs}ms wire latency${wireMs === 500 ? " with bounded offered load" : " under high load"}`, (context) =>
    highDexObservationLoad(context, wireMs));

it("three standard accounts with every configured RWA scope and mandatory history keep progressing at 500ms wire latency", context =>
  highDexObservationLoad(context, 500, "rwa"));

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
  await time.advance(10001);
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
  await time.advance(20001);
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
