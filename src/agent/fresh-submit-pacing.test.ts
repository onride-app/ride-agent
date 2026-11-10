import { EventEmitter } from "node:events";
import { submitObservationCancellation } from "./submit-observation-cancellation.js";
import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
} from "./venue-read-transport.js";
import {
  VenueReadBudget,
  type BudgetTimers,
  type AccountReadReservation,
} from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { issueNativeSourcePlan } from "./native-source-plan.js";
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
  const issuer = {};
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
      freshSubmitReadIssuer: issuer,
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
    issuer,
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

function trustedCaller(f: ReturnType<typeof component>, t: TestContext) {
  const req = Object.assign(new EventEmitter(), { aborted: false }),
    res = Object.assign(new EventEmitter(), { writableEnded: false });
  const caller = submitObservationCancellation(
    req as any,
    res as any,
    f.time.clock,
    f.time.timers,
    f.time.clock,
  );
  t.after(() => caller.close());
  return { caller, req, res };
}
function fresh(
  f: ReturnType<typeof component>,
  t: TestContext,
  options: {
    expiresIn?: number;
    current?: () => boolean;
    caller?: object;
  } = {},
) {
  const { caller } = trustedCaller(f, t),
    expiresAt = f.time.at + (options.expiresIn ?? 60000);
  const purpose = f.reads.freshSubmitReadPurpose(
    f.issuer,
    {
      user: "u",
      portfolio: "p",
      account: "a",
      revision: 1,
      control: "c",
      execution: "original",
      fingerprint: "d".repeat(64),
      expiresAt,
      currentBinding: "e".repeat(64),
    },
    options.caller ?? caller,
    options.current ?? (() => true),
  );
  const limits = {
    signal: caller.signal,
    deadlineMs: Math.min(expiresAt, caller.deadlineMs),
    waitForFrameAdmission: true as const,
  };
  const read = () =>
    f.reads.observeAccount(
      async () => {
        f.reads.bindAccountCostPlan(f.owner);
        return f.reads.readWithEvidence("https://api.hyperliquid.xyz/info", {
          type: "userAbstraction",
          user: "0x" + "1".repeat(40),
        });
      },
      f.owner,
      limits,
      purpose,
    );
  return { purpose, read, caller, limits };
}
it("Fixed286 keeps21.45s global pacing, while exactly one trusted fresh account is read inside its original20s", async (t) => {
  const f = component(t);
  await fixedPaid(f.budget, f.time);
  const before = f.budget.snapshot().observation_pacing_ms;
  assert.ok(before > 20000);
  const cap = fresh(f, t),
    started = f.time.at;
  const result = await f.time.run(cap.read());
  assert.ok(result.observed_at >= started);
  assert.ok(f.time.at - started < 20000);
  assert.equal(f.stats().wires, 1);
  assert.equal(f.stats().claims, 1);
  assert.equal(f.stats().publications, 1);
  assert.equal(f.begins.length, 1);
  assert.equal(f.begins[0].deadline_ms, started + 100000);
  assert.ok(
    f.budget.snapshot().observation_pacing_ms >= before - (f.time.at - started),
  );
  await assert.rejects(cap.read(), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.stats().wires, 1);
});
it("ordinary80 audit still waits the original6s and waitForFrameAdmission cannot mint a pacing exception", async (t) => {
  const f = component(t);
  f.budget.refreshObservationPlan(
    "prior",
    { demand: 184, peaks: [164] },
    600000,
  );
  const ticket = f.budget.beginObservation("prior");
  for (let i = 0; i < 4; i++) await pay(f.budget, f.time, ticket, 20);
  ticket.close(true);
  const started = f.time.at;
  await f.time.run(
    f.reads.observeAccount(
      async () => {
        f.reads.bindAccountCostPlan(f.owner);
        return f.reads.read("https://api.hyperliquid.xyz/info", {
          type: "userAbstraction",
          user: "x",
        });
      },
      f.owner,
      { waitForFrameAdmission: true },
    ),
  );
  assert.ok(f.time.at - started >= 5996 && f.time.at - started <= 6001);
});
it("copied original caller and JSON booleans retain pacing after Fixed286", async (t) => {
  const f = component(t);
  await fixedPaid(f.budget, f.time);
  const { caller } = trustedCaller(f, t);
  const cap = fresh(f, t, { caller: { ...caller, skipPacing: true } });
  assert.equal(cap.purpose, undefined);
  await assert.rejects(
    f.time.run(cap.read()),
    (error: any) => error.details?.reason_code === "READ_LOCAL_PACING",
  );
  assert.equal(f.stats().wires, 0);
  assert.equal(f.stats().claims, 0);
});
it("current owner work is not touched: BUSY waits before plan read/claim/Core and keeps the active generation", async (t) => {
  const f = component(t);
  let release!: () => void;
  f.providerBarrier(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const active = f.account();
  await flush();
  const before = f.stats();
  const second = fresh(f, t).read();
  await flush();
  assert.deepEqual(f.stats(), before);
  assert.equal(f.begins.length, 1);
  await f.time.advance(1000);
  assert.deepEqual(f.stats(), before);
  release();
  f.providerBarrier(undefined);
  await active;
  await f.time.advance(1000);
  await second;
  assert.equal(f.stats().claims, 2);
  assert.equal(f.stats().publications, 2);
});
it("a true FIFO head cannot be bypassed, even with a valid soft-pacing purpose", async (t) => {
  const f = component(t),
    interest = f.budget.beginObservationInterest("other");
  const work = fresh(f, t).read();
  const rejected = assert.rejects(work);
  await f.time.advance(20000);
  await rejected;
  assert.equal(f.begins.length, 0);
  assert.equal(f.stats().loads, 0);
  assert.equal(f.stats().claims, 0);
  assert.equal(f.stats().wires, 0);
  f.budget.endObservationInterest(interest);
});
for (const gate of ["quota", "debt", "exclusive", "quarantine", "429"] as const)
  it(`fresh-purpose leaves the actual ${gate} gate and fees intact`, async (t) => {
    const f = component(t);
    await fixedPaid(f.budget, f.time);
    let held: Awaited<ReturnType<VenueReadBudget["acquire"]>> | undefined;
    if (gate === "quarantine") f.budget.quarantine();
    else if (gate === "429") f.budget.note429(60000);
    else {
      held = await f.time.run(
        f.budget.acquire(
          "account",
          gate === "quota" ? 600 : 20,
          "other",
          signal(),
          gate !== "quota",
        ),
      );
      if (gate !== "exclusive") {
        held.sent();
        held.settle(gate === "debt" ? 1100 : 600);
        held.release();
        held = undefined;
      }
    }
    const before = f.budget.snapshot();
    await assert.rejects(f.time.run(fresh(f, t).read()));
    assert.equal(f.stats().wires, 0);
    assert.equal(f.stats().claims, 0);
    const after = f.budget.snapshot();
    assert.equal(after.used, before.used);
    held?.release();
  });
it("expiry, disconnect, drain and changed binding revoke waiting scope without a late Core begin", async (t) => {
  for (const kind of ["expiry", "disconnect", "drain", "binding"] as const) {
    const f = component(t),
      head = f.budget.beginObservationInterest("other");
    let current = true;
    const cap = fresh(f, t, {
      expiresIn: kind === "expiry" ? 1000 : 60000,
      current: () => current,
    });
    const work = cap.read(),
      rejected = assert.rejects(work);
    await flush();
    if (kind === "disconnect") cap.caller.close();
    if (kind === "binding") current = false;
    if (kind === "drain") await f.reads.drainAccounts();
    else await f.time.advance(1000);
    await rejected;
    assert.equal(f.stats().wires, 0);
    assert.equal(f.stats().claims, 0);
    assert.equal(f.begins.length, 0);
    f.budget.endObservationInterest(head);
  }
});
it("a purpose cannot upgrade existing ALS or a foreign reader, and a boolean cannot replace the runtime token", async (t) => {
  const f = component(t),
    other = component(t),
    cap = fresh(f, t);
  await assert.rejects(
    other.reads.observeAccount(
      async () => {},
      other.owner,
      cap.limits,
      cap.purpose,
    ),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  await f.reads.observeAccount(async () => {
    await assert.rejects(cap.read(), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
    assert.throws(() =>
      f.reads.freshSubmitReadPurpose(
        f.issuer,
        {} as any,
        cap.caller,
        () => true,
      ),
    );
  });
  await assert.rejects(
    f.reads.observeAccount(async () => {}, f.owner, cap.limits, {}),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  assert.equal(f.stats().wires, 0);
});
it("a fresh purpose does not renew provider12 or publish a slow/unknown response", async (t) => {
  const f = component(t);
  await fixedPaid(f.budget, f.time);
  let release!: () => void;
  f.providerBarrier(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const cap = fresh(f, t),
    work = cap.read(),
    rejected = assert.rejects(work);
  await flush();
  await f.time.advance(12000);
  await rejected;
  assert.equal(f.stats().wires, 1);
  assert.equal(f.stats().publications, 0);
  release();
  await flush();
  assert.equal(f.stats().publications, 0);
  await assert.rejects(cap.read());
});
it("local BUSY parks an existing real Core pin without polling, queue replacement or renewing original FIRST/caller20", async (t) => {
  const f = component(t),
    cap = fresh(f, t),
    started = f.time.at;
  f.pending(true);
  const work = cap.read();
  await flush();
  assert.equal(f.begins.length, 1);
  const original = { ...f.begins[0] };
  f.budget.refreshObservationPlan(
    "busy-peer",
    { demand: 184, peaks: [164] },
    600000,
  );
  const peer = f.budget.beginObservation("busy-peer");
  await f.time.advance(5000);
  assert.equal(f.begins.length, 1);
  assert.equal(f.stats().claims, 0);
  assert.equal(f.stats().wires, 0);
  peer.close(false);
  f.pending(false);
  await f.time.advance(1000);
  await work;
  assert.equal(f.begins.length, 2);
  const resumed = { ...f.begins[1] };
  delete original.at;
  delete resumed.at;
  assert.deepEqual(resumed, original);
  assert.equal(f.begins[1].deadline_ms, started + 100000);
  assert.equal(f.stats().wires, 1);
});
it("a late Core grant leaves only the original caller remainder, never a renewed20s or provider12", async (t) => {
  const f = component(t);
  await fixedPaid(f.budget, f.time);
  let grant!: () => void, provider!: () => void;
  f.coreBarrier(
    new Promise<void>((resolve) => {
      grant = resolve;
    }),
  );
  f.providerBarrier(
    new Promise<void>((resolve) => {
      provider = resolve;
    }),
  );
  const started = f.time.at,
    cap = fresh(f, t),
    work = cap.read(),
    failed = assert.rejects(work);
  await flush();
  await f.time.advance(15000);
  assert.equal(f.stats().wires, 0);
  grant();
  await flush();
  assert.equal(f.stats().wires, 1);
  await f.time.advance(5000);
  await failed;
  assert.equal(f.time.at, started + 20000);
  assert.equal(f.stats().publications, 0);
  provider();
  await flush();
  assert.equal(f.stats().publications, 0);
});
it("a prepared child and its source supplement cannot inherit or upgrade a fresh-submit purpose", async (t) => {
  const f = component(t),
    cap = fresh(f, t),
    window = await f.time.run(f.prepare());
  await assert.rejects(
    window.read(() => cap.read()),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  await window.close();
  assert.equal(f.stats().wires, 0);
  assert.equal(f.stats().claims, 0);
  const other = component(t),
    second = fresh(other, t),
    ready = await other.time.run(
      other.prepare(undefined, { purpose: "audit_source" }),
    );
  await ready.read(async () => {
    other.reads.bindAccountCostPlan(other.owner);
    return other.reads.read("https://api.hyperliquid.xyz/info", {
      type: "userAbstraction",
      user: "a",
    });
  });
  await assert.rejects(
    ready.supplement(() => second.read()),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  await ready.close();
  assert.equal(other.stats().wires, 1);
});
for (const sent of [false, true])
  it(`a fresh purpose never retries a typed provider error with upstream sent=${sent}`, async (t) => {
    const f = component(t);
    await fixedPaid(f.budget, f.time);
    let calls = 0;
    (f.reads as any).fetcher = async () => {
      calls++;
      throw new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", sent, 1000);
    };
    const cap = fresh(f, t);
    await assert.rejects(f.time.run(cap.read()));
    assert.equal(calls, 1);
    assert.equal(f.stats().publications, 0);
    await assert.rejects(cap.read());
    assert.equal(calls, 1);
  });
