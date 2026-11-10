import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { AccountObservationPlans } from "./account-observation-plans.js";
import { framePendingContinuation } from "./core-frame-coordinator.js";
import { recordCoordinatedEvidence } from "./venue-read-transport.js";
import {
  VenueReadBudget,
  type BudgetTimers,
  type AccountReadReservation,
} from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { CoreBridge } from "./core_bridge.js";
import { issueNativeSourcePlan } from "./native-source-plan.js";
import { recommend } from "./domain.js";
import { candidate } from "./fixtures.js";
import { fromPlan } from "./service.js";
import { preparedPortfolioInput } from "./prepared-portfolio.js";
async function flush() {
  for (let n = 0; n < 120; n++) await Promise.resolve();
}
class Time {
  at = 1793200000000;
  seq = 0;
  events = new Map<number, { at: number; run(): void }>();
  clock = () => this.at;
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
    const end = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  async run<T>(work: Promise<T>) {
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
    for (let n = 0; !done && n < 25000; n++) await this.advance(1);
    assert.equal(done, true);
    if (error) throw error;
    return value;
  }
}
const signal = () => new AbortController().signal;
async function pay(
  b: VenueReadBudget,
  time: Time,
  t: AccountReadReservation,
  reserve: number,
  actual = reserve,
  lane: "account" | "source" = "account",
) {
  const ticket = await time.run(
    b.acquire(lane, reserve, "synthetic-source", signal(), false, t),
  );
  ticket.sent();
  ticket.settle(actual);
  ticket.release();
}
async function audit144(
  b: VenueReadBudget,
  time: Time,
  t: AccountReadReservation,
) {
  for (let i = 0; i < 7; i++) await pay(b, time, t, 20);
  for (let i = 0; i < 2; i++) await pay(b, time, t, 2);
}
function fixedStart(b: VenueReadBudget, time: Time) {
  const owner = "f".repeat(64),
    frameOwner = "e".repeat(64);
  b.refreshObservationPlan(
    owner,
    { demand: 184, peaks: [164, 164, 164] },
    600000,
  );
  const sources = Array.from({ length: 3 }, (_, i) => ({
    id: "trader_" + String(i + 1).repeat(32),
    address: "0x" + String(i + 1).repeat(40),
    requires_rwa: false as const,
  }));
  const token = issueNativeSourcePlan(
    {
      issuer: {},
      reader: {},
      budget: b,
      costOwner: owner,
      frameOwner,
      firstDeadline: time.at + 100000,
      operationalBinding: "c".repeat(64),
      purpose: "audit_source",
      network: "mainnet",
    },
    { sources, nonClosedSleeves: 3, fixedSourceIds: [sources[0].id] },
    async () => {},
  );
  const plan = b.preparedSupplementPlan(frameOwner, [sources[0].id], token),
    interest = b.beginObservationInterest(owner),
    parent = b.beginObservationBundle(
      owner,
      184,
      1,
      interest,
      false,
      [sources[0].id],
      plan,
    );
  return { owner, parent, interest, source: sources[0].id };
}
async function fixedPaid(b: VenueReadBudget, time: Time, close = true) {
  const f = fixedStart(b, time),
    child = f.parent.beginChild();
  await audit144(b, time, child);
  child.close(true);
  const s = f.parent.beginSupplement();
  for (let i = 0; i < 3; i++) await pay(b, time, s, 2, 2, "source");
  s.close(true);
  const h = f.parent.beginHistorySupplement(f.source);
  await pay(b, time, h, 120, 100, "source");
  await pay(b, time, h, 120, 36, "source");
  h.close(true);
  if (close) {
    f.parent.close(true);
    b.endObservationInterest(f.interest);
  }
  return f;
}
it("actual Fixed A144 S6 H136 produces21.45s base pacing; H240 pool is not sourceHold240 and begin/finish do not double-add", async () => {
  const time = new Time(),
    b = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  const started = time.at;
  await fixedPaid(b, time);
  const state = b as any,
    paid = state.recentObservationWeights.at(-1),
    record = state.recentSuccessfulObservationFrames.at(-1),
    sourceHold = Math.max(
      ...state.charges.map((c: any) => c.boundedSourceHold ?? 0),
    );
  assert.equal(paid, 286);
  assert.equal(record.paid, 286);
  assert.equal(record.demand, null);
  assert.equal(sourceHold, 120);
  assert.equal(state.nextObservationAt - started, 21450);
  assert.equal(state.observationPacingMs(286), 21450);
  console.log(
    JSON.stringify({
      control: "fixed_total_pacing",
      paid,
      sourceHold,
      eligibleDemand: record.demand,
      nextAtFromStartMs: state.nextObservationAt - started,
      baseFormulaMs: (286 * 60000) / 800,
      used: b.snapshot().used,
    }),
  );
  await time.advance(21450 - (time.at - started));
  b.refreshObservationPlan(
    "a".repeat(64),
    { demand: 184, peaks: [164] },
    600000,
  );
  const start2 = time.at,
    t = b.beginObservation("a".repeat(64));
  const afterBegin = state.nextObservationAt;
  await audit144(b, time, t);
  t.close(true);
  assert.equal(afterBegin - start2, 21450);
  assert.equal(
    state.nextObservationAt,
    afterBegin,
    "finish max uses frame.started, it does not add another pacing interval",
  );
  console.log(
    JSON.stringify({
      control: "no_double_add",
      start2,
      afterBegin,
      afterFinish: state.nextObservationAt,
    }),
  );
});
it("ordinary warm A144 is ineligible for sourceHold120 overhang even while a real bounded source ticket remains charged", async () => {
  const time = new Time(),
    b = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  b.refreshObservationPlan(
    "a",
    { demand: 184, peaks: [164, 164, 164] },
    600000,
  );
  const t = b.beginObservation("a");
  await audit144(b, time, t);
  t.close(true);
  const src = await time.run(b.acquire("source", 120, "history", signal()));
  src.sent();
  src.settle(36);
  src.release();
  assert.equal((b as any).observationPacingMs(144), 10800);
  console.log(
    JSON.stringify({
      control: "source_hold_does_not_inflate_A144",
      sourceHold: Math.max(
        ...(b as any).charges.map((c: any) => c.boundedSourceHold ?? 0),
      ),
      spacing: (b as any).observationPacingMs(144),
    }),
  );
});
it("prepared-only local pending keeps the original entry and FIRST without early Core grant, then has the full20s at actual grant", async (t) => {
  const time = new Time();
  t.mock.method(Date, "now", time.clock);
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  await fixedPaid(budget, time);
  const b = new CoreBridge(
    "https://core.invalid",
    "fixture",
    "postgresql://127.0.0.1:1/unused",
    "s".repeat(32),
    "mainnet",
    { infoReadRoute: "core" },
  ) as any;
  await b.pool.end();
  b.pool = {
    end: async () => {},
    query: async () =>
      assert.fail("offline metadata fixture must not query PG"),
  };
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "single",
      },
      [candidate(1)],
    ),
  );
  p.account_id = "22222222-2222-4222-8222-222222222222";
  p.venue_accounts = { perps: p.account_id };
  p.state = "active";
  p.initial_equity = "1000";
  p.ledger_started_at = time.at - 10000;
  p.reconciliation = "complete";
  for (const s of p.sleeves) {
    s.state = "active";
    s.initialized = true;
    s.reviewed_at = time.at;
  }
  const identity = {
    account_id: p.account_id,
    network: 2,
    master: "0x" + "1".repeat(40),
    agent: "0x" + "2".repeat(40),
    wallet_generation: 1,
    status: 4,
    policy_revision: 1,
  };
  b.core = async (op: string) => {
    assert.equal(op, "perps_account");
    return identity;
  };
  const compact = preparedPortfolioInput(p),
    owner = await b.preparedIdentity("synthetic-user", compact);
  let begins: any[] = [],
    ends: any[] = [],
    claims = 0,
    wires = 0;
  const coordinator = coreFrameCoordinator(
    "http://127.0.0.1:1",
    "fixture",
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("_end")) {
        ends.push({ ...body, at: time.at });
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      begins.push({ ...body, at: time.at });
      assert.ok(286 + body.weight <= 900);
      return Response.json({
        state: "granted",
        frame_id: body.frame_id,
        expires_at: time.at + 20000,
        reserved_weight: body.weight,
        capacity: 900,
        guaranteed_complete: false,
      });
    },
    time.clock,
  );
  budget.refreshObservationPlan(
    owner,
    { demand: 184, peaks: [164, 164, 164] },
    600000,
  );
  b.venueReads = new VenueReads(
    async () => {
      wires++;
      assert.fail("preparation cannot dispatch provider reads");
    },
    time.clock,
    2,
    {
      transport: "core_shared_info",
      budget,
      frameCoordinator: coordinator,
      timers: time.timers,
      monotonicClock: time.clock,
      report: () => {},
      observationPlans: {
        read: async () => ({
          owner,
          generation: "1",
          plan: { demand: 184, peaks: [164, 164, 164] },
          remainingTtlMs: 600000,
        }),
        begin: async () => {
          claims++;
          throw Error("no dirty claim expected");
        },
        complete: async () => assert.fail("no completion expected"),
      },
    },
  );
  t.after(async () => b.close());
  const prepare = () =>
    b.operation("prepare_portfolio", {
      user_id: "synthetic-user",
      portfolio: compact,
    });
  const start = time.at;
  const initial = await prepare();
  assert.equal(initial.state, "pending");
  assert.equal(initial.retry_after_ms, 21436);
  assert.equal(begins.length, 0);
  assert.equal(ends.length, 0);
  assert.equal(claims, 0);
  assert.equal(wires, 0);
  const entry = [...b.preparedEntries.values()][0] as any,
    originalDeadline = entry.deadline,
    originalHandle = entry.handle;
  assert.equal(entry.expired, false);
  assert.equal(entry.pin, undefined);
  assert.equal(budget.snapshot().observation_queued, 0);
  await time.advance(5000);
  assert.equal((await prepare()).state, "pending");
  assert.equal(b.preparedEntries.get(entry.key), entry);
  assert.equal(entry.deadline, originalDeadline);
  assert.equal(begins.length, 0);
  assert.equal(claims, 0);
  await time.advance((budget as any).nextObservationAt - time.at);
  const ready: any = await time.run(prepare());
  assert.equal(ready.state, "ready");
  assert.equal(ready.handle, originalHandle);
  assert.equal(begins.length, 1);
  assert.equal(begins[0].deadline_ms, originalDeadline);
  assert.equal(ready.expires_at - begins[0].at, 20000);
  assert.equal(claims, 0);
  assert.equal(wires, 0);
  console.log(
    JSON.stringify({
      control: "prepared_pregrant_local_schedule",
      firstHandlePreserved: ready.handle === originalHandle,
      firstDeadlinePreserved: begins[0].deadline_ms === originalDeadline,
      coreBeginsBeforeReady: 0,
      coreGrants: begins.length,
      remainingCoreLeaseMs: ready.expires_at - time.at,
      dirtyClaims: claims,
      venueWires: wires,
      readyAfterOriginalStartMs: time.at - start,
    }),
  );
  await b.operation(
    "finish_portfolio",
    { user_id: "synthetic-user" },
    undefined,
    undefined,
    ready.handle,
  );
});

