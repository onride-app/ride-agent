import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { framePendingContinuation } from "./core-frame-coordinator.js";
import { coreDualFrameCoordinator } from "./core-dual-frame-coordinator.js";
import { coreDualInfoFetcher } from "./core-dual-info-reads.js";
import { runtimeBindingId, type DualBinding } from "./dual-egress-contract.js";
import { VenueReads, type AccountReadFrameCoordinator, type PreparedAccountWindow } from "./venue-reads.js";
import { VenueReadBudget } from "./venue-read-budget.js";
import { registerFreshSubmitReadCaller } from "./fresh-submit-read-purpose.js";

// These strict HTTP receipts exercise actual Node orchestration/books. They
// model no Core capacity or financial acceptance; actual Lua is a separate gate.
const owners = ["1".repeat(64), "2".repeat(64)], frames = ["3".repeat(64), "4".repeat(64)];
const info = "https://api.hyperliquid.xyz/info";
function barrier() { let release!: () => void; const wait = new Promise<void>(r => { release = r; }); return { wait, release }; }
async function flush() { for (let i = 0; i < 200; i++) await Promise.resolve(); }
async function failure(work: Promise<unknown>): Promise<any> { try { await work; } catch (e) { return e; } assert.fail("Expected rejection"); }
function fixture(enabled = true) {
  let elapsed = 0;
  const wall = () => 1794400000000 + elapsed, mono = () => 1000 + elapsed;
  const a = new VenueReadBudget({ clock: mono }), g = new VenueReadBudget({ clock: mono });
  for (const owner of owners) a.restoreObservationPlan(owner, { demand: 184, peaks: [164, 164, 164] }, 600000);
  const nonce = randomUUID(), binding: DualBinding = Object.freeze({ protocol_version: 3, authority_id: "a".repeat(64), binding_id: runtimeBindingId("a".repeat(64), nonce),
    binding_generation: randomUUID(), gateway_boot_nonce: nonce, account_bank_id: "b".repeat(64), gateway_bank_id: "c".repeat(64) });
  const bodies: any[] = [], ends: any[] = [], reads: any[] = [], state = new Map<string, any>();
  const blockedMetadata = new Map<string, Promise<void>>(), blockedReady = new Map<string, Promise<void>>();
  const pending = new Set<string>(), unknown = new Set<string>();
  let endUnknown = false, onReady: (() => void) | undefined, onLegacyRead: (() => Promise<void>) | undefined;
  const store = { begins: 0, completes: 0, reads: 0,
    read: async (owner: string) => { store.reads++; await blockedMetadata.get(owner); return { owner, generation: "1", plan: { demand: 184, peaks: [164, 164, 164] }, remainingTtlMs: 600000 }; },
    begin: async (owner: string) => { store.begins++; return { owner, generation: "2", plan: { demand: 184, peaks: [164, 164, 164] }, remainingTtlMs: 600000 }; },
    complete: async () => { store.completes++; return true; },
  };
  const request = (async (url: any, init: RequestInit) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(init.body));
    if (path.endsWith("_v3_begin")) {
      bodies.push(structuredClone(body));
      let f = state.get(body.frame_id);
      if (!f) { assert.equal(body.ready, false); assert.equal(body.control_seq, 1); f = { ...body, state: "pending", expires_at: body.deadline_ms }; state.set(body.frame_id, f); }
      if (body.ready) { onReady?.(); await blockedReady.get(body.owner); }
      if (f.state !== "granted") {
        assert.ok(body.control_seq >= f.control_seq);
        if (body.control_seq === f.control_seq) assert.equal(body.ready, f.ready);
        f.control_seq = body.control_seq; f.ready = body.ready;
        if (body.ready && !pending.has(body.owner)) { f.state = "granted"; f.expires_at = wall() + 20000; }
      }
      const gw = f.s_weight + Object.values(f.h_weights).reduce((n: any, w: any) => n + w, 0);
      const reply = { ...f, capacity: 900, guaranteed_complete: false, control_applied: true, queued: f.state === "pending",
        a_reserved_weight: f.state === "granted" ? f.a_weight : 0,
        g_reserved_weight: f.ready ? (f.state === "granted" ? gw : Math.min(gw, 100)) : 0,
        source_ready: gw === 0 || f.state === "granted", retry_after_ms: f.state === "pending" ? 1000 : 0 };
      if (body.ready && unknown.delete(body.owner)) throw new Error("Controlled lost ready ACK");
      return Response.json(reply);
    }
    if (path.endsWith("_v3_end")) {
      ends.push(body); if (endUnknown) throw new Error("Controlled END unknown");
      state.get(body.frame_id).state = "closed";
      return Response.json({ protocol_version: 3, state: "closed", frame_id: body.frame_id, deadline_ms: body.deadline_ms, binding_id: body.binding_id, control_applied: true });
    }
    reads.push(body);
    if (path.endsWith("/perps_info_read")) await onLegacyRead?.();
    return Response.json({ data: { universe: [] }, observed_at: wall(),
      ...(path.endsWith("_v3_read") ? { bank_id: body.stage === "account" ? binding.account_bank_id : binding.gateway_bank_id, read_id: randomUUID(), retain_until_ms: body.deadline_ms + 60000 } : {}) });
  }) as typeof fetch;
  const currentBinding = async () => binding;
  const dual = coreDualFrameCoordinator("https://core.fixture", "local", currentBinding, request, wall);
  const legacyBodies: any[] = [];
  const legacy: AccountReadFrameCoordinator = { capacity: 900, readinessV2: true,
    begin: async (...args) => { legacyBodies.push(args); return { frame_id: randomUUID(), expires_at: wall() + 20000 }; }, end: async () => {}, close: async () => {} };
  const issuer = Object.freeze({});
  const reader = new VenueReads(coreDualInfoFetcher("https://core.fixture", "local", currentBinding, request, wall), wall, 2, {
    transport: "core_shared_info", budget: a, monotonicClock: mono, frameCoordinator: legacy, observationPlans: store, report: () => {}, preparedPromotionV1: enabled, freshSubmitReadIssuer: issuer,
    dualEgress: { coordinator: dual, sourceBudget: g, currentBinding, accountBankId: binding.account_bank_id, gatewayBankId: binding.gateway_bank_id },
  });
  const firsts = [wall() + 90000, wall() + 100000];
  const prepare = (i: number, pin?: object, signal?: AbortSignal, submit = false) => reader.prepareAccountWindow(owners[i], frames[i], firsts[i], pin, signal,
    { purpose: submit ? "audit_submit" : "audit_source", historySources: submit ? [] : ["fixed"] });
  const close = async (...windows: (PreparedAccountWindow | undefined)[]) => { for (const w of windows) await w?.close(); endUnknown = false; await reader.drainAccounts(); };
  return { a, g, reader, dual, issuer, wall, mono, prepare, firsts, bodies, ends, reads, store, state, pending, unknown, blockedMetadata, blockedReady, legacyBodies, close,
    advance: (ms: number) => { elapsed += ms; }, setReadyHook: (hook: () => void) => { onReady = hook; }, setEndUnknown: () => { endUnknown = true; },
    setLegacyRead: (hook: () => Promise<void>) => { onLegacyRead = hook; } };
}

