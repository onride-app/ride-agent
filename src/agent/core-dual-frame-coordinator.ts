import { randomUUID } from "node:crypto";
import { AgentError } from "./contracts.js";
import { costPlanUnavailable } from "./account-observation-plans.js";
import { canonicalUuid, DUAL_SEQ_MAX, hash64, type DualBinding } from "./dual-egress-contract.js";

export type DualFramePlan = Readonly<{
  owner: string;
  deadline_ms: number;
  mode: "learned" | "cold_trial";
  a_weight: number;
  s_weight: number;
  h_weights: Readonly<Record<string, number>>;
  purpose: "account" | "audit_source" | "audit_submit";
  scope_hash: string;
}>;
export type DualFrameLease = Readonly<{ frame_id: string; expires_at: number }>;
type Frame = {
  id: string;
  plan: DualFramePlan;
  binding: DualBinding;
  seq: number;
  ready: boolean;
  acknowledged: boolean;
  initialPark: boolean;
  mayHaveApplied: boolean;
  polling: boolean;
  pin: object;
  expires?: number;
  leaseIssued: boolean;
  promotionUnknown: boolean;
};
type LeaseRecord = { frame: Frame; live(): boolean; consumed: boolean };
const pins = new WeakMap<object, Frame>();
const pending = new WeakMap<object, object>();
const leases = new WeakMap<DualFrameLease, LeaseRecord>();
export function dualFramePendingContinuation(error: unknown): object | undefined {
  return error && typeof error === "object" ? pending.get(error) : undefined;
}
function deferred(frame: Frame, reason = "READ_FRAME_PENDING") {
  const error = new AgentError("VENUE_READ_BUDGET_EXHAUSTED", "Complete dual-bank read is pending before upstream work.", true, 503, { reason_code: reason, retry_after_ms: 1000 });
  pending.set(error, frame.pin);
  return error;
}
const totalG = (p: DualFramePlan) => p.s_weight + Object.values(p.h_weights).reduce((n, w) => n + w, 0);
function validPlan(plan: DualFramePlan, now: number) {
  return hash64(plan.owner) && hash64(plan.scope_hash) && Number.isSafeInteger(plan.deadline_ms) && plan.deadline_ms > now && plan.deadline_ms <= now + 100000 &&
    ["learned", "cold_trial"].includes(plan.mode) && ["account", "audit_source", "audit_submit"].includes(plan.purpose) &&
    Number.isSafeInteger(plan.a_weight) && plan.a_weight >= 1 && Number.isSafeInteger(plan.s_weight) && plan.s_weight >= 0 &&
    Object.keys(plan.h_weights).length <= 8 && Object.entries(plan.h_weights).every(([s, w]) => /^[\x21-\x7e]{1,256}$/.test(s) && Number.isSafeInteger(w) && w > 0) &&
    (plan.purpose === "audit_source" || Object.keys(plan.h_weights).length === 0) &&
    (plan.purpose !== "account" || totalG(plan) === 0) && plan.a_weight + totalG(plan) <= 900;
}
function samePools(a: Readonly<Record<string, number>>, b: unknown): boolean {
  return !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => (b as Record<string, unknown>)[key] === value);
}
function fits(plan: DualFramePlan, original: DualFramePlan) {
  return plan.owner === original.owner && plan.purpose === original.purpose && plan.mode === original.mode && plan.scope_hash === original.scope_hash &&
    Object.keys(plan.h_weights).length === Object.keys(original.h_weights).length && Object.entries(plan.h_weights).every(([s, w]) => Object.hasOwn(original.h_weights, s) && w <= original.h_weights[s]) &&
    plan.a_weight <= original.a_weight && plan.s_weight <= original.s_weight &&
    (plan.mode !== "cold_trial" || (plan.a_weight === original.a_weight && plan.s_weight === original.s_weight && samePools(plan.h_weights, original.h_weights)));
}
/** The one strict full grant can be consumed once, synchronously by joint book. */
export function consumeDualFrameLease(lease: DualFrameLease): Readonly<{ plan: DualFramePlan; binding: DualBinding }> {
  const record = leases.get(lease);
  if (!record || record.consumed || !record.live()) throw costPlanUnavailable();
  record.consumed = true;
  return Object.freeze({ plan: record.frame.plan, binding: record.frame.binding });
}
export function dualFrameLeaseBinding(lease: DualFrameLease): DualBinding {
  const record = leases.get(lease);
  if (!record || !record.live()) throw costPlanUnavailable();
  return record.frame.binding;
}
export interface CoreDualFrameCoordinator {
  bootstrap(plan: DualFramePlan, signal: AbortSignal, continuation?: object): Promise<object>;
  reserve(plan: DualFramePlan, signal: AbortSignal, continuation?: object, ready?: boolean): Promise<DualFrameLease>;
  park(owner: string, signal: AbortSignal, continuation?: object): Promise<boolean>;
  isParked(continuation: object): boolean;
  /** Private current pending proof; absent/unknown is never promotion authority. */
  pendingPromotion?(continuation: object): Readonly<{ frame_id: string; plan: DualFramePlan }> | undefined;
  defer(continuation: object): AgentError;
  cancelPending(continuation: object): Promise<void>;
  end(frameId: string): Promise<void>;
  close(): Promise<void>;
}

