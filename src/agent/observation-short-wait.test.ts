import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";

async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
class Time {
  at = 0;
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
  async advance(ms: number, late = false) {
    const end = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, event]) => event.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = late ? end : next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  pending() {
    return this.events.size;
  }
}
const url = "https://venue.test/info";
function setup(caller?: AbortSignal) {
  const time = new Time();
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const sent: { at: number; method: string }[] = [];
  const reads = new VenueReads(
    (async (_url, init) => {
      sent.push({ at: time.at, method: JSON.parse(String(init?.body)).type });
      return new Response("{}");
    }) as typeof fetch,
    time.clock,
    2,
    { budget, timers: time.timers, signal: caller, report: () => {} },
  );
  const account = () =>
    reads.read(url, { type: "clearinghouseState", user: "a" });
  return { time, budget, reads, sent, account };
}
async function train(f: ReturnType<typeof setup>) {
  const frame = f.budget.beginObservation("a");
  const ticket = await f.budget.acquire(
    "account",
    20,
    "a",
    new AbortController().signal,
    false,
    frame,
  );
  ticket.sent();
  ticket.settle(20);
  ticket.release();
  frame.close(true);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 1500);
}
function deferred(ms: unknown, code = "VENUE_READ_BUDGET_EXHAUSTED") {
  return new AgentError(code, "Fixture admission wait", true, 503, {
    // Exercise malformed runtime hints despite the compile-time contract.
    retry_after_ms: ms as number,
  });
}

it("waits a genuine 141ms FIFO pacing remainder before the first financial dispatch, sharing admission across sibling reads", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(1359);
  const work = f.reads.observeAccount(async () => {
    await Promise.all([f.account(), f.reads.read(url, { type: "meta" })]);
    return f.reads.accountObservedAt();
  }, "a");
  await f.time.advance(140);
  assert.equal(f.sent.length, 0);
  assert.equal(f.budget.snapshot().observation_active, false);
  assert.equal(f.budget.snapshot().used, 20);
  await f.time.advance(5);
  assert.equal(
    await work,
    1500,
    "queue time cannot become the financial evidence timestamp",
  );
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every((read) => read.at >= 1500));
  assert.equal(f.budget.snapshot().observations.started, 2);
  assert.equal(f.budget.snapshot().observations.completed, 2);
  assert.equal(f.budget.snapshot().used, 42);
  assert.equal(f.time.pending(), 0);
});

it("returns a genuine long pacing hint immediately instead of holding the account transaction", async () => {
  const f = setup();
  await train(f);
  await assert.rejects(
    f.reads.observeAccount(f.account, "a"),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.details?.retry_after_ms, 1500);
      return true;
    },
  );
  assert.equal(f.time.at, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.time.pending(), 0);
});

it("bounds repeated short deferrals to one fixed second across all sibling reads", async (t) => {
  const f = setup();
  let calls = 0;
  t.mock.method(f.budget, "beginObservation", () => {
    calls++;
    throw deferred(200);
  });
  const work = f.reads
    .observeAccount(() => Promise.all([f.account(), f.account()]), "a")
    .catch((e) => e);
  await f.time.advance(1000);
  assert.equal((await work).code, "VENUE_READ_BUDGET_EXHAUSTED");
  assert.equal(
    calls,
    6,
    "siblings share one admission loop and one cumulative deadline",
  );
  assert.equal(f.sent.length, 0);
  assert.equal(f.time.pending(), 0);
  await f.time.advance(60000);
  assert.equal(calls, 6);
});

it("does not dispatch after a local admission timer oversleeps its fixed one-second boundary", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(1359);
  const work = f.reads.observeAccount(f.account, "a").catch((e) => e);
  await f.time.advance(1200, true);
  assert.equal((await work).code, "VENUE_READ_BUDGET_EXHAUSTED");
  assert.equal(f.budget.snapshot().observations.started, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.time.pending(), 0);
});

it("rechecks real capacity and preserves a fully charged pending hold after the short local wait", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(60001);
  for (let n = 0; n < 8; n++) {
    const ticket = await f.budget.acquire(
      "source",
      100,
      "source",
      new AbortController().signal,
    );
    ticket.sent();
    ticket.settle(100);
    ticket.release();
  }
  const pending = await f.budget.acquire(
    "source",
    120,
    "source",
    new AbortController().signal,
  );
  pending.sent();
  const work = f.reads.observeAccount(f.account, "a").catch((e) => e);
  await f.time.advance(500);
  pending.settle(120);
  pending.release();
  await f.time.advance(500);
  const error = await work;
  assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
  assert.equal(error.details.retry_after_ms, 59000);
  assert.equal(f.sent.length, 0);
  assert.equal(f.budget.snapshot().used, 920);
  assert.equal(f.budget.snapshot().observations.started, 1);
});

it("admits only after a pending hold genuinely settles smaller, retaining all actual weight", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(60001);
  for (let n = 0; n < 8; n++) {
    const ticket = await f.budget.acquire(
      "source",
      100,
      "source",
      new AbortController().signal,
    );
    ticket.sent();
    ticket.settle(100);
    ticket.release();
  }
  const pending = await f.budget.acquire(
    "source",
    120,
    "source",
    new AbortController().signal,
  );
  pending.sent();
  const work = f.reads.observeAccount(f.account, "a");
  await f.time.advance(500);
  assert.equal(f.sent.length, 0);
  pending.settle(20);
  pending.release();
  await f.time.advance(500);
  assert.deepEqual(await work, {});
  assert.equal(f.sent[0].at, 61001);
  assert.equal(f.budget.snapshot().used, 822);
});

