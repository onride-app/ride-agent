import assert from "node:assert/strict";
import { it } from "node:test";
import {
  VenueReadBudget,
  type AccountReadReservation,
} from "./venue-read-budget.js";
function fixture() {
  let at = 0;
  const budget = new VenueReadBudget({
    clock: () => at,
    timers: {
      setTimeout() {
        return 1;
      },
      clearTimeout() {},
    },
  });
  return {
    budget,
    setAt(value: number) {
      at = value;
    },
  };
}
async function charge(
  budget: VenueReadBudget,
  frame: AccountReadReservation,
  cost: number,
  paid = cost,
  unknown = false,
) {
  const read = await budget.acquire(
    "account",
    cost,
    "account",
    new AbortController().signal,
    false,
    frame,
  );
  read.sent();
  if (unknown) read.uncertain();
  else read.settle(paid);
  read.release();
}
async function reads(
  budget: VenueReadBudget,
  frame: AccountReadReservation,
  cached: boolean,
  restControl = true,
) {
  await charge(budget, frame, 20);
  if (!cached) await charge(budget, frame, 20);
  await charge(budget, frame, 2);
  await charge(budget, frame, 2);
  await charge(budget, frame, 120, 20);
  await charge(budget, frame, 20);
  await charge(budget, frame, 20);
  if (!cached) await charge(budget, frame, 20);
  if (restControl) await charge(budget, frame, 20);
  await charge(budget, frame, 20);
}
async function complete(
  budget: VenueReadBudget,
  cached: boolean,
  restControl = true,
) {
  const frame = budget.beginObservation("account");
  await reads(budget, frame, cached, restControl);
  frame.close(true);
}
async function source(budget: VenueReadBudget, sent = true) {
  const ticket = await budget.acquire(
    "source",
    120,
    "public",
    new AbortController().signal,
  );
  if (sent) {
    ticket.sent();
    ticket.settle(39);
  }
  ticket.release();
}
async function known() {
  const f = fixture();
  await complete(f.budget, false, false);
  await source(f.budget);
  f.setAt(20000);
  return f;
}
it("holds launch headroom only after a real cheaper frame cannot replace the observed source bound", async () => {
  const f = await known();
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().used, 287);
  f.setAt(30800);
  assert.throws(() => f.budget.beginObservation("account"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
});
it("keeps the original rate when account paid covers the source bound despite measured temporary inflation", async () => {
  const f = fixture();
  await complete(f.budget, false);
  await source(f.budget);
  f.setAt(20000);
  await complete(f.budget, true);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 12300);
});
it("keeps original pacing when only the learned margin exists with a real source bound", async () => {
  const f = fixture();
  await complete(f.budget, false);
  await source(f.budget);
  f.setAt(20000);
  await complete(f.budget, false);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 12300);
});
it("keeps original pacing for true account inflation without a bounded source hold", async () => {
  const f = fixture();
  await complete(f.budget, false, false);
  f.setAt(20000);
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
});
it("does not learn source Q from a reservation cancelled before sending", async () => {
  const f = fixture();
  await complete(f.budget, false, false);
  await source(f.budget, false);
  f.setAt(20000);
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().source_used, 0);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
});
it("excludes a swallowed sent unknown from later paired cost samples without refunding its real charge", async () => {
  const f = await known(),
    frame = f.budget.beginObservation("account");
  await charge(f.budget, frame, 2, 2, true);
  await charge(f.budget, frame, 120, 20);
  frame.close(true);
  assert.equal(f.budget.snapshot().used, 205);
  f.setAt(40000);
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 9000);
});
for (const issue of [
  "unsent release",
  "immediate rejection",
  "queued cancellation",
] as const)
  it(`excludes a swallowed ${issue} from the new launch-cost samples`, async () => {
    const f = await known(),
      frame = f.budget.beginObservation("account");
    if (issue === "unsent release") {
      const ticket = await f.budget.acquire(
        "account",
        120,
        "account",
        new AbortController().signal,
        false,
        frame,
      );
      ticket.release();
    } else if (issue === "immediate rejection") {
      await assert.rejects(
        f.budget.acquire(
          "account",
          1001,
          "account",
          new AbortController().signal,
          false,
          frame,
        ),
      );
    } else {
      const stop = new AbortController(),
        a = await f.budget.acquire(
          "account",
          2,
          "account",
          stop.signal,
          false,
          frame,
        ),
        b = await f.budget.acquire(
          "account",
          2,
          "account",
          stop.signal,
          false,
          frame,
        );
      a.sent();
      b.sent();
      const queued = f.budget
        .acquire("account", 120, "account", stop.signal, false, frame)
        .catch((e) => e);
      stop.abort();
      assert.equal((await queued).code, "VENUE_READ_DEADLINE");
      a.settle(2);
      a.release();
      b.settle(2);
      b.release();
    }
    await reads(f.budget, frame, true, false);
    frame.close(true);
    assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
  });