it("older live continuation validates before a newer prepared episode promotes; original FIRST/UUID survive", async () => {
  const f = fixture(); f.pending.add(frames[0]); f.pending.add(frames[1]);
  const pins = await Promise.all([0, 1].map(async i => framePendingContinuation(await failure(f.prepare(i)))));
  assert.ok(pins[0] && pins[1]); f.pending.clear();
  const before = f.bodies.length, slow = barrier(); f.blockedMetadata.set(owners[0], slow.wait);
  const oldWork = f.prepare(0, pins[0]); await flush();
  const youngerWork = f.prepare(1, pins[1]), youngerResult = failure(youngerWork); await flush();
  assert.equal(f.bodies.length, before, "younger cannot spend an older active validation turn");
  slow.release(); const old = await oldWork; await youngerResult;
  assert.deepEqual(f.bodies.slice(before).filter(b => b.ready).map(b => b.owner), [frames[0]]);
  const older = f.bodies.filter(b => b.owner === frames[0]);
  assert.equal(new Set(older.map(b => b.frame_id)).size, 1); assert.ok(older.every(b => b.deadline_ms === f.firsts[0]));
  assert.equal(f.a.snapshot().observation_active, true); assert.equal(f.store.begins, 0, "no PG lease was claimed just to book");
  await f.close(old);
});

