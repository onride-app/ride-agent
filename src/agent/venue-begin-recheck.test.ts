import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import {
  VenueReadBudget,
  isObservationAdmissionDeferred,
  type BudgetTimers,
} from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import {
  CoordinatedReadError,
  type VenueReadFetcher,
} from "./venue-read-transport.js";
import { recordFirstSubmissionFailure } from "./submission-failure-diagnostics.js";

const A = "a".repeat(64),
  B = "b".repeat(64),
  C = "c".repeat(64);
const url = "https://api.hyperliquid.xyz/info";
async function flush() {
  for (let n = 0; n < 80; n++) await Promise.resolve();
}
function time() {
  let at = 1700000000000,
    sequence = 0;
  const events = new Map<number, { at: number; run(): void }>();
  const timers: BudgetTimers = {
    setTimeout(run, ms) {
      const id = ++sequence;
      events.set(id, { at: at + ms, run });
      return id;
    },
    clearTimeout(id) {
      events.delete(id as number);
    },
  };
  return {
    clock: () => at,
    timers,
    async advance(ms: number) {
      const end = at + ms;
      await flush();
      for (;;) {
        const next = [...events]
          .filter(([, e]) => e.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        at = next[1].at;
        events.delete(next[0]);
        next[1].run();
        await flush();
      }
      at = end;
      await flush();
    },
  };
}
function setup(handler?: VenueReadFetcher, leaseMs = 20000) {
  const t = time(),
    budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  const grants: { id: string; at: number; weight: number }[] = [],
    ends: string[] = [],
    calls: { at: number; user?: string; deadline?: number }[] = [];
  const reads = new VenueReads(
    async (u, init, context) => {
      calls.push({
        at: t.clock(),
        user: JSON.parse(String(init.body)).user,
        deadline: context?.deadline_ms,
      });
      return handler ? handler(u, init, context) : Response.json({});
    },
    t.clock,
    2,
    {
      transport: "core_shared_info",
      budget,
      timers: t.timers,
      monotonicClock: t.clock,
      report: () => {},
      frameCoordinator: {
        capacity: 900,
        async begin(_owner, weight) {
          const id = `frame_begin_recheck_${grants.length.toString().padStart(8, "0")}`;
          grants.push({ id, at: t.clock(), weight });
          return { frame_id: id, expires_at: t.clock() + leaseMs };
        },
        async end(id) {
          ends.push(id);
        },
      },
    },
  );
  for (const owner of [A, B, C])
    budget.restoreObservationPlan(owner, { demand: 184, peaks: [164] }, 600000);
  return {
    t,
    budget,
    reads,
    grants,
    ends,
    calls,
    observe: (owner: string, limits = {}) =>
      reads.observeAccount(
        () =>
          reads.readWithEvidence(url, {
            type: "clearinghouseState",
            user: owner,
          }),
        owner,
        limits,
      ),
  };
}
async function pay(budget: VenueReadBudget, weight: number) {
  const ticket = await budget.acquire(
    "source",
    weight,
    "fixture",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(weight);
  ticket.release();
}

it("a granted account waits for the active local owner and preserves live FIFO before any provider read", async () => {
  const f = setup();
  const active = f.budget.beginObservation(A);
  let bDone = false,
    cDone = false;
  const b = f.observe(B).then((x) => {
    bDone = true;
    return x;
  });
  const c = f.observe(C).then((x) => {
    cDone = true;
    return x;
  });
  await flush();
  assert.equal(f.grants.length, 2);
  assert.equal(f.calls.length, 0);
  assert.equal(f.budget.snapshot().observation_queued, 2);
  await f.t.advance(500);
  assert.equal(bDone, false);
  assert.equal(cDone, false);
  active.close(false);
  await f.t.advance(1000);
  await b;
  await c;
  assert.deepEqual(
    f.calls.map((x) => x.user),
    [B, C],
  );
  assert.ok(f.calls[0].at >= f.grants[0].at + 1000);
  assert.equal(f.budget.snapshot().observations.started, 3);
  assert.equal(f.budget.snapshot().observation_queued, 0);
  await f.reads.drainAccounts();
  assert.deepEqual(
    f.ends,
    f.grants.map((x) => x.id),
  );
});

it("a failed Core admission removes its own interest instead of leaving a ghost local FIFO head", async () => {
  const f = setup();
  await pay(f.budget, 850);
  await assert.rejects(
    f.observe(A),
    (e) =>
      e instanceof AgentError && e.details?.reason_code === "READ_LOCAL_QUOTA",
  );
  assert.equal(f.budget.snapshot().observation_queued, 0);
  assert.equal(f.budget.snapshot().used, 850);
  await f.t.advance(60001);
  const evidence = await f.observe(B);
  assert.equal(evidence.observed_at, f.t.clock());
  assert.equal(f.calls.length, 1);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 2);
});

it("interest cancellation consumes only its token and never removes a live same-owner waiter", () => {
  const t = time(),
    budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  budget.restoreObservationPlan(A, { demand: 184, peaks: [164] }, 600000);
  const a1 = budget.beginObservationInterest(A),
    a2 = budget.beginObservationInterest(A);
  const first = budget.beginObservation(A, undefined, a1);
  budget.endObservationInterest(a1);
  assert.equal(budget.snapshot().observation_queued, 1);
  first.close(false);
  const second = budget.beginObservation(A, undefined, a2);
  const a3 = budget.beginObservationInterest(A);
  budget.endObservationInterest(a1);
  budget.endObservationInterest(a2);
  assert.equal(budget.snapshot().observation_queued, 1);
  budget.endObservationInterest(a3);
  second.close(false);
  assert.equal(budget.snapshot().observation_queued, 0);
  assert.throws(
    () => budget.beginObservation(A, undefined, a3),
    (e) => !isObservationAdmissionDeferred(e),
  );
});

it("a Core token cannot renew an older legacy interest beyond its original120seconds", async () => {
  const t = time(),
    budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  await pay(budget, 1);
  assert.throws(() => budget.beginObservation(A));
  await t.advance(119000);
  const token = budget.beginObservationInterest(A);
  await t.advance(2000);
  budget.endObservationInterest(token);
  assert.equal(budget.snapshot().observation_queued, 0);
  const other = budget.beginObservation(B);
  other.close(false);
});

async function mixedLedger(cutoff?: number) {
  let auditCalls = 0;
  const f = setup(async () => {
    if (++auditCalls === 4)
      await new Promise<void>((resolve) =>
        f.t.timers.setTimeout(resolve, 1500),
      );
    return Response.json({});
  });
  const start = f.t.clock();
  const unknown = await f.budget.acquire(
    "account",
    20,
    "unknown",
    new AbortController().signal,
    true,
  );
  unknown.sent();
  await f.t.advance(12000);
  unknown.settle(800);
  unknown.release();
  await f.t.advance(47000);
  const audit = f.reads.observeAccount(async () => {
    for (let i = 0; i < 4; i++) await f.reads.read(url, { type: "meta", i });
  }, A);
  await f.t.advance(1500);
  await audit;
  await f.t.advance(100);
  assert.equal(f.t.clock(), start + 60600);
  assert.equal(f.budget.snapshot().used, 880);
  const preflight = f
    .observe(A, cutoff === undefined ? {} : { deadlineMs: start + cutoff })
    .then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
  await flush();
  assert.equal(f.grants.length, 2);
  assert.equal(f.calls.length, 4);
  return { ...f, start, preflight };
}

it("Core264/local880 waits to the real T72 local fee expiry without forgiving debt at Core T60 or pacing T65", async () => {
  const f = await mixedLedger();
  await f.t.advance(4400);
  assert.equal(f.budget.snapshot().used, 880);
  assert.equal(f.calls.length, 4);
  await f.t.advance(6999);
  assert.equal(f.calls.length, 4);
  assert.equal(f.budget.snapshot().used, 880);
  await f.t.advance(1);
  const outcome = await f.preflight;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.value.observed_at, f.start + 72000);
  assert.equal(f.calls.length, 5);
  assert.equal(f.budget.snapshot().used, 82);
  assert.equal(
    f.calls[4].deadline,
    f.start + 80600,
    "original20s scope limits the remaining wire window",
  );
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 2);
});

