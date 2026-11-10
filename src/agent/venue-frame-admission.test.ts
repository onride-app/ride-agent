import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import {
  VenueReads,
  type AccountReadFrameCoordinator,
  type AccountReadFrameLease,
} from "./venue-reads.js";
import type { VenueReadFetcher } from "./venue-read-transport.js";

const url = "https://api.hyperliquid.xyz/info";
const owner = "a".repeat(64);
async function flush() {
  for (let n = 0; n < 80; n++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
          .filter(([, event]) => event.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
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
function setup(
  t: ReturnType<typeof time>,
  coordinator: AccountReadFrameCoordinator,
  fetcher: VenueReadFetcher,
  signal?: AbortSignal,
) {
  const budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  const reads = new VenueReads(fetcher, t.clock, 2, {
    transport: "core_shared_info",
    budget,
    timers: t.timers,
    monotonicClock: t.clock,
    report: () => {},
    frameCoordinator: coordinator,
    signal,
  });
  return { reads, budget };
}

async function paySource(budget: VenueReadBudget, weight = 20) {
  const ticket = await budget.acquire(
    "source",
    weight,
    "fixture_source",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(weight);
  ticket.release();
}

async function auditedPacingFixture(afterAudit?: VenueReadFetcher) {
  const t = time();
  let begins = 0;
  const ends: string[] = [],
    calls: { at: number; context: any }[] = [];
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      return {
        frame_id: `frame_pacing_${String(++begins).padStart(16, "0")}`,
        expires_at: t.clock() + 20000,
      };
    },
    async end(id) {
      ends.push(id);
    },
  };
  const { reads, budget } = setup(
    t,
    coordinator,
    async (_url, _init, context) => {
      calls.push({ at: t.clock(), context });
      if (calls.length > 4 && afterAudit)
        return afterAudit(_url, _init, context);
      return Response.json({});
    },
  );
  await reads.observeAccount(async () => {
    for (let n = 0; n < 4; n++) await reads.read(url, { type: "meta" });
  }, owner);
  await flush();
  assert.equal(budget.snapshot().used, 80);
  assert.equal(budget.snapshot().observation_pacing_ms, 6000);
  return { t, reads, budget, calls, ends, coordinator, begins: () => begins };
}

it("waits the original six-second pacing after an80weight audit before a fresh preflight without refreshing either deadline", async () => {
  const f = await auditedPacingFixture(),
    start = f.t.clock();
  const result = f.reads.observeAccount(
    () =>
      f.reads.readWithEvidence(url, {
        type: "clearinghouseState",
        user: "fixture",
      }),
    owner,
  );
  await flush();
  assert.equal(f.begins(), 2);
  assert.equal(f.calls.length, 4);
  assert.equal(f.ends.length, 1);
  assert.equal(f.budget.snapshot().observations.started, 1);
  await f.t.advance(5999);
  assert.equal(f.calls.length, 4);
  await f.t.advance(1);
  const evidence = await result;
  assert.equal(evidence.observed_at, start + 6000);
  assert.equal(
    f.calls[4].context.deadline_ms,
    start + 18000,
    "wire remains12s, not a renewed20s scope",
  );
  assert.equal(f.begins(), 2, "no second fleet reservation while waiting");
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 2);
  assert.equal(new Set(f.ends).size, 2);
});

it("a pacing grant cannot wait past the execution or original Core lease cutoff", async () => {
  for (const cutoff of ["execution", "core"] as const) {
    const f = await auditedPacingFixture();
    if (cutoff === "core")
      f.coordinator.begin = async () => ({
        frame_id: "frame_short_lease_000001",
        expires_at: f.t.clock() + 5000,
      });
    await assert.rejects(
      f.reads.observeAccount(
        () => f.reads.read(url, { type: "allMids" }),
        owner,
        cutoff === "execution" ? { deadlineMs: f.t.clock() + 5000 } : {},
      ),
    );
    await f.reads.drainAccounts();
    assert.equal(f.calls.length, 4);
    assert.equal(f.ends.length, 2);
    assert.equal(f.budget.snapshot().used, 80);
  }
});

it("keeps hard quota and cooldown closed while rechecking an exclusive gate without refunding it", async () => {
  for (const gate of ["quota", "unknown", "cooldown"] as const) {
    const f = await auditedPacingFixture();
    let ticket;
    if (gate === "quota" || gate === "unknown") {
      ticket = await f.budget.acquire(
        "account",
        gate === "quota" ? 850 : 20,
        "",
        new AbortController().signal,
        gate === "unknown",
      );
      if (gate === "quota") {
        ticket.sent();
        ticket.settle(850);
        ticket.release();
      }
    } else f.budget.note429(30000);
    const at = f.t.clock();
    const observation = f.reads.observeAccount(
      () => f.reads.read(url, { type: "allMids" }),
      owner,
    );
    if (gate === "unknown") {
      let done = false;
      const result = observation.then((value) => {
        done = true;
        return value;
      });
      await f.t.advance(500);
      assert.equal(done, false);
      assert.equal(f.calls.length, 4);
      assert.equal(f.budget.snapshot().used, 1000);
      ticket!.release();
      assert.equal(f.budget.snapshot().used, 80);
      await f.t.advance(5500);
      await result;
      assert.equal(f.calls.length, 5);
    } else {
      await assert.rejects(observation);
      assert.equal(f.t.clock(), at);
      assert.equal(f.calls.length, 4);
    }
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, gate === "cooldown" ? 1 : 2);
  }
});

