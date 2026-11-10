import assert from "node:assert/strict";
import { it } from "node:test";
import {
  VenueReadBudget,
  type AccountReadReservation,
} from "./venue-read-budget.js";
const signal = () => new AbortController().signal;
function setup(priorSource = 0) {
  const budget = new VenueReadBudget({ clock: () => 1000 });
  budget.restoreObservationPlan("owner", { demand: 184, peaks: [164] }, 600000);
  return budget;
}
async function pay(
  budget: VenueReadBudget,
  scope: AccountReadReservation | undefined,
  reserve: number,
  actual = reserve,
  unknown = false,
  lane: "account" | "source" = "account",
) {
  const ticket = await budget.acquire(
    lane,
    reserve,
    "owner",
    signal(),
    unknown,
    scope,
  );
  ticket.sent();
  try {
    ticket.settle(actual);
  } finally {
    ticket.release();
  }
}
async function audit84(b: VenueReadBudget, scope: AccountReadReservation) {
  await pay(b, scope, 120, 20);
  await pay(b, scope, 20, 20, true);
  await pay(b, scope, 20);
  await pay(b, scope, 20);
  await pay(b, scope, 2);
  await pay(b, scope, 2);
}
it("retains the ordinary source and legacy observation paths without a prepared meter", async () => {
  const b = new VenueReadBudget({ clock: () => 1000 });
  await pay(b, undefined, 2, 2, false, "source");
  assert.equal(b.snapshot().used, 2);
  const other = setup(),
    ticket = other.beginObservation("owner");
  await pay(other, ticket, 20);
  ticket.close(true);
  assert.equal(other.snapshot().used, 20);
});
it("two complete children learn only single-scope peaks and preserve all actual fees", async () => {
  const b = setup(),
    interest = b.beginObservationInterest("owner"),
    parent = b.beginObservationBundle("owner", 184, 2, interest);
  assert.equal(parent.weight, 368);
  assert.equal(b.snapshot().observation_reserved, 368);
  const a = parent.beginChild();
  await audit84(b, a);
  a.close(true);
  assert.ok(a.costPlan());
  assert.equal(a.costPlan()!.demand, 184);
  assert.equal(parent.costPlan(), null);
  const s = parent.beginSupplement();
  await pay(b, s, 2, 2, false, "source");
  await pay(b, s, 2, 2, false, "source");
  await pay(b, s, 2, 2, false, "source");
  s.close(true);
  const c = parent.beginChild();
  assert.equal(c.weight, 184);
  await audit84(b, c);
  c.close(true);
  assert.ok(c.costPlan()!.demand <= 184);
  assert.equal(parent.costPlan(), null);
  parent.close(true);
  b.endObservationInterest(interest);
  assert.equal(b.snapshot().used, 174);
  assert.equal(b.snapshot().observation_active, false);
});
it("supplement can spend exactly first-child unused credit and cannot consume the second full scope", async () => {
  const b = setup(),
    i = b.beginObservationInterest("owner"),
    p = b.beginObservationBundle("owner", 184, 2, i);
  const a = p.beginChild();
  await audit84(b, a);
  a.close(true);
  const s = p.beginSupplement();
  assert.equal(s.weight, 100);
  await pay(b, s, 100);
  s.close(true);
  const c = p.beginChild();
  assert.equal(c.weight, 184);
  await audit84(b, c);
  c.close(true);
  p.close(true);
  assert.equal(b.snapshot().used, 268);
});
it("a child cannot borrow the other child or first-child surplus to exceed184", async () => {
  const b = setup(),
    i = b.beginObservationInterest("owner"),
    p = b.beginObservationBundle("owner", 184, 2, i);
  const a = p.beginChild();
  await audit84(b, a);
  a.close(true);
  const c = p.beginChild();
  await assert.rejects(pay(b, c, 185), { code: "VENUE_READ_BUDGET_EXHAUSTED" });
  assert.throws(() => c.close(true));
  p.close(false);
  assert.equal(b.snapshot().used, 84);
});
it("unknown supplemental response retains its full actual global debt and invalidates the window", async () => {
  const b = setup();
  await pay(b, undefined, 220, 220, false, "source");
  const i = b.beginObservationInterest("owner"),
    p = b.beginObservationBundle("owner", 184, 2, i);
  const a = p.beginChild();
  await audit84(b, a);
  a.close(true);
  const s = p.beginSupplement();
  await assert.rejects(pay(b, s, 20, 900, true, "source"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  s.close(false);
  assert.throws(() => p.beginChild());
  p.close(false);
  assert.equal(b.snapshot().used, 1204);
  assert.equal(b.snapshot().debt, 204);
});
it("cancelled parent cannot learn a late child completion or clear paid costs", async () => {
  const b = setup(),
    i = b.beginObservationInterest("owner"),
    p = b.beginObservationBundle("owner", 184, 2, i),
    a = p.beginChild();
  await pay(b, a, 120, 20);
  p.close(false);
  a.close(true);
  assert.equal(a.costPlan(), null);
  assert.equal(b.snapshot().used, 20);
});