it("a known fee expiry outside the original caller cutoff fails without waiting, refunding or provider reads", async () => {
  const f = await mixedLedger(70000);
  const outcome = await f.preflight;
  assert.equal(outcome.ok, false);
  if (outcome.ok) assert.fail();
  assert.equal(outcome.error.details.reason_code, "READ_LOCAL_QUOTA");
  assert.equal(f.t.clock(), f.start + 60600);
  assert.equal(f.budget.snapshot().used, 880);
  assert.equal(f.calls.length, 4);
  assert.equal(f.budget.snapshot().observation_queued, 0);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 2);
});

it("caller abort and drain cancel only waiting admissions and end each original grant once", async () => {
  for (const kind of ["caller", "drain"] as const) {
    const f = setup(),
      active = f.budget.beginObservation(A),
      stop = new AbortController();
    const work = f.observe(B, { signal: stop.signal }).catch((e) => e);
    await flush();
    if (kind === "caller") stop.abort(new Error("fixture abort"));
    else await f.reads.drainAccounts();
    await work;
    active.close(false);
    await f.t.advance(20000);
    assert.equal(f.calls.length, 0);
    assert.equal(f.budget.snapshot().observation_queued, 0);
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
  }
});

it("aborting one same-owner scope preserves another live Core-granted waiter's FIFO reference", async () => {
  const f = setup(),
    active = f.budget.beginObservation(A),
    first = new AbortController();
  const rejected = f.observe(B, { signal: first.signal }).catch((e) => e);
  const surviving = f.observe(B);
  await flush();
  assert.equal(f.grants.length, 2);
  assert.equal(f.budget.snapshot().observation_queued, 1);
  first.abort(new Error("first fixture caller left"));
  await rejected;
  assert.equal(f.budget.snapshot().observation_queued, 1);
  assert.equal(f.calls.length, 0);
  active.close(false);
  await f.t.advance(1000);
  await surviving;
  assert.equal(f.calls.length, 1);
  assert.equal(f.budget.snapshot().observation_queued, 0);
  await f.reads.drainAccounts();
  assert.equal(new Set(f.ends).size, 2);
  assert.equal(f.ends.length, 2);
});