export function coreDualFrameCoordinator(
  coreUrl: string,
  token: string,
  currentBinding: (signal: AbortSignal) => Promise<DualBinding>,
  request: typeof fetch = fetch,
  clock = Date.now,
): CoreDualFrameCoordinator {
  const beginUrl = new URL("/internal/agent-core/perps_info_frame_v3_begin", coreUrl), endUrl = new URL("/internal/agent-core/perps_info_frame_v3_end", coreUrl);
  const frames = new Map<string, Frame>(), retiring = new Map<string, Frame>(), releases = new WeakMap<Frame, Promise<void>>(), releasing = new Set<Promise<void>>();
  const creating = new Map<string, Promise<Frame>>(), stop = new AbortController();
  let closing = false;
  const live = (frame: Frame) => !closing && frames.get(frame.plan.owner) === frame && (frame.expires ?? frame.plan.deadline_ms) > clock();
  async function post(url: URL, body: unknown, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      const work = (async () => {
        const response = await request(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal, redirect: "error" });
        const value = await response.json() as any;
        if (signal.aborted) throw signal.reason;
        return { response, value };
      })();
      return await Promise.race([work, aborted]);
    } finally { signal.removeEventListener("abort", abort); }
  }
  function release(frame: Frame): Promise<void> {
    const previous = releases.get(frame);
    if (previous) return previous;
    // Retain before removing the active map: a new same-owner caller cannot
    // mistake an END in flight/unknown for no existing physical reservation.
    retiring.set(frame.plan.owner, frame);
    if (frames.get(frame.plan.owner) === frame) frames.delete(frame.plan.owner);
    const work = (async () => {
      const { response, value } = await post(endUrl, { protocol_version: 3, frame_id: frame.id, owner: frame.plan.owner, deadline_ms: frame.plan.deadline_ms, binding_id: frame.binding.binding_id }, AbortSignal.timeout(2000));
      if (response.status !== 200 || value?.protocol_version !== 3 || value.state !== "closed" || value.frame_id !== frame.id || value.deadline_ms !== frame.plan.deadline_ms || value.binding_id !== frame.binding.binding_id || value.control_applied !== true)
        throw costPlanUnavailable();
    })();
    releases.set(frame, work); releasing.add(work);
    void work.then(() => {
      releasing.delete(work);
      if (retiring.get(frame.plan.owner) === frame) retiring.delete(frame.plan.owner);
    }, () => { releasing.delete(work); releases.delete(frame); });
    return work;
  }
  function notExpired(frame: Frame) {
    if ((frame.expires ?? frame.plan.deadline_ms) > clock()) return;
    void release(frame).catch(() => {});
    throw new AgentError("VENUE_READ_DEADLINE", "Original dual-bank episode expired.", true, 503);
  }
  async function get(plan: DualFramePlan, signal: AbortSignal, continuation?: object): Promise<Frame> {
    const prior = frames.get(plan.owner);
    for (const frame of frames.values())
      if ((frame.expires ?? frame.plan.deadline_ms) <= clock()) void release(frame).catch(() => {});
    if (prior && (prior.expires ?? prior.plan.deadline_ms) <= clock())
      throw new AgentError("VENUE_READ_DEADLINE", "Original dual-bank episode expired.", true, 503);
    if (closing || signal.aborted || !validPlan(plan, clock())) throw costPlanUnavailable();
    const old = retiring.get(plan.owner);
    if (old) await release(old);
    if (closing || signal.aborted) throw costPlanUnavailable();
    let frame = frames.get(plan.owner);
    if (continuation && (!frame || pins.get(continuation) !== frame)) throw costPlanUnavailable();
    if (frame) {
      notExpired(frame);
      if (!fits(plan, frame.plan)) throw costPlanUnavailable();
      return frame;
    }
    const pending = creating.get(plan.owner);
    if (pending) {
      const result = await pending;
      if (closing || signal.aborted || frames.get(plan.owner) !== result || !fits(plan, result.plan)) throw costPlanUnavailable();
      notExpired(result);
      return result;
    }
    if (frames.size + retiring.size + creating.size >= 64) throw costPlanUnavailable();
    // Reserve a bounded slot before even invoking a binding reader: it may
    // await IO or synchronously re-enter this coordinator for another owner.
    const work: Promise<Frame> = Promise.resolve().then(async () => {
      const binding = await currentBinding(signal);
      if (closing || signal.aborted || plan.deadline_ms <= clock()) throw costPlanUnavailable();
      const pin = Object.freeze({});
      const result: Frame = { id: randomUUID(), plan: Object.freeze({ ...plan, h_weights: Object.freeze({ ...plan.h_weights }) }), binding, seq: 1, ready: false, acknowledged: false, initialPark: false, mayHaveApplied: false, polling: false, pin, leaseIssued: false, promotionUnknown: false };
      // One synchronous transfer preserves the same reserved slot; there is
      // never a gap in which a competing owner can claim additional capacity.
      if (creating.get(plan.owner) !== work) throw costPlanUnavailable();
      creating.delete(plan.owner);
      pins.set(pin, result); frames.set(plan.owner, result);
      return result;
    });
    creating.set(plan.owner, work);
    try { return await work; }
    finally { if (creating.get(plan.owner) === work) creating.delete(plan.owner); }
  }
  const tuple = (frame: Frame, value: any) => value?.protocol_version === 3 && value.frame_id === frame.id && value.owner === frame.plan.owner && value.deadline_ms === frame.plan.deadline_ms &&
    value.binding_id === frame.binding.binding_id && value.binding_generation === frame.binding.binding_generation && value.account_bank_id === frame.binding.account_bank_id && value.gateway_bank_id === frame.binding.gateway_bank_id &&
    value.mode === frame.plan.mode && value.purpose === frame.plan.purpose && value.scope_hash === frame.plan.scope_hash && value.a_weight === frame.plan.a_weight && value.s_weight === frame.plan.s_weight && samePools(frame.plan.h_weights, value.h_weights);
  async function exchange(frame: Frame, ready: boolean, signal: AbortSignal): Promise<any> {
    notExpired(frame);
    const send = async () => {
      notExpired(frame);
      if (!live(frame) || signal.aborted) throw costPlanUnavailable();
      frame.mayHaveApplied = true;
      try {
      const { response, value } = await post(beginUrl, { protocol_version: 3, frame_id: frame.id, ...frame.plan, binding_id: frame.binding.binding_id, binding_generation: frame.binding.binding_generation, account_bank_id: frame.binding.account_bank_id, gateway_bank_id: frame.binding.gateway_bank_id, control_seq: frame.seq, ready: frame.ready }, signal);
      if (!live(frame) || signal.aborted) throw costPlanUnavailable();
      if (response.status === 200 && tuple(frame, value) && value.state === "cancelled" && value.control_applied === true && value.queued === false && value.a_reserved_weight === 0 && value.g_reserved_weight === 0 && value.expires_at === frame.plan.deadline_ms && value.retry_after_ms === 0 && value.control_seq === frame.seq && value.ready === frame.ready) {
        await release(frame);
        throw new AgentError("VENUE_READ_DEADLINE", "Original dual-bank episode is permanently fenced.", true, 503);
      }
      if (response.status === 200 && tuple(frame, value) && value.state === "granted" && value.control_applied === false && Number.isSafeInteger(value.expires_at) && value.expires_at > clock() && value.expires_at <= clock() + 20000) {
        // An in-use/refused park is not full unused-credit authority.
        frame.expires ??= value.expires_at;
        throw costPlanUnavailable();
      }
      const g = totalG(frame.plan);
      if (response.status !== 200 || !tuple(frame, value) || value.control_applied !== true || value.control_seq !== frame.seq || value.ready !== frame.ready || value.capacity !== 900 || value.guaranteed_complete !== false ||
        !["pending", "granted"].includes(value.state) || !Number.isSafeInteger(value.expires_at) || value.expires_at <= clock() ||
        !Number.isSafeInteger(value.a_reserved_weight) || !Number.isSafeInteger(value.g_reserved_weight) || typeof value.source_ready !== "boolean" ||
        (value.state === "pending" ? value.queued !== true || value.a_reserved_weight !== 0 || value.g_reserved_weight < 0 || value.g_reserved_weight > g || (!frame.ready && value.g_reserved_weight !== 0) || value.source_ready !== (g === 0 || (frame.ready && value.g_reserved_weight === g)) || value.expires_at !== frame.plan.deadline_ms || !Number.isSafeInteger(value.retry_after_ms) || value.retry_after_ms < 1 || value.retry_after_ms > 1000
          : !frame.ready || value.queued !== false || value.a_reserved_weight !== frame.plan.a_weight || value.g_reserved_weight !== g || value.source_ready !== true || value.expires_at > clock() + 20000 || value.retry_after_ms !== 0 || (frame.expires !== undefined && value.expires_at !== frame.expires)))
        throw costPlanUnavailable();
      frame.acknowledged = true;
      if (!frame.ready) {
        frame.initialPark = true;
        // A strict parked ACK fences every older ready intent. A later same
        // ready=true pending reply alone cannot fence an earlier lost grant.
        frame.promotionUnknown = false;
      }
      if (value.state === "granted") frame.expires ??= value.expires_at;
      return value;
      } catch (error) {
        frame.promotionUnknown = true;
        throw error;
      }
    };
    // Resolve a possibly applied intent before changing it. A transport error
    // can never become permission to downgrade or use a new UUID/FIRST.
    if (!frame.acknowledged && frame.ready !== ready) {
      const previous = await send();
      if (previous.state === "granted") return previous;
    }
    if (frame.ready !== ready) {
      if (frame.seq >= DUAL_SEQ_MAX || frame.expires !== undefined) throw costPlanUnavailable();
      frame.seq++; frame.ready = ready; frame.acknowledged = false;
    }
    return send();
  }
  async function controlled<T>(frame: Frame, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (frame.polling) throw deferred(frame, "READ_FRAME_POLLING");
    frame.polling = true;
    try { return await work(AbortSignal.any([signal, stop.signal])); }
    catch (error) {
      if (error instanceof AgentError && error.code === "VENUE_READ_DEADLINE") throw error;
      // Retain exact unknowns and a cancellation handle. No negative response
      // grants credit, while the original frame still expires/cleans normally.
      if (frames.get(frame.plan.owner) === frame) throw deferred(frame);
      throw error;
    } finally { frame.polling = false; }
  }
  return {
    async bootstrap(plan, signal, continuation) {
      const frame = await get(plan, signal, continuation);
      if (frame.initialPark) return frame.pin;
      return controlled(frame, signal, async (combined) => {
        const value = await exchange(frame, false, combined);
        if (!frame.initialPark || value.state !== "pending" || value.a_reserved_weight !== 0 || value.g_reserved_weight !== 0) throw costPlanUnavailable();
        return frame.pin;
      });
    },
    async reserve(plan, signal, continuation, ready = true) {
      const frame = await get(plan, signal, continuation);
      if (!frame.initialPark) throw deferred(frame);
      return controlled(frame, signal, async (combined) => {
        if (frame.leaseIssued) throw costPlanUnavailable();
        const value = await exchange(frame, ready, combined);
        if (!ready || value.state !== "granted") throw deferred(frame);
        notExpired(frame);
        frame.leaseIssued = true;
        const lease = Object.freeze({ frame_id: frame.id, expires_at: value.expires_at as number });
        leases.set(lease, { frame, consumed: false, live: () => live(frame) && frame.expires === lease.expires_at });
        return lease;
      });
    },
    async park(owner, signal, continuation) {
      const frame = frames.get(owner);
      if (!frame || (continuation && pins.get(continuation) !== frame)) return false;
      notExpired(frame);
      if (frame.expires !== undefined || frame.polling) return false;
      return controlled(frame, signal, async (combined) => {
        const value = await exchange(frame, false, combined);
        return value.state === "pending" && value.a_reserved_weight === 0 && value.g_reserved_weight === 0;
      });
    },
    isParked(continuation) {
      const frame = pins.get(continuation);
      return !!frame && live(frame) && frame.initialPark && frame.acknowledged && !frame.ready && frame.expires === undefined && !frame.polling;
    },
    pendingPromotion(continuation) {
      const frame = pins.get(continuation);
      if (!frame || !live(frame) || !frame.initialPark || !frame.acknowledged || frame.polling ||
        frame.promotionUnknown || frame.expires !== undefined || frame.leaseIssued) return undefined;
      return Object.freeze({ frame_id: frame.id, plan: frame.plan });
    },
    defer(continuation) {
      const frame = pins.get(continuation);
      if (!frame || frames.get(frame.plan.owner) !== frame) throw costPlanUnavailable();
      notExpired(frame);
      return deferred(frame);
    },
    async cancelPending(continuation) {
      const frame = pins.get(continuation);
      if (!frame || (frames.get(frame.plan.owner) !== frame && retiring.get(frame.plan.owner) !== frame) || frame.leaseIssued) throw costPlanUnavailable();
      await release(frame);
    },
    async end(frameId) {
      const frame = [...frames.values(), ...retiring.values()].find((f) => f.id === frameId);
      if (frame) await release(frame);
    },
    async close() {
      closing = true; stop.abort(costPlanUnavailable());
      await Promise.allSettled([...creating.values()]);
      await Promise.allSettled([...frames.values(), ...retiring.values()].map(release));
      while (releasing.size) await Promise.allSettled([...releasing]);
    },
  };
}