it("aborts pacing waits on caller disconnect or drain with no late provider call and one end per grant", async () => {
  for (const kind of ["caller", "drain"] as const) {
    const f = await auditedPacingFixture(),
      stop = new AbortController();
    const work = f.reads.observeAccount(
      () => f.reads.read(url, { type: "allMids" }),
      owner,
      { signal: stop.signal },
    );
    await flush();
    const rejected = assert.rejects(work);
    if (kind === "caller") stop.abort(new Error("fixture caller left"));
    else await f.reads.drainAccounts();
    await rejected;
    await f.t.advance(20000);
    await f.reads.drainAccounts();
    assert.equal(f.calls.length, 4);
    assert.equal(f.ends.length, 2);
    assert.equal(new Set(f.ends).size, 2);
    assert.equal(f.budget.snapshot().used, 80);
    assert.equal(f.budget.snapshot().observation_active, false);
  }
});

it("rechecks the full plan after pacing and releases changed-hint credit without a provider read", async () => {
  const f = await auditedPacingFixture();
  const work = f.reads.observeAccount(
    () => f.reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  f.budget.refreshObservationPlan(owner, { demand: 300, peaks: [280] }, 600000);
  const rejected = assert.rejects(
    work,
    (e) => e instanceof AgentError && e.code === "VENUE_COST_PLAN_UNAVAILABLE",
  );
  await f.t.advance(6000);
  await rejected;
  await f.reads.drainAccounts();
  assert.equal(f.calls.length, 4);
  assert.equal(f.ends.length, 2);
  assert.equal(f.budget.snapshot().observation_active, false);
});

it("a grant arriving late cannot renew the initial account deadline", async () => {
  const t = time();
  let ended = 0,
    calls = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      await t.advance(20001);
      return {
        frame_id: "frame_past_scope_000001",
        expires_at: t.clock() + 20000,
      };
    },
    async end() {
      ended++;
    },
  };
  const { reads } = setup(t, coordinator, async () => {
    calls++;
    return Response.json({});
  });
  await assert.rejects(
    reads.observeAccount(() => reads.read(url, { type: "allMids" }), owner),
  );
  await reads.drainAccounts();
  assert.equal(calls, 0);
  assert.equal(ended, 1);
});

it("the actual wire timer still expires12s after the six-second pacing wait", async () => {
  let wireSignal: AbortSignal | null | undefined;
  const f = await auditedPacingFixture(async (_url, init) => {
    wireSignal = init.signal;
    return new Promise<Response>(() => {});
  });
  const start = f.t.clock();
  const work = f.reads.observeAccount(
    () => f.reads.read(url, { type: "allMids" }),
    owner,
  );
  let settled = false;
  const rejected = assert
    .rejects(
      work,
      (e) => e instanceof AgentError && e.code === "VENUE_READ_DEADLINE",
    )
    .then(() => {
      settled = true;
    });
  await f.t.advance(6000);
  assert.equal(f.calls.length, 5);
  await f.t.advance(11999);
  assert.equal(settled, false);
  await f.t.advance(1);
  await rejected;
  assert.equal(f.t.clock(), start + 18000);
  assert.equal(wireSignal?.aborted, true);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 2);
  assert.equal(f.budget.snapshot().used, 82, "sent unknown weight is retained");
});

it("a waiting owner retains local FIFO and a later granted owner cannot use its pacing gap", async () => {
  const f = await auditedPacingFixture();
  const first = f.reads.observeAccount(
    () => f.reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  let laterDone = false;
  const later = f.reads
    .observeAccount(
      () => f.reads.read(url, { type: "allMids" }),
      "b".repeat(64),
    )
    .then((value) => {
      laterDone = true;
      return value;
    });
  await flush();
  assert.equal(laterDone, false);
  assert.equal(f.calls.length, 4);
  assert.equal(f.budget.snapshot().observations.started, 1);
  await f.t.advance(6000);
  await first;
  assert.equal(laterDone, false);
  assert.equal(f.calls.length, 5);
  await f.t.advance(10000);
  await later;
  await f.reads.drainAccounts();
  assert.equal(f.calls.length, 6);
  assert.equal(f.ends.length, 3);
});

it("draining a real Core coordinator ends the waiting lease exactly once on the wire", async () => {
  const t = time(),
    endIds: string[] = [];
  let wireCalls = 0;
  const coordinator = coreFrameCoordinator(
    "https://core.test",
    "fixture",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (!Object.hasOwn(body, "weight")) {
        endIds.push(body.frame_id);
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      return Response.json({
        state: "granted",
        frame_id: body.frame_id,
        expires_at: t.clock() + 20000,
        reserved_weight: body.weight,
        guaranteed_complete: false,
      });
    },
    t.clock,
  );
  const { reads } = setup(t, coordinator, async () => {
    wireCalls++;
    return Response.json({});
  });
  await reads.observeAccount(async () => {
    for (let n = 0; n < 4; n++) await reads.read(url, { type: "meta" });
  }, owner);
  await flush();
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  const rejected = assert.rejects(work);
  await reads.drainAccounts();
  await rejected;
  await t.advance(20000);
  assert.equal(wireCalls, 4);
  assert.equal(endIds.length, 2);
  assert.equal(new Set(endIds).size, 2);
});

it("drains an already admitted in-flight fleet read through its original completion", async () => {
  const t = time(),
    wire = deferred<Response>();
  let calls = 0,
    ended = 0,
    drained = false;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      return {
        frame_id: "frame_inflight_drain_0001",
        expires_at: t.clock() + 20000,
      };
    },
    async end() {
      ended++;
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    calls++;
    return wire.promise;
  });
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  assert.equal(calls, 1);
  const draining = reads.drainAccounts().then(() => {
    drained = true;
  });
  await flush();
  assert.equal(
    drained,
    false,
    "admitted work retains its original graceful completion",
  );
  wire.resolve(Response.json({}));
  await work;
  await draining;
  assert.equal(ended, 1);
  assert.equal(budget.snapshot().observations.completed, 1);
  assert.equal(budget.peekObservationDemand(owner), 120);
});

