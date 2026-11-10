import { AgentError } from "./contracts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readCost, responseCost } from "./venue-read-cost.js";
import { framePendingContinuation } from "./core-frame-coordinator.js";
import type { PreparedSourceRetryLimits } from "./source-feed.js";
import {
  costPlanUnavailable,
  type ObservationPlanLease,
  type ObservationPlanStore,
} from "./account-observation-plans.js";
import {
  CoordinatedReadError,
  coordinatedEvidence,
  type VenueReadFetcher,
} from "./venue-read-transport.js";
import {
  sharedVenueReadBudget,
  isObservationAdmissionDeferred,
  readTimers,
  type BudgetTimers,
  type ReadLane,
  type ReadTicket,
  type AccountReadReservation,
  type AccountReadBundle,
  type PreparedSupplementPlan,
  VenueReadBudget,
} from "./venue-read-budget.js";

type Entry = { at: number; until: number; evidenceAt: number; value: unknown };
type ObservationFleetPlan = Readonly<{
  fullDemand: number;
  reservedWeight: number;
  cold: boolean;
  childLimit: number;
  childCount: 1 | 2;
  historySources: readonly string[];
  supplements?: PreparedSupplementPlan;
}>;
type PendingPreparedBooking = {
  readonly owner: string;
  readonly frameOwner: string;
  readonly purpose: "audit_submit" | "audit_source";
  readonly firstDeadline: number;
  readonly booked: ObservationFleetPlan;
  latest: ObservationFleetPlan;
};
const unsupportedPreparedBundles = new WeakSet<AgentError>();
export const isPreparedBundleUnsupported = (error: unknown): boolean =>
  error instanceof AgentError && unsupportedPreparedBundles.has(error);
export type VenueReadEvidence = {
  value: any;
  // The original dispatch time after admission, never the completion/cache-hit
  // time. A joined request carries the first caller's actual wire evidence.
  observed_at: number;
};
type AccountReadScope = {
  id: number;
  until: number;
  admission: AbortController;
  owner?: string;
  reservation?: AccountReadReservation;
  reservationPromise?: Promise<AccountReadReservation>;
  admissionError?: unknown;
  observedAt?: number;
  planLease?: ObservationPlanLease;
  planBound?: boolean;
  planDisabled?: boolean;
  durableAttempted?: boolean;
  monotonicUntil: number;
  planAttempt?: object;
  frameLease?: AccountReadFrameLease;
  localInterest?: object;
  releasedFrames?: Set<string>;
  queueUntil: number;
  waitForFrameAdmission: boolean;
  activateEvidenceDeadline?(): void;
  frameOwner?: string;
  preparingBundle?: boolean;
  preparedParent?: AccountReadScope;
  preparedIdentityVerified?: boolean;
  preparedHint?: Awaited<ReturnType<ObservationPlanStore["read"]>>;
  preparedClaim?: Promise<void>;
  preparedHistoryGuard?: (payload: unknown) => void;
};
export interface PreparedReadWindowOptions {
  purpose?: "audit_submit" | "audit_source";
  historySources?: readonly string[];
}
export interface PreparedAccountWindow {
  readonly mode: "cold" | "warm";
  readonly purpose: "audit_submit" | "audit_source";
  readonly expires_at: number;
  read<T>(
    work: () => Promise<T>,
    limits?: AccountObservationLimits,
  ): Promise<T>;
  supplement<T>(
    work: () => Promise<T>,
    limits?: AccountObservationLimits,
  ): Promise<T>;
  readSource<T>(
    work: (limits: PreparedSourceRetryLimits) => Promise<T>,
    limits?: AccountObservationLimits,
  ): Promise<T>;
  sourceRetryLimits(): PreparedSourceRetryLimits;
  history<T>(
    source: string,
    work: () => Promise<T>,
    guard: (payload: unknown) => void,
    limits?: AccountObservationLimits,
  ): Promise<T>;
  close(): Promise<void>;
  assertNextChildReady(): void;
}
export type AccountReadFrameLease = {
  frame_id: string;
  expires_at: number;
};
/** Trusted caller lifetime, separate from the fleet's pending booking lifetime. */
export type AccountObservationLimits = {
  signal?: AbortSignal;
  deadlineMs?: number;
  /** Internal NEW execution preflight only; never accepted from request JSON. */
  waitForFrameAdmission?: true;
};
/** Authenticated fleet admission; it must use the existing shared ledger. */
export interface AccountReadFrameCoordinator {
  readonly capacity: number;
  begin(
    owner: string,
    weight: number,
    deadlineMs: number,
    signal: AbortSignal,
    mode: "learned" | "cold_trial",
    continuation?: object,
  ): Promise<AccountReadFrameLease>;
  end(frameId: string): Promise<void>;
  close?(): Promise<void>;
  cancelPending?(continuation: object): Promise<void>;
}
type Counters = {
  calls: number;
  cache_hit: number;
  flight_join: number;
  actual_fetch: number;
  http_429: number;
  http_failure: number;
  transport_failure: number;
  local_budget_denied: number;
  local_deadline_denied: number;
  local_cooldown_denied: number;
  coordinated_denied: number;
  coordinated_no_upstream: number;
  coordinated_rate_limited: number;
  unsupported_method: number;
  invalid_response: number;
  reserved_weight: number;
  charged_weight: number;
  unknown_fetch: number;
  unknown_uncertain: number;
  unknown_overrun: number;
  unknown_debt_weight: number;
};
type RateLimitResponse = {
  purpose_method: string;
  content_kind: "json" | "html" | "text" | "other" | "missing";
  retry_after_kind: "seconds" | "date" | "invalid" | "missing";
  retry_after_ms: number;
  server_family:
    "cloudflare" | "cloudfront" | "nginx" | "envoy" | "other" | "missing";
  cloudfront_header: boolean;
  cloudflare_header: boolean;
  count: number;
};
const counters = (): Counters => ({
  calls: 0,
  cache_hit: 0,
  flight_join: 0,
  actual_fetch: 0,
  http_429: 0,
  http_failure: 0,
  transport_failure: 0,
  local_budget_denied: 0,
  local_deadline_denied: 0,
  local_cooldown_denied: 0,
  coordinated_denied: 0,
  coordinated_no_upstream: 0,
  coordinated_rate_limited: 0,
  unsupported_method: 0,
  invalid_response: 0,
  reserved_weight: 0,
  charged_weight: 0,
  unknown_fetch: 0,
  unknown_uncertain: 0,
  unknown_overrun: 0,
  unknown_debt_weight: 0,
});
const costPlanCounters = () => ({
  loaded_valid: 0,
  loaded_cold: 0,
  load_failed: 0,
  claimed: 0,
  restored_admitted: 0,
  claim_failed: 0,
  persisted: 0,
  persist_failed: 0,
  invalidated: 0,
});
export interface VenueReadOptions {
  transport?: "official" | "core_shared_info";
  budget?: VenueReadBudget;
  timers?: BudgetTimers;
  deadlineMs?: number;
  signal?: AbortSignal;
  report?: (record: Record<string, unknown>) => void;
  observationPlans?: ObservationPlanStore;
  requireObservationPlanBinding?: boolean;
  monotonicClock?: () => number;
  frameCoordinator?: AccountReadFrameCoordinator;
}

