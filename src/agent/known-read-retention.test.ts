import assert from "node:assert/strict";
import { it } from "node:test";
import { VenueReadBudget } from "./venue-read-budget.js";

const signal = () => new AbortController().signal;
function clockBank(start = 1000) {
  let at = start;
  return { budget: new VenueReadBudget({ clock: () => at }), advance(ms: number) { at += ms; }, now: () => at };
}

it("R64 a known complete actual fee expires60s after completion in either wall or monotonic clock domains", async () => {
  for (const start of [1000, 1794400000000]) {
    const bank = clockBank(start), ticket = await bank.budget.acquire("account", 20, "one", signal());
    // This is a remaining duration, never a wall timestamp copied into a
    // performance-clock budget. The original wire has12s left at dispatch.
    ticket.retainFor!(12000 + 60000); ticket.sent(); bank.advance(400);
    ticket.settle(20); ticket.release();
    bank.advance(59999); assert.equal(bank.budget.snapshot().used, 20);
    ticket.settle(20); // A repeated/late duplicate cannot re-age a known fee.
    bank.advance(1); assert.equal(bank.budget.snapshot().used, 0);
    assert.equal(bank.now(), start + 60400, "does not wait for the unused original72s upper bound");
  }
});

it("R64 unknown release keeps the original72s claim despite settled bookkeeping and scope exit", async () => {
  const bank = clockBank(), ticket = await bank.budget.acquire("source", 20, "one", signal());
  ticket.retainFor!(72000); ticket.sent(); bank.advance(400);
  ticket.uncertain(); ticket.release();
  bank.advance(60000); assert.equal(bank.budget.snapshot().used, 20);
  bank.advance(11599); assert.equal(bank.budget.snapshot().used, 20);
  bank.advance(1); assert.equal(bank.budget.snapshot().used, 0);
});

it("R64 invalid settlement cannot erase a still-inflight original claim", async () => {
  const bank = clockBank(), ticket = await bank.budget.acquire("source", 20, "one", signal());
  ticket.retainFor!(72000); ticket.sent(); bank.advance(400);
  for (const invalid of [-1, NaN, 1.5, 21]) assert.throws(() => ticket.settle(invalid), RangeError);
  ticket.release();
  bank.advance(60000); assert.equal(bank.budget.snapshot().used, 20);
  bank.advance(11599); assert.equal(bank.budget.snapshot().used, 20, "invalid known cost must stay conservative on release");
  bank.advance(1); assert.equal(bank.budget.snapshot().used, 0);
});

it("R64 late known unbounded actual keeps all5000 fee debt and does not reset provider cooldown", async () => {
  const bank = clockBank(), ticket = await bank.budget.acquire("account", 20, "one", signal(), true);
  assert.equal(ticket.reservation, 1000);
  ticket.retainFor!(72000); ticket.sent(); bank.advance(65000);
  bank.budget.note429(60000);
  ticket.settle(5000); ticket.release();
  assert.equal(bank.budget.snapshot().used, 5000);
  assert.equal(bank.budget.snapshot().debt, 4000);
  assert.equal(bank.budget.snapshot().provider_cooldown_ms, 60000);
  bank.advance(7001); assert.equal(bank.budget.snapshot().used, 5000, "late actual is not erased at the old original72s mark");
  assert.equal(bank.budget.snapshot().provider_cooldown_ms, 52999);
  await assert.rejects(bank.budget.acquire("source", 2, "other", signal()), (e: any) => e.code === "VENUE_RATE_LIMITED");
  bank.advance(52998); assert.equal(bank.budget.snapshot().used, 5000);
  bank.advance(1); assert.equal(bank.budget.snapshot().used, 0);
  assert.equal(bank.budget.snapshot().provider_cooldown_ms, 0);
});