it("a backwards wall clock cannot renew the original monotonic scope after grant", async () => {
  const t = time();
  let offset = 0,
    wireCalls = 0;
  const clock = () => t.clock() + offset;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      await t.advance(5000);
      offset -= 10000;
      return {
        frame_id: "frame_clock_back_000001",
        expires_at: clock() + 20000,
      };
    },
    async end() {},
  };
  const budget = new VenueReadBudget({ clock, timers: t.timers });
  const reads = new VenueReads(
    async () => {
      wireCalls++;
      return Response.json({});
    },
    clock,
    2,
    {
      budget,
      timers: t.timers,
      monotonicClock: t.clock,
      transport: "core_shared_info",
      frameCoordinator: coordinator,
      report: () => {},
    },
  );
  const work = reads.observeAccount(async () => {
    await reads.read(url, { type: "allMids" });
    assert.equal(reads.accountReadTimeout(), 15000);
    await t.advance(15001);
    await reads.read(url, { type: "allMids" });
  }, owner);
  await assert.rejects(work);
  await reads.drainAccounts();
  assert.equal(wireCalls, 1);
});

it("polls a stable Core booking across busy local source rounds without taking a local observation ticket", async () => {
  const t = time(),
    rpc: any[] = [];
  let grant = false,
    wireCalls = 0;
  const coordinator = coreFrameCoordinator(
    "https://core.test",
    "fixture",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      rpc.push(body);
      if (!Object.hasOwn(body, "weight"))
        return Response.json({ state: "closed", frame_id: body.frame_id });
      return Response.json({
        state: grant ? "granted" : "pending",
        frame_id: body.frame_id,
        expires_at: grant ? t.clock() + 20000 : body.deadline_ms,
        retry_after_ms: 1000,
        reserved_weight: grant ? body.weight : 120,
        guaranteed_complete: false,
      });
    },
    t.clock,
  );
  const { reads, budget } = setup(t, coordinator, async () => {
    wireCalls++;
    return Response.json({});
  });
  await paySource(budget, 150);
  const attempt = () =>
    reads.observeAccount(() => reads.read(url, { type: "allMids" }), owner);
  for (let n = 0; n < 2; n++) {
    await assert.rejects(
      attempt(),
      (e) =>
        e instanceof AgentError &&
        e.details?.reason_code === "READ_FRAME_PENDING",
    );
    assert.equal(budget.snapshot().observations.started, 0);
    assert.equal(budget.snapshot().observation_queued, 0);
    if (n === 0) {
      await t.advance(30000);
      await paySource(budget, 150);
    }
  }
  assert.equal(rpc.length, 2);
  assert.equal(rpc[0].frame_id, rpc[1].frame_id);
  assert.equal(rpc[0].deadline_ms, rpc[1].deadline_ms);
  assert.equal(
    budget.peekObservationDemand(owner),
    1000,
    "cold hint remains full local demand",
  );
  grant = true;
  await assert.rejects(
    attempt(),
    (e) => e instanceof AgentError && e.code === "VENUE_READ_BUDGET_EXHAUSTED",
  );
  await flush();
  assert.equal(
    rpc.length,
    4,
    "one grant poll and one release, no second poll in this transaction",
  );
  assert.equal(rpc[3].frame_id, rpc[0].frame_id);
  assert.equal(Object.hasOwn(rpc[3], "weight"), false);
  assert.equal(wireCalls, 0);
  assert.equal(budget.snapshot().used, 300);
  assert.equal(budget.snapshot().observations.started, 0);
  await reads.drainAccounts();
});

