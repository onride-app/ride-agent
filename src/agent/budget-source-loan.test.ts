import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import {
  VenueReadBudget,
  type BudgetTimers,
  type ReadLane,
  type ReadTicket,
} from "./venue-read-budget.js";

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
class Clock {
  at = 0;
  private sequence = 0;
  private events = new Map<number, { at: number; run(): void }>();
  readonly timers: BudgetTimers = {
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
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.at = first[1].at;
      this.events.delete(first[0]);
      first[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
function pending(budget: VenueReadBudget, cost: number, unknown = false) {
  const controller = new AbortController();
  let ticket: ReadTicket | undefined;
  const done = budget
    .acquire("source", cost, "public", controller.signal, unknown)
    .then(
      (value) => {
        ticket = value;
      },
      () => {},
    );
  return {
    get ticket() {
      return ticket;
    },
    async cancel() {
      controller.abort();
      await done;
      ticket?.release();
    },
  };
}
function deferredHead(budget: VenueReadBudget, owner = "head") {
  assert.throws(
    () => budget.beginObservation(owner),
    (error) =>
      error instanceof AgentError &&
      error.code === "VENUE_READ_BUDGET_EXHAUSTED",
  );
}
async function setup(sourceWeight = 40, totalWeight = 808) {
  const time = new Clock(),
    budget = new VenueReadBudget({
      clock: () => time.at,
      timers: time.timers,
      slots: 2,
    });
  const charge = async (lane: ReadLane, weight: number) => {
    const ticket = await budget.acquire(
      lane,
      weight,
      lane === "source" ? "public" : "head",
      new AbortController().signal,
    );
    ticket.sent();
    ticket.settle(weight);
    ticket.release();
  };
  // A real completed frame learns a full 184-weight admission reservation and
  // a 12.3s pacing interval. The next request stays at the FIFO head unsent.
  const frame = budget.beginObservation("head");
  const read = await budget.acquire(
    "account",
    164,
    "head",
    new AbortController().signal,
    false,
    frame,
  );
  read.sent();
  read.settle(164);
  read.release();
  frame.close(true);
  await time.advance(1000);
  await charge("account", totalWeight - 164 - sourceWeight);
  await charge("source", sourceWeight);
  deferredHead(budget);
  deferredHead(budget, "tail");
  assert.equal(budget.snapshot().used, totalWeight);
  assert.equal(budget.snapshot().observation_pacing_ms, 11300);
  return { budget, time };
}

it("loans a bounded source hold during head pacing and refunds only its settled fee", async () => {
  const { budget } = await setup(),
    work = pending(budget, 120);
  try {
    await flush();
    const ticket = work.ticket;
    assert.ok(ticket);
    assert.equal(ticket.reservation, 120);
    assert.equal(budget.snapshot().used, 928);
    assert.equal(budget.snapshot().source_used, 160);
    assert.equal(budget.snapshot().source_pacing_loans, 1);
    ticket.sent();
    ticket.settle(20);
    assert.equal(budget.snapshot().used, 828);
    assert.equal(budget.snapshot().source_used, 60);
  } finally {
    await work.cancel();
  }
});

it("keeps ordinary source admission above the loan share when full head protection already fits", async () => {
  const { budget } = await setup(40, 400),
    work = pending(budget, 250);
  try {
    await flush();
    assert.ok(work.ticket);
    assert.equal(budget.snapshot().used, 650);
    assert.equal(budget.snapshot().source_used, 290);
    assert.equal(budget.snapshot().source_pacing_loans, 0);
  } finally {
    await work.cancel();
  }
});

for (const sourceWeight of [199, 200])
  it(`permits one full bounded request to cross the soft 200 share only from below it (${sourceWeight} + 120)`, async () => {
    const { budget } = await setup(sourceWeight),
      work = pending(budget, 120);
    try {
      await flush();
      assert.equal(work.ticket !== undefined, sourceWeight === 199);
      assert.equal(
        budget.snapshot().source_pacing_loans,
        sourceWeight === 199 ? 1 : 0,
      );
      assert.equal(budget.snapshot().used, sourceWeight === 199 ? 928 : 808);
      if (sourceWeight === 199) {
        assert.equal(budget.snapshot().source_used, 319);
        const another = pending(budget, 1);
        try {
          await flush();
          assert.equal(
            another.ticket,
            undefined,
            "crossing the soft share blocks every further loan",
          );
          assert.equal(budget.snapshot().source_pacing_loans, 1);
        } finally {
          await another.cancel();
        }
      }
    } finally {
      await work.cancel();
    }
  });

it("does not loan a request whose full bound exceeds the 200 share even when global capacity fits", async () => {
  const { budget } = await setup(40, 792),
    work = pending(budget, 201);
  try {
    await flush();
    assert.equal(work.ticket, undefined);
    assert.equal(budget.snapshot().used, 792);
    assert.equal(budget.snapshot().source_pacing_loans, 0);
  } finally {
    await work.cancel();
  }
});

it("counts unsent and late unsettled source holds in full before allowing another loan", async () => {
  const { budget, time } = await setup(100),
    first = pending(budget, 120),
    second = pending(budget, 60);
  try {
    await flush();
    const ticket = first.ticket;
    assert.ok(ticket);
    assert.equal(
      second.ticket,
      undefined,
      "an unsent hold cannot be treated as its expected cheap response",
    );
    assert.equal(budget.snapshot().source_used, 220);
    ticket.sent();
    await time.advance(10000);
    assert.equal(
      second.ticket,
      undefined,
      "elapsed wire time cannot refund an unsettled full hold",
    );
    assert.equal(budget.snapshot().source_used, 220);
    ticket.settle(20);
    await flush();
    assert.ok(
      second.ticket,
      "the real 100-weight refund releases loan capacity",
    );
    assert.equal(budget.snapshot().source_used, 180);
    assert.equal(budget.snapshot().source_pacing_loans, 2);
  } finally {
    await first.cancel();
    await second.cancel();
  }
});

it("retains a sent unsettled loan beyond a minute and starts the real fee window at late settlement", async () => {
  const { budget, time } = await setup(),
    work = pending(budget, 120);
  try {
    await flush();
    const ticket = work.ticket;
    assert.ok(ticket);
    ticket.sent();
    await time.advance(60001);
    assert.equal(budget.snapshot().used, 120);
    assert.equal(budget.snapshot().source_used, 120);
    ticket.settle(20);
    assert.equal(budget.snapshot().source_used, 20);
    await time.advance(59999);
    assert.equal(budget.snapshot().source_used, 20);
    await time.advance(1);
    assert.equal(budget.snapshot().source_used, 0);
  } finally {
    await work.cancel();
  }
});

it("keeps an uncertain sent loan at its full retained weight instead of predicting a refund", async () => {
  const { budget, time } = await setup(100),
    first = pending(budget, 120);
  await flush();
  const ticket = first.ticket;
  assert.ok(ticket);
  ticket.sent();
  ticket.release();
  const second = pending(budget, 60);
  try {
    await time.advance(10000);
    assert.equal(second.ticket, undefined);
    assert.equal(budget.snapshot().source_used, 220);
    assert.equal(budget.snapshot().source_pacing_loans, 1);
  } finally {
    await first.cancel();
    await second.cancel();
  }
});

it("allows a real 120 fee to defer the head until true rolling expiry without changing FIFO order", async () => {
  const { budget, time } = await setup(100),
    work = pending(budget, 120);
  try {
    await flush();
    const ticket = work.ticket;
    assert.ok(ticket);
    ticket.sent();
    ticket.settle(120);
    ticket.release();
    assert.equal(budget.snapshot().source_used, 220);
    const another = pending(budget, 1);
    try {
      await flush();
      assert.equal(
        another.ticket,
        undefined,
        "the paid 120 fee must retain its full cost and block another loan",
      );
    } finally {
      await another.cancel();
    }
    await time.advance(11300);
    deferredHead(budget);
    deferredHead(budget, "tail");
    assert.equal(budget.snapshot().used, 928);
    assert.equal(budget.snapshot().observation_active, false);
    await time.advance(47699);
    deferredHead(budget);
    await time.advance(1);
    assert.equal(budget.snapshot().used, 764);
    const head = budget.beginObservation("head");
    deferredHead(budget, "tail");
    head.close(true);
    await time.advance(12300);
    assert.equal(budget.snapshot().used, 0);
    deferredHead(budget, "head");
    const tail = budget.beginObservation("tail");
    tail.close();
  } finally {
    await work.cancel();
  }
});

for (const blocked of [
  "eligible head",
  "active frame",
  "unknown surcharge",
] as const)
  it(`does not loan head protection for an ${blocked}`, async () => {
    const { budget, time } = await setup();
    let frame;
    if (blocked !== "unknown surcharge") {
      await time.advance(11300);
      if (blocked === "active frame") frame = budget.beginObservation("head");
    }
    const work = pending(
      budget,
      blocked === "unknown surcharge" ? 20 : 120,
      blocked === "unknown surcharge",
    );
    try {
      await flush();
      assert.equal(work.ticket, undefined);
      assert.equal(budget.snapshot().source_pacing_loans, 0);
      assert.equal(budget.snapshot().used, 808);
    } finally {
      await work.cancel();
      frame?.close();
    }
  });

it("never loans beyond the global 1000 hard ledger even with source share available", async () => {
  const { budget } = await setup(40, 900),
    tooLarge = pending(budget, 120);
  await flush();
  assert.equal(tooLarge.ticket, undefined);
  assert.equal(budget.snapshot().source_pacing_loans, 0);
  await tooLarge.cancel();
  const exact = pending(budget, 100);
  await flush();
  assert.ok(exact.ticket);
  const extra = pending(budget, 1);
  try {
    await flush();
    assert.equal(extra.ticket, undefined);
    assert.equal(budget.snapshot().used, 1000);
    assert.equal(budget.snapshot().debt, 0);
    assert.equal(budget.snapshot().source_pacing_loans, 1);
  } finally {
    await exact.cancel();
    await extra.cancel();
  }
});

it("preserves provider cooldown and response-contract quarantine before any loan", async () => {
  const cooling = await setup();
  cooling.budget.note429(0);
  await assert.rejects(
    cooling.budget.acquire(
      "source",
      120,
      "public",
      new AbortController().signal,
    ),
    (error) =>
      error instanceof AgentError && error.code === "VENUE_RATE_LIMITED",
  );
  assert.equal(cooling.budget.snapshot().source_pacing_loans, 0);
  const quarantined = await setup();
  quarantined.budget.quarantine();
  const work = pending(quarantined.budget, 120);
  try {
    await flush();
    assert.equal(work.ticket, undefined);
    assert.equal(quarantined.budget.snapshot().source_pacing_loans, 0);
    assert.equal(quarantined.budget.snapshot().used, 808);
  } finally {
    await work.cancel();
  }
});