function component(t: TestContext) {
  const time = new Time(),
    owner = "a".repeat(64),
    frameOwner = "b".repeat(64);
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  let pendingCore = false,
    coreBarrier: Promise<void> | undefined,
    providerBarrier: Promise<void> | undefined,
    readBarrier: Promise<void> | undefined,
    generation = 1,
    dirty = false,
    wires = 0,
    loads = 0,
    claims = 0,
    publications = 0;
  let plan = { demand: 184, peaks: [164, 164, 164] };
  const begins: any[] = [],
    ends: any[] = [];
  const coordinator = coreFrameCoordinator(
    "http://127.0.0.1:1",
    "fixture",
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("_end")) {
        ends.push(body);
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      begins.push({ ...body, at: time.at });
      if (coreBarrier) await coreBarrier;
      return Response.json({
        state: pendingCore ? "pending" : "granted",
        frame_id: body.frame_id,
        expires_at: pendingCore ? body.deadline_ms : time.at + 20000,
        retry_after_ms: pendingCore ? 1000 : 0,
        reserved_weight: pendingCore ? 0 : body.weight,
        capacity: 900,
        guaranteed_complete: false,
      });
    },
    time.clock,
  );
  const reads = new VenueReads(
    async () => {
      wires++;
      if (providerBarrier) await providerBarrier;
      const response = Response.json({});
      recordCoordinatedEvidence(response, time.at);
      return response;
    },
    time.clock,
    2,
    {
      transport: "core_shared_info",
      budget,
      frameCoordinator: coordinator,
      timers: time.timers,
      monotonicClock: time.clock,
      report: () => {},
      observationPlans: {
        read: async () => {
          loads++;
          if (readBarrier) await readBarrier;
          if (dirty) throw Error("active dirty generation must not be read");
          return {
            owner,
            generation: String(generation),
            plan,
            remainingTtlMs: 600000,
          };
        },
        begin: async () => {
          claims++;
          assert.equal(dirty, false);
          dirty = true;
          return {
            owner,
            generation: String(++generation),
            plan,
            remainingTtlMs: 600000,
          };
        },
        complete: async (lease, value, signal) => {
          assert.equal(signal.aborted, false);
          assert.equal(lease.generation, String(generation));
          dirty = false;
          plan = { demand: value.demand, peaks: [...value.peaks] };
          publications++;
          return true;
        },
      },
    },
  );
  budget.refreshObservationPlan(owner, plan, 600000);
  t.after(() => reads.drainAccounts());
  const first = time.at + 100000;
  const prepare = (
    continuation?: object,
    options: any = {},
    deadline = first,
    signal?: AbortSignal,
  ) =>
    reads.prepareAccountWindow(
      owner,
      frameOwner,
      deadline,
      continuation,
      signal,
      options,
    );
  const binding = (
    continuation?: object,
    options: any = {},
    deadline = first,
  ) => ({
    owner,
    frameOwner,
    firstDeadline: deadline,
    continuation,
    ...options,
  });
  const account = () =>
    reads.observeAccount(async () => {
      reads.bindAccountCostPlan(owner);
      return reads.read("https://api.hyperliquid.xyz/info", {
        type: "userAbstraction",
        user: "0x" + "1".repeat(40),
      });
    }, owner);
  return {
    time,
    budget,
    reads,
    coordinator,
    owner,
    frameOwner,
    first,
    begins,
    ends,
    prepare,
    binding,
    account,
    stats: () => ({ wires, loads, claims, publications, dirty, generation }),
    pending: (value: boolean) => {
      pendingCore = value;
    },
    coreBarrier: (value: Promise<void> | undefined) => {
      coreBarrier = value;
    },
    providerBarrier: (value: Promise<void> | undefined) => {
      providerBarrier = value;
    },
    readBarrier: (value: Promise<void> | undefined) => {
      readBarrier = value;
    },
    setPlan: (demand: number) => {
      plan = { demand, peaks: [demand - 20, demand - 20, demand - 20] };
      generation++;
    },
  };
}