it("waits the real remaining quota expiry without credit forgiveness or a renewed Core grant", async () => {
  const t = time();
  let ended = 0,
    polls = 0,
    wireCalls = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      polls++;
      return {
        frame_id: "frame_local_quota_0001",
        expires_at: t.clock() + 20000,
      };
    },
    async end(id) {
      assert.equal(id, "frame_local_quota_0001");
      ended++;
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    wireCalls++;
    return Response.json({});
  });
  await paySource(budget, 300);
  await t.advance(59950);
  const at = t.clock();
  const observation = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  assert.equal(t.clock(), at);
  assert.equal(polls, 1);
  assert.equal(ended, 0);
  assert.equal(wireCalls, 0);
  assert.equal(budget.snapshot().used, 300);
  assert.equal(budget.snapshot().observations.started, 0);
  await t.advance(49);
  assert.equal(wireCalls, 0);
  assert.equal(budget.snapshot().used, 300);
  await t.advance(1);
  await observation;
  assert.equal(polls, 1);
  assert.equal(wireCalls, 1);
  assert.equal(budget.snapshot().used, 2);
  await reads.drainAccounts();
  assert.equal(ended, 1);
});

it("fails closed and releases the grant when full local demand changes while Core admission is in flight", async () => {
  const t = time(),
    grant = deferred<AccountReadFrameLease>();
  let polls = 0,
    ended = 0,
    wireCalls = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin(_owner, weight) {
      polls++;
      assert.equal(weight, 200);
      return grant.promise;
    },
    async end(id) {
      assert.equal(id, "frame_changed_hint_0001");
      ended++;
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    wireCalls++;
    return Response.json({});
  });
  budget.restoreObservationPlan(owner, { demand: 200, peaks: [180] }, 600000);
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  assert.equal(budget.snapshot().observations.started, 0);
  budget.refreshObservationPlan(owner, { demand: 300, peaks: [280] }, 600000);
  grant.resolve({
    frame_id: "frame_changed_hint_0001",
    expires_at: t.clock() + 20000,
  });
  await assert.rejects(
    work,
    (e) => e instanceof AgentError && e.code === "VENUE_COST_PLAN_UNAVAILABLE",
  );
  await flush();
  assert.equal(polls, 1);
  assert.equal(ended, 1);
  assert.equal(wireCalls, 0);
  assert.equal(budget.snapshot().used, 0);
  assert.equal(budget.snapshot().observation_active, false);
  assert.equal(budget.peekObservationDemand(owner), 300);
  await reads.drainAccounts();
});

it("keeps local owner FIFO authoritative when Core grants arrive behind another active local account", async () => {
  const t = time();
  const grants: string[] = [],
    ended: string[] = [];
  let wireCalls = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      const frame_id = `frame_fifo_local_${String(grants.length).padStart(8, "0")}`;
      grants.push(frame_id);
      return { frame_id, expires_at: t.clock() + 20000 };
    },
    async end(id) {
      ended.push(id);
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    wireCalls++;
    return Response.json({});
  });
  const active = budget.beginObservation("b".repeat(64)),
    later = "c".repeat(64);
  const firstRead = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  const laterRead = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    later,
  );
  await flush();
  assert.equal(grants.length, 2);
  assert.equal(ended.length, 0);
  assert.equal(wireCalls, 0);
  assert.equal(budget.snapshot().observation_active, true);
  assert.equal(budget.snapshot().observation_queued, 2);
  active.close(false);
  await t.advance(1500);
  await firstRead;
  await laterRead;
  assert.equal(wireCalls, 2);
  assert.equal(budget.snapshot().observation_active, false);
  assert.equal(budget.snapshot().observation_queued, 0);
  await reads.drainAccounts();
  assert.deepEqual(ended, grants);
});

it("drains a late grant despite busy source charges without reserving or refunding a local account ticket", async () => {
  const t = time(),
    grant = deferred<AccountReadFrameLease>(),
    stopped = new AbortController();
  let ended = 0,
    wireCalls = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    begin: () => grant.promise,
    async end() {
      ended++;
    },
  };
  const { reads, budget } = setup(
    t,
    coordinator,
    async () => {
      wireCalls++;
      return Response.json({});
    },
    stopped.signal,
  );
  await paySource(budget);
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  stopped.abort(new Error("fixture stop"));
  await assert.rejects(work);
  const draining = reads.drainAccounts();
  grant.resolve({
    frame_id: "frame_busy_late_000001",
    expires_at: t.clock() + 20000,
  });
  await draining;
  assert.equal(ended, 1);
  assert.equal(wireCalls, 0);
  assert.equal(budget.snapshot().used, 20);
  assert.equal(budget.snapshot().observations.started, 0);
});

it("peeks full demand without joining or renewing local queues or expired plans", async () => {
  const t = time();
  const budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  assert.equal(budget.peekObservationDemand(owner), 1000);
  assert.equal(budget.snapshot().observation_queued, 0);
  budget.refreshObservationPlan(owner, { demand: 200, peaks: [180] }, 100);
  assert.equal(budget.peekObservationDemand(owner), 200);
  await t.advance(101);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  await paySource(budget);
  assert.throws(() => budget.beginObservation(owner));
  await t.advance(119999);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  await t.advance(2);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  assert.equal(
    budget.snapshot().observation_queued,
    0,
    "peeking cannot refresh FIFO seen time",
  );
  assert.equal(budget.snapshot().observations.started, 0);
});