it("two new prepared candidates cannot both hold grants while waiting for the same local A", async () => {
  const f = fixture(), hold = barrier(); f.blockedReady.set(frames[0], hold.wait);
  const first = f.prepare(0); await flush(); const second = failure(f.prepare(1)); await flush();
  assert.equal(f.bodies.filter(b => b.ready).length, 1);
  hold.release(); const window = await first; await second;
  assert.equal(f.bodies.filter(b => b.ready).length, 1, "the second scope deferred before Core, with its parked original pin");
  assert.equal(f.g.snapshot().used, 0); assert.equal(f.a.snapshot().observation_reserved, 184);
  await f.close(window);
});

it("known G-partial pending releases the zero-credit turn without parking or losing its original intent", async () => {
  const f = fixture(); f.pending.add(frames[0]);
  const pin = framePendingContinuation(await failure(f.prepare(0))); assert.ok(pin);
  const window = await f.prepare(1);
  assert.equal(f.bodies.filter(b => b.owner === frames[0]).length, 2);
  assert.deepEqual(f.bodies.filter(b => b.owner === frames[0]).map(b => b.ready), [false, true]);
  assert.ok(f.dual.pendingPromotion?.(pin), "strict partial proof remains pending, not cancelled/parked");
  assert.equal(f.bodies.filter(b => b.ready).length, 2); await f.close(window);
});

it("lost ready ACK stays private unknown and a different prepared owner can proceed", async () => {
  const f = fixture(); f.pending.add(frames[0]); f.unknown.add(frames[0]);
  const pin = framePendingContinuation(await failure(f.prepare(0))); assert.ok(pin);
  assert.equal(f.dual.pendingPromotion?.(pin), undefined);
  // Even a subsequent same-ready known pending response cannot erase the old
  // possible application. Only an authenticated park can fence that intent.
  const original = f.bodies.find(b => b.owner === frames[0]);
  const proofPlan = { owner: original.owner, deadline_ms: original.deadline_ms, mode: original.mode, a_weight: original.a_weight, s_weight: original.s_weight, h_weights: original.h_weights, purpose: original.purpose, scope_hash: original.scope_hash };
  await failure(f.dual.reserve(proofPlan, new AbortController().signal, pin));
  assert.equal(f.dual.pendingPromotion?.(pin), undefined);
  const window = await f.prepare(1);
  assert.equal(new Set(f.bodies.filter(b => b.owner === frames[0]).map(b => b.frame_id)).size, 1);
  await f.dual.park(frames[0], new AbortController().signal, pin); assert.ok(f.dual.pendingPromotion?.(pin));
  await f.close(window);
});

