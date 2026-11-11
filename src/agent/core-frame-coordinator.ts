import { randomUUID } from "node:crypto";
import { AgentError } from "./contracts.js";
import { dualFramePendingContinuation } from "./core-dual-frame-coordinator.js";
import { costPlanUnavailable } from "./account-observation-plans.js";
import type {
  AccountReadFrameCoordinator,
  AccountReadFrameLease,
} from "./venue-reads.js";

type Frame = {
  readonly id: string;
  readonly owner: string;
  readonly weight: number;
  readonly mode: "learned" | "cold_trial";
  readonly deadline: number;
  expires?: number;
  polling: boolean;
  pendingReceipt?: true;
  readiness?: {
    mayHaveApplied: boolean;
    intent: { seq: number; ready: boolean; acknowledged: boolean };
  };
};

export type FrameReadinessOptions = { readinessV2?: { fleetEpoch: string } };
// Shared wire bound: Redis cjson does not preserve MAX_SAFE_INTEGER decimal text.
export const FRAME_CONTROL_SEQ_MAX = 1_000_000_000;
const canonicalEpoch = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
    value,
  ) && value !== "00000000-0000-0000-0000-000000000000";
/** Operator gate only. An echoed epoch does not prove every shared Lua reader upgraded. */
export function frameReadinessOptions(
  env: NodeJS.ProcessEnv,
): FrameReadinessOptions {
  if (env.RIDE_AGENT_INFO_FRAME_V2_ENABLED !== "true") return {};
  const fleetEpoch = env.RIDE_AGENT_INFO_FRAME_V2_FLEET_EPOCH ?? "";
  if (!canonicalEpoch(fleetEpoch))
    throw new Error("Frame v2 requires a canonical fleet epoch");
  return { readinessV2: { fleetEpoch } };
}

const pendingContinuations = new WeakMap<AgentError, object>();
const framePins = new WeakMap<Frame, object>();
const pinnedFrames = new WeakMap<
  object,
  {
    frame: Frame;
    id: string;
    owner: string;
    weight: number;
    mode: Frame["mode"];
    deadline: number;
  }
>();
/** Local capability only; serialized error reasons cannot authorize polling. */
export function framePendingContinuation(error: unknown): object | undefined {
  return error instanceof AgentError &&
    error.retryable === true &&
    error.code === "VENUE_READ_BUDGET_EXHAUSTED" &&
    ["READ_FRAME_PENDING", "READ_FRAME_POLLING"].includes(
      error.details?.reason_code ?? "",
    )
    ? pendingContinuations.get(error) ?? dualFramePendingContinuation(error)
    : undefined;
}
function deferred(retry = 1000, frame?: Frame, reason = "READ_FRAME_PENDING") {
  const error = new AgentError(
    "VENUE_READ_BUDGET_EXHAUSTED",
    "Complete account observation is queued before venue reads begin.",
    true,
    503,
    { retry_after_ms: retry, reason_code: reason },
  );
  if (frame) {
    let pin = framePins.get(frame);
    if (!pin) {
      pin = {};
      framePins.set(frame, pin);
      pinnedFrames.set(pin, {
        frame,
        id: frame.id,
        owner: frame.owner,
        weight: frame.weight,
        mode: frame.mode,
        deadline: frame.deadline,
      });
    }
    pendingContinuations.set(error, pin);
  }
  return error;
}
const identityChanged = () =>
  deferred(1000, undefined, "READ_FRAME_IDENTITY_CHANGED");

/**
 * One bounded private poll per monitor attempt. Pending reservations survive an
 * account-work callback's normal abort/finally so a busy fleet can fund the FIFO
 * head without holding a PostgreSQL user transaction for the rolling minute.
 * No account response, read cursor or financial evidence is cached here.
 */