it("cancels a local wait with the caller signal and never sends after cancellation", async () => {
  const stop = new AbortController();
  const f = setup(stop.signal);
  await train(f);
  await f.time.advance(1359);
  const cause = new Error("caller left");
  const work = f.reads.observeAccount(f.account, "a").catch((e) => e);
  await f.time.advance(50);
  stop.abort(cause);
  await flush();
  assert.equal(await work, cause);
  await f.time.advance(60000);
  assert.equal(f.sent.length, 0);
  assert.equal(f.time.pending(), 0);
});

it("keeps the original 20-second scope deadline while awaiting a short admission hint", async (t) => {
  const f = setup();
  let calls = 0;
  t.mock.method(f.budget, "beginObservation", () => {
    calls++;
    throw deferred(100);
  });
  const work = f.reads
    .observeAccount(async () => {
      await new Promise<void>((resolve) =>
        f.time.timers.setTimeout(resolve, 19900),
      );
      return f.account();
    }, "a")
    .catch((e) => e);
  await f.time.advance(20000);
  assert.equal((await work).code, "VENUE_READ_DEADLINE");
  assert.equal(calls, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.time.pending(), 0);
});

it("cannot overtake an earlier cold FIFO owner after its short local wait", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(1359);
  assert.throws(() => f.budget.beginObservation("earlier"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  const work = f.reads.observeAccount(f.account, "a").catch((e) => e);
  await f.time.advance(1000);
  assert.equal((await work).code, "VENUE_READ_BUDGET_EXHAUSTED");
  assert.equal(f.budget.snapshot().observation_queued, 2);
  assert.equal(f.budget.snapshot().observations.started, 1);
  assert.equal(f.sent.length, 0);
});

it("cancels sibling admission waits when the enclosing account scope fails", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(1359);
  const cause = new Error("account sibling failed");
  const work = f.reads
    .observeAccount(
      () =>
        Promise.all([
          f.account(),
          new Promise<never>((_, reject) =>
            f.time.timers.setTimeout(() => reject(cause), 20),
          ),
        ]),
      "a",
    )
    .catch((e) => e);
  await f.time.advance(1000);
  assert.equal(await work, cause);
  assert.equal(f.sent.length, 0);
  assert.equal(f.time.pending(), 0);
});

for (const retry of [0, -1, 0.5, 1001, NaN, Infinity, "141", undefined])
  it(`does not locally wait for an invalid or overlong retry hint (${String(retry)})`, async (t) => {
    const f = setup();
    const cause = deferred(retry);
    t.mock.method(f.budget, "beginObservation", () => {
      throw cause;
    });
    assert.equal(
      await f.reads.observeAccount(f.account, "a").catch((e) => e),
      cause,
    );
    assert.equal(f.time.at, 0);
    assert.equal(f.sent.length, 0);
    assert.equal(f.time.pending(), 0);
  });

it("preserves a provider cooldown without waiting or dispatching", async () => {
  const f = setup();
  f.budget.note429(60000);
  const error = await f.reads.observeAccount(f.account, "a").catch((e) => e);
  assert.equal(error.code, "VENUE_RATE_LIMITED");
  assert.equal(error.details.retry_after_ms, 60000);
  assert.equal(f.time.at, 0);
  assert.equal(f.sent.length, 0);
});

it("honors a new provider 429 that arrives during the local wait", async () => {
  const f = setup();
  await train(f);
  await f.time.advance(1359);
  const work = f.reads.observeAccount(f.account, "a").catch((e) => e);
  await f.time.advance(50);
  f.budget.note429(60000);
  await f.time.advance(91);
  const error = await work;
  assert.equal(error.code, "VENUE_RATE_LIMITED");
  assert.equal(error.details.retry_after_ms, 59909);
  assert.equal(f.sent.length, 0);
  assert.equal(f.budget.snapshot().used, 20);
  assert.equal(f.budget.snapshot().observations.started, 1);
});

for (const cancellation of ["caller", "provider"] as const)
  it(`revalidates ${cancellation} cancellation after ready admission before returning cached prices`, async () => {
    const stop = new AbortController();
    const f = setup(stop.signal);
    const prices = () => f.reads.read(url, { type: "allMids" }, 1000);
    await f.reads.observeAccount(prices, "a");
    await f.time.advance(150);
    const cause = new Error("caller left during ready admission");
    const work = f.reads.observeAccount(prices, "a").catch((e) => e);
    if (cancellation === "caller") stop.abort(cause);
    else f.budget.note429(60000);
    await flush();
    const error = await work;
    if (cancellation === "caller") assert.equal(error, cause);
    else assert.equal(error.code, "VENUE_RATE_LIMITED");
    assert.equal(f.sent.length, 1);
    assert.equal(f.budget.snapshot().observation_active, false);
    assert.equal(f.budget.snapshot().observations.completed, 1);
  });
