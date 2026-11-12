import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { coreDualFrameCoordinator } from "./core-dual-frame-coordinator.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import { registerFreshSubmitReadCaller } from "./fresh-submit-read-purpose.js";

// Actual Node coordination and budget books; HTTP receipts here are local stubs,
// not a rolling Core bank or evidence of complete financial-account coverage.
const owners = ["a".repeat(64), "b".repeat(64)];
const info = "https://api.hyperliquid.xyz/info";
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let n = 0; n < 200; n++) await Promise.resolve(); }
class Time {
  elapsed = 0;
  seq = 0;
  events = new Map<number, { at: number; run(): void }>();
  wall = () => 1794400000000 + this.elapsed;
  mono = () => 1000 + this.elapsed;
  timers: BudgetTimers = {
    setTimeout: (run, ms) => { const id = ++this.seq; this.events.set(id, { at: this.elapsed + ms, run }); return id; },
    clearTimeout: id => { this.events.delete(id as number); },
  };
  async advance(ms: number) {
    const end = this.elapsed + ms;
    await flush();
    for (;;) {
      const next = [...this.events].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.elapsed = next[1].at; this.events.delete(next[0]); next[1].run(); await flush();
    }
    this.elapsed = end; await flush();
  }
}
function fixture(enabled: boolean, dualEnabled = true) {
  const time = new Time(), a = new VenueReadBudget({ clock: time.mono, timers: time.timers });
  const g = new VenueReadBudget({ clock: time.mono, timers: time.timers });
  for (const owner of owners) a.restoreObservationPlan(owner, { demand: 184, peaks: [164, 164, 164] }, 600000);
  const begins: any[] = [], ends: any[] = [], wires: any[] = [];
  const plans = {
    claims: 0,
    read: async (owner: string) => ({ owner, generation: "1", plan: { demand: 184, peaks: [164, 164, 164] }, remainingTtlMs: 600000 }),
    begin: async (owner: string) => { plans.claims++; return { owner, generation: "2", plan: { demand: 184, peaks: [164, 164, 164] }, remainingTtlMs: 600000 }; },
    complete: async () => true,
  };
  let endUnknown = false, grantStatus = 200, pending = false;
  const request: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)), path = new URL(String(url)).pathname;
    assert.ok(!path.includes("v2"), "ordinary reads must not enable V2 or discover Gateway");
    if (path.endsWith("_end")) {
      ends.push(body);
      if (endUnknown) throw new DOMException("Controlled lost END ACK", "TimeoutError");
      return Response.json({ state: "closed", frame_id: body.frame_id });
    }
    begins.push(body);
    return Response.json({ frame_id: body.frame_id, state: pending ? "pending" : "granted", reserved_weight: pending ? 71 : body.weight,
      expires_at: pending ? body.deadline_ms : time.wall() + 20000, retry_after_ms: pending ? 1000 : 0, guaranteed_complete: body.mode !== "cold_trial" }, { status: grantStatus });
  };
  const c = coreFrameCoordinator("https://core.fixture", "local", request, time.wall);
  const noBinding = async (): Promise<never> => { assert.fail("ordinary A cannot depend on Gateway binding/cold/availability"); };
  const dual = coreDualFrameCoordinator("https://core.fixture", "local", noBinding, request, time.wall);
  const hold = barrier<Response>();
  const issuer = Object.freeze({});
  const reader = new VenueReads(async (_url, _init, context) => {
    wires.push(context);
    return wires.length === 1 ? hold.promise : Response.json({ universe: [] });
  }, time.wall, 2, {
    transport: "core_shared_info", budget: a, timers: time.timers, monotonicClock: time.mono,
    frameCoordinator: c, report: () => {}, preparedPromotionV1: enabled, observationPlans: plans, freshSubmitReadIssuer: issuer,
    ...(dualEnabled ? { dualEgress: { coordinator: dual, sourceBudget: g, currentBinding: noBinding,
      accountBankId: "c".repeat(64), gatewayBankId: "d".repeat(64) } } : {}),
  });
  const read = (i: number, wait = false) => reader.observeAccount(() => reader.read(info, { type: "meta" }), owners[i], wait ? { waitForFrameAdmission: true } : {});
  return { time, a, g, c, reader, begins, ends, wires, hold, read, plans, issuer,
    endUnknown: (value: boolean) => { endUnknown = value; }, status: (value: number) => { grantStatus = value; }, pending: (value: boolean) => { pending = value; } };
}
function localBusy(error: unknown) {
  assert.ok(error instanceof AgentError);
  assert.equal(error.details?.reason_code, "READ_LOCAL_BUSY");
  return true;
}

it("default-off reproduces an unused ordinary grant waiting behind the active observation", async () => {
  const f = fixture(false), first = f.read(0);
  await flush();
  let done = false;
  const second = f.read(1).finally(() => { done = true; });
  await flush();
  assert.equal(f.begins.length, 2); assert.equal(f.wires.length, 1);
  await f.time.advance(6000);
  assert.equal(done, false); assert.equal(f.ends.length, 0, "old grant remains unused for six seconds");
  f.hold.resolve(Response.json({ universe: [] })); await first; await f.time.advance(1000); await second;
  assert.equal(f.wires.length, 2); await f.reader.drainAccounts();
});