it("an empty queue is schedulable and the pure relative probe neither registers nor refreshes an interest", async () => {
  const time = new Time(),
    budget = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  const before = budget.snapshot();
  for (let i = 0; i < 3; i++)
    assert.deepEqual(budget.preparedObservationSchedule("owner"), {
      ready: true,
    });
  assert.deepEqual(budget.snapshot(), before);
  const interest = budget.beginObservationInterest("other"),
    snapshot = budget.snapshot();
  assert.deepEqual(budget.preparedObservationSchedule("owner"), {
    ready: false,
    reason: "READ_LOCAL_FIFO",
    retryAfterMs: 1000,
  });
  assert.deepEqual(budget.preparedObservationSchedule("other"), {
    ready: true,
  });
  assert.deepEqual(budget.snapshot(), snapshot);
  budget.endObservationInterest(interest);
});

it("a local scheduling error is not a Core continuation and only its exact reader/context consumes the private brand once", async (t) => {
  const f = component(t);
  await fixedPaid(f.budget, f.time);
  let error: any;
  try {
    await f.prepare();
    assert.fail();
  } catch (e) {
    error = e;
  }
  assert.equal(framePendingContinuation(error), undefined);
  assert.equal(f.begins.length, 0);
  assert.equal(f.stats().claims, 0);
  const other = component(t);
  assert.equal(other.reads.preparedLocalRetry(error, f.binding()), undefined);
  for (const altered of [
    { ...f.binding(), owner: "c".repeat(64) },
    { ...f.binding(), frameOwner: "c".repeat(64) },
    { ...f.binding(), firstDeadline: f.first + 1 },
    { ...f.binding(), purpose: "audit_source" as const },
    { ...f.binding(), continuation: {} },
    { ...f.binding(), historySources: ["wrong"] },
  ])
    assert.equal(f.reads.preparedLocalRetry(error, altered), undefined);
  assert.equal(
    f.reads.preparedLocalRetry({ ...error }, f.binding()),
    undefined,
  );
  assert.equal(
    f.reads.preparedLocalRetry(error, f.binding()),
    Math.ceil((f.budget as any).nextObservationAt - f.time.at),
  );
  assert.equal(f.reads.preparedLocalRetry(error, f.binding()), undefined);
});