function trialCoordinator(t: ReturnType<typeof time>) {
  const bookings: { weight: number; mode: string }[] = [],
    ended: string[] = [];
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin(_owner, weight, _deadline, _signal, mode) {
      bookings.push({ weight, mode });
      return {
        frame_id: `frame_trial_case_${String(bookings.length).padStart(8, "0")}`,
        expires_at: t.clock() + 20000,
      };
    },
    async end(id) {
      ended.push(id);
    },
  };
  return { coordinator, bookings, ended };
}

it("completes a full cold scope with100paid source weight using an explicit780trial while preserving its1000hint before success", async () => {
  const t = time(),
    c = trialCoordinator(t);
  let wireCalls = 0;
  const { reads, budget } = setup(t, c.coordinator, async (_url, init) => {
    wireCalls++;
    assert.equal(budget.peekObservationDemand(owner), 1000);
    assert.ok(
      budget.snapshot().used + budget.snapshot().observation_reserved <= 1000,
    );
    return Response.json(
      JSON.parse(String(init.body)).type === "userFillsByTime" ? [] : {},
    );
  });
  await paySource(budget, 100);
  await reads.observeAccount(async () => {
    await reads.read(url, { type: "clearinghouseState", user: "wallet" });
    await reads.read(url, { type: "userFillsByTime", user: "wallet" });
  }, owner);
  await reads.drainAccounts();
  assert.deepEqual(c.bookings, [{ weight: 780, mode: "cold_trial" }]);
  assert.equal(wireCalls, 2);
  assert.equal(budget.snapshot().capacity, 1000);
  assert.equal(budget.snapshot().used, 122);
  assert.equal(budget.snapshot().observations.completed, 1);
  assert.equal(c.ended.length, 1);
});

it("records fullDemand separately from reserved trial weight without rewriting a cold hint", async () => {
  const t = time(),
    budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  await paySource(budget, 100);
  const ticket = budget.beginObservation(owner, {
    fullDemand: 1000,
    reservedWeight: 780,
  });
  assert.equal(ticket.fullDemand, 1000);
  assert.equal(ticket.weight, 780);
  assert.equal(ticket.capacityTrial, true);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  assert.equal(budget.snapshot().observation_reserved, 780);
  assert.equal(budget.snapshot().used, 100);
  ticket.close(false);
  assert.equal(ticket.costPlan(), null);
});

it("rejects a scope above780 before the next provider read and cannot publish partial success even if the callback catches that error", async () => {
  const t = time(),
    c = trialCoordinator(t);
  let calls = 0;
  const { reads, budget } = setup(t, c.coordinator, async (_url, init) => {
    calls++;
    return Response.json(
      JSON.parse(String(init.body)).type === "userFillsByTime"
        ? Array(2000).fill(0)
        : {},
    );
  });
  await assert.rejects(
    reads.observeAccount(async () => {
      for (let n = 0; n < 6; n++)
        await reads.read(url, { type: "userFillsByTime", user: "wallet" });
      for (let n = 0; n < 3; n++) await reads.read(url, { type: "meta" });
      try {
        await reads.read(url, { type: "allMids" });
      } catch {
        return { partial: true };
      }
      assert.fail("scope growth must not dispatch beyond780");
    }, owner),
    (e) =>
      e instanceof AgentError &&
      e.details?.reason_code === "READ_FRAME_CAPACITY",
  );
  await reads.drainAccounts();
  assert.equal(calls, 9);
  assert.equal(budget.snapshot().used, 780);
  assert.equal(budget.snapshot().observations.completed, 0);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  assert.equal(c.ended.length, 1);
});

it("waits for real bounded response refunds instead of growing a concurrent trial into the free local quota", async () => {
  const t = time(),
    c = trialCoordinator(t),
    pending = deferred<Response>();
  let calls = 0;
  const { reads, budget } = setup(t, c.coordinator, async () => {
    calls++;
    if (calls <= 5) return Response.json(Array(2000).fill(0));
    if (calls === 6) return pending.promise;
    return Response.json([]);
  });
  const work = reads.observeAccount(async () => {
    for (let n = 0; n < 5; n++)
      await reads.read(url, { type: "userFillsByTime", user: "wallet" });
    await Promise.all([
      reads.read(url, {
        type: "userFillsByTime",
        user: "wallet",
        startTime: 1,
      }),
      reads.read(url, {
        type: "userFillsByTime",
        user: "wallet",
        startTime: 2,
      }),
    ]);
  }, owner);
  for (let n = 0; n < 10 && calls < 6; n++) await flush();
  assert.equal(calls, 6);
  assert.equal(budget.snapshot().observation_reserved, 60);
  pending.resolve(Response.json([]));
  await work;
  await reads.drainAccounts();
  assert.equal(calls, 7);
  assert.equal(budget.snapshot().used, 640);
  assert.equal(budget.snapshot().observations.completed, 1);
});