it("opt-in ordinary grant makes one synchronous local attempt then ENDs without sleep, PG claim, ticket or second wire", async () => {
  const f = fixture(true), first = f.read(0);
  await flush();
  let attempts = 0;
  const original = f.a.beginObservation;
  f.a.beginObservation = function (...args) { attempts++; return original.apply(this, args); };
  const start = f.time.elapsed;
  assert.equal(f.plans.claims, 1);
  await assert.rejects(f.read(1), localBusy); await flush();
  assert.equal(attempts, 1); assert.equal(f.time.elapsed, start);
  assert.equal(f.begins.length, 2); assert.equal(f.wires.length, 1); assert.equal(f.ends.length, 1);
  assert.equal(f.ends[0].frame_id, f.begins[1].frame_id);
  assert.equal(f.a.snapshot().observation_active, true, "peer's original reservation survives");
  assert.equal(f.a.snapshot().observations.started, 1);
  assert.equal(f.plans.claims, 1, "failed local booking never calls the PG claim hook");
  assert.equal(f.g.snapshot().used, 0); assert.equal(f.g.snapshot().observation_reserved, 0);
  f.hold.resolve(Response.json({ universe: [] })); await first; await f.reader.drainAccounts();
  assert.equal(f.ends.length, 2, "scope finally does not send duplicate END");
});

it("lost END ACK keeps the same ordinary frame past original expiry and retries END before any new BEGIN", async () => {
  const f = fixture(true), first = f.read(0);
  await flush(); f.endUnknown(true);
  await assert.rejects(f.read(1), localBusy); await flush();
  const original = f.begins[1];
  await assert.rejects(f.read(1)); await flush();
  assert.equal(f.begins.length, 2); assert.equal(f.ends.length, 2);
  assert.ok(f.ends.every(e => e.frame_id === original.frame_id && e.owner === original.owner));
  f.endUnknown(false); f.hold.resolve(Response.json({ universe: [] })); await first;
  await f.time.advance(100001);
  // No expiry-based eviction: even after FIRST, the original END is confirmed
  // before a subsequent independent observation may acquire a new UUID.
  await f.read(1); await flush();
  assert.equal(f.ends[3].frame_id, original.frame_id);
  assert.notEqual(f.begins[2].frame_id, original.frame_id);
  assert.equal(f.begins[2].weight, original.weight);
  await f.reader.drainAccounts();
});

it("financial waitForFrameAdmission retains the original postgrant waiting contract", async () => {
  const f = fixture(true), first = f.read(0);
  await flush(); let done = false;
  const second = f.read(1, true).finally(() => { done = true; });
  await flush(); await f.time.advance(6000);
  assert.equal(done, false); assert.equal(f.ends.length, 0);
  f.hold.resolve(Response.json({ universe: [] })); await first; await f.time.advance(1000); await second;
  await f.reader.drainAccounts();
});

it("a genuinely branded fresh-submit caller keeps its original BUSY wait and financial permit path", async () => {
  const f = fixture(true), first = f.read(0); await flush();
  const caller = registerFreshSubmitReadCaller({ signal: new AbortController().signal, deadlineMs: f.time.wall() + 20000 }, f.time.wall, f.time.mono);
  const purpose = f.reader.freshSubmitReadPurpose(f.issuer, { user: "u", portfolio: "p", account: "a", revision: 1,
    control: "c", execution: "original", fingerprint: "e".repeat(64), expiresAt: caller.deadlineMs, currentBinding: "f".repeat(64) }, caller, () => true);
  assert.ok(purpose); let done = false;
  const fresh = f.reader.observeAccount(async () => {
    f.reader.bindAccountCostPlan(owners[1]);
    await f.reader.read(info, { type: "meta" });
  }, owners[1], { signal: caller.signal, deadlineMs: caller.deadlineMs, waitForFrameAdmission: true }, purpose).finally(() => { done = true; });
  await flush(); await f.time.advance(6000);
  assert.equal(done, false); assert.equal(f.begins.length, 1, "existing fresh BUSY precheck stays before Core");
  assert.equal(f.ends.length, 0); assert.equal(f.plans.claims, 1);
  f.hold.resolve(Response.json({ universe: [] })); await first; await f.time.advance(1000); await fresh;
  assert.equal(f.wires.length, 2); assert.equal(f.begins.length, 2);
  await f.reader.drainAccounts();
});

it("ordinary pending still polls its original FIFO frame and FIRST without the rejected R60 pre-Core skip", async () => {
  const f = fixture(true), first = f.read(0); await flush();
  f.pending(true);
  await assert.rejects(f.read(1), (e: any) => e.details?.reason_code === "READ_FRAME_PENDING");
  await f.time.advance(5000);
  await assert.rejects(f.read(1), (e: any) => e.details?.reason_code === "READ_FRAME_PENDING");
  assert.equal(f.begins[1].frame_id, f.begins[2].frame_id);
  assert.equal(f.begins[1].deadline_ms, f.begins[2].deadline_ms);
  assert.equal(f.ends.length, 0); assert.equal(f.wires.length, 1);
  f.pending(false); f.hold.resolve(Response.json({ universe: [] })); await first;
  await f.reader.drainAccounts();
});
