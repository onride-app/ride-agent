import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { framePendingContinuation } from "./core-frame-coordinator.js";
import { consumeDualFrameLease, coreDualFrameCoordinator, dualFrameLeaseBinding } from "./core-dual-frame-coordinator.js";
import { coreDualInfoFetcher } from "./core-dual-info-reads.js";
import { runtimeBindingId, type DualBinding } from "./dual-egress-contract.js";
import { VenueReads, type AccountReadFrameCoordinator } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";

// Protocol receipts are local stubs here, NOT a Core capacity model. Actual
// dual-bank Lua/handler/relay/CAS is a separate frozen interop gate. These tests
// exercise actual Node books, clocks, private capabilities and stage routing;
// the small read callbacks do not claim complete financial-account coverage.
class Time {
  elapsed = 0;
  seq = 0;
  events = new Map<number, { at: number; run(): void }>();
  wall = () => 1794400000000 + this.elapsed;
  mono = () => 1000 + this.elapsed;
  timers: BudgetTimers = {
    setTimeout: (run, ms) => { const id = ++this.seq; this.events.set(id, { at: this.elapsed + ms, run }); return id; },
    clearTimeout: (id) => { this.events.delete(id as number); },
  };
  async flush() { for (let i = 0; i < 200; i++) await Promise.resolve(); }
  async advance(ms: number) {
    const end = this.elapsed + ms;
    await this.flush();
    for (;;) {
      const next = [...this.events].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.elapsed = next[1].at; this.events.delete(next[0]); next[1].run(); await this.flush();
    }
    this.elapsed = end; await this.flush();
  }
  async run<T>(work: Promise<T>): Promise<T> {
    let done = false, result!: T, error: unknown;
    void work.then((v) => { done = true; result = v; }, (e) => { done = true; error = e; });
    for (let n = 0; !done && n < 40; n++) {
      await this.flush();
      if (done) break;
      const next = [...this.events.values()].sort((a, b) => a.at - b.at)[0];
      if (!next) throw new Error("Pure Node control has no remaining work");
      await this.advance(Math.max(0, next.at - this.elapsed));
    }
    assert.equal(done, true, "pure Node control remains bounded");
    if (error) throw error;
    return result;
  }
}
const owner = "a".repeat(64), frameOwner = "b".repeat(64), info = "https://api.hyperliquid.xyz/info";
function binding(nonce = randomUUID()): DualBinding {
  return Object.freeze({ protocol_version: 3, authority_id: "c".repeat(64), binding_id: runtimeBindingId("c".repeat(64), nonce), binding_generation: "11111111-1111-4111-8111-111111111111", gateway_boot_nonce: nonce, account_bank_id: "d".repeat(64), gateway_bank_id: "e".repeat(64) });
}
function fixture() {
  const time = new Time(), account = new VenueReadBudget({ clock: time.mono, timers: time.timers }), gateway = new VenueReadBudget({ clock: time.mono, timers: time.timers });
  account.restoreObservationPlan(owner, { demand: 184, peaks: [164, 164, 164] }, 600000);
  let current = binding(), discovery = 0, lostBegin = false, endUnknown = false, malformed: ((reply: any) => void) | undefined, httpStatus = 200;
  let readBarrier: Promise<void> | undefined, readError: { code: string; retry_after_ms: number } | undefined;
  const bodies: any[] = [], reads: any[] = [], frames = new Map<string, any>();
  let generation = 0, plan = { demand: 184, peaks: [164, 164, 164] }, dirty = false;
  const store = { reads: 0, begins: 0, completes: 0,
    read: async (costOwner: string) => { store.reads++; assert.equal(dirty, false); return { owner: costOwner, generation: String(generation), plan, remainingTtlMs: 600000 }; },
    begin: async (costOwner: string, _signal: AbortSignal, expected: any) => { store.begins++; assert.equal(dirty, false); assert.equal(expected.generation, String(generation)); dirty = true; generation++; return { owner: costOwner, generation: String(generation), plan, remainingTtlMs: 600000 }; },
    complete: async (lease: any, value: any) => { assert.equal(lease.generation, String(generation)); dirty = false; plan = structuredClone(value); store.completes++; return true; },
  };
  const request: typeof fetch = (async (target: any, init: RequestInit) => {
    const path = new URL(String(target)).pathname, body = JSON.parse(String(init.body));
    if (path.endsWith("_v3_begin")) {
      bodies.push(structuredClone(body));
      let frame = frames.get(body.frame_id);
      if (!frame) {
        assert.equal(body.control_seq, 1); assert.equal(body.ready, false);
        frame = { ...structuredClone(body), state: "pending", expires_at: body.deadline_ms }; frames.set(body.frame_id, frame);
      }
      const unchanged = frame.state === "granted";
      if (!unchanged) {
        assert.ok(body.control_seq >= frame.control_seq);
        if (body.control_seq === frame.control_seq) assert.equal(body.ready, frame.ready);
        frame.control_seq = body.control_seq; frame.ready = body.ready;
        if (body.ready) { frame.state = "granted"; frame.expires_at = time.wall() + 20000; }
      }
      const g = frame.s_weight + Object.values(frame.h_weights).reduce((n: any, w: any) => n + w, 0);
      const reply = { ...frame, capacity: 900, guaranteed_complete: false, control_applied: !(unchanged && !body.ready), queued: frame.state === "pending",
        a_reserved_weight: frame.state === "granted" ? frame.a_weight : 0, g_reserved_weight: frame.state === "granted" ? g : 0,
        source_ready: g === 0 || frame.state === "granted", retry_after_ms: frame.state === "pending" ? 1000 : 0 };
      if (lostBegin) { lostBegin = false; throw new Error("Controlled lost BEGIN ACK after server processing"); }
      malformed?.(reply);
      return Response.json(reply, { status: httpStatus });
    }
    if (path.endsWith("_v3_end")) {
      if (endUnknown) throw new Error("Controlled END unknown");
      const f = frames.get(body.frame_id); if (f) f.state = "closed";
      return Response.json({ protocol_version: 3, state: "closed", frame_id: body.frame_id, deadline_ms: body.deadline_ms, binding_id: body.binding_id, control_applied: true });
    }
    assert.equal(path, "/internal/agent-core/perps_info_v3_read", "no prepared fallback to the old single-bank read route");
    reads.push(structuredClone(body));
    if (body.binding_id !== current.binding_id) return Response.json({ error: { code: "unavailable", upstream_request_sent: true } }, { status: 503 });
    if (readError) { const error = readError; readError = undefined; return Response.json({ error: { ...error, upstream_request_sent: true } }, { status: 503 }); }
    if (readBarrier) { const waiting = readBarrier; readBarrier = undefined; await waiting; }
    const data = body.request.type === "userFillsByTime" ? [] : body.request.type === "meta" ? { universe: [] } : { assetPositions: [], marginSummary: { accountValue: "1000" } };
    return Response.json({ data, observed_at: time.wall(), bank_id: body.stage === "account" ? current.account_bank_id : current.gateway_bank_id, read_id: randomUUID(), retain_until_ms: body.deadline_ms + 60000 });
  }) as typeof fetch;
  const currentBinding = async () => { discovery++; return current; };
  const dual = coreDualFrameCoordinator("https://core.fixture", "fixture-token", currentBinding, request, time.wall);
  const legacy: AccountReadFrameCoordinator = { capacity: 900, readinessV2: true, begin: async () => { throw new Error("No legacy parent permitted"); }, end: async () => {}, close: async () => {}, cancelPending: async () => { throw new Error("No legacy cancellation permitted"); } };
  const reader = new VenueReads(coreDualInfoFetcher("https://core.fixture", "fixture-token", currentBinding, request, time.wall), time.wall, 2, {
    transport: "core_shared_info", budget: account, timers: time.timers, monotonicClock: time.mono, frameCoordinator: legacy, observationPlans: store, report: () => {},
    dualEgress: { coordinator: dual, sourceBudget: gateway, currentBinding, accountBankId: current.account_bank_id, gatewayBankId: current.gateway_bank_id },
  });
  const first = time.wall() + 100000;
  const prepare = (pin?: object) => reader.prepareAccountWindow(owner, frameOwner, first, pin, undefined, { purpose: "audit_source", historySources: ["fixed"] });
  return { time, account, gateway, store, reader, dual, request, bodies, reads, first, prepare, frames,
    get discovery() { return discovery; }, setBinding: (v: DualBinding) => { current = v; }, currentBinding,
    loseBegin: () => { lostBegin = true; }, unknownEnd: (value: boolean) => { endUnknown = value; },
    malformed: (mutate: (reply: any) => void, status = 200) => { malformed = mutate; httpStatus = status; },
    denyNextRead: (code: string, retry_after_ms = 1000) => { readError = { code, retry_after_ms }; },
    pauseNextRead: () => { let release!: () => void; readBarrier = new Promise<void>((resolve) => { release = resolve; }); return release; },
  };
}
async function rejected(work: Promise<unknown>) {
  try { await work; } catch (error) { return error; }
  assert.fail("expected rejection");
}