it("caps an unknown trial hold at780 while retaining global exclusivity and queues another read until actual settlement", async () => {
  const t = time(),
    c = trialCoordinator(t),
    pending = deferred<Response>();
  let calls = 0;
  const { reads, budget } = setup(t, c.coordinator, async (_url, init) => {
    calls++;
    return JSON.parse(String(init.body)).type === "userFunding"
      ? pending.promise
      : Response.json({});
  });
  await paySource(budget, 100);
  const work = reads.observeAccount(
    () =>
      Promise.all([
        reads.read(url, { type: "userFunding", user: "wallet" }),
        reads.read(url, { type: "clearinghouseState", user: "wallet" }),
      ]),
    owner,
  );
  await flush();
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().used, 880);
  assert.equal(budget.snapshot().unknown_exclusive, true);
  pending.resolve(Response.json([]));
  await work;
  await reads.drainAccounts();
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().used, 122);
  assert.equal(budget.snapshot().unknown_exclusive, false);
  assert.equal(budget.snapshot().observations.completed, 1);
});

it("keeps the entire unknown actual surcharge as debt and rejects the cold observation instead of returning fresh evidence", async () => {
  const t = time(),
    c = trialCoordinator(t),
    pending = deferred<Response>();
  const { reads, budget } = setup(
    t,
    c.coordinator,
    async () => pending.promise,
  );
  await paySource(budget, 100);
  const work = reads.observeAccount(
    () => reads.read(url, { type: "userFunding", user: "wallet" }),
    owner,
  );
  await flush();
  assert.equal(budget.snapshot().used, 880);
  pending.resolve(Response.json(Array(20000).fill(0)));
  await assert.rejects(
    work,
    (e) =>
      e instanceof AgentError &&
      e.details?.reason_code === "READ_FRAME_CAPACITY",
  );
  await reads.drainAccounts();
  assert.equal(budget.snapshot().used, 1120);
  assert.equal(budget.snapshot().debt, 120);
  assert.equal(reads.diagnostics().counts.charged_weight, 1020);
  assert.equal(reads.diagnostics().counts.unknown_uncertain, 0);
  assert.equal(budget.snapshot().observations.completed, 0);
  assert.equal(c.ended.length, 1);
});

it("rejects and retains an actual900 unknown fee even though it fits the local1000 quota", async () => {
  const t = time(),
    c = trialCoordinator(t);
  const { reads, budget } = setup(t, c.coordinator, async () =>
    Response.json(Array(17600).fill(0)),
  );
  await assert.rejects(
    reads.observeAccount(
      () => reads.read(url, { type: "userFunding", user: "wallet" }),
      owner,
    ),
    (e) =>
      e instanceof AgentError &&
      e.details?.reason_code === "READ_FRAME_CAPACITY",
  );
  await reads.drainAccounts();
  assert.equal(budget.snapshot().used, 900);
  assert.equal(budget.snapshot().debt, 0);
  assert.equal(budget.snapshot().observations.completed, 0);
  assert.equal(reads.diagnostics().counts.charged_weight, 900);
});

it("revalidates cold trial eligibility after Core await even if the full hint is still1000", async () => {
  const t = time(),
    grant = deferred<AccountReadFrameLease>();
  let ended = 0,
    calls = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin(_owner, weight, _deadline, _signal, mode) {
      assert.equal(weight, 780);
      assert.equal(mode, "cold_trial");
      return grant.promise;
    },
    async end() {
      ended++;
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    calls++;
    return Response.json({});
  });
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  budget.refreshObservationPlan(owner, { demand: 1000, peaks: [980] }, 600000);
  grant.resolve({
    frame_id: "frame_changed_cold_0001",
    expires_at: t.clock() + 20000,
  });
  await assert.rejects(
    work,
    (e) => e instanceof AgentError && e.code === "VENUE_COST_PLAN_UNAVAILABLE",
  );
  await reads.drainAccounts();
  assert.equal(calls, 0);
  assert.equal(ended, 1);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  assert.equal(budget.snapshot().observations.started, 0);
});

it("does not clamp a proven high-cost or non-placeholder learned plan to the cold trial", async () => {
  for (const plan of [
    { demand: 950, peaks: [930] },
    { demand: 950, peaks: [120] },
    { demand: 1000, peaks: [980] },
    { demand: 1000, peaks: [120, 120, 120] },
  ]) {
    const t = time(),
      c = trialCoordinator(t);
    let calls = 0;
    const { reads, budget } = setup(t, c.coordinator, async () => {
      calls++;
      return Response.json({});
    });
    budget.restoreObservationPlan(owner, plan, 600000);
    await assert.rejects(
      reads.observeAccount(() => reads.read(url, { type: "allMids" }), owner),
      (e) =>
        e instanceof AgentError &&
        e.details?.reason_code === "READ_FRAME_CAPACITY",
    );
    await reads.drainAccounts();
    assert.equal(c.bookings.length, 0);
    assert.equal(calls, 0);
    assert.equal(budget.peekObservationDemand(owner), plan.demand);
  }
});