it("a genuine unresolved ready ACK keeps the explicit original conservative wait path, not a claimed promotion turn", async () => {
  const f = fixture(); f.unknown.add(frames[0]);
  const pin = framePendingContinuation(await failure(f.prepare(0))); assert.ok(pin);
  assert.equal(f.dual.pendingPromotion?.(pin), undefined);
  let rival: ReturnType<VenueReadBudget["beginObservation"]> | undefined, interest: object | undefined;
  f.setReadyHook(() => {
    f.setReadyHook(() => {});
    interest = f.a.beginObservationInterest(owners[1]); rival = f.a.beginObservation(owners[1], undefined, interest);
  });
  const pendingWindow = f.prepare(0, pin); await flush();
  assert.ok(rival); assert.equal(f.ends.length, 0, "unresolved old work is not falsely assigned the new no-wait guarantee");
  assert.equal(f.reads.length, 0); assert.equal(f.g.sourceCapacityReady(1000), true);
  rival.close(false); f.a.endObservationInterest(interest!);
  const window = await pendingWindow;
  assert.equal(new Set(f.bodies.map(b => b.frame_id)).size, 1); assert.ok(f.bodies.every(b => b.deadline_ms === f.firsts[0]));
  await f.close(window);
});

it("cancelled/expired promotion cannot book a late full grant or renew its episode", async () => {
  for (const cancel of [true, false]) {
    const f = fixture(), hold = barrier(), caller = new AbortController(); f.blockedReady.set(frames[0], hold.wait);
    const result = failure(f.prepare(0, undefined, caller.signal)); await flush();
    if (cancel) caller.abort(new Error("controlled original caller cancellation")); else f.advance(20001);
    hold.release(); const error = await result;
    assert.ok(error); assert.equal(f.a.snapshot().observation_active, false); assert.equal(f.g.sourceCapacityReady(1000), true);
    assert.equal(f.reads.length, 0); assert.equal(f.store.begins, 0);
    assert.equal(new Set(f.bodies.map(b => b.frame_id)).size, 1); assert.ok(f.bodies.every(b => b.deadline_ms === f.firsts[0]));
    await f.close();
  }
});

it("ordinary and branded fresh-submit A remain outside the prepared gate; a lost local race exact-ENDs once", async () => {
  for (const fresh of [false, true]) {
  const f = fixture(), hold = barrier(); f.blockedReady.set(frames[0], hold.wait);
  const prepared = failure(f.prepare(0)); await flush();
  const legacyRead = barrier(); f.setLegacyRead(() => legacyRead.wait);
  const caller = registerFreshSubmitReadCaller({ signal: new AbortController().signal, deadlineMs: f.wall() + 20000 }, f.wall, f.mono);
  const purpose = fresh ? f.reader.freshSubmitReadPurpose(f.issuer, { user: "u", portfolio: "p", account: "a", revision: 1, control: "c", execution: "original", fingerprint: "d".repeat(64), expiresAt: caller.deadlineMs, currentBinding: "e".repeat(64) }, caller, () => true) : undefined;
  if (fresh) assert.ok(purpose);
  const ordinary = f.reader.observeAccount(async () => { f.reader.bindAccountCostPlan(owners[1]); await f.reader.readWithEvidence(info, { type: "meta" }); }, owners[1],
    fresh ? { signal: caller.signal, deadlineMs: caller.deadlineMs, waitForFrameAdmission: true } : {}, purpose);
  await flush(); assert.equal(f.legacyBodies.length, 1); assert.equal(f.a.snapshot().observation_active, true);
  hold.release(); await prepared; await flush();
  assert.equal(f.ends.length, 1, "the granted prepared frame is ENDed, not held while local FIFO waits");
  assert.equal(f.ends[0].frame_id, f.bodies[0].frame_id); assert.equal(f.g.sourceCapacityReady(1000), true);
  assert.equal(f.reads.length, 1, "only the independently authorized ordinary read dispatched");
  legacyRead.release(); await ordinary; await f.close();
  }
});

