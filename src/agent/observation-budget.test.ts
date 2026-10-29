import assert from "node:assert/strict";
import { it } from "node:test";
import {
  VenueReadBudget,
  type BudgetTimers,
  type AccountReadReservation,
} from "./venue-read-budget.js";

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
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
  async advance(ms: number) {
    const end = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, e]) => e.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  async resolve<T>(work: Promise<T>): Promise<T> {
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
    for (let i = 0; !done && i < 20; i++) await this.advance(5);
    assert.equal(
      done,
      true,
      "a permitted frame read must not be stranded behind a protected source waiter",
    );
    if (error) throw error;
    return value;
  }
}
const signal = () => new AbortController().signal;
function setup() {
  const time = new Time();
  return {
    time,
    budget: new VenueReadBudget({ clock: time.clock, timers: time.timers }),
  };
}
async function charge(
  budget: VenueReadBudget,
  time: Time,
  cost: number,
  actual = cost,
  frame?: AccountReadReservation,
) {
  const ticket = await time.resolve(
    budget.acquire("account", cost, "a", signal(), false, frame),
  );
  ticket.sent();
  ticket.settle(actual);
  ticket.release();
}

it("a full cold observation shields its unused capacity without letting a source waiter block its own reads", async (t) => {
  const { time, budget } = setup();
  const frame = budget.beginObservation("a");
  const source = new AbortController();
  t.after(() => {
    source.abort();
    frame.close();
  });
  let sourceSent = false;
  const waiting = budget
    .acquire("source", 2, "public", source.signal)
    .then((ticket) => {
      sourceSent = true;
      ticket.sent();
      ticket.settle(2);
      ticket.release();
    })
    .catch(() => {});
  await charge(budget, time, 20, 20, frame);
  assert.equal(sourceSent, false);
  assert.equal(budget.snapshot().used, 20);
  frame.close(true);
  await time.advance(5);
  await waiting;
  assert.equal(sourceSent, true);
  assert.equal(
    budget.snapshot().used,
    22,
    "only actual wire reads remain charged after the frame closes",
  );
});

it("an unknown response provisional hold is excluded from the learned complete frame footprint", async () => {
  const { time, budget } = setup();
  const first = budget.beginObservation("a");
  await charge(budget, time, 20, 20, first);
  const unknown = await time.resolve(
    budget.acquire("account", 20, "a", signal(), true, first),
  );
  assert.ok(
    unknown.reservation > 900,
    "the real unknown response still needs the full exclusive hold",
  );
  unknown.sent();
  unknown.settle(20);
  unknown.release();
  first.close(true);
  await time.advance(60_001);
  const next = budget.beginObservation("a");
  assert.ok(
    budget.snapshot().observation_reserved < 1000,
    "a tiny verified response cannot teach every future frame to reserve the entire window",
  );
  assert.ok(
    budget.snapshot().observation_reserved >= 120,
    "a learned frame must still admit the maximum mandatory bounded history reservation",
  );
  next.close();
});