it("keeps learned850 admission unchanged instead of truncating it to780", async () => {
  const t = time(),
    c = trialCoordinator(t);
  const { reads, budget } = setup(t, c.coordinator, async () =>
    Response.json({}),
  );
  budget.restoreObservationPlan(owner, { demand: 850, peaks: [830] }, 600000);
  await paySource(budget, 100);
  await reads.observeAccount(() => reads.read(url, { type: "allMids" }), owner);
  await reads.drainAccounts();
  assert.deepEqual(c.bookings, [{ weight: 850, mode: "learned" }]);
  assert.equal(budget.snapshot().used, 102);
});

it("preserves a conservative full-window hint until complete low-cost samples finish the original learning window", async () => {
  const t = time(),
    c = trialCoordinator(t);
  const { reads, budget } = setup(t, c.coordinator, async () =>
    Response.json([]),
  );
  budget.restoreObservationPlan(owner, { demand: 1000, peaks: [120] }, 600000);
  for (let n = 0; n < 3; n++) {
    await reads.observeAccount(
      () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
      owner,
    );
    assert.equal(budget.peekObservationDemand(owner), n === 0 ? 1000 : 140);
    await t.advance(60000);
  }
  await reads.drainAccounts();
  assert.deepEqual(c.bookings, [
    { weight: 780, mode: "cold_trial" },
    { weight: 780, mode: "cold_trial" },
    { weight: 140, mode: "learned" },
  ]);
});

it("does not turn a failed empty-peaks cold prior into a permanent learned1000 blocker after a complete trial", async () => {
  const t = time(),
    c = trialCoordinator(t);
  const { reads, budget } = setup(t, c.coordinator, async () =>
    Response.json([]),
  );
  const prior = budget.beginObservation(owner),
    paid = await budget.acquire(
      "account",
      120,
      owner,
      new AbortController().signal,
      false,
      prior,
    );
  paid.sent();
  paid.settle(20);
  paid.release();
  prior.close(false);
  assert.equal(prior.costPlan(), null);
  assert.equal(budget.peekObservationDemand(owner), 1000);
  await t.advance(60000);
  await reads.observeAccount(
    () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
    owner,
  );
  assert.equal(budget.peekObservationDemand(owner), 140);
  await t.advance(60000);
  await reads.observeAccount(
    () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
    owner,
  );
  await reads.drainAccounts();
  assert.deepEqual(c.bookings, [
    { weight: 780, mode: "cold_trial" },
    { weight: 140, mode: "learned" },
  ]);
});

it("spends zero upstream weight while a stable fleet reservation is pending, then passes the grant owner/token through every account request", async () => {
  const t = time(),
    rpc: any[] = [],
    contexts: any[] = [];
  let granted = false,
    calls = 0;
  const coordinator = coreFrameCoordinator(
    "https://core.test",
    "fixture-token",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      rpc.push(body);
      if (!Object.hasOwn(body, "weight"))
        return Response.json({ state: "closed", frame_id: body.frame_id });
      return Response.json({
        state: granted ? "granted" : "pending",
        frame_id: body.frame_id,
        expires_at: granted ? t.clock() + 20000 : body.deadline_ms,
        retry_after_ms: 1000,
        reserved_weight: granted ? body.weight : 250,
        guaranteed_complete: false,
      });
    },
    t.clock,
  );
  const { reads, budget } = setup(
    t,
    coordinator,
    async (_url, init, context) => {
      calls++;
      contexts.push(context);
      return Response.json(
        JSON.parse(String(init.body)).type === "userFillsByTime" ? [] : {},
      );
    },
  );
  try {
    await assert.rejects(
      reads.observeAccount(
        () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
        owner,
      ),
      (error) =>
        error instanceof AgentError &&
        error.details?.reason_code === "READ_FRAME_PENDING",
    );
    assert.equal(calls, 0);
    assert.equal(budget.snapshot().used, 0);
    assert.equal(
      rpc.length,
      1,
      "the local near-ready retry loop must not busy-poll a fleet queue",
    );
    await t.advance(60000);
    granted = true;
    await reads.observeAccount(async () => {
      await reads.read(url, { type: "clearinghouseState", user: "wallet" });
      await reads.read(url, { type: "userFillsByTime", user: "wallet" });
    }, owner);
    await flush();
    assert.equal(calls, 2);
    assert.equal(rpc[1].frame_id, rpc[0].frame_id);
    assert.equal(rpc[1].deadline_ms, rpc[0].deadline_ms);
    assert.equal(rpc[0].mode, "cold_trial");
    assert.equal(
      rpc[0].weight,
      780,
      "explicit cold trial leaves one maximum history reservation below Core's unchanged900cap",
    );
    assert.ok(
      contexts.every(
        (context) =>
          context.frame_id === rpc[0].frame_id && context.frame_owner === owner,
      ),
    );
    assert.equal(
      budget.snapshot().used,
      22,
      "ending a frame never refunds paid reads",
    );
    assert.equal(reads.diagnostics().frames.capacity_trials, 2);
  } finally {
    await reads.drainAccounts();
  }
});