it("local BEGIN waits neither renew a short Core lease nor spend a changed operational hint", async () => {
  for (const gate of ["lease", "hint", "hintTTL"] as const) {
    const f = setup(undefined, gate === "lease" ? 1500 : 20000),
      active = f.budget.beginObservation(A);
    const result = f.observe(B).catch((e) => e);
    await flush();
    if (gate === "hint") {
      f.budget.refreshObservationPlan(B, { demand: 300, peaks: [280] }, 600000);
      active.close(false);
    }
    if (gate === "hintTTL") {
      f.budget.refreshObservationPlan(B, { demand: 184, peaks: [164] }, 500);
      active.close(false);
    }
    await f.t.advance(1000);
    const error = await result;
    assert.equal(
      error.code,
      gate === "lease"
        ? "VENUE_READ_BUDGET_EXHAUSTED"
        : "VENUE_COST_PLAN_UNAVAILABLE",
    );
    assert.equal(f.calls.length, 0);
    assert.equal(f.grants.length, 1);
    assert.equal(f.budget.snapshot().observation_queued, 0);
    active.close(false);
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
  }
});

it("an uncertain sent unknown fee is retained and its quarantine cannot become a waitable refund", async () => {
  const f = setup();
  const unknown = await f.budget.acquire(
    "account",
    20,
    "unknown",
    new AbortController().signal,
    true,
  );
  unknown.sent();
  const result = f.observe(B).catch((e) => e);
  await flush();
  await f.t.advance(1000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.budget.snapshot().used, 1000);
  unknown.uncertain();
  unknown.release();
  await f.t.advance(1000);
  const error = await result;
  assert.equal(error.details.reason_code, "READ_LOCAL_QUARANTINE");
  assert.equal(f.budget.snapshot().used, 1000);
  assert.equal(f.calls.length, 0);
  assert.equal(f.budget.snapshot().observation_queued, 0);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
});

it("provider429, authenticated Core budget-sent receipts and stale dispatched tickets are never BEGIN retries", async () => {
  assert.equal(
    isObservationAdmissionDeferred(
      new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "fixture remote reason",
        true,
        503,
        { reason_code: "READ_LOCAL_BUSY", retry_after_ms: 1 },
      ),
    ),
    false,
  );
  for (const kind of ["429", "sent"] as const) {
    const f = setup(async () => {
      throw new CoordinatedReadError(
        kind === "429" ? "VENUE_RATE_LIMITED" : "VENUE_READ_BUDGET_EXHAUSTED",
        true,
        1000,
      );
    });
    const error = await f.observe(A).catch((e) => e);
    assert.equal(f.calls.length, 1);
    assert.equal(f.grants.length, 1);
    assert.equal(isObservationAdmissionDeferred(error), false);
    if (kind === "sent")
      assert.equal(error.details.reason_code, "READ_CORE_BUDGET_SENT");
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
  }
  const budget = new VenueReadBudget();
  const stale = budget.beginObservation(A);
  stale.close(false);
  const error = await budget
    .acquire("account", 2, "x", new AbortController().signal, false, stale)
    .catch((e) => e);
  assert.equal(error.details.reason_code, "READ_LOCAL_TICKET_STALE");
  assert.equal(isObservationAdmissionDeferred(error), false);
  const execution: any = {};
  recordFirstSubmissionFailure(
    execution,
    error,
    0,
    () => 1,
    () => 1,
  );
  assert.equal(
    execution.first_submission_failure.reason_code,
    "READ_LOCAL_TICKET_STALE",
  );
});