it("V3 first zero-hold ACK precedes soft pacing; same original pin/UUID/FIRST resumes", async () => {
  const f = fixture(), interest = f.account.beginObservationInterest(owner), old = f.account.beginObservation(owner, undefined, interest);
  const paid = await f.account.acquire("account", 102, "one", new AbortController().signal, false, old);
  paid.sent(); paid.settle(102); paid.release(); old.close(true); f.account.endObservationInterest(interest);
  const error = await rejected(f.prepare()), pin = framePendingContinuation(error);
  assert.ok(pin); assert.equal(f.bodies.length, 1); assert.equal(f.bodies[0].ready, false);
  assert.equal(f.store.begins, 0); assert.equal(f.gateway.snapshot().used, 0);
  await f.time.advance(7651);
  const window = await f.time.run(f.prepare(pin));
  assert.equal(f.bodies.at(-1).frame_id, f.bodies[0].frame_id); assert.equal(f.bodies.at(-1).deadline_ms, f.first);
  assert.equal(f.bodies.at(-1).control_seq, 2);
  await window.close(); await f.reader.drainAccounts();
});

it("lost BEGIN ACK then active-A BUSY resolves/parks the same episode without reading dirty PG", async () => {
  const f = fixture(); f.loseBegin();
  const error = await rejected(f.prepare()), pin = framePendingContinuation(error); assert.ok(pin);
  f.account.restoreObservationPlan("rival", { demand: 184, peaks: [164] }, 600000);
  const interest = f.account.beginObservationInterest("rival"), rival = f.account.beginObservation("rival", undefined, interest);
  const before = f.store.reads;
  assert.equal(framePendingContinuation(await rejected(f.prepare(pin))), pin);
  assert.equal(f.store.reads, before); assert.equal(f.store.begins, 0);
  assert.equal(f.bodies[1].frame_id, f.bodies[0].frame_id); assert.equal(f.bodies[1].deadline_ms, f.first); assert.equal(f.bodies[1].ready, false);
  rival.close(false); f.account.endObservationInterest(interest);
  const window = await f.time.run(f.prepare(pin));
  assert.equal(f.bodies.at(-1).frame_id, f.bodies[0].frame_id);
  await window.close(); await f.reader.drainAccounts();
});

