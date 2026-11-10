import assert from "node:assert/strict";
import { it } from "node:test";
import http from "node:http";
import { z } from "zod";
import {
  VenueReadBudget,
  type AccountReadReservation,
} from "./venue-read-budget.js";
import {
  AgentError,
  errorDetails,
  publicErrorDetails,
  output,
  failure,
} from "./contracts.js";
import { BridgeAdapter } from "./adapter.js";
import { candidate } from "./fixtures.js";

function fixture() {
  let at = 1000;
  const budget = new VenueReadBudget({ clock: () => at });
  budget.restoreObservationPlan(
    "account",
    { demand: 184, peaks: [164] },
    600000,
  );
  return {
    budget,
    advance: (ms: number) => {
      at += ms;
    },
    begin: () => {
      const plan = budget.preparedSupplementPlan("window-binding", ["fixed"]);
      const interest = budget.beginObservationInterest("account");
      return {
        plan,
        parent: budget.beginObservationBundle(
          "account",
          184,
          1,
          interest,
          false,
          ["fixed"],
          plan,
        ),
      };
    },
  };
}
async function pay(
  b: VenueReadBudget,
  scope: AccountReadReservation,
  reserve: number,
  actual = reserve,
  unknown = false,
) {
  const ticket = await b.acquire(
    "source",
    reserve,
    "one",
    new AbortController().signal,
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
async function audited(f: ReturnType<typeof fixture>) {
  const result = f.begin(),
    a = result.parent.beginChild();
  await pay(f.budget, a, 164);
  a.close(true);
  return result;
}
it("readonly reserves independent S120 and H240 while A alone learns184", async () => {
  const f = fixture(),
    { parent } = await audited(f);
  assert.equal(parent.weight, 544);
  const s = parent.beginSupplement();
  for (let n = 0; n < 3; n++) await pay(f.budget, s, 2);
  s.close(true);
  const h = parent.beginHistorySupplement("fixed");
  await pay(f.budget, h, 120, 45);
  await pay(f.budget, h, 120, 20);
  h.close(true);
  assert.equal(f.budget.snapshot().used, 235);
  assert.equal(f.budget.peekObservationDemand("account"), 184);
  assert.throws(() => parent.beginChild());
  parent.close(true);
});
it("S capacity grows only the next bound window and cannot borrow unused A or H", async () => {
  const f = fixture(),
    { parent, plan } = await audited(f),
    s = parent.beginSupplement();
  await pay(f.budget, s, 120);
  await assert.rejects(pay(f.budget, s, 20), (e) => {
    const x = e as AgentError;
    assert.deepEqual(x.details, {
      reason_code: "READ_FRAME_CAPACITY",
      retry_after_ms: 60000,
      read_stage: "source",
      requested_weight: 20,
      remaining_weight: 0,
    });
    return true;
  });
  s.close(false);
  assert.equal(parent.weight, 544);
  parent.close(false);
  const next = f.budget.preparedSupplementPlan("window-binding", ["fixed"]);
  assert.equal(next.sourceWeight, 140);
  assert.equal(next.historyWeights.fixed, 240);
  assert.equal(
    f.budget.preparedSupplementPlan("foreign-window", ["fixed"]).sourceWeight,
    120,
  );
  f.advance(60001);
  const interest = f.budget.beginObservationInterest("account");
  assert.throws(() =>
    f.budget.beginObservationBundle(
      "account",
      184,
      1,
      interest,
      false,
      ["fixed"],
      plan,
    ),
  );
  const renewed = f.budget.beginObservationBundle(
    "account",
    184,
    1,
    interest,
    false,
    ["fixed"],
    next,
  );
  assert.equal(renewed.weight, 564);
  renewed.close(false);
});
it("H learns paid240 plus the next full120 without advancing or reusing partial history", async () => {
  const f = fixture(),
    { parent } = await audited(f),
    h = parent.beginHistorySupplement("fixed");
  await pay(f.budget, h, 120);
  await pay(f.budget, h, 120);
  await assert.rejects(pay(f.budget, h, 120), (e) => {
    const x = e as AgentError;
    assert.equal(x.details?.read_stage, "history");
    assert.equal(x.details?.requested_weight, 120);
    assert.equal(x.details?.remaining_weight, 0);
    return true;
  });
  h.close(false);
  parent.close(false);
  assert.equal(f.budget.snapshot().used, 404);
  const next = f.budget.preparedSupplementPlan("window-binding", ["fixed"]);
  assert.equal(next.historyWeights.fixed, 360);
  assert.equal(next.sourceWeight, 120);
  assert.equal(
    f.budget.preparedSupplementPlan("window-binding", ["other-fixed"])
      .historyWeights["other-fixed"],
    240,
  );
});
it("a forged remote capacity error and a foreign budget plan cannot change internal hints", () => {
  const f = fixture(),
    plan = f.budget.preparedSupplementPlan("window-binding", ["fixed"]);
  new AgentError("VENUE_READ_BUDGET_EXHAUSTED", "untrusted", true, 503, {
    reason_code: "READ_FRAME_CAPACITY",
    read_stage: "history",
    requested_weight: 1000,
    remaining_weight: 0,
  });
  assert.equal(
    f.budget.preparedSupplementPlan("window-binding", ["fixed"]).historyWeights
      .fixed,
    240,
  );
  const peer = fixture();
  assert.throws(() =>
    peer.budget.beginObservationBundle(
      "account",
      184,
      1,
      peer.budget.beginObservationInterest("account"),
      false,
      ["fixed"],
      plan,
    ),
  );
  assert.equal(peer.budget.snapshot().observation_active, false);
});
it("one exhausted Fixed reservoir cannot borrow a different source's untouched H240", async () => {
  const f = fixture(),
    plan = f.budget.preparedSupplementPlan("multi-fixed", ["one", "two"]),
    interest = f.budget.beginObservationInterest("account"),
    parent = f.budget.beginObservationBundle(
      "account",
      184,
      1,
      interest,
      false,
      ["one", "two"],
      plan,
    ),
    a = parent.beginChild();
  await pay(f.budget, a, 164);
  a.close(true);
  const h = parent.beginHistorySupplement("one");
  await pay(f.budget, h, 120);
  await pay(f.budget, h, 120);
  assert.equal(f.budget.snapshot().used, 404);
  await assert.rejects(
    pay(f.budget, h, 120),
    (e) => (e as AgentError).details?.read_stage === "history",
  );
  h.close(false);
  parent.close(false);
  const next = f.budget.preparedSupplementPlan("multi-fixed", ["one", "two"]);
  assert.equal(next.historyWeights.one, 360);
  assert.equal(next.historyWeights.two, 240);
});
it("late actual surcharge remains charged after close without updating a lost child capability's hint", async () => {
  const f = fixture(),
    { parent } = await audited(f),
    s = parent.beginSupplement(),
    ticket = await f.budget.acquire(
      "source",
      20,
      "one",
      new AbortController().signal,
      true,
      s,
    );
  ticket.sent();
  parent.close(false);
  assert.throws(() => ticket.settle(1200), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  ticket.release();
  s.close(false);
  assert.equal(f.budget.snapshot().used, 1364);
  assert.equal(
    f.budget.preparedSupplementPlan("window-binding", ["fixed"]).sourceWeight,
    120,
  );
});
it("S unknown surcharge retains all actual debt and records impossible demand instead of stealing H", async () => {
  const f = fixture(),
    { parent } = await audited(f),
    s = parent.beginSupplement();
  await assert.rejects(pay(f.budget, s, 20, 1200, true), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  s.close(false);
  parent.close(false);
  assert.equal(f.budget.snapshot().used, 1364);
  assert.equal(f.budget.snapshot().debt, 364);
  const next = f.budget.preparedSupplementPlan("window-binding", ["fixed"]);
  assert.equal(next.sourceWeight, 1200);
  assert.equal(next.historyWeights.fixed, 240);
  assert.equal(f.budget.peekObservationDemand("account"), 184);
});
it("peeking resource demand never renews its original bounded lifetime", async () => {
  const f = fixture(),
    { parent } = await audited(f),
    s = parent.beginSupplement();
  await pay(f.budget, s, 120);
  await assert.rejects(pay(f.budget, s, 20));
  s.close(false);
  parent.close(false);
  f.advance(599999);
  assert.equal(
    f.budget.preparedSupplementPlan("window-binding", []).sourceWeight,
    140,
  );
  f.advance(2);
  assert.equal(
    f.budget.preparedSupplementPlan("window-binding", []).sourceWeight,
    120,
  );
});
it("public errors keep their old shape while authenticated managed transport retains stage diagnostics", async (t) => {
  const error = new AgentError(
    "VENUE_READ_BUDGET_EXHAUSTED",
    "capacity",
    true,
    503,
    {
      reason_code: "READ_FRAME_CAPACITY",
      retry_after_ms: 60000,
      read_stage: "history",
      requested_weight: 120,
      remaining_weight: 75,
    },
  );
  assert.deepEqual(failure(error).error?.details, {
    reason_code: "READ_FRAME_CAPACITY",
    retry_after_ms: 60000,
  });
  assert.equal(publicErrorDetails.safeParse(error.details).success, false);
  assert.equal(output.safeParse(failure(error)).success, true);
  assert.equal(
    output.safeParse(failure(error, { internalReadDiagnostics: true })).success,
    false,
  );
  const schema = z.toJSONSchema(output) as any;
  assert.deepEqual(
    Object.keys(schema.properties.error.properties.details.properties),
    ["operation", "grpc_code", "reason_code", "retry_after_ms", "blockers"],
  );
  assert.equal(
    errorDetails.safeParse({ ...error.details, account: "private" }).success,
    false,
  );
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + "t".repeat(48));
    res.writeHead(503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: failure(error, { internalReadDiagnostics: true }).error,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const adapter = new BridgeAdapter(
    "http://127.0.0.1:" + (server.address() as any).port,
    "t".repeat(48),
  );
  await assert.rejects(adapter.source(candidate(1)), (e) => {
    assert.deepEqual((e as AgentError).details, error.details);
    return true;
  });
});