it("a rejected joint book with END unknown retains the old frame; no replacement UUID or unused G credit", async () => {
  const f = fixture(); f.setEndUnknown();
  f.a.beginObservationBundle = () => { throw new Error("controlled synchronous second book failure"); };
  await failure(f.prepare(0)); await flush(); await failure(f.prepare(0));
  assert.equal(new Set(f.bodies.map(b => b.frame_id)).size, 1); assert.equal(f.bodies.length, 2);
  assert.equal(f.g.sourceCapacityReady(1000), true); assert.equal(f.reads.length, 0); assert.equal(f.store.begins, 0);
  await f.close();
});

it("audit_submit keeps its two real A children in one parent and releases the promotion turn before child work", async () => {
  const f = fixture(), window = await f.prepare(0, undefined, undefined, true);
  assert.equal(f.bodies.at(-1).a_weight, 368); assert.equal(f.a.snapshot().observation_reserved, 368);
  for (let n = 0; n < 2; n++) await window.read(async () => { f.reader.bindAccountCostPlan(owners[0]); await f.reader.readPublicSource(info, { type: "meta", dex: "dex" + n }); });
  assert.equal(f.reads.length, 2); assert.ok(f.reads.every(r => r.stage === "account")); assert.equal(f.bodies.filter(b => b.ready).length, 1);
  assert.equal(f.store.begins, 2); assert.equal(f.store.completes, 2); await f.close(window);
});

it("BUSY continuation parks its original pin without dirty metadata, then resumes after the active A", async () => {
  const f = fixture(); f.pending.add(frames[0]);
  const pin = framePendingContinuation(await failure(f.prepare(0))); assert.ok(pin);
  const interest = f.a.beginObservationInterest(owners[1]), rival = f.a.beginObservation(owners[1], undefined, interest), before = f.store.reads;
  await failure(f.prepare(0, pin));
  assert.equal(f.store.reads, before); assert.deepEqual(f.bodies.filter(b => b.owner === frames[0]).map(b => b.ready), [false, true, false]);
  rival.close(false); f.a.endObservationInterest(interest); f.pending.delete(frames[0]);
  const window = await f.prepare(0, pin);
  assert.equal(new Set(f.bodies.map(b => b.frame_id)).size, 1); assert.ok(f.bodies.every(b => b.deadline_ms === f.firsts[0]));
  await f.close(window);
});

it("private pending proof rejects clones, foreign coordinator and the original FIRST expiry", async () => {
  const f = fixture(), other = fixture(); f.pending.add(frames[0]);
  const pin = framePendingContinuation(await failure(f.prepare(0))); assert.ok(pin);
  assert.ok(f.dual.pendingPromotion?.(pin)); assert.equal(f.dual.pendingPromotion?.({ ...pin }), undefined);
  assert.equal(other.dual.pendingPromotion?.(pin), undefined);
  f.advance(90000); assert.equal(f.dual.pendingPromotion?.(pin), undefined);
  await assert.rejects(f.dual.park(frames[0], new AbortController().signal, pin), (e: any) => e.code === "VENUE_READ_DEADLINE");
  await flush(); assert.equal(f.ends.length, 1); assert.equal(f.ends[0].deadline_ms, f.firsts[0]);
  await f.close(); await other.close();
});

it("drain revokes metadata contenders before they can promote or leave an arbiter head", async () => {
  const f = fixture(); f.pending.add(frames[0]); f.pending.add(frames[1]);
  const pins = await Promise.all([0, 1].map(async i => framePendingContinuation(await failure(f.prepare(i)))));
  assert.ok(pins[0] && pins[1]); f.pending.clear();
  const slow = barrier(); f.blockedMetadata.set(owners[0], slow.wait);
  const old = failure(f.prepare(0, pins[0])); await flush();
  const younger = failure(f.prepare(1, pins[1])); await flush();
  const before = f.bodies.length; await f.reader.drainAccounts(); slow.release(); await Promise.all([old, younger]);
  assert.equal(f.bodies.length, before); assert.equal(f.a.snapshot().observation_active, false);
  assert.equal(f.g.sourceCapacityReady(1000), true); assert.equal(f.reads.length, 0);
});
