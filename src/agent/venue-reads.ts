import { AgentError } from "./contracts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readCost, responseCost } from "./venue-read-cost.js";
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
  readTimers,
  type BudgetTimers,
  type ReadLane,
  type ReadTicket,
  type AccountReadReservation,
  VenueReadBudget,
} from "./venue-read-budget.js";

type Entry = { at: number; until: number; evidenceAt: number; value: unknown };
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
};
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
}

// Completed account evidence is never reused. Metadata TTL and same-lane
// single-flight are unchanged. Both HL hosts share one process weighted gate.
export class VenueReads {
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
  private counts = counters();
  private costPlans = costPlanCounters();
  private accountObservations = new Set<Promise<unknown>>();
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
  async observeAccount<T>(work: () => Promise<T>, owner?: string): Promise<T> {
    if (this.accountScope.getStore()) return work();
    if (this.draining) throw costPlanUnavailable();
    const scope: AccountReadScope = {
      id: ++this.accountSequence,
      until: this.clock() + 20000,
      admission: new AbortController(),
      owner,
      monotonicUntil: this.monotonicClock() + 20000,
    };
    const timer = this.timers.setTimeout(
      () => scope.admission.abort(this.accountDeadline()),
      20000,
    );
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
      };
      try {
        const value = await Promise.race([work(), cancelled]);
        this.accountReadTimeout();
        complete = true;
        // All successful work has returned before cost publication. A failed,
        // still-pending, unknown or otherwise invalid scope yields no plan.
        scope.reservation?.close(true);
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
            } finally {
              cleanup();
            }
          })();
          this.accountFinalizers.add(finalizer);
          void finalizer.then(
            () => this.accountFinalizers.delete(finalizer),
            () => this.accountFinalizers.delete(finalizer),
          );
        } else if (scope.durableAttempted) this.invalidateCostPlan(scope);
        return value;
      } catch (error) {
        if (scope.durableAttempted) this.invalidateCostPlan(scope);
        scope.admission.abort(error);
        throw error;
      } finally {
        if (!finalizing) cleanup();
        scope.reservation?.close(complete);
      }
    });
    this.accountObservations.add(observing);
    try {
      return await observing;
    } finally {
      this.accountObservations.delete(observing);
    }
  }
  async drainAccounts(): Promise<void> {
    this.draining = true;
    await Promise.allSettled([...this.accountObservations]);
    await Promise.allSettled([...this.accountFinalizers]);
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
  bindAccountCostPlan(owner: string): void {
    const scope = this.accountScope.getStore();
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
    const left = Math.ceil(scope.until - this.clock());
    if (left <= 0) throw this.accountDeadline();
    return Math.min(maximum, left);
  }
  private async reserveObservation(
    scope: AccountReadScope,
  ): Promise<AccountReadReservation> {
    // A near-ready FIFO slot should not be lost to a complete monitor cycle's
    // reconciliation and commit work. Wait only before the first venue read,
    // for at most one second in total, inside the original account deadline.
    // No frame or provisional weight is held while waiting; every recheck must
    // pass the same whole-observation admission gate again.
    const until = Math.min(scope.until, this.clock() + 1000);
    const signal = this.callerSignal
      ? AbortSignal.any([scope.admission.signal, this.callerSignal])
      : scope.admission.signal;
    let durableHint:
      Awaited<ReturnType<ObservationPlanStore["read"]>> | undefined;
    let restored = false;
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
    let deferred: unknown;
    for (;;) {
      if (signal.aborted) throw signal.reason;
      this.accountReadTimeout();
      if (deferred && this.clock() > until) throw deferred;
      try {
        const reservation = this.budget.beginObservation(scope.owner!);
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
        const retry =
          error instanceof AgentError &&
          error.code === "VENUE_READ_BUDGET_EXHAUSTED"
            ? error.details?.retry_after_ms
            : undefined;
        if (
          typeof retry !== "number" ||
          !Number.isSafeInteger(retry) ||
          retry < 1 ||
          retry > until - this.clock()
        )
          throw error;
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
      // Queue time belongs to the enclosing 20-second account observation.
      // Bound HTTP/JSON work to 12 seconds after admission instead of consuming
      // its wire window in the queue; the whole-operation boundary stays 20s.
      const wire = new AbortController();
      const wireMs = this.accountReadTimeout(this.deadlineMs);
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
            { deadline_ms: wireDeadline },
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
      ticket.settle(actual);
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
