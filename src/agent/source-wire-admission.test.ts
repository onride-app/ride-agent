import assert from "node:assert/strict";
import { it } from "node:test";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";

async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
class Clock {
  at = 0;
  seq = 0;
  events = new Map<number, { at: number; run(): void }>();
  timers: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++this.seq;
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
      const next = [...this.events]
        .filter(([, x]) => x.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
async function fixture(start = 48100, wireMs = 300) {
  const time = new Clock(),
    budget = new VenueReadBudget({ clock: () => time.at, timers: time.timers });
  const prior = await budget.acquire(
    "account",
    1000,
    "other",
    new AbortController().signal,
  );
  prior.sent();
  prior.settle(1000);
  prior.release();
  await time.advance(start);
  let calls = 0;
  const stop = new AbortController();
  const reads = new VenueReads(
    async () => {
      calls++;
      await new Promise<void>((resolve) =>
        time.timers.setTimeout(resolve, wireMs),
      );
      return Response.json(Array.from({ length: 380 }, (_, i) => ({ tid: i })));
    },
    () => time.at,
    2,
    { budget, timers: time.timers, signal: stop.signal, report: () => {} },
  );
  return {
    time,
    budget,
    reads,
    stop,
    get calls() {
      return calls;
    },
  };
}
it("does not send a fixed-history request after its queue consumes the final minimum wire window", async () => {
  const f = await fixture(),
    work = f.reads
      .read(
        "https://fixture.invalid/info",
        { type: "userFillsByTime", user: "source" },
        0,
        "source",
      )
      .catch((e) => e);
  await f.time.advance(12500);
  const error = await work;
  assert.ok(
    ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(error.code),
  );
  assert.equal(
    f.calls,
    0,
    "11900ms queue wait must not create a 100ms wire request and 120-weight unknown",
  );
  assert.equal(
    f.budget.snapshot().used,
    0,
    "an unsent expired admission retains no fabricated financial charge",
  );
});
it("retains a real 500ms source response admitted with at least one second left and clears only its queue cutoff", async () => {
  const f = await fixture(49500, 500),
    work = f.reads.read(
      "https://fixture.invalid/info",
      { type: "userFillsByTime", user: "source" },
      0,
      "source",
    );
  await f.time.advance(10500);
  assert.equal(f.calls, 1);
  assert.equal(
    [...f.time.events.values()].filter((event) => event.at === 60500).length,
    1,
    "only the response remains at the former admission cutoff; the queue timer was removed",
  );
  await f.time.advance(1500);
  assert.equal((await work).length, 380);
  assert.equal(f.calls, 1);
  assert.equal(
    f.budget.snapshot().used,
    39,
    "only the complete real response may refund the original 120 bound",
  );
});
it("keeps an already-sent source timeout at its full unknown weight and does not extend the original 12s deadline", async () => {
  const f = await fixture(60001, 13000),
    work = f.reads
      .read(
        "https://fixture.invalid/info",
        { type: "userFillsByTime", user: "source" },
        0,
        "source",
      )
      .catch((e) => e);
  await f.time.advance(12000);
  assert.equal((await work).code, "VENUE_READ_DEADLINE");
  assert.equal(f.calls, 1);
  assert.equal(f.budget.snapshot().used, 120);
  await f.time.advance(2000);
  assert.equal(f.budget.snapshot().used, 120);
});

it("rejects a same-turn ticket at the admission cutoff before sending and releases its unsent reservation", async () => {
  const time = new Clock(),
    budget = new VenueReadBudget({ clock: () => time.at, timers: time.timers });
  const held = await budget.acquire(
    "account",
    1000,
    "other",
    new AbortController().signal,
  );
  await time.advance(49000);
  time.timers.setTimeout(() => held.release(), 11000); // Earlier callback than the queue timeout.
  let calls = 0;
  const reads = new VenueReads(
    async () => {
      calls++;
      return Response.json([]);
    },
    () => time.at,
    2,
    { budget, timers: time.timers, report: () => {} },
  );
  const work = reads
    .read(
      "https://fixture.invalid/info",
      { type: "userFillsByTime", user: "source" },
      0,
      "source",
    )
    .catch((e) => e);
  await time.advance(12000);
  assert.equal((await work).code, "VENUE_READ_DEADLINE");
  assert.equal(calls, 0);
  assert.equal(budget.snapshot().used, 0);
});
it("does not dispatch or retain an unsent source hold after caller cancellation while queued", async () => {
  const f = await fixture(),
    reason = new Error("fixture caller cancelled");
  const work = f.reads
    .read(
      "https://fixture.invalid/info",
      { type: "userFillsByTime", user: "source" },
      0,
      "source",
    )
    .catch((e) => e);
  await f.time.advance(5000);
  f.stop.abort(reason);
  await flush();
  assert.equal(await work, reason);
  assert.equal(f.calls, 0);
  await f.time.advance(8000);
  assert.equal(f.budget.snapshot().used, 0);
});