it("same-owner active A completes without a prepared BUSY probe replacing its attempt or reading its dirty hint", async (t) => {
  const f = component(t);
  let release!: () => void;
  f.providerBarrier(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const work = f.account();
  await flush();
  assert.equal(f.stats().dirty, true);
  assert.equal(f.stats().wires, 1);
  const attempt = (f.budget as any).observationPlanAttempts.get(f.owner),
    before = f.stats();
  let error: any;
  try {
    await f.prepare();
    assert.fail();
  } catch (e) {
    error = e;
  }
  assert.equal(f.reads.preparedLocalRetry(error, f.binding()), 1000);
  assert.deepEqual(f.stats(), before);
  assert.equal((f.budget as any).observationPlanAttempts.get(f.owner), attempt);
  assert.equal(f.begins.length, 1);
  release();
  await work;
  assert.equal(f.stats().dirty, false);
  assert.equal(f.stats().publications, 1);
  await f.time.advance(2000);
  const ready = await f.time.run(f.prepare());
  assert.equal(ready.mode, "warm");
  assert.ok(f.stats().loads > before.loads);
  await ready.close();
});

it("a real Core pending pin is not polled or ended while local pacing is pending and resumes the same UUID/FIRST after a legal hint decline", async (t) => {
  const f = component(t);
  f.pending(true);
  let pin!: object;
  await assert.rejects(f.prepare(), (e) => {
    pin = framePendingContinuation(e)!;
    return !!pin;
  });
  const first = { ...f.begins[0] };
  await fixedPaid(f.budget, f.time);
  let error: any;
  try {
    await f.prepare(pin);
    assert.fail();
  } catch (e) {
    error = e;
  }
  assert.equal(framePendingContinuation(error), undefined);
  assert.ok(f.reads.preparedLocalRetry(error, f.binding(pin))! > 0);
  assert.equal(f.begins.length, 1);
  assert.equal(f.ends.length, 0);
  f.setPlan(164);
  await f.time.advance((f.budget as any).nextObservationAt - f.time.at);
  f.pending(false);
  const ready = await f.time.run(f.prepare(pin));
  assert.equal(f.begins.length, 2);
  assert.equal(f.begins[1].frame_id, first.frame_id);
  assert.equal(f.begins[1].deadline_ms, first.deadline_ms);
  assert.equal(f.begins[1].weight, first.weight);
  assert.equal(f.budget.snapshot().observation_reserved, 328);
  assert.equal(ready.expires_at - f.begins[1].at, 20000);
  assert.equal(f.stats().claims, 0);
  assert.equal(f.stats().wires, 0);
  await ready.close();
});

it("fake or foreign continuation cannot obtain even a BUSY local pending brand", async (t) => {
  const f = component(t),
    other = component(t);
  other.pending(true);
  let pin!: object;
  await assert.rejects(other.prepare(), (e) => {
    pin = framePendingContinuation(e)!;
    return !!pin;
  });
  const active = f.budget.beginObservation("active");
  for (const token of [{}, JSON.parse(JSON.stringify(pin)), pin]) {
    let error: any;
    try {
      await f.prepare(token);
      assert.fail();
    } catch (e) {
      error = e;
    }
    assert.equal(
      f.reads.preparedLocalRetry(error, f.binding(token)),
      undefined,
    );
    assert.equal(f.stats().loads, 0);
  }
  active.close(false);
  await other.reads.cancelPreparedPending(pin);
});

it("expired FIRST and a changed pool cannot use a local defer to renew or silently rebook the old Core pin", async (t) => {
  const f = component(t);
  f.pending(true);
  let pin!: object;
  await assert.rejects(f.prepare(), (e) => {
    pin = framePendingContinuation(e)!;
    return !!pin;
  });
  await fixedPaid(f.budget, f.time);
  f.setPlan(200);
  await assert.rejects(f.prepare(pin), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 1);
  await f.time.advance(f.first - f.time.at + 1);
  await assert.rejects(f.prepare(pin), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 1);
  await f.reads.cancelPreparedPending(pin);
  assert.equal(f.ends.length, 1);
});

it("post-grant local pacing races retain the original bounded rejection instead of becoming pre-grant pending", async (t) => {
  const f = component(t);
  let release!: () => void;
  f.coreBarrier(
    new Promise<void>((r) => {
      release = r;
    }),
  );
  const work = f.prepare();
  await flush();
  assert.equal(f.begins.length, 1);
  await fixedPaid(f.budget, f.time);
  release();
  let error: any;
  try {
    await work;
    assert.fail();
  } catch (e) {
    error = e;
  }
  await flush();
  assert.equal(error.details.reason_code, "READ_LOCAL_PACING");
  assert.equal(f.reads.preparedLocalRetry(error, f.binding()), undefined);
  assert.equal(f.ends.length, 1);
  assert.equal(f.stats().claims, 0);
  assert.equal(f.stats().wires, 0);
});

it("disconnect or drain during the fresh metadata read cannot return local pending or begin a Core frame", async (t) => {
  for (const action of ["disconnect", "drain"] as const) {
    const f = component(t);
    let release!: () => void;
    f.readBarrier(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    const controller = new AbortController();
    const work = f.prepare(undefined, {}, f.first, controller.signal);
    await flush();
    assert.equal(f.stats().loads, 1);
    if (action === "disconnect")
      controller.abort(Error("fixture disconnected"));
    else await f.reads.drainAccounts();
    release();
    let error: any;
    try {
      await work;
      assert.fail();
    } catch (e) {
      error = e;
    }
    assert.equal(f.reads.preparedLocalRetry(error, f.binding()), undefined);
    assert.equal(f.begins.length, 0);
    assert.equal(f.stats().claims, 0);
    assert.equal(f.stats().wires, 0);
  }
});

it("ordinary account observation still uses its existing post-grant pacing wait and cannot mint the prepared brand", async (t) => {
  const f = component(t);
  await fixedPaid(f.budget, f.time);
  let error: any;
  try {
    await f.time.run(f.account());
    assert.fail();
  } catch (e) {
    error = e;
  }
  assert.equal(f.begins.length, 1);
  assert.equal(error.details.reason_code, "READ_LOCAL_PACING");
  assert.equal(f.reads.preparedLocalRetry(error, f.binding()), undefined);
  assert.equal(f.stats().wires, 0);
  assert.equal(f.stats().claims, 0);
});

it(
  "a BUSY prepared probe leaves a real same-owner PG dirty generation/lease byte-identical and the original active A can still publish",
  { skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL, timeout: 20000 },
  async (t) => {
    const f = component(t),
      url = new URL(process.env.RIDE_AGENT_TEST_DATABASE_URL!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    const admin = new pg.Pool({ connectionString: url.toString(), max: 2 }),
      schema = "local_ready_" + randomUUID().replaceAll("-", "");
    await admin.query("CREATE SCHEMA " + schema);
    url.searchParams.set("options", "-c search_path=" + schema);
    const pool = new pg.Pool({ connectionString: url.toString(), max: 2 }),
      store = new AccountObservationPlans(pool);
    t.after(async () => {
      await f.reads.drainAccounts();
      await pool.end();
      await admin.query("DROP SCHEMA " + schema + " CASCADE");
      await admin.end();
    });
    await store.migrate();
    const seeded = await store.begin(f.owner, signal());
    assert.equal(
      await store.complete(
        seeded,
        { demand: 184, peaks: [164, 164, 164] },
        signal(),
      ),
      true,
    );
    let loads = 0,
      claims = 0,
      publications = 0;
    (f.reads as any).observationPlans = {
      read: async (...args: Parameters<AccountObservationPlans["read"]>) => {
        loads++;
        return store.read(...args);
      },
      begin: async (...args: Parameters<AccountObservationPlans["begin"]>) => {
        claims++;
        return store.begin(...args);
      },
      complete: async (
        ...args: Parameters<AccountObservationPlans["complete"]>
      ) => {
        const ok = await store.complete(...args);
        if (ok) publications++;
        return ok;
      },
    };
    let release!: () => void;
    f.providerBarrier(
      new Promise<void>((r) => {
        release = r;
      }),
    );
    t.after(() => release());
    const work = f.account();
    let done = false,
      error: unknown;
    void work.catch((e) => {
      done = true;
      error = e;
    });
    for (let n = 0; f.stats().wires < 1 && !done && n < 5000; n++)
      await new Promise<void>((r) => setTimeout(r, 1));
    if (error) throw error;
    assert.equal(f.stats().wires, 1);
    assert.equal(loads, 1);
    assert.equal(claims, 1);
    const row = async () =>
      (
        await pool.query(
          "SELECT generation::text,dirty,demand,peaks,learned_at::text,lease_until::text FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [f.owner],
        )
      ).rows[0];
    const before = await row(),
      attempt = (f.budget as any).observationPlanAttempts.get(f.owner);
    assert.equal(before.dirty, true);
    assert.notEqual(before.lease_until, null);
    let pending: any;
    try {
      await f.prepare();
      assert.fail();
    } catch (e) {
      pending = e;
    }
    assert.equal(f.reads.preparedLocalRetry(pending, f.binding()), 1000);
    assert.deepEqual(
      await row(),
      before,
      "generation,dirty,demand,peaks and exact PG microsecond stamps stay unchanged",
    );
    assert.equal(
      (f.budget as any).observationPlanAttempts.get(f.owner),
      attempt,
    );
    assert.equal(loads, 1);
    assert.equal(claims, 1);
    assert.equal(publications, 0);
    assert.equal(f.stats().wires, 1);
    assert.equal(f.begins.length, 1);
    release();
    await work;
    const after = await row();
    assert.equal(after.dirty, false);
    assert.equal(after.lease_until, null);
    assert.equal(after.generation, before.generation);
    assert.equal(publications, 1);
    await f.time.advance(2000);
    const ready = await f.prepare();
    assert.equal(ready.mode, "warm");
    assert.equal(loads, 2);
    assert.equal(claims, 1);
    await ready.close();
  },
);