it("prepared private A/source/history stages use one lease and real independent books", async () => {
  const f = fixture(), afterSourceBook: boolean[] = [], book = f.gateway.beginSourceCapacity.bind(f.gateway);
  f.gateway.beginSourceCapacity = (...args) => { const result = book(...args); queueMicrotask(() => afterSourceBook.push(f.account.snapshot().observation_active)); return result; };
  const window = await f.time.run(f.prepare());
  assert.deepEqual(afterSourceBook, [true], "no await separates the two complete local books");
  assert.equal(f.account.snapshot().observation_reserved, 184);
  assert.equal(f.gateway.sourceCapacityReady(641), false);
  await f.time.run(window.read(async () => { f.reader.bindAccountCostPlan(owner); await f.reader.readPublicSource(info, { type: "meta" }); }));
  await f.time.run(window.supplement(() => f.reader.readPublicSource(info, { type: "clearinghouseState", user: "0x" + "1".repeat(40) })));
  await f.time.run(window.history("fixed", () => f.reader.readPublicSource(info, { type: "userFillsByTime", user: "0x" + "1".repeat(40), startTime: 1, endTime: 2, aggregateByTime: false }), () => {}));
  assert.deepEqual(f.reads.map((r) => r.stage), ["account", "source", "history"]);
  assert.equal(new Set(f.reads.map((r) => r.frame_id)).size, 1);
  assert.equal(f.reads[2].history_source, "fixed"); assert.equal(f.store.begins, 1); assert.equal(f.store.completes, 1);
  assert.equal(f.account.snapshot().used, 20); assert.equal(f.gateway.snapshot().used, 22);
  assert.equal(f.gateway.snapshot().observations.started, 0);
  await window.close(); await f.reader.drainAccounts();
});

