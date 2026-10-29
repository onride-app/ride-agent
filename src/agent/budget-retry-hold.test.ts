import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { VenueReadBudget, type ReadTicket } from "./venue-read-budget.js";

async function fixture(settledWeight = 800) {
  let at = 0;
  const budget = new VenueReadBudget({ clock: () => at });
  const signal = new AbortController().signal;
  const training = budget.beginObservation("account");
  const read = await budget.acquire(
    "account",
    20,
    "account",
    signal,
    false,
    training,
  );
  read.sent();
  read.settle(20);
  read.release();
  training.close(true);
  at = 60001;
  // Model earlier completed bounded source histories; every actual request
  // remains charged while the next response's provisional hold is pending.
  for (let weight = 0; weight < settledWeight; weight += 100) {
    const ticket = await budget.acquire("source", 120, "public", signal);
    ticket.sent();
    ticket.settle(100);
    ticket.release();
  }
  const pending = async (weight = 120): Promise<ReadTicket> => {
    const ticket = await budget.acquire("source", weight, "public", signal);
    ticket.sent();
    return ticket;
  };
  const retry = (owner = "account", code = "VENUE_READ_BUDGET_EXHAUSTED") => {
    let delay = 0;
    assert.throws(
      () => budget.beginObservation(owner),
      (error) => {
        assert.ok(error instanceof AgentError);
        assert.equal(error.code, code);
        delay = error.details?.retry_after_ms as number;
        return true;
      },
    );
    return delay;
  };
  return {
    budget,
    pending,
    retry,
    advance(ms: number) {
      at += ms;
    },
  };
}

it("rechecks a bounded pending hold after one second and admits the FIFO head when its small response settles after 500ms", async () => {
  const f = await fixture();
  const pending = await f.pending();
  assert.equal(f.budget.snapshot().used, 920);
  assert.equal(f.retry(), 1000);
  assert.equal(
    f.budget.snapshot().used,
    920,
    "retry advice cannot refund an in-flight request",
  );
  assert.equal(f.retry("later-owner"), 1000);
  f.advance(500);
  pending.settle(20);
  pending.release();
  assert.equal(f.budget.snapshot().used, 820);
  assert.equal(
    f.retry("later-owner"),
    1000,
    "a later owner still cannot overtake the waiting head",
  );
  const frame = f.budget.beginObservation("account");
  assert.equal(f.budget.snapshot().observation_reserved, 120);
  assert.equal(f.budget.snapshot().used, 820);
  frame.close();
});

it("does not admit a frame or discard a sent charge when a pending hold has not shrunk", async () => {
  const f = await fixture();
  const pending = await f.pending();
  assert.equal(f.retry(), 1000);
  f.advance(1000);
  assert.equal(f.retry(), 1000);
  assert.equal(f.budget.snapshot().used, 920);
  assert.equal(f.budget.snapshot().observation_active, false);
  pending.settle(120);
  pending.release();
  assert.equal(
    f.retry(),
    59000,
    "a fully retained response must wait for real charged weight to expire",
  );
  assert.equal(f.budget.snapshot().used, 920);
});

it("treats a released uncertain bounded attempt as retained weight rather than a refundable hold", async () => {
  const f = await fixture();
  const pending = await f.pending();
  assert.equal(f.retry(), 1000);
  f.advance(500);
  pending.release();
  assert.equal(f.budget.snapshot().used, 920);
  assert.equal(f.retry(), 59500);
});

it("keeps the full charged expiry when settled weight alone cannot fit the frame", async () => {
  const f = await fixture(900);
  const pending = await f.pending(80);
  assert.equal(f.budget.snapshot().used, 980);
  assert.equal(f.retry(), 60000);
  f.advance(500);
  pending.settle(20);
  pending.release();
  assert.equal(f.budget.snapshot().used, 920);
  assert.equal(f.retry(), 59500);
});

it("preserves a real charged expiry earlier than the one-second provisional recheck", async () => {
  const f = await fixture();
  f.advance(59500);
  const pending = await f.pending();
  assert.equal(f.retry(), 500);
  pending.settle(120);
  pending.release();
});

it("does not shorten a response quarantine while a bounded response could refund its hold", async () => {
  const f = await fixture();
  const pending = await f.pending();
  f.budget.quarantine();
  assert.equal(f.retry(), 60000);
  f.advance(1000);
  pending.settle(20);
  pending.release();
  assert.equal(f.budget.snapshot().used, 820);
  assert.equal(f.retry(), 59000);
});

it("does not shorten provider cooldown while a bounded response could refund its hold", async () => {
  const f = await fixture();
  const pending = await f.pending();
  f.budget.note429(0);
  assert.equal(f.retry("account", "VENUE_RATE_LIMITED"), 60000);
  f.advance(1000);
  pending.settle(20);
  pending.release();
  assert.equal(f.retry("account", "VENUE_RATE_LIMITED"), 59000);
  assert.equal(f.budget.snapshot().used, 820);
});