it("does not discard a learned cost hint when fleet admission rejects before any dispatch", async () => {
  const t = time();
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      throw new AgentError("VENUE_READ_BUDGET_EXHAUSTED", "queued", true, 503, {
        retry_after_ms: 1000,
        reason_code: "READ_FRAME_PENDING",
      });
    },
    async end() {
      assert.fail(
        "pending frame must remain queued across normal callback failure",
      );
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    assert.fail("no upstream");
  });
  budget.restoreObservationPlan(owner, { demand: 200, peaks: [180] }, 600000);
  await assert.rejects(
    reads.observeAccount(() => reads.read(url, { type: "allMids" }), owner),
  );
  const next = budget.beginObservation(owner);
  assert.equal(next.weight, 200);
  next.close(false);
  assert.equal(budget.snapshot().used, 0);
  await reads.drainAccounts();
});

it("a Core grant consumes the original wall and monotonic scope deadline and preserves dispatch age", async () => {
  const t = time();
  let ended = 0;
  const contexts: any[] = [];
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      await t.advance(10000);
      return {
        frame_id: "frame_granted_000001",
        expires_at: t.clock() + 20000,
      };
    },
    async end() {
      ended++;
    },
  };
  const { reads } = setup(t, coordinator, async (_url, _init, context) => {
    contexts.push(context);
    return Response.json({});
  });
  const start = t.clock();
  const result = await reads.observeAccount(async () => {
    const first = await reads.readWithEvidence(url, {
      type: "clearinghouseState",
      user: "wallet",
    });
    await t.advance(9000);
    const second = await reads.readWithEvidence(url, { type: "allMids" });
    return { first, second, at: reads.accountObservedAt() };
  }, owner);
  assert.equal(result.first.observed_at, start + 10000);
  assert.equal(result.second.observed_at, start + 19000);
  assert.equal(
    result.at,
    start + 10000,
    "later steps must not re-age the financial prefix",
  );
  assert.equal(contexts[1].deadline_ms, start + 20000);
  await reads.drainAccounts();
  assert.equal(ended, 1);
});

it("releases a late grant after cancellation and drain waits for that release", async () => {
  const t = time(),
    begin = deferred<AccountReadFrameLease>(),
    release = deferred<void>(),
    stop = new AbortController();
  let endCalls = 0,
    wireCalls = 0,
    drained = false;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    begin: () => begin.promise,
    async end() {
      endCalls++;
      await release.promise;
    },
  };
  const { reads, budget } = setup(
    t,
    coordinator,
    async () => {
      wireCalls++;
      return Response.json({});
    },
    stop.signal,
  );
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  stop.abort(new Error("fixture shutdown"));
  await assert.rejects(work);
  const draining = reads.drainAccounts().then(() => {
    drained = true;
  });
  begin.resolve({
    frame_id: "frame_late_grant_0001",
    expires_at: t.clock() + 20000,
  });
  await flush();
  assert.equal(endCalls, 1);
  assert.equal(drained, false);
  assert.equal(wireCalls, 0);
  release.resolve();
  await draining;
  assert.equal(budget.snapshot().used, 0);
});

it("does not refund a sent-unknown bounded request when an account frame is cancelled", async () => {
  const t = time(),
    stop = new AbortController(),
    wire = deferred<Response>();
  let calls = 0,
    ended = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      return {
        frame_id: "frame_unknown_wire_001",
        expires_at: t.clock() + 20000,
      };
    },
    async end() {
      ended++;
    },
  };
  const { reads, budget } = setup(
    t,
    coordinator,
    async () => {
      calls++;
      return wire.promise;
    },
    stop.signal,
  );
  const work = reads.observeAccount(
    () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
    owner,
  );
  await flush();
  assert.equal(calls, 1);
  stop.abort(new Error("fixture shutdown"));
  await assert.rejects(work);
  await reads.drainAccounts();
  assert.equal(ended, 1);
  assert.equal(budget.snapshot().used, 120);
  wire.resolve(Response.json([]));
  await flush();
  assert.equal(budget.snapshot().used, 120);
});

it("does not reuse completed account data and never lends an account frame token to a public source", async () => {
  const t = time(),
    contexts: any[] = [];
  let sequence = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      return {
        frame_id: `frame_complete_${String(++sequence).padStart(8, "0")}`,
        expires_at: t.clock() + 20000,
      };
    },
    async end() {},
  };
  const { reads } = setup(t, coordinator, async (_url, _init, context) => {
    contexts.push(context);
    return Response.json({});
  });
  await reads.observeAccount(
    () => reads.read(url, { type: "clearinghouseState", user: "wallet" }),
    owner,
  );
  await t.advance(3000);
  await reads.observeAccount(
    () => reads.read(url, { type: "clearinghouseState", user: "wallet" }),
    owner,
  );
  await reads.read(url, { type: "allMids" }, 0, "source");
  assert.equal(contexts.length, 3);
  assert.notEqual(contexts[0].frame_id, contexts[1].frame_id);
  assert.equal(contexts[2].frame_id, undefined);
  assert.equal(contexts[2].frame_owner, undefined);
  await reads.drainAccounts();
});