it("a malformed/201 parked receipt creates neither local capacity nor an A attempt", async () => {
  for (const control of [{ mutate: (r: any) => { r.h_weights = {}; }, status: 200 }, { mutate: (r: any) => { r.a_reserved_weight = 1; }, status: 200 }, { mutate: (_r: any) => {}, status: 201 }]) {
    const f = fixture(); f.malformed(control.mutate, control.status);
    assert.ok(framePendingContinuation(await rejected(f.prepare())));
    assert.equal(f.account.snapshot().observation_active, false); assert.equal(f.account.snapshot().observation_queued, 0);
    assert.equal(f.gateway.sourceCapacityReady(1000), true); assert.equal(f.reads.length, 0); assert.equal(f.store.begins, 0);
    await f.reader.drainAccounts();
  }
});

it("one granted capability cannot be cloned, consumed twice or used after exact END", async () => {
  const f = fixture(), plan = { owner: frameOwner, deadline_ms: f.first, mode: "learned" as const, a_weight: 184, s_weight: 120, h_weights: {}, purpose: "audit_source" as const, scope_hash: "f".repeat(64) };
  const signal = new AbortController().signal, pin = await f.dual.bootstrap(plan, signal), lease = await f.dual.reserve(plan, signal, pin);
  assert.throws(() => consumeDualFrameLease({ ...lease }));
  assert.equal(consumeDualFrameLease(lease).plan.a_weight, 184); assert.throws(() => consumeDualFrameLease(lease));
  await f.dual.end(lease.frame_id); assert.throws(() => dualFrameLeaseBinding(lease)); await f.dual.close();
});

it("unknown END retains the original owner episode and never creates a replacement UUID", async () => {
  const f = fixture(), window = await f.time.run(f.prepare()); f.unknownEnd(true);
  await window.close(); await f.time.flush();
  await rejected(f.prepare());
  assert.equal(new Set(f.bodies.map((body) => body.frame_id)).size, 1); assert.ok(f.bodies.every((body) => body.deadline_ms === f.first));
  assert.equal(f.reads.length, 0); f.unknownEnd(false); await f.reader.drainAccounts();
});

it("failed second local book unwinds only unused source credit and dispatches no read", async () => {
  const f = fixture();
  f.account.beginObservationBundle = () => { throw new Error("Controlled second-book failure"); };
  await rejected(f.prepare()); await f.reader.drainAccounts();
  assert.equal(f.gateway.sourceCapacityReady(1000), true); assert.equal(f.gateway.snapshot().used, 0);
  assert.equal(f.account.snapshot().used, 0); assert.equal(f.store.begins, 0); assert.equal(f.reads.length, 0);
});