export function coreFrameCoordinator(
  coreUrl: string,
  token: string,
  request: typeof fetch = (...args) => fetch(...args),
  clock = Date.now,
  options: FrameReadinessOptions = {},
): AccountReadFrameCoordinator {
  const epoch = options.readinessV2?.fleetEpoch;
  if (epoch !== undefined && !canonicalEpoch(epoch))
    throw new Error("Frame v2 requires a canonical fleet epoch");
  const beginUrl = new URL(
    "/internal/agent-core/perps_info_frame_begin",
    coreUrl,
  );
  const endUrl = new URL("/internal/agent-core/perps_info_frame_end", coreUrl);
  const v2BeginUrl = new URL(
    "/internal/agent-core/perps_info_frame_v2_begin",
    coreUrl,
  );
  const v2EndUrl = new URL(
    "/internal/agent-core/perps_info_frame_v2_end",
    coreUrl,
  );
  if (
    beginUrl.protocol !== "https:" &&
    !(
      beginUrl.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(beginUrl.hostname)
    )
  )
    throw new Error("Core observation frames require a private HTTPS endpoint");
  const frames = new Map<string, Frame>();
  const releasing = new Set<Promise<void>>();
  const releases = new WeakMap<Frame, Promise<void>>();
  // A failed v2 END must not turn map absence into permission for a new UUID.
  // New episodes stop at this bound; existing exact cleanup remains available.
  const retiring = new Map<string, Frame>();
  const stop = new AbortController();
  let closing = false;

  async function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void work.catch(() => {});
      throw signal.reason;
    }
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  async function release(frame: Frame) {
    if (frames.get(frame.owner) === frame) frames.delete(frame.owner);
    // A release has its own small bound: shutdown must still cancel a queued
    // booking after the account attempt's signal has already been aborted.
    const signal = AbortSignal.timeout(2000);
    const response = await bounded(
      request(frame.readiness ? v2EndUrl : endUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          frame_id: frame.id,
          owner: frame.owner,
          ...(frame.readiness
            ? { protocol_version: 2, deadline_ms: frame.deadline }
            : {}),
        }),
        signal,
        redirect: "error",
      }),
      signal,
    );
    const body = (await bounded(response.json(), signal)) as any;
    if (
      response.status !== 200 ||
      body?.state !== "closed" ||
      body?.frame_id !== frame.id ||
      (frame.readiness &&
        (body.protocol_version !== 2 ||
          body.control_applied !== true ||
          body.deadline_ms !== frame.deadline))
    )
      throw costPlanUnavailable();
  }
  function trackRelease(frame: Frame) {
    const previous = releases.get(frame);
    if (previous) return previous;
    if (frame.readiness) retiring.set(frame.owner, frame);
    const work = release(frame);
    releases.set(frame, work);
    releasing.add(work);
    void work.then(
      () => {
        releasing.delete(work);
        if (retiring.get(frame.owner) === frame) retiring.delete(frame.owner);
      },
      () => {
        releasing.delete(work);
        if (frame.readiness) releases.delete(frame); // Retry the same idempotent END, never a new identity.
      },
    );
    return work;
  }
  function prune() {
    for (const frame of frames.values())
      if ((frame.expires ?? frame.deadline) <= clock())
        void trackRelease(frame).catch(() => {});
  }
  async function finishRetiring(owner: string) {
    const frame = retiring.get(owner);
    if (frame) await trackRelease(frame);
  }
  function expired(frame: Frame) {
    if ((frame.expires ?? frame.deadline) > clock()) return;
    void trackRelease(frame).catch(() => {});
    throw new AgentError(
      "VENUE_READ_DEADLINE",
      "Queued account observation reached its original deadline before venue reads began.",
      true,
      503,
    );
  }
  function terminal(body: any, frame: Frame) {
    return (
      body?.protocol_version === 2 &&
      body.frame_id === frame.id &&
      body.deadline_ms === frame.deadline &&
      body.state === "cancelled" &&
      body.queued === false
    );
  }
  async function beginResponse(
    frame: Frame,
    ready: boolean,
    signal: AbortSignal,
    unchanged: () => void,
  ): Promise<{ response: Response; body: any }> {
    const exchange = async () => {
      if (closing || signal.aborted) throw costPlanUnavailable();
      const control = frame.readiness;
      const priorPossible = control?.mayHaveApplied ?? false;
      if (control) {
        control.mayHaveApplied = true;
        control.intent.acknowledged = false;
      }
      const response = await bounded(
        request(control ? v2BeginUrl : beginUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            frame_id: frame.id,
            owner: frame.owner,
            weight: frame.weight,
            mode: frame.mode,
            deadline_ms: frame.deadline,
            ...(control
              ? {
                  protocol_version: 2,
                  control_seq: control.intent.seq,
                  ready: control.intent.ready,
                }
              : {}),
          }),
          signal,
          redirect: "error",
        }),
        signal,
      );
      try {
        unchanged();
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      const body = (await bounded(response.json(), signal)) as any;
      unchanged();
      if (!control) return { response, body };
      const explicitlyUnsupported =
        (response.status === 503 &&
          body?.error?.code === "frame_v2_disabled" &&
          body.error.upstream_request_sent === false) ||
        (response.status === 409 &&
          body?.error?.code === "CORE_REJECTED" &&
          body.error.message === "Unknown private Agent operation");
      if (!priorPossible && explicitlyUnsupported) {
        frame.readiness = undefined; // This entire episode now stays legacy.
        return exchange();
      }
      if (response.status === 200 && terminal(body, frame)) {
        await trackRelease(frame); // Positive exact fence cleanup, not an absence assumption.
        throw new AgentError(
          "VENUE_READ_DEADLINE",
          "Original read episode is permanently closed.",
          true,
          503,
        );
      }
      if (
        response.status !== 200 ||
        body?.protocol_version !== 2 ||
        body.fleet_epoch !== epoch ||
        body.frame_id !== frame.id ||
        body.deadline_ms !== frame.deadline ||
        !Number.isInteger(body.control_seq) ||
        body.control_seq < 1 ||
        body.control_seq > FRAME_CONTROL_SEQ_MAX ||
        body.control_seq !== control.intent.seq ||
        body.ready !== control.intent.ready ||
        body.control_applied !== true ||
        body.capacity !== 900 ||
        body.guaranteed_complete !== false ||
        !["pending", "granted"].includes(body.state) ||
        !Number.isSafeInteger(body.reserved_weight) ||
        body.reserved_weight < 0 ||
        body.reserved_weight > frame.weight ||
        !Number.isSafeInteger(body.expires_at) ||
        body.expires_at <= clock() ||
        !Number.isSafeInteger(body.retry_after_ms) ||
        (body.state === "pending"
          ? body.retry_after_ms < 1 || body.retry_after_ms > 1000
          : body.retry_after_ms !== 0) ||
        (body.state === "pending" &&
          (body.queued !== true ||
            body.expires_at !== frame.deadline ||
            (!control.intent.ready && body.reserved_weight !== 0))) ||
        (body.state === "granted" &&
          (!control.intent.ready ||
            body.queued !== false ||
            body.reserved_weight !== frame.weight ||
            body.expires_at > clock() + 20000))
      ) {
        // A refused park can report an already existing lease. Preserve its
        // real expiry, but this negative ACK never grants a new caller a lease.
        if (
          response.status === 200 &&
          body?.protocol_version === 2 &&
          body.fleet_epoch === epoch &&
          body.frame_id === frame.id &&
          body.deadline_ms === frame.deadline &&
          body.state === "granted" &&
          body.control_applied === false &&
          Number.isSafeInteger(body.expires_at) &&
          body.expires_at > clock() &&
          body.expires_at <= clock() + 20000
        )
          frame.expires = body.expires_at;
        throw costPlanUnavailable();
      }
      control.intent.acknowledged = true;
      frame.pendingReceipt = body.state === "pending" ? true : undefined;
      return { response, body };
    };
    const control = frame.readiness;
    if (control) {
      // Resolve an unknown old intent before changing readiness. Equal seq is
      // an idempotent intent and still performs a real capacity poll in Core.
      if (!control.intent.acknowledged && control.intent.ready !== ready) {
        const previous = await exchange();
        if (!frame.readiness || previous.body.state !== "pending")
          return previous;
      }
      if (frame.readiness && frame.readiness.intent.ready !== ready) {
        if (frame.readiness.intent.seq >= FRAME_CONTROL_SEQ_MAX)
          throw costPlanUnavailable();
        frame.readiness.intent = {
          seq: frame.readiness.intent.seq + 1,
          ready,
          acknowledged: false,
        };
      }
    }
    return exchange();
  }
  return {
    capacity: 900,
    ...(epoch ? { readinessV2: true as const } : {}),
    async parkPending(owner, signal, continuation) {
      if (!epoch) return false;
      if (closing || signal.aborted) throw costPlanUnavailable();
      await finishRetiring(owner);
      if (closing || signal.aborted) throw costPlanUnavailable();
      const frame = frames.get(owner);
      if (!frame) {
        prune();
        return false;
      }
      expired(frame);
      prune();
      if (!frame.readiness || frame.polling || frame.expires !== undefined)
        return false;
      if (continuation !== undefined) {
        const pin = pinnedFrames.get(continuation);
        if (
          !pin ||
          pin.frame !== frame ||
          pin.id !== frame.id ||
          pin.deadline !== frame.deadline
        )
          throw identityChanged();
      }
      const control = frame.readiness;
      if (
        !frame.pendingReceipt &&
        (control.intent.ready || control.intent.acknowledged)
      )
        return false;
      if (!control.intent.ready && control.intent.acknowledged) return true;
      frame.polling = true;
      const boundedSignal = AbortSignal.any([
        signal,
        stop.signal,
        AbortSignal.timeout(2000),
      ]);
      try {
        const { body } = await beginResponse(
          frame,
          false,
          boundedSignal,
          () => {
            if (frames.get(owner) !== frame) throw identityChanged();
          },
        );
        return (
          !!frame.readiness && body.state === "pending" && body.ready === false
        );
      } catch (error) {
        if (error instanceof AgentError && error.code === "VENUE_READ_DEADLINE")
          throw error;
        throw deferred(1000, frame); // Operational continuity only; no park ACK or read permission.
      } finally {
        frame.polling = false;
      }
    },
    async begin(
      owner,
      weight,
      deadlineMs,
      signal,
      mode,
      continuation,
      localReady,
    ) {
      if (closing || signal.aborted) throw costPlanUnavailable();
      if (epoch) await finishRetiring(owner);
      if (closing || signal.aborted) throw costPlanUnavailable();
      const now = clock();
      if (
        !/^[0-9a-f]{64}$/.test(owner) ||
        !Number.isSafeInteger(weight) ||
        weight < 1 ||
        weight > 900 ||
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs <= now ||
        deadlineMs > now + 100000 ||
        !["learned", "cold_trial"].includes(mode)
      )
        throw costPlanUnavailable();
      const pinned =
        continuation === undefined ? undefined : pinnedFrames.get(continuation);
      if (
        continuation !== undefined &&
        (!pinned ||
          frames.get(owner) !== pinned.frame ||
          pinned.owner !== owner ||
          pinned.weight !== weight ||
          pinned.mode !== mode ||
          pinned.frame.id !== pinned.id ||
          pinned.frame.deadline !== pinned.deadline)
      )
        throw identityChanged();
      const expired = frames.get(owner);
      if (expired && (expired.expires ?? expired.deadline) <= now) {
        void trackRelease(expired).catch(() => {});
        throw new AgentError(
          "VENUE_READ_DEADLINE",
          "Queued account observation reached its original deadline before venue reads began.",
          true,
          503,
        );
      }
      prune();
      let frame = frames.get(owner);
      if (frame?.expires !== undefined)
        throw deferred(250, undefined, "READ_FRAME_IN_USE");
      if (frame?.polling) throw deferred(250, frame, "READ_FRAME_POLLING");
      if (frame && (frame.weight !== weight || frame.mode !== mode)) {
        if (continuation === undefined)
          void trackRelease(frame).catch(() => {});
        throw identityChanged();
      }
      if (!frame) {
        if (frames.size >= 64 || (epoch && retiring.size >= 64))
          throw deferred(1000, undefined, "READ_FRAME_QUEUE_FULL");
        frame = {
          id: randomUUID(),
          owner,
          weight,
          mode,
          // Subsequent polls retain this FIRST deadline; retries never renew it.
          deadline: deadlineMs,
          polling: false,
          ...(epoch
            ? {
                readiness: {
                  mayHaveApplied: false,
                  intent: {
                    seq: 1,
                    ready: localReady !== false,
                    acknowledged: false,
                  },
                },
              }
            : {}),
        };
        frames.set(owner, frame);
      }
      const current = frame;
      const firstId = current.id,
        firstDeadline = current.deadline;
      const unchanged = () => {
        if (
          frames.get(owner) !== current ||
          current.owner !== owner ||
          current.weight !== weight ||
          current.mode !== mode ||
          current.id !== firstId ||
          current.deadline !== firstDeadline ||
          (pinned !== undefined &&
            (current !== pinned.frame ||
              current.id !== pinned.id ||
              current.deadline !== pinned.deadline))
        )
          throw identityChanged();
      };
      unchanged();
      current.polling = true;
      current.pendingReceipt = undefined;
      const boundedSignal = AbortSignal.any([
        signal,
        stop.signal,
        AbortSignal.timeout(2000),
      ]);
      try {
        const { response, body } = await beginResponse(
          current,
          localReady !== false,
          boundedSignal,
          unchanged,
        );
        if (!response.ok) {
          const retry = body?.error?.retry_after_ms;
          if (
            response.status === 503 &&
            body?.error?.code === "local_budget" &&
            body.error.upstream_request_sent === false &&
            Number.isSafeInteger(retry) &&
            retry >= 1 &&
            retry <= 60000
          )
            throw deferred(Math.max(250, Math.min(1000, retry)), current);
          throw costPlanUnavailable();
        }
        if (
          body?.frame_id !== current.id ||
          ![
            "pending",
            "granted",
            "busy",
            "cancelled",
            "scope_cost_exceeds_capacity",
          ].includes(body?.state) ||
          !Number.isSafeInteger(body?.reserved_weight) ||
          body.reserved_weight < 0 ||
          body.reserved_weight > current.weight ||
          (current.mode === "cold_trial" && body.guaranteed_complete !== false)
        )
          throw costPlanUnavailable();
        if (body.state === "cancelled") {
          frames.delete(current.owner);
          throw new AgentError(
            "VENUE_READ_DEADLINE",
            "Queued account observation expired or was cancelled before venue reads began.",
            true,
            503,
          );
        }
        if (body.state === "scope_cost_exceeds_capacity") {
          frames.delete(current.owner);
          throw new AgentError(
            "VENUE_READ_BUDGET_EXHAUSTED",
            "Account observation scope exceeds the configured fleet capacity.",
            true,
            503,
            { retry_after_ms: 60000, reason_code: "READ_FRAME_CAPACITY" },
          );
        }
        if (body.state === "pending" || body.state === "busy") {
          if (
            !Number.isSafeInteger(body.expires_at) ||
            body.expires_at !== current.deadline ||
            body.expires_at <= clock() ||
            !Number.isSafeInteger(body.retry_after_ms) ||
            body.retry_after_ms < 1 ||
            body.retry_after_ms > 1000
          )
            throw costPlanUnavailable();
          throw deferred(Math.max(250, body.retry_after_ms), current);
        }
        if (
          body.reserved_weight !== current.weight ||
          !Number.isSafeInteger(body.expires_at) ||
          body.expires_at <= clock() ||
          body.expires_at > clock() + 20000 ||
          clock() > current.deadline
        )
          throw costPlanUnavailable();
        current.expires = body.expires_at;
        if (boundedSignal.aborted || closing) {
          await trackRelease(current);
          throw costPlanUnavailable();
        }
        return {
          frame_id: current.id,
          expires_at: body.expires_at as number,
        } satisfies AccountReadFrameLease;
      } catch (error) {
        // A verified pending receipt is operational progress and owns its FIFO
        // place. Unverified transport errors retain the SAME stable id too;
        // they cannot authorize a new reservation or upstream read.
        if (
          error instanceof AgentError &&
          ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(
            error.code,
          )
        )
          throw error;
        if (
          current.readiness?.mayHaveApplied &&
          current.expires === undefined &&
          frames.get(owner) === current
        )
          throw deferred(1000, current);
        throw costPlanUnavailable();
      } finally {
        current.polling = false;
      }
    },
    async end(frameId) {
      const frame = [...frames.values(), ...retiring.values()].find(
        (entry) => entry.id === frameId,
      );
      if (frame) await trackRelease(frame);
    },
    async cancelPending(continuation) {
      const pinned = pinnedFrames.get(continuation);
      if (
        !pinned ||
        frames.get(pinned.owner) !== pinned.frame ||
        pinned.frame.id !== pinned.id ||
        pinned.frame.deadline !== pinned.deadline
      )
        throw identityChanged();
      // A waiter never owns a peer's already granted lease.
      if (pinned.frame.expires !== undefined) throw identityChanged();
      await trackRelease(pinned.frame);
    },
    async close() {
      closing = true;
      stop.abort(costPlanUnavailable());
      await Promise.allSettled([...frames.values()].map(trackRelease));
      await Promise.allSettled([...retiring.values()].map(trackRelease));
      while (releasing.size) await Promise.allSettled([...releasing]);
    },
  };
}