// Completed account evidence is never reused. Metadata TTL and same-lane
// single-flight are unchanged. Both HL hosts share one process weighted gate.
export class VenueReads {
  private readonly preparedWindows = new Set<PreparedAccountWindow>();
  private readonly preparedOwners = new Set<string>();
  private readonly preparingFrameOwners = new Set<string>();
  private readonly pendingPreparedBookings = new WeakMap<
    object,
    PendingPreparedBooking
  >();
  private flights = new Map<string, Promise<VenueReadEvidence>>();
  private cache = new Map<string, Entry>();
  private readonly budget: VenueReadBudget;
  private readonly timers: BudgetTimers;
  private readonly deadlineMs: number;
  private readonly transport: "official" | "core_shared_info";
  private readonly callerSignal?: AbortSignal;
  private readonly report: NonNullable<VenueReadOptions["report"]>;
  private readonly observationPlans?: ObservationPlanStore;
  private readonly requireObservationPlanBinding: boolean;
  private readonly monotonicClock: () => number;
  private readonly frameCoordinator?: AccountReadFrameCoordinator;
  private frames = {
    admitted: 0,
    denied: 0,
    capacity_trials: 0,
    released: 0,
    release_failed: 0,
  };
  private counts = counters();
  private costPlans = costPlanCounters();
  private accountObservations = new Set<Promise<unknown>>();
  private activeAccountScopes = new Set<AccountReadScope>();
  private accountFinalizers = new Set<Promise<void>>();
  private draining = false;
  private byMethod = new Map<string, Counters>();
  private rateLimitResponses = new Map<string, RateLimitResponse>();
  private lastReport: number;
  private readonly accountScope = new AsyncLocalStorage<AccountReadScope>();
  private accountSequence = 0;
  constructor(
    private readonly fetcher: VenueReadFetcher = (url, init) =>
      fetch(url, init),
    private readonly clock = Date.now,
    concurrency = 2,
    options: VenueReadOptions = {},
  ) {
    if (!Number.isFinite(concurrency) || concurrency < 1)
      throw new RangeError("Venue concurrency must be positive");
    this.budget = options.budget ?? sharedVenueReadBudget;
    this.timers = options.timers ?? readTimers;
    this.deadlineMs = options.deadlineMs ?? 12000;
    this.transport = options.transport ?? "official";
    this.callerSignal = options.signal;
    this.observationPlans = options.observationPlans;
    this.requireObservationPlanBinding =
      options.requireObservationPlanBinding ?? false;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.frameCoordinator = options.frameCoordinator;
    if (
      this.frameCoordinator &&
      (!Number.isSafeInteger(this.frameCoordinator.capacity) ||
        this.frameCoordinator.capacity < 120 ||
        this.frameCoordinator.capacity > 1200)
    )
      throw new RangeError("Fleet observation capacity must be bounded");
    if (this.frameCoordinator && this.transport !== "core_shared_info")
      throw new RangeError(
        "Fleet observation admission requires authenticated Core reads",
      );
    if (
      !Number.isSafeInteger(this.deadlineMs) ||
      this.deadlineMs < 1 ||
      this.deadlineMs > 12000
    )
      throw new RangeError("Venue read deadline cannot exceed 12 seconds");
    this.report =
      options.report ?? ((record) => console.info(JSON.stringify(record)));
    this.lastReport = this.clock();
  }
  private count(
    method: string,
    lane: ReadLane,
    key: keyof Counters,
    value = 1,
  ) {
    this.counts[key] += value;
    const label = `${lane}:${method}`;
    let row = this.byMethod.get(label);
    if (!row) this.byMethod.set(label, (row = counters()));
    row[key] += value;
  }
  diagnostics() {
    return {
      event: "venue_read_budget",
      scope: "shared_VenueReads_instances_and_HL_hosts_only",
      transport: this.transport,
      interval_ms: Math.max(0, this.clock() - this.lastReport),
      budget: this.budget.snapshot(),
      counts: { ...this.counts },
      cost_plans: { ...this.costPlans },
      frames: { ...this.frames },
      methods: [...this.byMethod].map(([purpose_method, values]) => ({
        purpose_method,
        ...values,
      })),
      // Fixed classifications and numeric counters only. Never log response
      // bodies, raw headers, edge IDs, request payloads or account identities.
      rate_limit_responses: [...this.rateLimitResponses.values()].map(
        (row) => ({
          ...row,
        }),
      ),
    };
  }
  private maybeReport() {
    if (this.clock() - this.lastReport < 60000) return;
    try {
      this.report(this.diagnostics());
    } catch {
      /* Telemetry cannot alter reads. */
    }
    this.counts = counters();
    this.costPlans = costPlanCounters();
    this.byMethod.clear();
    this.rateLimitResponses.clear();
    this.lastReport = this.clock();
  }
  private unavailable() {
    return new AgentError(
      "VENUE_RATE_LIMITED",
      "Venue reads are cooling down after a rate limit. Existing settings are preserved; execution needs fresh account evidence.",
      true,
      503,
      {
        retry_after_ms: Math.min(
          60000,
          Math.max(1, this.budget.cooldownRemaining()),
        ),
      },
    );
  }
  private checkCooldown(method: string, lane: ReadLane, countDenial = true) {
    if (this.budget.cooldownRemaining() > 0) {
      if (countDenial) this.count(method, lane, "local_cooldown_denied");
      throw this.unavailable();
    }
  }
  async cancelPreparedPending(continuation: object): Promise<void> {
    if (!this.frameCoordinator?.cancelPending) throw costPlanUnavailable();
    const booking = this.pendingPreparedBookings.get(continuation);
    await this.frameCoordinator.cancelPending(continuation);
    if (this.pendingPreparedBookings.get(continuation) === booking)
      this.pendingPreparedBookings.delete(continuation);
  }
  private pendingPlanFits(
    current: ObservationFleetPlan,
    prior: ObservationFleetPlan,
  ): boolean {
    if (
      current.cold !== prior.cold ||
      current.childCount !== prior.childCount ||
      current.historySources.length !== prior.historySources.length ||
      current.historySources.some(
        (source, i) => source !== prior.historySources[i],
      ) ||
      current.supplements?.key !== prior.supplements?.key ||
      !!current.supplements !== !!prior.supplements
    )
      return false;
    const weights = (plan: ObservationFleetPlan) => [
      plan.fullDemand,
      plan.childLimit,
      plan.supplements?.sourceWeight ?? 0,
      ...plan.historySources.map(
        (source) => plan.supplements?.historyWeights[source] ?? 120,
      ),
    ];
    const before = weights(prior);
    // Cold trials keep their exact existing identity. Only a valid learned
    // demand may shrink, independently in each already-bound resource pool.
    return weights(current).every((weight, i) =>
      current.cold ? weight === before[i] : weight <= before[i],
    );
  }
  async prepareAccountWindow(
    owner: string,
    frameOwner: string,
    firstDeadline: number,
    continuation?: object,
    callerSignal?: AbortSignal,
    options: PreparedReadWindowOptions = {},
  ): Promise<PreparedAccountWindow> {
    if (
      !this.frameCoordinator ||
      this.draining ||
      this.preparedWindows.size >= 64 ||
      this.preparingFrameOwners.has(frameOwner) ||
      this.accountScope.getStore() ||
      !/^[0-9a-f]{64}$/.test(owner) ||
      !/^[0-9a-f]{64}$/.test(frameOwner) ||
      firstDeadline <= this.clock() ||
      firstDeadline > this.clock() + 100000 ||
      (options.purpose !== undefined &&
        !["audit_submit", "audit_source"].includes(options.purpose)) ||
      ((options.historySources?.length ?? 0) > 0 &&
        options.purpose !== "audit_source")
    )
      throw costPlanUnavailable();
    this.preparingFrameOwners.add(frameOwner);
    const scope: AccountReadScope = {
      id: ++this.accountSequence,
      owner,
      frameOwner,
      planBound: true,
      until: this.clock() + 20000,
      monotonicUntil: this.monotonicClock() + 20000,
      admission: new AbortController(),
      queueUntil: firstDeadline,
      waitForFrameAdmission: false,
      preparingBundle: true,
    };
    let timer = this.timers.setTimeout(
      () => scope.admission.abort(this.accountDeadline()),
      20000,
    );
    scope.activateEvidenceDeadline = () => {
      // Queue metadata was not evidence work. The FIRST real grant starts the
      // existing20s lease; every subsequent child only consumes this remainder.
      scope.until = scope.frameLease!.expires_at;
      scope.monotonicUntil =
        this.monotonicClock() + Math.max(0, scope.until - this.clock());
      this.timers.clearTimeout(timer);
      timer = this.timers.setTimeout(
        () => scope.admission.abort(this.accountDeadline()),
        Math.max(0, scope.until - this.clock()),
      );
    };
    const cancelled = () => scope.admission.abort(callerSignal!.reason);
    callerSignal?.addEventListener("abort", cancelled, { once: true });
    if (callerSignal?.aborted) cancelled();
    let parent: AccountReadBundle;
    try {
      parent = (await this.accountScope.run(scope, () =>
        this.reserveObservation(scope, { continuation, ...options }),
      )) as AccountReadBundle;
      if (scope.admission.signal.aborted) throw scope.admission.signal.reason;
    } catch (error) {
      this.preparingFrameOwners.delete(frameOwner);
      this.timers.clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancelled);
      scope.reservation?.close(false);
      if (scope.localInterest)
        this.budget.endObservationInterest(scope.localInterest);
      this.releaseFrame(scope);
      throw error;
    }
    this.preparingFrameOwners.delete(frameOwner);
    callerSignal?.removeEventListener("abort", cancelled);
    this.preparedOwners.add(owner);
    let closed = false,
      reading = false,
      reads = 0,
      failed = false;
    let supplementTail = Promise.resolve(),
      supplementQueued = 0,
      supplementReading = false;
    const runSupplement = async <T>(
      work: () => Promise<T>,
      limits: AccountObservationLimits,
      monotonicUntil: number,
      history?: { source: string; guard: (payload: unknown) => void },
    ) => {
      if (closed || reading || reads < 1 || scope.admission.signal.aborted)
        throw costPlanUnavailable();
      const ticket = history
        ? parent.beginHistorySupplement(history.source)
        : parent.beginSupplement();
      reading = true;
      const sourceScope: AccountReadScope = {
        ...scope,
        id: ++this.accountSequence,
        reservation: ticket,
        preparingBundle: false,
        preparedParent: scope,
        preparedIdentityVerified: true,
        planLease: undefined,
        durableAttempted: false,
        preparedHint: undefined,
        preparedClaim: undefined,
        preparedHistoryGuard: history?.guard,
        admission: new AbortController(),
      };
      sourceScope.until = Math.min(scope.until, limits.deadlineMs ?? Infinity);
      sourceScope.monotonicUntil = Math.min(
        scope.monotonicUntil,
        monotonicUntil,
      );
      const stop = () =>
        sourceScope.admission.abort(scope.admission.signal.reason);
      scope.admission.signal.addEventListener("abort", stop, { once: true });
      const callerStop = () =>
        sourceScope.admission.abort(limits.signal!.reason);
      limits.signal?.addEventListener("abort", callerStop, { once: true });
      if (limits.signal?.aborted) callerStop();
      let complete = false;
      try {
        const value = await this.accountScope.run(sourceScope, async () => {
          this.accountReadTimeout();
          const value = await this.abortable(
            work(),
            sourceScope.admission.signal,
          );
          this.accountReadTimeout();
          return value;
        });
        ticket.close(true);
        complete = true;
        return value;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        ticket.close(complete);
        scope.admission.signal.removeEventListener("abort", stop);
        limits.signal?.removeEventListener("abort", callerStop);
        reading = false;
      }
    };
    const supplement = async <T>(
      work: () => Promise<T>,
      limits: AccountObservationLimits = {},
      history?: { source: string; guard: (payload: unknown) => void },
    ): Promise<T> => {
      // Source collection has two workers. Serialize only these supplemental
      // children, not account observations, inside this same original lease.
      // Each child still spends only the proved unused first-child capacity.
      if (
        closed ||
        failed ||
        reads < 1 ||
        (reading && !supplementReading) ||
        scope.admission.signal.aborted ||
        supplementQueued >= 64
      )
        throw costPlanUnavailable();
      if (
        limits.deadlineMs !== undefined &&
        !Number.isSafeInteger(limits.deadlineMs)
      )
        throw this.accountDeadline();
      const until = Math.min(scope.until, limits.deadlineMs ?? Infinity),
        monotonicUntil = Math.min(
          scope.monotonicUntil,
          this.monotonicClock() + Math.max(0, until - this.clock()),
        ),
        admission = new AbortController(),
        stop = () => admission.abort(scope.admission.signal.reason),
        callerStop = () => admission.abort(limits.signal!.reason);
      scope.admission.signal.addEventListener("abort", stop, { once: true });
      limits.signal?.addEventListener("abort", callerStop, { once: true });
      if (limits.signal?.aborted) callerStop();
      if (scope.admission.signal.aborted) stop();
      const timer = this.timers.setTimeout(
        () => admission.abort(this.accountDeadline()),
        Math.max(
          0,
          Math.min(
            until - this.clock(),
            monotonicUntil - this.monotonicClock(),
          ),
        ),
      );
      const earlier = supplementTail;
      let release!: () => void;
      const settled = new Promise<void>((resolve) => (release = resolve));
      // An aborted queued caller may finish early, but cannot release a later
      // caller past a still-running earlier child.
      supplementTail = earlier.then(() => settled);
      supplementQueued++;
      let active = false;
      try {
        await this.abortable(earlier, admission.signal);
        if (admission.signal.aborted) throw admission.signal.reason;
        if (
          closed ||
          failed ||
          reads < 1 ||
          reading ||
          this.clock() >= until ||
          this.monotonicClock() >= monotonicUntil
        )
          throw costPlanUnavailable();
        active = true;
        supplementReading = true;
        const value = await runSupplement(
          work,
          { ...limits, signal: admission.signal, deadlineMs: until },
          monotonicUntil,
          history,
        );
        if (admission.signal.aborted) throw admission.signal.reason;
        return value;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (active) supplementReading = false;
        supplementQueued--;
        release();
        this.timers.clearTimeout(timer);
        scope.admission.signal.removeEventListener("abort", stop);
        limits.signal?.removeEventListener("abort", callerStop);
      }
    };
    const window: PreparedAccountWindow = {
      mode: parent.capacityTrial ? "cold" : "warm",
      purpose: options.purpose ?? "audit_submit",
      expires_at: scope.until,
      supplement,
      history: async <T>(
        source: string,
        work: () => Promise<T>,
        guard: (payload: unknown) => void,
        limits: AccountObservationLimits = {},
      ) => {
        if (
          options.purpose !== "audit_source" ||
          !options.historySources?.includes(source) ||
          typeof guard !== "function"
        )
          throw costPlanUnavailable();
        return supplement(work, limits, { source, guard });
      },
      sourceRetryLimits: () => {
        if (closed || failed || reads < 1 || scope.admission.signal.aborted)
          throw costPlanUnavailable();
        return this.sourceRetryWindow(scope.admission.signal, () =>
          Math.min(
            scope.until - this.clock(),
            scope.monotonicUntil - this.monotonicClock(),
          ),
        );
      },
      readSource: async <T>(
        work: (limits: PreparedSourceRetryLimits) => Promise<T>,
        limits: AccountObservationLimits = {},
      ): Promise<T> => {
        if (
          closed ||
          failed ||
          reads < 1 ||
          (reading && !supplementReading) ||
          scope.admission.signal.aborted
        )
          throw costPlanUnavailable();
        if (
          limits.deadlineMs !== undefined &&
          !Number.isSafeInteger(limits.deadlineMs)
        )
          throw this.accountDeadline();
        const until = Math.min(scope.until, limits.deadlineMs ?? Infinity),
          monotonicUntil = Math.min(
            scope.monotonicUntil,
            this.monotonicClock() + Math.max(0, until - this.clock()),
          ),
          admission = new AbortController(),
          stop = () => admission.abort(scope.admission.signal.reason),
          callerStop = () => admission.abort(limits.signal!.reason),
          remainingMs = () =>
            Math.min(
              until - this.clock(),
              monotonicUntil - this.monotonicClock(),
            );
        scope.admission.signal.addEventListener("abort", stop, { once: true });
        limits.signal?.addEventListener("abort", callerStop, { once: true });
        if (scope.admission.signal.aborted) stop();
        if (limits.signal?.aborted) callerStop();
        const timer = this.timers.setTimeout(
          () => admission.abort(this.accountDeadline()),
          Math.max(0, remainingMs()),
        );
        try {
          if (admission.signal.aborted) throw admission.signal.reason;
          if (remainingMs() <= 0) throw this.accountDeadline();
          const value = await this.abortable(
            work(this.sourceRetryWindow(admission.signal, remainingMs)),
            admission.signal,
          );
          if (admission.signal.aborted) throw admission.signal.reason;
          if (remainingMs() <= 0) throw this.accountDeadline();
          return value;
        } finally {
          this.timers.clearTimeout(timer);
          scope.admission.signal.removeEventListener("abort", stop);
          limits.signal?.removeEventListener("abort", callerStop);
        }
      },
      assertNextChildReady: () => {
        if (
          closed ||
          failed ||
          reading ||
          supplementQueued > 0 ||
          reads !== 1 ||
          parent.childCount !== 2 ||
          scope.admission.signal.aborted ||
          scope.until <= this.clock() ||
          scope.monotonicUntil <= this.monotonicClock()
        )
          throw costPlanUnavailable();
        const hint = this.budget.peekObservationFramePlan(
          owner,
          parent.childLimit,
        );
        if (hint.cold || hint.fullDemand > parent.childLimit)
          throw costPlanUnavailable();
        parent.assertNextChildReady();
      },
      read: async <T>(
        work: () => Promise<T>,
        limits: AccountObservationLimits = {},
      ) => {
        if (
          closed ||
          failed ||
          reading ||
          supplementQueued > 0 ||
          scope.admission.signal.aborted ||
          reads >= parent.childCount
        )
          throw costPlanUnavailable();
        reading = true;
        try {
          const value = await this.observeAccount(
            async () => {
              const child = this.accountScope.getStore()!;
              child.preparedParent = scope;
              child.owner = owner;
              child.planBound = true;
              child.frameOwner = frameOwner;
              child.frameLease = scope.frameLease;
              child.until = Math.min(child.until, scope.until);
              child.monotonicUntil = Math.min(
                child.monotonicUntil,
                scope.monotonicUntil,
              );
              child.planAttempt =
                this.budget.beginObservationPlanAttempt(owner);
              if (!this.observationPlans) throw costPlanUnavailable();
              const before = this.monotonicClock();
              const hint = await this.observationPlans.read(
                owner,
                child.admission.signal,
              );
              this.accountReadTimeout();
              if (
                (hint.plan && hint.plan.demand > parent.childLimit) ||
                (window.mode === "warm" &&
                  (!hint.plan ||
                    hint.remainingTtlMs - (this.monotonicClock() - before) <=
                      0))
              )
                throw costPlanUnavailable();
              child.preparedHint = hint;
              child.reservation = parent.beginChild();
              reads++;
              return work();
            },
            owner,
            {
              signal: limits.signal
                ? AbortSignal.any([limits.signal, scope.admission.signal])
                : scope.admission.signal,
              deadlineMs: Math.min(limits.deadlineMs ?? Infinity, scope.until),
            },
          );
          return value;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          reading = false;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        this.preparedWindows.delete(window);
        this.preparedOwners.delete(owner);
        this.timers.clearTimeout(timer);
        scope.admission.signal.removeEventListener("abort", expired);
        scope.admission.abort(costPlanUnavailable());
        parent.close(
          reads > 0 && !failed && !reading && supplementQueued === 0,
        );
        if (scope.localInterest)
          this.budget.endObservationInterest(scope.localInterest);
        this.releaseFrame(scope);
      },
    };
    const expired = () => {
      void window.close().catch(() => {});
    };
    scope.admission.signal.addEventListener("abort", expired, { once: true });
    this.preparedWindows.add(window);
    return window;
  }
  async observeAccount<T>(
    work: () => Promise<T>,
    owner?: string,
    limits: AccountObservationLimits = {},
  ): Promise<T> {
    if (this.accountScope.getStore()) return work();
    if (this.draining) throw costPlanUnavailable();
    if (
      limits.deadlineMs !== undefined &&
      !Number.isSafeInteger(limits.deadlineMs)
    )
      throw this.accountDeadline();
    const remaining = Math.min(
      20000,
      (limits.deadlineMs ?? Infinity) - this.clock(),
    );
    if (remaining <= 0) throw this.accountDeadline();
    const scope: AccountReadScope = {
      id: ++this.accountSequence,
      until: this.clock() + remaining,
      admission: new AbortController(),
      owner,
      monotonicUntil: this.monotonicClock() + remaining,
      queueUntil: this.clock() + 100000,
      waitForFrameAdmission: limits.waitForFrameAdmission === true,
    };
    let timer = this.timers.setTimeout(
      () => scope.admission.abort(this.accountDeadline()),
      remaining,
    );
    const callerCancelled = () => scope.admission.abort(limits.signal!.reason);
    limits.signal?.addEventListener("abort", callerCancelled, { once: true });
    if (limits.signal?.aborted) callerCancelled();
    this.activeAccountScopes.add(scope);
    scope.activateEvidenceDeadline = () => {
      if (scope.admission.signal.aborted) throw scope.admission.signal.reason;
      this.timers.clearTimeout(timer);
      scope.until = Math.min(scope.until, scope.frameLease!.expires_at);
      const remaining = Math.max(
        0,
        Math.min(
          scope.until - this.clock(),
          scope.monotonicUntil - this.monotonicClock(),
        ),
      );
      scope.monotonicUntil = Math.min(
        scope.monotonicUntil,
        this.monotonicClock() + remaining,
      );
      if (remaining <= 0) throw this.accountDeadline();
      timer = this.timers.setTimeout(
        () => scope.admission.abort(this.accountDeadline()),
        remaining,
      );
    };
    const observing = this.accountScope.run(scope, async () => {
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(scope.admission.signal.reason);
        scope.admission.signal.addEventListener("abort", abort, { once: true });
      });
      let complete = false;
      let finalizing = false;
      const cleanup = () => {
        this.timers.clearTimeout(timer);
        scope.admission.signal.removeEventListener("abort", abort);
        limits.signal?.removeEventListener("abort", callerCancelled);
      };
      try {
        if (scope.admission.signal.aborted) throw scope.admission.signal.reason;
        const value = await Promise.race([work(), cancelled]);
        this.accountReadTimeout();
        // All successful work has returned before cost publication. A failed,
        // still-pending, unknown or otherwise invalid scope yields no plan.
        scope.reservation?.close(true);
        complete = true;
        const plan = scope.reservation?.costPlan();
        if (plan && scope.planLease && this.observationPlans) {
          const signal = this.callerSignal
            ? AbortSignal.any([scope.admission.signal, this.callerSignal])
            : scope.admission.signal;
          // Financial work is already complete and remains dated at dispatch.
          // Only the operational CAS runs in this tracked finalizer, under the
          // SAME original timer. Dirty state remains until its real commit.
          finalizing = true;
          const finalizer = (async () => {
            try {
              if (
                signal.aborted ||
                !(await this.observationPlans!.complete(
                  scope.planLease!,
                  plan,
                  signal,
                ))
              )
                throw costPlanUnavailable();
              this.accountReadTimeout();
              this.costPlans.persisted++;
            } catch {
              this.costPlans.persist_failed++;
              this.invalidateCostPlan(scope);
              if (scope.preparedParent) throw costPlanUnavailable();
            } finally {
              cleanup();
            }
          })();
          this.accountFinalizers.add(finalizer);
          void finalizer.then(
            () => this.accountFinalizers.delete(finalizer),
            () => this.accountFinalizers.delete(finalizer),
          );
          // Before a new financial ID exists, a bundle audit must have really
          // published its original single-scope generation, not merely queued CAS.
          if (scope.preparedParent) await finalizer;
        } else if (scope.durableAttempted) this.invalidateCostPlan(scope);
        return value;
      } catch (error) {
        if (scope.durableAttempted) this.invalidateCostPlan(scope);
        scope.admission.abort(error);
        throw error;
      } finally {
        if (!finalizing) cleanup();
        scope.reservation?.close(complete);
        if (scope.localInterest)
          this.budget.endObservationInterest(scope.localInterest);
        this.releaseFrame(scope);
      }
    });
    this.accountObservations.add(observing);
    try {
      return await observing;
    } finally {
      this.accountObservations.delete(observing);
      this.activeAccountScopes.delete(scope);
    }
  }
  async drainAccounts(): Promise<void> {
    this.draining = true;
    await Promise.allSettled(
      [...this.preparedWindows].map((window) => window.close()),
    );
    for (const scope of this.activeAccountScopes)
      // Cancel only fleet admissions still waiting for their local ticket.
      // Already admitted reads retain the original graceful completion and
      // durable cost-plan publication before the database pool is closed.
      if (this.frameCoordinator && !scope.reservation)
        scope.admission.abort(costPlanUnavailable());
    await this.frameCoordinator?.close?.();
    await Promise.allSettled([...this.accountObservations]);
    // A cancelled admission may resolve late and add its release finalizer.
    // Drain that release too, rather than snapshotting the set only once.
    while (this.accountFinalizers.size)
      await Promise.allSettled([...this.accountFinalizers]);
  }
  private releaseFrame(scope: AccountReadScope): void {
    if (scope.preparedParent || !scope.frameLease || !this.frameCoordinator)
      return;
    const frameId = scope.frameLease.frame_id;
    scope.releasedFrames ??= new Set();
    if (scope.releasedFrames.has(frameId)) return;
    scope.releasedFrames.add(frameId);
    scope.frameLease = undefined;
    // end releases only the unused Core booking. Sent or uncertain requests
    // remain charged in Core's shared rolling ledger, independent of this call.
    const releasing = Promise.resolve()
      .then(() => this.frameCoordinator!.end(frameId))
      .then(
        () => {
          this.frames.released++;
        },
        () => {
          this.frames.release_failed++;
        },
      );
    this.accountFinalizers.add(releasing);
    void releasing.finally(() => this.accountFinalizers.delete(releasing));
  }
  private async reserveFrame(
    scope: AccountReadScope,
    reservation: { weight: number; mode: "learned" | "cold_trial" },
    signal: AbortSignal,
    firstContinuation?: object,
  ): Promise<void> {
    if (!this.frameCoordinator) return;
    if (reservation.mode === "cold_trial") this.frames.capacity_trials++;
    let continuation: object | undefined = firstContinuation;
    for (;;) {
      this.accountReadTimeout();
      if (signal.aborted) throw signal.reason;
      if (scope.waitForFrameAdmission && this.budget.cooldownRemaining() > 0)
        throw this.unavailable();
      try {
        await this.pollFrame(scope, reservation, signal, continuation);
        return;
      } catch (error) {
        const next =
          scope.waitForFrameAdmission && !scope.frameLease
            ? framePendingContinuation(error)
            : undefined;
        if (!next || !(error instanceof AgentError)) throw error;
        if (continuation !== undefined && next !== continuation)
          throw costPlanUnavailable();
        continuation = next;
        const retry = error.details?.retry_after_ms;
        const remaining = Math.min(
          scope.until - this.clock(),
          scope.monotonicUntil - this.monotonicClock(),
        );
        if (
          !Number.isSafeInteger(retry) ||
          retry! < 1 ||
          retry! > 1000 ||
          retry! >= remaining
        )
          throw error;
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            this.timers.clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            reject(signal.reason);
          };
          const timer = this.timers.setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, retry!);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      }
    }
  }
  private async pollFrame(
    scope: AccountReadScope,
    reservation: { weight: number; mode: "learned" | "cold_trial" },
    signal: AbortSignal,
    continuation?: object,
  ): Promise<void> {
    if (!this.frameCoordinator) return;
    const coordinator = this.frameCoordinator;
    // The cold local plan is a full-process-window placeholder (1000), not a
    // proven provider cost. An explicit capacity trial books only its verified
    // reservation without rewriting that hint or promising completeness.
    // If actual scope exceeds the booking, Core must reject the continuation;
    // no partial account evidence or reduced history can become a success.
    const weight = reservation.weight;
    const pending = coordinator
      .begin(
        scope.frameOwner ?? scope.owner!,
        weight,
        scope.queueUntil,
        signal,
        reservation.mode,
        continuation,
      )
      .then((lease) => {
        if (
          !lease ||
          typeof lease.frame_id !== "string" ||
          !/^[A-Za-z0-9_-]{16,128}$/.test(lease.frame_id)
        )
          throw costPlanUnavailable();
        scope.frameLease = lease;
        if (
          !Number.isSafeInteger(lease.expires_at) ||
          lease.expires_at > this.clock() + 20000 ||
          this.clock() > scope.queueUntil
        ) {
          this.releaseFrame(scope);
          throw costPlanUnavailable();
        }
        if (signal.aborted || lease.expires_at <= this.clock()) {
          this.releaseFrame(scope);
          throw signal.aborted ? signal.reason : this.accountDeadline();
        }
        scope.activateEvidenceDeadline!();
        this.frames.admitted++;
      });
    this.accountFinalizers.add(pending);
    void pending.then(
      () => this.accountFinalizers.delete(pending),
      () => this.accountFinalizers.delete(pending),
    );
    try {
      await this.abortable(pending, signal);
      this.accountReadTimeout();
    } catch (error) {
      this.frames.denied++;
      throw error;
    }
  }
  private invalidateCostPlan(scope: AccountReadScope): void {
    if (
      scope.owner &&
      this.budget.invalidateObservationPlan(scope.owner, scope.planAttempt)
    )
      this.costPlans.invalidated++;
  }
  accountObservedAt(): number {
    return this.accountScope.getStore()?.observedAt ?? this.clock();
  }
  private async claimPreparedChild(scope: AccountReadScope): Promise<void> {
    if (!scope.preparedParent || scope.preparedHint === undefined) return;
    if (!scope.preparedIdentityVerified || !this.observationPlans)
      throw costPlanUnavailable();
    scope.preparedClaim ??= (async () => {
      scope.durableAttempted = true;
      const signal = this.callerSignal
        ? AbortSignal.any([scope.admission.signal, this.callerSignal])
        : scope.admission.signal;
      try {
        scope.planLease = await this.observationPlans!.begin(
          scope.owner!,
          signal,
          scope.preparedHint,
          Math.min(
            this.accountReadTimeout(),
            Math.floor(scope.monotonicUntil - this.monotonicClock()),
          ),
        );
        this.accountReadTimeout();
        this.costPlans.claimed++;
      } catch {
        this.costPlans.claim_failed++;
        this.invalidateCostPlan(scope);
        throw costPlanUnavailable();
      }
    })();
    await scope.preparedClaim;
  }
  bindAccountCostPlan(owner: string): void {
    const scope = this.accountScope.getStore();
    if (scope?.preparedParent) {
      if (owner !== scope.owner || scope.preparedParent.owner !== owner)
        throw costPlanUnavailable();
      scope.preparedIdentityVerified = true;
      return;
    }
    if (
      !scope ||
      scope.reservationPromise ||
      scope.reservation ||
      scope.planLease ||
      scope.planBound ||
      !/^[0-9a-f]{64}$/.test(owner)
    )
      throw costPlanUnavailable();
    scope.owner = owner;
    scope.planBound = true;
  }
  disableAccountCostPlan(): void {
    const scope = this.accountScope.getStore();
    if (
      !scope ||
      scope.reservationPromise ||
      scope.reservation ||
      scope.planLease ||
      scope.planBound
    )
      throw costPlanUnavailable();
    scope.planDisabled = true;
  }
  accountReadSignal(): AbortSignal {
    return (
      this.accountScope.getStore()?.admission.signal ??
      this.callerSignal ??
      new AbortController().signal
    );
  }
  private accountDeadline() {
    return new AgentError(
      "VENUE_READ_DEADLINE",
      "Complete account observation deadline expired.",
      true,
      503,
    );
  }
  accountReadTimeout(maximum = 20000): number {
    const scope = this.accountScope.getStore();
    if (!scope) return maximum;
    if (scope.admission.signal.aborted) throw scope.admission.signal.reason;
    const left = Math.ceil(
      Math.min(
        scope.until - this.clock(),
        scope.monotonicUntil - this.monotonicClock(),
      ),
    );
    if (left <= 0) throw this.accountDeadline();
    return Math.min(maximum, left);
  }
  private async reserveObservation(
    scope: AccountReadScope,
    bundle?: PreparedReadWindowOptions & { continuation?: object },
  ): Promise<AccountReadReservation> {
    // A near-ready FIFO slot should not be lost to a complete monitor cycle's
    // reconciliation and commit work. Uncoordinated reads retain their original
    // one-second wait. Fleet grants may recheck only branded local BEGIN gates.
    // The original scope,
    // caller and Core lease deadlines keep running. Every hard gate remains
    // authoritative; final failure releases only this scope's unused credit.
    const until = Math.min(scope.until, this.clock() + 1000);
    const signal = this.callerSignal
      ? AbortSignal.any([scope.admission.signal, this.callerSignal])
      : scope.admission.signal;
    let durableHint:
      Awaited<ReturnType<ObservationPlanStore["read"]>> | undefined;
    let restored = false;
    if (
      !scope.preparingBundle &&
      !scope.preparedParent &&
      this.preparedOwners.has(scope.owner!)
    )
      throw costPlanUnavailable();
    if (this.observationPlans && !scope.planDisabled) {
      if (this.requireObservationPlanBinding && !scope.planBound)
        throw costPlanUnavailable();
      try {
        scope.planAttempt = this.budget.beginObservationPlanAttempt(
          scope.owner!,
        );
        const before = this.monotonicClock();
        durableHint = await this.observationPlans.read(scope.owner!, signal);
        this.accountReadTimeout();
        if (signal.aborted) throw signal.reason;
        if (
          !this.budget.observationPlanAttemptCurrent(
            scope.owner!,
            scope.planAttempt,
          )
        )
          throw costPlanUnavailable();
        // DB age is authoritative; round-trip delay consumes, never renews,
        // the remaining original ten-minute operational-plan lifetime.
        const remaining = Math.floor(
          durableHint.remainingTtlMs -
            Math.max(0, this.monotonicClock() - before),
        );
        if (durableHint.plan && remaining > 0) {
          this.costPlans.loaded_valid++;
          restored = this.budget.refreshObservationPlan(
            scope.owner!,
            durableHint.plan,
            remaining,
          );
        } else {
          this.costPlans.loaded_cold++;
          this.invalidateCostPlan(scope);
        }
      } catch {
        this.costPlans.load_failed++;
        this.invalidateCostPlan(scope);
        throw costPlanUnavailable();
      }
    }
    let fleetPlan: ObservationFleetPlan | undefined;
    if (this.frameCoordinator) {
      // A busy local source ledger must not prevent polling or expiring an
      // already queued fleet reservation. This peek claims no local capacity
      // and never changes the cold hint, plan lifetime or FIFO membership.
      const historyReservation = readCost({ type: "userFillsByTime" }).reserve;
      const historySources = bundle?.historySources ?? [];
      if (
        historySources.length > 8 ||
        new Set(historySources).size !== historySources.length ||
        historySources.some(
          (source) =>
            typeof source !== "string" || !source || source.length > 256,
        ) ||
        (historySources.length > 0 && bundle?.purpose !== "audit_source")
      )
        throw costPlanUnavailable();
      const supplements =
        bundle?.purpose === "audit_source"
          ? this.budget.preparedSupplementPlan(
              scope.frameOwner ?? scope.owner!,
              historySources,
            )
          : undefined;
      const supplementalWeight = supplements
        ? supplements.sourceWeight +
          Object.values(supplements.historyWeights).reduce(
            (sum, weight) => sum + weight,
            0,
          )
        : historySources.length * historyReservation;
      const trialCapacity = Math.min(
        this.frameCoordinator.capacity - historyReservation,
        this.frameCoordinator.capacity - supplementalWeight,
      );
      if (trialCapacity < Math.min(120, this.budget.limit)) {
        const unsupported = new AgentError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          "This complete read window exceeds its unchanged fleet capacity.",
          true,
          503,
          { reason_code: "READ_FRAME_CAPACITY", retry_after_ms: 60000 },
        );
        if (bundle) unsupportedPreparedBundles.add(unsupported);
        throw unsupported;
      }
      const hint = this.budget.peekObservationFramePlan(
        scope.owner!,
        trialCapacity,
      );
      const childLimit = hint.cold
        ? Math.min(hint.fullDemand, trialCapacity)
        : hint.fullDemand;
      const childCount: 1 | 2 =
        bundle && bundle.purpose !== "audit_source" && !hint.cold ? 2 : 1;
      const reservedWeight = childLimit * childCount + supplementalWeight;
      if (
        bundle &&
        childLimit <= this.frameCoordinator.capacity &&
        reservedWeight > this.frameCoordinator.capacity
      ) {
        const unsupported = new AgentError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          "This complete read window exceeds its unchanged fleet capacity.",
          true,
          503,
          { reason_code: "READ_FRAME_CAPACITY", retry_after_ms: 60000 },
        );
        unsupportedPreparedBundles.add(unsupported);
        throw unsupported;
      }
      if (
        reservedWeight > this.frameCoordinator.capacity ||
        (hint.cold && trialCapacity < Math.min(120, this.budget.limit))
      ) {
        throw new AgentError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          "Known account scope exceeds fleet capacity; fresh complete evidence is still required.",
          true,
          503,
          { retry_after_ms: 60000, reason_code: "READ_FRAME_CAPACITY" },
        );
      }
      fleetPlan = Object.freeze({
        ...hint,
        reservedWeight,
        childLimit,
        childCount,
        historySources: Object.freeze([...historySources]),
        supplements,
      });
      const continuation = bundle?.continuation;
      const pending = continuation
        ? this.pendingPreparedBookings.get(continuation)
        : undefined;
      if (continuation) {
        if (
          !pending ||
          pending.owner !== scope.owner ||
          pending.frameOwner !== scope.frameOwner ||
          pending.purpose !== (bundle?.purpose ?? "audit_submit") ||
          pending.firstDeadline !== scope.queueUntil ||
          !this.pendingPlanFits(fleetPlan, pending.latest) ||
          !this.pendingPlanFits(fleetPlan, pending.booked)
        )
          throw costPlanUnavailable();
        pending.latest = fleetPlan;
      }
      // Core retains its original conservative booking/UUID/FIRST. The local
      // ticket below still uses the CURRENT fresh, smaller per-pool demand.
      // Any excess Core hold is unused credit until normal end, never a pool.
      const booked = pending?.booked ?? fleetPlan;
      try {
        await this.reserveFrame(
          scope,
          {
            weight: booked.reservedWeight,
            mode: booked.cold ? "cold_trial" : "learned",
          },
          signal,
          continuation,
        );
      } catch (error) {
        const pin = bundle && framePendingContinuation(error);
        if (pin) {
          if (continuation) {
            if (
              pin !== continuation ||
              this.pendingPreparedBookings.get(pin) !== pending
            )
              throw costPlanUnavailable();
          } else {
            // Only this call's verified HTTP pending receipt can establish a
            // booking. A peer's local POLLING pin conveys no ownership.
            if (
              (error as AgentError).details?.reason_code !==
                "READ_FRAME_PENDING" ||
              this.pendingPreparedBookings.has(pin)
            )
              throw costPlanUnavailable();
            this.pendingPreparedBookings.set(pin, {
              owner: scope.owner!,
              frameOwner: scope.frameOwner!,
              purpose: bundle!.purpose ?? "audit_submit",
              firstDeadline: scope.queueUntil,
              booked: fleetPlan,
              latest: fleetPlan,
            });
          }
        }
        throw error;
      }
      if (continuation) this.pendingPreparedBookings.delete(continuation);
      scope.localInterest = this.budget.beginObservationInterest(scope.owner!);
    }
    let deferred: unknown;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      this.accountReadTimeout();
      if (!this.frameCoordinator && deferred && this.clock() > until)
        throw deferred;
      try {
        if (fleetPlan) {
          const current = this.budget.peekObservationFramePlan(
            scope.owner!,
            fleetPlan.childLimit,
          );
          if (
            current.fullDemand !== fleetPlan.fullDemand ||
            current.cold !== fleetPlan.cold
          )
            throw costPlanUnavailable();
        }
        const reservation = bundle
          ? this.budget.beginObservationBundle(
              scope.owner!,
              fleetPlan!.childLimit,
              fleetPlan!.childCount,
              scope.localInterest!,
              fleetPlan!.cold,
              fleetPlan!.historySources,
              fleetPlan!.supplements,
            )
          : this.budget.beginObservation(
              scope.owner!,
              fleetPlan?.cold
                ? {
                    fullDemand: fleetPlan.fullDemand,
                    reservedWeight: fleetPlan.reservedWeight,
                  }
                : undefined,
              scope.localInterest,
            );
        scope.reservation = reservation;
        // The hint may change while the private grant is in flight. Never
        // spend a ticket whose actual full demand differs from that booking.
        if (
          fleetPlan &&
          (reservation.fullDemand !== fleetPlan.fullDemand ||
            reservation.weight !== fleetPlan.reservedWeight ||
            reservation.capacityTrial !== fleetPlan.cold)
        ) {
          reservation.close(false);
          scope.reservation = undefined;
          this.releaseFrame(scope);
          throw costPlanUnavailable();
        }
        if (bundle) {
          scope.preparedHint = durableHint;
          return reservation;
        }
        if (this.observationPlans && durableHint) {
          scope.durableAttempted = true;
          // Record the reservation before awaiting the claim so cancellation
          // always closes it. No read ticket or venue request exists yet.
          scope.reservation = reservation;
          try {
            const remainingLease = Math.min(
              this.accountReadTimeout(),
              Math.floor(scope.monotonicUntil - this.monotonicClock()),
            );
            if (remainingLease <= 0) throw this.accountDeadline();
            scope.planLease = await this.observationPlans.begin(
              scope.owner!,
              signal,
              durableHint,
              remainingLease,
            );
            this.accountReadTimeout();
            if (signal.aborted) throw signal.reason;
            this.costPlans.claimed++;
            if (restored) this.costPlans.restored_admitted++;
          } catch {
            this.costPlans.claim_failed++;
            reservation.close(false);
            this.invalidateCostPlan(scope);
            throw costPlanUnavailable();
          }
        }
        return reservation;
      } catch (error) {
        const fleetBegin =
          this.frameCoordinator &&
          !scope.reservation &&
          isObservationAdmissionDeferred(error);
        const waitUntil = fleetBegin ? scope.until : until;
        if (this.frameCoordinator && !fleetBegin) {
          this.releaseFrame(scope);
          throw error;
        }
        const retry =
          error instanceof AgentError &&
          error.code === "VENUE_READ_BUDGET_EXHAUSTED" &&
          error.details?.reason_code !== "READ_FRAME_PENDING"
            ? error.details?.retry_after_ms
            : undefined;
        if (
          typeof retry !== "number" ||
          !Number.isSafeInteger(retry) ||
          retry < 1 ||
          (fleetBegin
            ? retry >=
              Math.min(
                waitUntil - this.clock(),
                scope.monotonicUntil - this.monotonicClock(),
              )
            : retry > waitUntil - this.clock())
        ) {
          if (this.frameCoordinator) this.releaseFrame(scope);
          throw error;
        }
        deferred = error;
        await new Promise<void>((resolve, reject) => {
          const cancel = () => {
            this.timers.clearTimeout(timer);
            signal.removeEventListener("abort", cancel);
            reject(signal.reason);
          };
          const timer = this.timers.setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, retry);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        });
      }
    }
  }
  async read(
    url: string,
    payload: unknown,
    ttlMs = 0,
    lane: ReadLane = "account",
  ): Promise<any> {
    return (await this.readWithEvidence(url, payload, ttlMs, lane)).value;
  }
  async readWithEvidence(
    url: string,
    payload: unknown,
    ttlMs = 0,
    lane: ReadLane = "account",
  ): Promise<VenueReadEvidence> {
    let method = "unsupported";
    try {
      const cost = readCost(payload);
      method = cost.method;
      this.count(method, lane, "calls");
      this.accountReadTimeout();
      if (this.callerSignal?.aborted) throw this.callerSignal.reason;
      this.checkCooldown(method, lane);
      const scope = this.accountScope.getStore();
      if (
        scope?.preparedHistoryGuard &&
        (lane !== "source" ||
          cost.method !== "userFillsByTime" ||
          cost.reserve !== 120 ||
          cost.unknownSurcharge)
      )
        throw costPlanUnavailable();
      scope?.preparedHistoryGuard?.(payload);
      if (scope?.preparedParent) {
        if (!scope.preparedIdentityVerified) throw costPlanUnavailable();
      }
      if (scope?.owner && !scope.reservation) {
        if (scope.admissionError) throw scope.admissionError;
        try {
          scope.reservationPromise ??= this.reserveObservation(scope);
          scope.reservation = await scope.reservationPromise;
        } catch (error) {
          scope.admissionError = error;
          if (error instanceof AgentError) {
            if (error.code === "VENUE_READ_BUDGET_EXHAUSTED")
              this.count(method, lane, "local_budget_denied");
            else if (error.code === "VENUE_READ_DEADLINE")
              this.count(method, lane, "local_deadline_denied");
            else if (error.code === "VENUE_RATE_LIMITED")
              this.count(method, lane, "local_cooldown_denied");
          }
          throw error;
        }
      }
      // Admission may now yield even when the gate was immediately ready.
      // Revalidate before returning cached metadata as well as before dispatch.
      this.accountReadTimeout();
      if (this.callerSignal?.aborted) throw this.callerSignal.reason;
      this.checkCooldown(method, lane);
      const key = JSON.stringify([url, payload]),
        // A failed observation may cancel only its own queued work, never a
        // different caller that joined the same account request.
        flightKey = `${lane}:${this.accountScope.getStore()?.id ?? "shared"}:${key}`;
      const cached = this.cache.get(key);
      if (
        ttlMs > 0 &&
        cached &&
        Math.min(cached.until, cached.at + ttlMs) > this.clock()
      ) {
        this.count(method, lane, "cache_hit");
        if (scope && method === "allMids")
          scope.observedAt = Math.min(
            scope.observedAt ?? cached.evidenceAt,
            cached.evidenceAt,
          );
        return {
          value: structuredClone(cached.value),
          observed_at: cached.evidenceAt,
        };
      }
      if (cached) this.cache.delete(key);
      let flight = this.flights.get(flightKey);
      if (!flight) {
        const evidence: { at?: number } = {};
        const controller = new AbortController();
        const timer = this.timers.setTimeout(
          () =>
            controller.abort(
              new AgentError(
                "VENUE_READ_DEADLINE",
                "Venue read deadline expired before complete evidence arrived.",
                true,
                503,
              ),
            ),
          this.accountReadTimeout(
            this.accountScope.getStore() ? 20000 : this.deadlineMs,
          ),
        );
        flight = this.perform(
          url,
          payload,
          lane,
          cost,
          controller.signal,
          evidence,
        )
          .then((value) => {
            if (controller.signal.aborted) throw controller.signal.reason;
            // perform() records this only at actual HTTP dispatch. A missing
            // stamp cannot become fresh evidence just because JSON completed.
            if (evidence.at === undefined || !Number.isFinite(evidence.at))
              throw new AgentError(
                "VENUE_RESPONSE_INVALID",
                "Venue read has no original dispatch evidence.",
                true,
                503,
              );
            if (ttlMs > 0) {
              if (this.cache.size >= 2000)
                this.cache.delete(this.cache.keys().next().value!);
              this.cache.set(key, {
                at: this.clock(),
                evidenceAt: evidence.at,
                value: structuredClone(value),
                until: this.clock() + ttlMs,
              });
            }
            return { value, observed_at: evidence.at };
          })
          .finally(() => this.timers.clearTimeout(timer));
        this.flights.set(flightKey, flight);
        void flight.then(
          () => this.flights.delete(flightKey),
          () => this.flights.delete(flightKey),
        );
      } else this.count(method, lane, "flight_join");
      return structuredClone(await flight);
    } catch (error) {
      if (method === "unsupported")
        this.count(method, lane, "unsupported_method");
      throw error;
    } finally {
      this.maybeReport();
    }
  }
  private sourceRetryWindow(
    admission: AbortSignal,
    remainingMs: () => number,
  ): PreparedSourceRetryLimits {
    return {
      signal: admission,
      remainingMs,
      wait: async (delayMs, cancelled) => {
        if (
          !Number.isSafeInteger(delayMs) ||
          delayMs < 0 ||
          delayMs >= remainingMs()
        )
          throw this.accountDeadline();
        const signal = AbortSignal.any([admission, cancelled]);
        if (signal.aborted) throw signal.reason;
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            this.timers.clearTimeout(waiting);
            signal.removeEventListener("abort", stop);
            reject(signal.reason);
          };
          const waiting = this.timers.setTimeout(() => {
            signal.removeEventListener("abort", stop);
            if (signal.aborted) reject(signal.reason);
            else if (remainingMs() <= 0) reject(this.accountDeadline());
            else resolve();
          }, delayMs);
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
        });
      },
    };
  }
  private async abortable<T>(
    work: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      void work.catch(() => {});
      throw signal.reason;
    }
    let abort!: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([work, cancellation]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async perform(
    url: string,
    payload: unknown,
    lane: ReadLane,
    cost: ReturnType<typeof readCost>,
    signal: AbortSignal,
    evidence: { at?: number },
  ): Promise<unknown> {
    let ticket: ReadTicket | undefined,
      sent = false,
      settled = false;
    let wireTimer: unknown, admissionTimer: unknown;
    let wireSignal = signal;
    const user = (payload as { user?: unknown })?.user;
    const owner = typeof user === "string" && user.length ? user : undefined;
    const scope = this.accountScope.getStore();
    const requestSignal = this.callerSignal
      ? AbortSignal.any([signal, this.callerSignal])
      : signal;
    const sourceAdmission =
      lane === "source" &&
      !scope &&
      cost.rows?.maximum !== undefined &&
      cost.reserve >= 100
        ? new AbortController()
        : undefined;
    const admissionUntil = sourceAdmission
      ? this.clock() + Math.max(1, this.deadlineMs - 1000)
      : undefined;
    const admissionError = () =>
      new AgentError(
        "VENUE_READ_DEADLINE",
        "Source admission expired before the minimum wire window.",
        true,
        503,
      );
    const admissionSignal = scope
      ? AbortSignal.any([requestSignal, scope.admission.signal])
      : sourceAdmission
        ? AbortSignal.any([requestSignal, sourceAdmission.signal])
        : requestSignal;
    try {
      if (sourceAdmission)
        admissionTimer = this.timers.setTimeout(
          () => sourceAdmission.abort(admissionError()),
          Math.max(0, admissionUntil! - this.clock()),
        );
      ticket = await this.budget.acquire(
        lane,
        cost.reserve,
        owner,
        admissionSignal,
        cost.unknownSurcharge,
        scope?.reservation,
      );
      if (admissionTimer !== undefined)
        this.timers.clearTimeout(admissionTimer);
      // A late ticket may resolve in the same turn as the queue cutoff. No
      // HTTP is sent unless the original operation still has its wire reserve.
      if (admissionUntil !== undefined && this.clock() >= admissionUntil)
        throw admissionError();
      this.checkCooldown(cost.method, lane, false);
      if (admissionSignal.aborted) throw admissionSignal.reason;
      if (signal.aborted) throw signal.reason;
      // A cached metadata hit never claims/dirty-marks a financial cost plan.
      // Claim only this new dispatch, after its real local ticket is ready.
      if (scope?.preparedParent) await this.claimPreparedChild(scope);
      if (admissionSignal.aborted) throw admissionSignal.reason;
      this.accountReadTimeout();
      // Queue time belongs to the enclosing 20-second account observation.
      // Bound HTTP/JSON work to 12 seconds after admission instead of consuming
      // its wire window in the queue; the whole-operation boundary stays 20s.
      const wire = new AbortController();
      const wireMs = Math.min(
        this.accountReadTimeout(this.deadlineMs),
        scope?.frameLease
          ? Math.max(0, scope.frameLease.expires_at - this.clock())
          : this.deadlineMs,
      );
      if (wireMs <= 0) throw this.accountDeadline();
      const wireDeadline = this.clock() + wireMs;
      wireTimer = this.timers.setTimeout(
        () =>
          wire.abort(
            new AgentError(
              "VENUE_READ_DEADLINE",
              "Venue wire read deadline expired before complete evidence arrived.",
              true,
              503,
            ),
          ),
        wireMs,
      );
      wireSignal = AbortSignal.any([requestSignal, wire.signal]);
      ticket.sent();
      evidence.at = this.clock();
      if (
        scope &&
        [
          "clearinghouseState",
          "spotClearinghouseState",
          "allMids",
          "frontendOpenOrders",
          "openOrders",
        ].includes(cost.method)
      )
        scope.observedAt ??= this.clock();
      sent = true;
      this.count(cost.method, lane, "actual_fetch");
      this.count(cost.method, lane, "reserved_weight", ticket.reservation);
      if (cost.unknownSurcharge) this.count(cost.method, lane, "unknown_fetch");
      let response: Response;
      try {
        response = await this.abortable(
          this.fetcher(
            url,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: wireSignal,
              redirect: "error",
            },
            {
              deadline_ms: wireDeadline,
              ...(scope?.frameLease
                ? {
                    frame_id: scope.frameLease.frame_id,
                    frame_owner: scope.frameOwner ?? scope.owner!,
                  }
                : {}),
            },
          ),
          wireSignal,
        );
      } catch (error) {
        if (error instanceof CoordinatedReadError) {
          this.count(cost.method, lane, "coordinated_denied");
          if (!error.upstreamRequestSent) {
            ticket.settle(0);
            settled = true;
            this.count(cost.method, lane, "coordinated_no_upstream");
          }
          if (error.code === "VENUE_RATE_LIMITED") {
            this.count(cost.method, lane, "coordinated_rate_limited");
            this.budget.note429(error.details?.retry_after_ms ?? 0);
            this.cache.clear();
          }
          throw error;
        }
        this.count(cost.method, lane, "transport_failure");
        if (wireSignal.aborted) throw wireSignal.reason;
        throw new AgentError(
          "VENUE_UNAVAILABLE",
          "Venue read did not complete. Fresh account evidence is required before execution.",
          true,
          503,
        );
      }
      const originalAt = coordinatedEvidence(response);
      if (originalAt !== undefined) {
        evidence.at = Math.min(evidence.at!, originalAt);
        if (scope?.observedAt !== undefined)
          scope.observedAt = Math.min(scope.observedAt, originalAt);
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          this.count(cost.method, lane, "http_429");
          const retry = response.headers.get("retry-after"),
            seconds = retry == null ? NaN : Number(retry);
          const retryMs =
            Number.isFinite(seconds) && seconds > 0
              ? Math.min(Number.MAX_SAFE_INTEGER, seconds * 1000)
              : retry && Number.isFinite(Date.parse(retry))
                ? Date.parse(retry) - this.clock()
                : 0;
          this.budget.note429(Math.max(0, retryMs));
          this.cache.clear();
          try {
            this.noteRateLimitResponse(
              cost.method,
              lane,
              response.headers,
              retryMs,
            );
          } catch {
            // Diagnostics must never bypass the provider cooldown or cache invalidation.
          }
          throw this.unavailable();
        }
        this.count(cost.method, lane, "http_failure");
        throw new AgentError(
          "VENUE_UNAVAILABLE",
          "Venue read failed. Existing settings are preserved.",
          response.status >= 500,
          503,
        );
      }
      let data: unknown;
      try {
        data = await this.abortable(response.json(), wireSignal);
      } catch {
        if (wireSignal.aborted) throw wireSignal.reason;
        this.count(cost.method, lane, "invalid_response");
        throw new AgentError(
          "VENUE_RESPONSE_INVALID",
          "Venue response was not complete valid JSON.",
          true,
          503,
        );
      }
      let actual: number;
      try {
        actual = responseCost(cost, data);
      } catch (error) {
        this.count(cost.method, lane, "invalid_response");
        this.budget.quarantine();
        throw error;
      }
      let capacityFailure: AgentError | undefined;
      try {
        ticket.settle(actual);
      } catch (error) {
        if (
          error instanceof AgentError &&
          error.details?.reason_code === "READ_FRAME_CAPACITY"
        )
          capacityFailure = error;
        else throw error;
      }
      settled = true;
      this.count(cost.method, lane, "charged_weight", actual);
      if (cost.unknownSurcharge && actual > ticket.reservation) {
        this.count(cost.method, lane, "unknown_overrun");
        this.count(
          cost.method,
          lane,
          "unknown_debt_weight",
          actual - ticket.reservation,
        );
      }
      if (capacityFailure) throw capacityFailure;
      return data;
    } catch (error) {
      if (this.callerSignal?.aborted) throw this.callerSignal.reason;
      if (
        error instanceof AgentError &&
        error.code === "VENUE_READ_BUDGET_EXHAUSTED"
      )
        this.count(cost.method, lane, "local_budget_denied");
      else if (
        error instanceof AgentError &&
        error.code === "VENUE_READ_DEADLINE"
      )
        this.count(cost.method, lane, "local_deadline_denied");
      else if (
        error instanceof AgentError &&
        error.code === "VENUE_RATE_LIMITED" &&
        !sent
      )
        this.count(cost.method, lane, "local_cooldown_denied");
      throw error;
    } finally {
      if (admissionTimer !== undefined)
        this.timers.clearTimeout(admissionTimer);
      if (wireTimer !== undefined) this.timers.clearTimeout(wireTimer);
      if (sent && !settled) {
        this.count(cost.method, lane, "charged_weight", ticket!.reservation);
        if (cost.unknownSurcharge) {
          ticket!.uncertain();
          this.count(cost.method, lane, "unknown_uncertain");
        }
      }
      ticket?.release();
    }
  }
  private noteRateLimitResponse(
    method: string,
    lane: ReadLane,
    headers: Headers,
    retryMs: number,
  ) {
    const content = (headers.get("content-type") ?? "").toLowerCase();
    const server = (headers.get("server") ?? "").toLowerCase();
    const retry = headers.get("retry-after");
    const row: RateLimitResponse = {
      purpose_method: `${lane}:${method}`,
      content_kind: !content
        ? "missing"
        : content.includes("json")
          ? "json"
          : content.includes("html")
            ? "html"
            : content.startsWith("text/")
              ? "text"
              : "other",
      retry_after_kind:
        retry == null
          ? "missing"
          : Number.isFinite(Number(retry)) && Number(retry) > 0
            ? "seconds"
            : Number.isFinite(Date.parse(retry))
              ? "date"
              : "invalid",
      retry_after_ms: Number.isFinite(retryMs)
        ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(retryMs)))
        : 0,
      server_family: !server
        ? "missing"
        : server.includes("cloudflare")
          ? "cloudflare"
          : server.includes("cloudfront")
            ? "cloudfront"
            : server.includes("nginx")
              ? "nginx"
              : server.includes("envoy")
                ? "envoy"
                : "other",
      cloudfront_header: Boolean(headers.get("x-amz-cf-id")),
      cloudflare_header: Boolean(headers.get("cf-ray")),
      count: 1,
    };
    const key = JSON.stringify({ ...row, count: 0 });
    const previous = this.rateLimitResponses.get(key);
    if (previous) previous.count++;
    else if (this.rateLimitResponses.size < 200)
      this.rateLimitResponses.set(key, row);
  }
}