it("excludes an owner-limit rejection swallowed by a metering callback", async () => {
  const f = await known();
  for (let i = 0; i < 2047; i++) {
    f.setAt(20000 + i * 3);
    const ticket = await f.budget.acquire(
      "account",
      2,
      `existing_${i}`,
      new AbortController().signal,
    );
    ticket.release();
  }
  f.setAt(30000);
  const frame = f.budget.beginObservation("account");
  await assert.rejects(
    f.budget.acquire(
      "account",
      20,
      "one_too_many",
      new AbortController().signal,
      false,
      frame,
    ),
  );
  await reads(f.budget, frame, true, false);
  frame.close(true);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
});
it("excludes rate-limit queue rejection swallowed before known tickets finish", async () => {
  const f = await known(),
    frame = f.budget.beginObservation("account");
  await charge(f.budget, frame, 120, 96);
  const stop = new AbortController(),
    a = await f.budget.acquire(
      "account",
      2,
      "account",
      stop.signal,
      false,
      frame,
    ),
    b = await f.budget.acquire(
      "account",
      2,
      "account",
      stop.signal,
      false,
      frame,
    );
  a.sent();
  b.sent();
  const queued = f.budget
    .acquire("account", 120, "account", stop.signal, false, frame)
    .catch((e) => e);
  f.budget.note429(0);
  assert.equal((await queued).code, "VENUE_RATE_LIMITED");
  a.settle(2);
  a.release();
  b.settle(2);
  b.release();
  frame.close(true);
  assert.equal(f.budget.snapshot().provider_cooldown_ms, 60000);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
});
it("does not use a cold full-window placeholder as a learned successful demand", async () => {
  const f = fixture();
  f.budget.beginObservation("account").close(false);
  const frame = f.budget.beginObservation("account");
  await charge(f.budget, frame, 120, 20);
  frame.close(true);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 1500);
});
it("bounds a heterogeneous inflated light frame without inventing a multi-window pause", async () => {
  const f = fixture(),
    heavy = f.budget.beginObservation("account");
  for (let i = 0; i < 38; i++) await charge(f.budget, heavy, 20);
  heavy.close(true);
  f.setAt(59500);
  await source(f.budget);
  f.setAt(60000);
  const light = f.budget.beginObservation("account");
  await charge(f.budget, light, 140, 110);
  light.close(true);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 57000);
});
it("expires Q by its original charge clock and lets already scheduled bounded spacing finish before recovery", async () => {
  const f = fixture();
  await complete(f.budget, false, false);
  await source(f.budget);
  f.setAt(59000);
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 12400);
  f.setAt(60000);
  assert.equal(f.budget.snapshot().source_used, 0);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 11400);
  f.setAt(71400);
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 9300);
});

it("does not learn provider source pressure from a sent Core hop proven no_upstream and settled zero", async () => {
  const f = fixture();
  await complete(f.budget, false, false);
  const hop = await f.budget.acquire(
    "source",
    120,
    "public",
    new AbortController().signal,
  );
  hop.sent();
  hop.settle(0);
  hop.release();
  f.setAt(20000);
  await complete(f.budget, true, false);
  assert.equal(f.budget.snapshot().source_used, 0);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
});

it("excludes a swallowed account Core no_upstream zero-settlement from temporary-inflation samples", async () => {
  const f = await known(),
    frame = f.budget.beginObservation("account");
  await charge(f.budget, frame, 120, 0);
  await reads(f.budget, frame, true, false);
  frame.close(true);
  assert.equal(f.budget.snapshot().used, 287);
  assert.equal(f.budget.snapshot().observation_pacing_ms, 10800);
});