it("cold owners retain FIFO priority across retry deferrals instead of losing their place to cheap backfill", async (t) => {
  const { time, budget } = setup();
  const a = budget.beginObservation("a");
  await charge(budget, time, 20, 20, a);
  for (const owner of ["b", "c"])
    assert.throws(() => budget.beginObservation(owner), {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
    });
  a.close(true);
  const source = new AbortController();
  t.after(() => source.abort());
  let sourceSent = false;
  const pending = budget
    .acquire("source", 2, "public", source.signal)
    .then((ticket) => {
      sourceSent = true;
      ticket.sent();
      ticket.settle(2);
      ticket.release();
    })
    .catch(() => {});
  await time.advance(60_001);
  assert.equal(
    sourceSent,
    false,
    "the oldest full frame keeps the capacity it was told to wait for",
  );
  assert.throws(() => budget.beginObservation("c"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  const b = budget.beginObservation("b");
  await charge(budget, time, 20, 20, b);
  b.close(true);
  await time.advance(60_001);
  const c = budget.beginObservation("c");
  await charge(budget, time, 20, 20, c);
  c.close(true);
  await time.advance(5);
  await pending;
  assert.equal(sourceSent, true);
  assert.equal(budget.snapshot().observation_active, false);
  assert.equal(budget.snapshot().observation_queued, 0);
});

it("a growing frame fails before an unreserved dispatch and retains all real costs for the next attempt", async () => {
  const { time, budget } = setup();
  const training = budget.beginObservation("a");
  await charge(budget, time, 120, 20, training);
  training.close(true);
  await time.advance(60_001);
  const frame = budget.beginObservation("a");
  const learned = budget.snapshot().observation_reserved;
  assert.ok(learned >= 120 && learned < 1000);
  await charge(budget, time, 100, 100, frame);
  const publicTicket = await time.resolve(
    budget.acquire("source", 1000 - learned, "public", signal()),
  );
  publicTicket.sent();
  publicTicket.settle(1000 - learned);
  publicTicket.release();
  const before = budget.snapshot().used;
  const extra = learned + 1;
  await assert.rejects(
    budget.acquire("account", extra, "a", signal(), false, frame),
    { code: "VENUE_READ_BUDGET_EXHAUSTED" },
  );
  assert.equal(
    budget.snapshot().used,
    before,
    "rejected frame growth may not manufacture a send or refund real reads",
  );
  frame.close();
  assert.equal(budget.snapshot().used, before);
  await time.advance(60_001);
  const retry = budget.beginObservation("a");
  assert.ok(
    budget.snapshot().observation_reserved >= 100 + extra,
    "the next reservation must fit the failed full prefix plus its next required read",
  );
  retry.close();
});

it("closing an observation cannot refund or abandon its already-sent unfinished request", async () => {
  const { time, budget } = setup();
  const frame = budget.beginObservation("a");
  const active = await time.resolve(
    budget.acquire("account", 20, "a", signal(), false, frame),
  );
  active.sent();
  frame.close();
  assert.equal(budget.snapshot().observation_active, true);
  assert.throws(() => budget.beginObservation("b"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  active.settle(20);
  active.release();
  assert.equal(budget.snapshot().observation_active, false);
  assert.equal(budget.snapshot().used, 20);
});

it("a failed cold prefix does not teach an undersized reservation for an unobserved full account", async () => {
  const { time, budget } = setup();
  const failed = budget.beginObservation("a");
  await charge(budget, time, 20, 20, failed);
  failed.close(false);
  await time.advance(60_001);
  const retry = budget.beginObservation("a");
  assert.equal(
    budget.snapshot().observation_reserved,
    1000,
    "only a complete account frame may teach a smaller cold reservation",
  );
  retry.close();
});

it("an abandoned deferred owner stops shielding capacity after its bounded interest expires", async (t) => {
  const { time, budget } = setup();
  const active = budget.beginObservation("a");
  await charge(budget, time, 20, 20, active);
  assert.throws(() => budget.beginObservation("abandoned"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  active.close(true);
  const controller = new AbortController();
  t.after(() => controller.abort());
  let sent = false;
  const source = budget
    .acquire("source", 2, "public", controller.signal)
    .then((ticket) => {
      sent = true;
      ticket.sent();
      ticket.settle(2);
      ticket.release();
    })
    .catch(() => {});
  await time.advance(119_999);
  assert.equal(sent, false);
  await time.advance(10);
  await source;
  assert.equal(sent, true);
  assert.equal(budget.snapshot().observation_queued, 0);
});

it("an unsettled unknown source response defers a learned account briefly instead of teaching a false full-minute retry", async () => {
  const { time, budget } = setup();
  const training = budget.beginObservation("a");
  await charge(budget, time, 20, 20, training);
  training.close(true);
  await time.advance(60_001);
  const unknown = await time.resolve(
    budget.acquire("source", 20, "public", signal(), true),
  );
  unknown.sent();
  assert.equal(unknown.reservation, 1000);
  assert.throws(
    () => budget.beginObservation("a"),
    (error: any) => {
      assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
      assert.equal(
        error.details.retry_after_ms,
        1000,
        "a provisional exclusive response is not evidence of sixty seconds of real consumption",
      );
      return true;
    },
  );
  unknown.settle(20);
  unknown.release();
  const resumed = budget.beginObservation("a");
  assert.equal(budget.snapshot().observation_reserved, 120);
  assert.equal(budget.snapshot().used, 20);
  resumed.close();
});