it("different public-source observations cannot join an old-boot flight or migrate later pages", async () => {
  const f = fixture(), old = await f.currentBinding(), release = f.pauseNextRead();
  const payload = { type: "clearinghouseState", user: "0x" + "1".repeat(40) };
  const first = f.reader.runPublicSource(async () => {
    await f.reader.readPublicSource(info, payload);
    return f.reader.readPublicSource(info, { type: "userFillsByTime", user: payload.user, startTime: 1, endTime: 2, aggregateByTime: false });
  });
  const failedFirst = rejected(first);
  await f.time.flush(); assert.equal(f.reads.length, 1);
  const next = binding(); f.setBinding(next);
  let secondDone = false;
  const second = f.reader.runPublicSource(async () => { await f.reader.readPublicSource(info, payload); secondDone = true; });
  await f.time.flush();
  try {
    // The original source lane has one slot. A separate queued acquisition
    // proves this is NOT a join of the old producer's in-flight response.
    assert.equal(secondDone, false);
    assert.equal(f.gateway.snapshot().source_queued, 1);
    assert.equal(f.reads.length, 1);
  } finally { release(); }
  await f.time.run(Promise.all([second, failedFirst]));
  assert.deepEqual(f.reads.map((r) => r.binding_id), [old.binding_id, next.binding_id, old.binding_id]);
  assert.equal(f.account.snapshot().used, 0); assert.equal(f.bodies.length, 0);
  await f.reader.drainAccounts();
});

it("original FIRST cleanup still runs while local A is busy and never renews its UUID", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const plan = { owner: frameOwner, deadline_ms: f.first, mode: "learned" as const, a_weight: 184, s_weight: 120, h_weights: {}, purpose: "audit_source" as const, scope_hash: "f".repeat(64) };
  const pin = await f.dual.bootstrap(plan, signal);
  f.account.restoreObservationPlan("rival", { demand: 184, peaks: [164] }, 600000);
  const interest = f.account.beginObservationInterest("rival"), rival = f.account.beginObservation("rival", undefined, interest);
  await f.time.advance(100001);
  await assert.rejects(f.dual.park(frameOwner, signal, pin), (e: any) => e.code === "VENUE_READ_DEADLINE");
  await f.time.flush(); assert.equal(f.frames.get(f.bodies[0].frame_id).state, "closed"); assert.equal(f.bodies.length, 1);
  rival.close(false); f.account.endObservationInterest(interest); await f.reader.drainAccounts();
});

it("binding discovery reserves one of 64 slots before awaiting, so owner65 never sends BEGIN", async () => {
  const f = fixture(); let release!: (value: DualBinding) => void, discoveries = 0;
  const blocked = new Promise<DualBinding>((resolve) => { release = resolve; });
  const dual = coreDualFrameCoordinator("https://core.fixture", "fixture-token", () => { discoveries++; return blocked; }, f.request, f.time.wall);
  const plans = Array.from({ length: 65 }, (_, i) => ({ owner: i.toString(16).padStart(64, "0"), deadline_ms: f.first, mode: "learned" as const, a_weight: 184, s_weight: 120, h_weights: {}, purpose: "audit_source" as const, scope_hash: "f".repeat(64) }));
  const jobs = plans.map((plan) => dual.bootstrap(plan, new AbortController().signal));
  const settled = Promise.allSettled(jobs);
  await f.time.flush(); assert.equal(discoveries, 64); assert.equal(f.bodies.length, 0);
  release(await f.currentBinding());
  const results = await settled;
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 64);
  assert.equal(results[64].status, "rejected");
  if (results[64].status === "rejected") assert.equal(framePendingContinuation(results[64].reason), undefined);
  assert.equal(f.bodies.length, 64); assert.equal(new Set(f.bodies.map((body) => body.frame_id)).size, 64);
  await dual.close(); assert.equal([...f.frames.values()].filter((frame) => frame.state === "closed").length, 64);
});

it("same-owner binding creation is reused and cancelled discovery releases its reserved slot", async () => {
  const f = fixture(); let release!: (value: DualBinding) => void, discoveries = 0;
  const blocked = new Promise<DualBinding>((resolve) => { release = resolve; });
  const dual = coreDualFrameCoordinator("https://core.fixture", "fixture-token", () => { discoveries++; return blocked; }, f.request, f.time.wall);
  const plan = { owner: frameOwner, deadline_ms: f.first, mode: "learned" as const, a_weight: 184, s_weight: 120, h_weights: {}, purpose: "audit_source" as const, scope_hash: "f".repeat(64) };
  const first = dual.bootstrap(plan, new AbortController().signal), second = dual.bootstrap(plan, new AbortController().signal);
  const results = Promise.allSettled([first, second]);
  await f.time.flush(); assert.equal(discoveries, 1);
  release(await f.currentBinding());
  const complete = await results;
  const pin = complete.find((result): result is PromiseFulfilledResult<object> => result.status === "fulfilled")?.value;
  assert.ok(pin); assert.equal(f.bodies.length, 1);
  for (const result of complete) if (result.status === "rejected") assert.equal(framePendingContinuation(result.reason), pin);
  await dual.close();

  const cancelled = new AbortController(); let unblock!: (value: DualBinding) => void, calls = 0;
  const waiting = new Promise<DualBinding>((resolve) => { unblock = resolve; });
  const retry = coreDualFrameCoordinator("https://core.fixture", "fixture-token", () => { calls++; return calls === 1 ? waiting : f.currentBinding(); }, f.request, f.time.wall);
  const error = rejected(retry.bootstrap({ ...plan, owner: "1".repeat(64) }, cancelled.signal));
  await f.time.flush(); cancelled.abort(new Error("controlled caller cancelled while binding discovery waits"));
  unblock(await f.currentBinding()); await error;
  assert.equal(f.bodies.length, 1, "cancelled discovery never obtains a UUID or sends BEGIN");
  await retry.bootstrap({ ...plan, owner: "1".repeat(64) }, new AbortController().signal);
  assert.equal(calls, 2); assert.equal(f.bodies.length, 2); await retry.close();
});

it("typed G429 preserves its full claim and cools only G for the original provider60s gate", async () => {
  const f = fixture(), payload = { type: "clearinghouseState", user: "0x" + "1".repeat(40) };
  f.denyNextRead("data_provider_rate_limited");
  const error: any = await rejected(f.reader.readPublicSource(info, payload));
  assert.equal(error.code, "VENUE_RATE_LIMITED");
  assert.equal(f.gateway.snapshot().provider_cooldown_ms, 60000); assert.equal(f.account.snapshot().provider_cooldown_ms, 0);
  assert.equal(f.gateway.snapshot().used, 2, "429 with sent=true does not refund the G claim");
  const ticket = await f.account.acquire("account", 2, "unrelated-A", new AbortController().signal); ticket.release();
  await rejected(f.reader.readPublicSource(info, payload)); assert.equal(f.reads.length, 1);
  await f.time.advance(60000);
  await f.time.run(f.reader.readPublicSource(info, payload)); assert.equal(f.reads.length, 2);
  await f.reader.drainAccounts();
});

it("typed A429 cools A while a separately authorized G source read remains usable", async () => {
  const f = fixture(), window = await f.time.run(f.prepare());
  f.denyNextRead("data_provider_rate_limited", 60000);
  const error: any = await rejected(f.time.run(window.read(async () => { f.reader.bindAccountCostPlan(owner); await f.reader.readPublicSource(info, { type: "meta" }); })));
  assert.equal(error.code, "VENUE_RATE_LIMITED");
  assert.equal(f.account.snapshot().provider_cooldown_ms, 60000); assert.equal(f.gateway.snapshot().provider_cooldown_ms, 0);
  await f.time.run(f.reader.readPublicSource(info, { type: "clearinghouseState", user: "0x" + "1".repeat(40) }));
  assert.deepEqual(f.reads.map((read) => read.stage), ["account", "source"]);
  await window.close(); await f.reader.drainAccounts();
});

it("untyped read_unknown stays conservative without inventing provider429 evidence", async () => {
  const f = fixture(); f.denyNextRead("read_unknown");
  const error: any = await rejected(f.reader.readPublicSource(info, { type: "clearinghouseState", user: "0x" + "1".repeat(40) }));
  assert.equal(error.code, "VENUE_UNAVAILABLE");
  assert.equal(f.gateway.snapshot().provider_cooldown_ms, 0); assert.equal(f.account.snapshot().provider_cooldown_ms, 0);
  assert.equal(f.gateway.snapshot().used, 2);
  await f.time.advance(60001); assert.equal(f.gateway.snapshot().used, 2, "unknown original last-possible-dispatch retention is not refunded");
  await f.reader.drainAccounts();
});
