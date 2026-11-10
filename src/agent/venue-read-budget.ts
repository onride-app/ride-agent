import { AgentError } from "./contracts.js";
import { UNSENT_READ_BUDGET_REASON } from "./venue-read-transport.js";
import {
  ACCOUNT_OBSERVATION_PLAN_TTL_MS,
  costPlanUnavailable,
  validObservationCostPlan,
  type ObservationCostPlan,
} from "./account-observation-plans.js";

export type ReadLane = "account" | "source";
export interface BudgetTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const readTimers: BudgetTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type ObservationBeginReason =
  | "READ_LOCAL_BUSY"
  | "READ_LOCAL_FIFO"
  | "READ_LOCAL_PACING"
  | "READ_LOCAL_QUOTA"
  | "READ_LOCAL_EXCLUSIVE"
  | "READ_LOCAL_QUARANTINE";
const beginDeferrals = new WeakSet<object>();
/** Only BEGIN can create this brand. A read/remote error cannot authorize a wait. */
export class ObservationAdmissionDeferred extends AgentError {
  constructor(reason: ObservationBeginReason, retry: number) {
    super(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "Complete account observation is queued before venue reads begin.",
      true,
      503,
      { retry_after_ms: retry, reason_code: reason },
    );
    beginDeferrals.add(this);
  }
}
export function isObservationAdmissionDeferred(
  error: unknown,
): error is ObservationAdmissionDeferred {
  return (
    error instanceof ObservationAdmissionDeferred && beginDeferrals.has(error)
  );
}
export class ObservationPacingDeferred extends ObservationAdmissionDeferred {
  constructor(retry: number) {
    super("READ_LOCAL_PACING", retry);
  }
}

type Charge = {
  at: number;
  lane: ReadLane;
  weight: number;
  sent: boolean;
  settled: boolean;
  boundedSourceHold?: number;
};
type Waiter = {
  lane: ReadLane;
  owner: string;
  cost: number;
  unknownSurcharge: boolean;
  signal: AbortSignal;
  resolve(ticket: ReadTicket): void;
  reject(error: Error): void;
  cancel(): void;
  budgetBlocked: boolean;
  observation?: AccountReadReservation;
};
export interface AccountReadReservation {
  readonly id: number;
  /** Operational frame estimate, never a provider quota increase or evidence. */
  readonly weight: number;
  /** Original operational hint; a capacity trial never rewrites this value. */
  readonly fullDemand: number;
  readonly capacityTrial: boolean;
  close(complete?: boolean): void;
  costPlan(): ObservationCostPlan | null;
}
/** A bounded parent holds capacity only; only completed children learn costs. */
export interface AccountReadBundle extends AccountReadReservation {
  readonly childLimit: number;
  readonly childCount: number;
  beginChild(): AccountReadReservation;
  beginSupplement(): AccountReadReservation;
  assertNextChildReady(): void;
}
type Observation = {
  ticket: AccountReadReservation;
  owner: string;
  remaining: number;
  committed: number;
  peak: number;
  pending: number;
  closed: boolean;
  complete: boolean;
  grew: boolean;
  hadUncertain: boolean;
  sampleInvalid: boolean;
  admittedPeak: number;
  started: number;
  publishCostPlan(plan: ObservationCostPlan): void;
  previousPlan?: { demand: number; peaks: number[] };
  planAttempt?: object;
  capacityTrialLimit?: number;
  trialExceeded?: boolean;
  supplement?: boolean;
  bundle?: {
    limit: number;
    count: number;
    opened: number;
    child?: Observation;
    supplementRemaining?: number;
  };
};
type Owner = {
  served: number;
  pending: number;
  lastSeen: number;
  lastTurn: number;
};
type Turn = {
  owner: string;
  started: number;
  lastActivity: number;
  served: number;
  sharedReads: number;
};
export interface ReadTicket {
  readonly reservation: number;
  sent(): void;
  settle(weight: number): void;
  uncertain(): void;
  release(): void;
}

// Shared by ALL production VenueReads instances and both HL hosts. Different
// hostnames do not imply independent IP quotas. Pending response surcharges
// count against the same rolling window as already-sent requests.
export class VenueReadBudget {
  readonly limit: number;
  private readonly clock: () => number;
  private readonly timers: BudgetTimers;
  private readonly slots: number;
  private charges: Charge[] = [];
  private queues: Record<ReadLane, Waiter[]> = { account: [], source: [] };
  private active: Record<ReadLane, number> = { account: 0, source: 0 };
  private turns: Partial<Record<ReadLane, Turn>> = {};
  private owners: Record<ReadLane, Map<string, Owner>> = {
    account: new Map(),
    source: new Map(),
  };
  private lastLane: ReadLane = "source";
  private wake?: unknown;
  private pumping = false;
  private blockedUntil = 0;
  private exclusive?: Charge;
  private providerUntil = 0;
  private turnSequence = 0;
  private observationSequence = 0;
  private observation?: Observation;
  private observationQueue = new Map<
    string,
    {
      demand: number;
      seen: number;
      legacy: boolean;
      legacySeen: number;
      interests: Set<object>;
    }
  >();
  private observationInterests = new Map<
    object,
    { owner: string; waiting: boolean }
  >();
  private observationPlans = new Map<
    string,
    { demand: number; seen: number; peaks: number[]; attempt?: object }
  >();
  private observationPlanAttempts = new Map<
    string,
    { token: object; at: number }
  >();
  private nextObservationAt = 0;
  private recentObservationWeights: number[] = [];
  private recentSuccessfulObservationFrames: {
    paid: number;
    demand: number | null;
    peak: number;
    at: number;
  }[] = [];
  private sourcePacingLoans = 0;
  private observations = { started: 0, completed: 0, deferred: 0, growth: 0 };
  constructor(
    options: {
      limit?: number;
      clock?: () => number;
      timers?: BudgetTimers;
      slots?: number;
    } = {},
  ) {
    this.limit = options.limit ?? 1000;
    this.clock = options.clock ?? (() => performance.now());
    this.timers = options.timers ?? readTimers;
    this.slots = options.slots ?? 1;
    if (
      !Number.isSafeInteger(this.limit) ||
      this.limit <= 0 ||
      this.limit > 1200 ||
      !Number.isSafeInteger(this.slots) ||
      this.slots < 1
    )
      throw new RangeError(
        "Venue read budget must be bounded by the official 1200 weight/minute cap.",
      );
  }
  snapshot() {
    this.prune();
    return {
      capacity: this.limit,
      window_ms: 60000,
      used: this.used(),
      source_used: this.sourceUsed(),
      source_pacing_loans: this.sourcePacingLoans,
      debt: Math.max(0, this.used() - this.limit),
      unknown_exclusive: this.exclusive !== undefined,
      provider_cooldown_ms: this.cooldownRemaining(),
      quarantine_ms: Math.max(0, Math.ceil(this.blockedUntil - this.clock())),
      account_active: this.active.account,
      source_active: this.active.source,
      account_queued: this.queues.account.length,
      source_queued: this.queues.source.length,
      observation_active: this.observation !== undefined,
      observation_queued: this.observationQueue.size,
      observation_reserved: this.observation?.remaining ?? 0,
      observation_pacing_ms: Math.max(
        0,
        Math.ceil(this.nextObservationAt - this.clock()),
      ),
      observations: { ...this.observations },
    };
  }
  private observationPacingMs(weight: number) {
    const originalAllowance = this.limit * 0.8;
    const original = Math.ceil((weight * 60000) / originalAllowance);
    const learned = this.recentSuccessfulObservationFrames.filter(
      (frame) =>
        frame.demand !== null &&
        frame.peak > frame.paid &&
        frame.at > this.clock() - 60000,
    );
    if (!learned.length) return original;
    const sourceHold = this.charges
      .filter(
        (charge) =>
          charge.lane === "source" &&
          charge.sent &&
          charge.weight > 0 &&
          (!charge.settled || charge.at > this.clock() - 60000),
      )
      .reduce(
        (maximum, charge) => Math.max(maximum, charge.boundedSourceHold ?? 0),
        0,
      );
    if (sourceHold <= 0) return original;
    const eligible = learned.filter((frame) => sourceHold > frame.paid);
    if (!eligible.length) return original;
    const overhang = Math.max(
      0,
      ...eligible.map((frame) => frame.demand! - frame.paid),
    );
    const allowance = originalAllowance - overhang - sourceHold;
    if (allowance <= 0) return original;
    const spacing = Math.ceil((weight * 60000) / allowance);
    return spacing <= Math.max(original, 60000) ? spacing : original;
  }
  private prune() {
    const now = this.clock();
    for (const [owner, attempt] of this.observationPlanAttempts)
      if (
        attempt.at < now - ACCOUNT_OBSERVATION_PLAN_TTL_MS &&
        this.observation?.owner !== owner &&
        !this.observationQueue.has(owner)
      )
        this.observationPlanAttempts.delete(owner);
    for (const [key, entry] of this.observationQueue) {
      if (entry.legacy && entry.legacySeen <= now - 120000)
        entry.legacy = false;
      if (
        !entry.legacy &&
        (entry.interests.size === 0 || entry.seen <= now - 120000)
      )
        this.observationQueue.delete(key);
    }
    this.charges = this.charges.filter(
      (c) => !c.sent || !c.settled || c.at > now - 60000,
    );
    for (const lane of ["account", "source"] as const)
      for (const [key, value] of this.owners[lane])
        if (
          value.lastSeen < now - 120000 &&
          value.pending === 0 &&
          !this.queues[lane].some((w) => w.owner === key) &&
          this.turns[lane]?.owner !== key
        )
          this.owners[lane].delete(key);
  }
  private used() {
    return this.charges.reduce((n, c) => n + c.weight, 0);
  }
  private sourceUsed() {
    return this.charges.reduce(
      (weight, charge) =>
        weight + (charge.lane === "source" ? charge.weight : 0),
      0,
    );
  }
  // Whole observations join a FIFO before spending any venue weight. A retry
  // keeps its place; a ready head's full capacity stays protected. Before its
  // pacing time, bounded sources may use the limited lane-share exception.
  // No account payload or completed evidence is retained here.
  restoreObservationPlan(
    owner: string,
    value: unknown,
    remainingTtlMs: number,
  ): boolean {
    const plan = validObservationCostPlan(value, this.limit);
    const now = this.clock();
    const existing = this.observationPlans.get(owner);
    if (existing && existing.seen < now - ACCOUNT_OBSERVATION_PLAN_TTL_MS)
      this.observationPlans.delete(owner);
    if (
      !plan ||
      !Number.isSafeInteger(remainingTtlMs) ||
      remainingTtlMs <= 0 ||
      remainingTtlMs > ACCOUNT_OBSERVATION_PLAN_TTL_MS ||
      this.observationPlans.has(owner) ||
      this.observationQueue.has(owner) ||
      this.observation?.owner === owner ||
      this.observationPlans.size >= 2048
    )
      return false;
    this.observationPlans.set(owner, {
      ...plan,
      seen: now - (ACCOUNT_OBSERVATION_PLAN_TTL_MS - remainingTtlMs),
      attempt: this.observationPlanAttempts.get(owner)?.token,
    });
    return true;
  }
  beginObservationPlanAttempt(owner: string): object {
    this.prune();
    if (
      this.observationPlanAttempts.size >= 2048 &&
      !this.observationPlanAttempts.has(owner)
    )
      throw this.denied(true);
    const token = {};
    this.observationPlanAttempts.set(owner, { token, at: this.clock() });
    return token;
  }
  observationPlanAttemptCurrent(owner: string, token: object): boolean {
    return this.observationPlanAttempts.get(owner)?.token === token;
  }
  invalidateObservationPlan(owner: string, token?: object): boolean {
    if (
      token &&
      !this.observationPlanAttemptCurrent(owner, token) &&
      this.observationPlans.get(owner)?.attempt !== token
    )
      return false;
    const removed = this.observationPlans.delete(owner);
    const queued = this.observationQueue.get(owner);
    const changed = queued !== undefined && queued.demand !== this.limit;
    if (queued) queued.demand = this.limit;
    return removed || changed;
  }
  refreshObservationPlan(
    owner: string,
    value: unknown,
    remainingTtlMs: number,
  ): boolean {
    const plan = validObservationCostPlan(value, this.limit);
    if (
      !plan ||
      !Number.isSafeInteger(remainingTtlMs) ||
      remainingTtlMs <= 0 ||
      remainingTtlMs > ACCOUNT_OBSERVATION_PLAN_TTL_MS
    ) {
      this.invalidateObservationPlan(owner);
      return false;
    }
    if (this.observation?.owner === owner) return false;
    if (this.observationPlans.size >= 2048 && !this.observationPlans.has(owner))
      return false;
    this.observationPlans.set(owner, {
      ...plan,
      seen: this.clock() - (ACCOUNT_OBSERVATION_PLAN_TTL_MS - remainingTtlMs),
      attempt: this.observationPlanAttempts.get(owner)?.token,
    });
    const queued = this.observationQueue.get(owner);
    if (queued) queued.demand = plan.demand;
    return true;
  }
  /** Read the next full demand without reserving, joining or renewing a FIFO. */
  peekObservationDemand(owner: string): number {
    const now = this.clock();
    const queued = this.observationQueue.get(owner);
    const plan = this.observationPlans.get(owner);
    if (!plan || plan.seen < now - ACCOUNT_OBSERVATION_PLAN_TTL_MS)
      return this.limit;
    return queued && queued.seen > now - 120000 ? queued.demand : plan.demand;
  }
  peekObservationFramePlan(owner: string, trialCapacity: number) {
    const fullDemand = this.peekObservationDemand(owner);
    const raw = this.observationPlans.get(owner);
    const plan =
      raw && raw.seen >= this.clock() - ACCOUNT_OBSERVATION_PLAN_TTL_MS
        ? validObservationCostPlan(raw, this.limit)
        : null;
    // Old partial -> complete learning can retain the full-window high-water
    // placeholder for its first two low samples. Preserve that hint and let
    // the same bounded trial gather its remaining COMPLETE scope samples.
    const conservativeFullHint =
      plan &&
      plan.demand === this.limit &&
      plan.peaks.length < 3 &&
      plan.peaks.every((peak) => peak + 20 <= trialCapacity);
    return {
      fullDemand,
      cold: fullDemand === this.limit && (!plan || !!conservativeFullHint),
    };
  }
  private observationEntry(owner: string, legacy: boolean) {
    let entry = this.observationQueue.get(owner);
    if (!entry) {
      if (
        this.observationQueue.size >= 256 ||
        (this.observationPlans.size >= 2048 &&
          !this.observationPlans.has(owner))
      )
        throw this.denied(true);
      const plan = this.observationPlans.get(owner);
      entry = {
        demand:
          plan && plan.seen >= this.clock() - ACCOUNT_OBSERVATION_PLAN_TTL_MS
            ? plan.demand
            : this.limit,
        seen: this.clock(),
        legacy,
        legacySeen: legacy ? this.clock() : 0,
        interests: new Set<object>(),
      };
      this.observationQueue.set(owner, entry);
    }
    if (legacy) {
      entry.legacy = true;
      entry.legacySeen = this.clock();
    }
    entry.seen = this.clock();
    return entry;
  }
  /** Called only AFTER a fleet grant. This reserves no fee or local ticket. */
  beginObservationInterest(owner: string): object {
    this.prune();
    if (this.observationInterests.size >= 256) throw costPlanUnavailable();
    const token = {};
    this.observationEntry(owner, false).interests.add(token);
    this.observationInterests.set(token, { owner, waiting: true });
    return token;
  }
  endObservationInterest(token: object): void {
    const interest = this.observationInterests.get(token);
    if (!interest) return;
    this.observationInterests.delete(token);
    if (!interest.waiting) return;
    this.prune();
    const entry = this.observationQueue.get(interest.owner);
    if (
      entry?.interests.delete(token) &&
      !entry.legacy &&
      entry.interests.size === 0
    )
      this.observationQueue.delete(interest.owner);
    this.pump();
  }
  beginObservation(
    owner: string,
    capacityTrial?: { fullDemand: number; reservedWeight: number },
    interestToken?: object,
    bundle?: { childLimit: number; count: 1 | 2 },
  ): AccountReadReservation {
    this.prune();
    const now = this.clock();
    for (const [key, entry] of this.observationPlans)
      if (entry.seen < now - ACCOUNT_OBSERVATION_PLAN_TTL_MS)
        this.observationPlans.delete(key);
    if (this.cooldownRemaining() > 0) throw this.coolingDown();
    const interest = interestToken
      ? this.observationInterests.get(interestToken)
      : undefined;
    if (interestToken && (!interest?.waiting || interest.owner !== owner))
      throw costPlanUnavailable();
    const entry = this.observationEntry(owner, interestToken === undefined);
    if (interestToken) entry.interests.add(interestToken);
    if (
      capacityTrial &&
      (!Number.isSafeInteger(capacityTrial.reservedWeight) ||
        capacityTrial.reservedWeight < Math.min(120, this.limit) ||
        capacityTrial.reservedWeight > this.limit ||
        capacityTrial.fullDemand !== entry.demand ||
        capacityTrial.fullDemand !== this.limit ||
        !this.peekObservationFramePlan(owner, capacityTrial.reservedWeight)
          .cold)
    )
      throw costPlanUnavailable();
    if (
      bundle &&
      (!Number.isSafeInteger(bundle.childLimit) ||
        bundle.childLimit < 120 ||
        ![1, 2].includes(bundle.count) ||
        bundle.childLimit * bundle.count > this.limit ||
        (capacityTrial
          ? bundle.count !== 1 ||
            bundle.childLimit !== capacityTrial.reservedWeight
          : bundle.childLimit !== entry.demand))
    )
      throw costPlanUnavailable();
    const reservedWeight = bundle
      ? bundle.childLimit * bundle.count
      : (capacityTrial?.reservedWeight ?? entry.demand);
    const first = this.observationQueue.keys().next().value;
    if (this.observation || first !== owner) {
      this.observations.deferred++;
      this.pump();
      throw new ObservationAdmissionDeferred(
        this.observation ? "READ_LOCAL_BUSY" : "READ_LOCAL_FIFO",
        interestToken
          ? 1000
          : Math.min(
              60000,
              Math.max(1000, Math.ceil(this.nextObservationAt - now)),
            ),
      );
    }
    if (now < this.nextObservationAt) {
      this.observations.deferred++;
      const retry = Math.min(
        60000,
        Math.max(1, Math.ceil(this.nextObservationAt - now)),
      );
      // Legacy retry hints remain unchanged. Fleet callers can distinguish
      // the actual hard gate and may only recheck it before any local ticket.
      if (
        this.exclusive ||
        now < this.blockedUntil ||
        this.used() + reservedWeight > this.limit
      )
        throw new ObservationAdmissionDeferred(
          this.exclusive
            ? "READ_LOCAL_EXCLUSIVE"
            : now < this.blockedUntil
              ? "READ_LOCAL_QUARANTINE"
              : "READ_LOCAL_QUOTA",
          interestToken
            ? this.exclusive
              ? 1000
              : now < this.blockedUntil
                ? Math.min(
                    60000,
                    Math.max(1, Math.ceil(this.blockedUntil - now)),
                  )
                : this.denied(true, reservedWeight).details!.retry_after_ms!
            : retry,
        );
      throw new ObservationPacingDeferred(retry);
    }
    if (this.exclusive) {
      this.observations.deferred++;
      throw new ObservationAdmissionDeferred("READ_LOCAL_EXCLUSIVE", 1000);
    }
    if (now < this.blockedUntil || this.used() + reservedWeight > this.limit) {
      this.observations.deferred++;
      const error = this.denied(true, reservedWeight);
      this.pump();
      if (!interestToken) throw error;
      throw new ObservationAdmissionDeferred(
        now < this.blockedUntil ? "READ_LOCAL_QUARANTINE" : "READ_LOCAL_QUOTA",
        error.details!.retry_after_ms!,
      );
    }
    if (interestToken) {
      entry.interests.delete(interestToken);
      interest!.waiting = false;
    } else entry.legacy = false;
    if (!entry.legacy && entry.interests.size === 0)
      this.observationQueue.delete(owner);
    let learnedCostPlan: ObservationCostPlan | null = null;
    const ticket: AccountReadReservation = {
      id: ++this.observationSequence,
      weight: reservedWeight,
      fullDemand: entry.demand,
      capacityTrial: capacityTrial !== undefined,
      costPlan: () =>
        learnedCostPlan
          ? {
              demand: learnedCostPlan.demand,
              peaks: [...learnedCostPlan.peaks],
            }
          : null,
      close: (complete = false) => {
        if (this.observation?.ticket !== ticket) return;
        this.observation.closed = true;
        this.observation.complete = complete;
        if (this.observation.bundle) {
          for (const lane of ["account", "source"] as const)
            for (const waiter of [...this.queues[lane]])
              if (this.ownsObservation(waiter.observation)) {
                this.queues[lane].splice(this.queues[lane].indexOf(waiter), 1);
                waiter.signal.removeEventListener("abort", waiter.cancel);
                this.observation.sampleInvalid = true;
                waiter.reject(this.observationDeferred(1000));
              }
        }
        if (
          [...this.queues.account, ...this.queues.source].some(
            (waiter) => waiter.observation === ticket,
          )
        )
          this.observation.sampleInvalid = true;
        if (
          capacityTrial &&
          complete &&
          (this.observation.pending > 0 ||
            this.observation.hadUncertain ||
            this.observation.sampleInvalid ||
            this.observation.trialExceeded)
        ) {
          this.observation.complete = false;
          this.finishObservation();
          throw this.trialExhausted();
        }
        this.finishObservation();
      },
    };
    this.observation = {
      ticket,
      owner,
      remaining: reservedWeight,
      committed: 0,
      peak: 0,
      pending: 0,
      closed: false,
      complete: false,
      grew: false,
      hadUncertain: false,
      sampleInvalid: false,
      admittedPeak: 0,
      started: now,
      publishCostPlan: (plan) => {
        learnedCostPlan = plan;
      },
      previousPlan:
        this.observationPlans.has(owner) &&
        (!capacityTrial ||
          validObservationCostPlan(
            this.observationPlans.get(owner),
            this.limit,
          ))
          ? {
              demand: this.observationPlans.get(owner)!.demand,
              peaks: [...this.observationPlans.get(owner)!.peaks],
            }
          : undefined,
      planAttempt: this.observationPlanAttempts.get(owner)?.token,
      ...(capacityTrial ? { capacityTrialLimit: reservedWeight } : {}),
      ...(bundle
        ? {
            bundle: {
              limit: bundle.childLimit,
              count: bundle.count,
              opened: 0,
            },
          }
        : {}),
    };
    this.observations.started++;
    if (this.recentObservationWeights.length) {
      const weight =
        this.recentObservationWeights.reduce((sum, value) => sum + value, 0) /
        this.recentObservationWeights.length;
      this.nextObservationAt = Math.max(
        this.nextObservationAt,
        now + this.observationPacingMs(weight),
      );
    }
    return ticket;
  }
  beginObservationBundle(
    owner: string,
    childLimit: number,
    count: 1 | 2,
    interestToken: object,
    cold = false,
  ): AccountReadBundle {
    const ticket = this.beginObservation(
      owner,
      cold ? { fullDemand: this.limit, reservedWeight: childLimit } : undefined,
      interestToken,
      { childLimit, count },
    );
    const openChild = (supplement = false) => {
      const parent = this.observation;
      if (
        parent?.ticket !== ticket ||
        parent.closed ||
        parent.sampleInvalid ||
        !parent.bundle ||
        parent.bundle.child ||
        (supplement
          ? parent.bundle.opened < 1 ||
            parent.bundle.supplementRemaining === undefined
          : parent.bundle.opened >= count)
      )
        throw costPlanUnavailable();
      const scopeLimit = supplement
        ? parent.bundle.supplementRemaining!
        : childLimit;
      let learned: ObservationCostPlan | null = null;
      const childTicket: AccountReadReservation = {
        id: ++this.observationSequence,
        weight: scopeLimit,
        fullDemand: ticket.fullDemand,
        capacityTrial: cold,
        costPlan: () => (learned ? structuredClone(learned) : null),
        close: (complete = false) => {
          const child = parent.bundle?.child;
          if (
            this.observation !== parent ||
            parent.closed ||
            child?.ticket !== childTicket ||
            child.closed
          )
            return;
          child.closed = true;
          child.complete = complete;
          if (
            child.pending ||
            [...this.queues.account, ...this.queues.source].some(
              (w) => w.observation === childTicket,
            )
          ) {
            child.sampleInvalid = true;
            child.complete = false;
          }
          if (child.hadUncertain || child.sampleInvalid || child.trialExceeded)
            child.complete = false;
          if (child.complete && !supplement && child.committed > 0)
            this.learnObservation(child);
          if (supplement)
            parent.bundle!.supplementRemaining = Math.max(
              0,
              parent.bundle!.supplementRemaining! - child.committed,
            );
          else if (child.complete && parent.bundle!.opened === 1)
            parent.bundle!.supplementRemaining = Math.max(
              0,
              childLimit - child.committed,
            );
          if (!child.complete) {
            parent.sampleInvalid = true;
            if (
              !supplement &&
              (child.committed || child.hadUncertain || child.sampleInvalid)
            )
              this.invalidateObservationPlan(owner, child.planAttempt);
          }
          if (!child.pending) parent.bundle!.child = undefined;
          if (complete && !child.complete) throw this.trialExhausted();
        },
      };
      const prior = this.observationPlans.get(owner);
      if (!supplement) parent.bundle.opened++;
      parent.bundle.child = {
        ticket: childTicket,
        owner,
        remaining: scopeLimit,
        committed: 0,
        peak: 0,
        pending: 0,
        closed: false,
        complete: false,
        grew: false,
        hadUncertain: false,
        sampleInvalid: false,
        admittedPeak: 0,
        started: this.clock(),
        capacityTrialLimit: scopeLimit,
        supplement,
        publishCostPlan: (value) => {
          learned = value;
        },
        previousPlan:
          prior && validObservationCostPlan(prior, this.limit)
            ? { demand: prior.demand, peaks: [...prior.peaks] }
            : undefined,
        planAttempt: this.observationPlanAttempts.get(owner)?.token,
      };
      return childTicket;
    };
    return Object.assign(ticket, {
      childLimit,
      childCount: count,
      beginChild: () => openChild(),
      beginSupplement: () => openChild(true),
      assertNextChildReady: () => {
        const parent = this.observation;
        if (
          parent?.ticket !== ticket ||
          parent.closed ||
          parent.sampleInvalid ||
          !parent.bundle ||
          parent.bundle.count !== 2 ||
          parent.bundle.opened !== 1 ||
          parent.bundle.child ||
          parent.remaining <
            childLimit + (parent.bundle.supplementRemaining ?? 0)
        )
          throw costPlanUnavailable();
      },
    });
  }
  private ownsObservation(ticket: AccountReadReservation | undefined) {
    return (
      !!ticket &&
      (this.observation?.ticket === ticket ||
        this.observation?.bundle?.child?.ticket === ticket)
    );
  }
  private observationMeter(
    ticket: AccountReadReservation | undefined,
  ): Observation | undefined {
    if (!ticket) return undefined;
    return this.observation?.bundle?.child?.ticket === ticket
      ? this.observation.bundle.child
      : this.observation?.ticket === ticket
        ? this.observation
        : undefined;
  }
  private observationDeferred(retry: number) {
    return new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "Complete account observation is queued before venue reads begin.",
      true,
      503,
      { retry_after_ms: retry, reason_code: "READ_LOCAL_TICKET_STALE" },
    );
  }
  private learnObservation(frame: Observation) {
    // Include a metadata miss margin. An expanding scope/history raises the
    // high-water mark before admission and fails closed if it cannot fit.
    const previous =
      frame.previousPlan?.demand ?? (frame.complete ? 0 : this.limit);
    const peaks = frame.complete
      ? [...(frame.previousPlan?.peaks ?? []), frame.peak].slice(-3)
      : [];
    this.observationPlans.set(frame.owner, {
      demand: Math.min(
        this.limit,
        Math.max(
          120,
          peaks.length < 3 ? previous : 0,
          frame.peak + 20,
          ...peaks.map((peak) => peak + 20),
          frame.grew ? previous * 2 : 0,
        ),
      ),
      seen: this.clock(),
      peaks,
      attempt: frame.planAttempt,
    });
    const queued = this.observationQueue.get(frame.owner);
    if (queued) queued.demand = this.observationPlans.get(frame.owner)!.demand;
    if (
      frame.complete &&
      !frame.hadUncertain &&
      !frame.sampleInvalid &&
      frame.committed > 0
    ) {
      const plan = validObservationCostPlan(
        this.observationPlans.get(frame.owner),
        this.limit,
      );
      if (plan) frame.publishCostPlan(plan);
    }
  }
  private finishObservation() {
    const frame = this.observation;
    if (!frame?.closed || frame.pending) return;
    // Fleet admission may reject before the first dispatch. That is no cost
    // sample and no evidence of scope growth: preserve a valid learned hint
    // rather than replacing it with the cold full-window placeholder.
    if (
      !frame.complete &&
      frame.committed === 0 &&
      !frame.grew &&
      !frame.hadUncertain &&
      !frame.sampleInvalid
    ) {
      this.observation = undefined;
      this.pump();
      return;
    }
    if (!frame.bundle) this.learnObservation(frame);
    // Spread complete frames rather than spending the window in a burst.
    // Settled ledger costs form the base; unknown charges keep their original
    // conservative weight. Qualified known cost samples and real source bounds
    // can add bounded soft spacing, without treating a hold as a paid fee.
    // The original share, full reservations and hard ledger remain unchanged.
    if (frame.complete)
      this.recentObservationWeights = [
        ...this.recentObservationWeights,
        Math.min(this.limit, frame.committed),
      ].slice(-5);
    if (frame.complete) {
      const demand =
        this.observationPlans.get(frame.owner)?.demand ?? this.limit;
      this.recentSuccessfulObservationFrames = [
        ...this.recentSuccessfulObservationFrames,
        {
          paid: frame.committed,
          peak: frame.admittedPeak,
          at: this.clock(),
          demand:
            !frame.hadUncertain &&
            !frame.sampleInvalid &&
            demand < this.limit &&
            frame.committed > 0 &&
            frame.committed <= demand
              ? demand
              : null,
        },
      ].slice(-5);
    }
    const pacedWeight = this.recentObservationWeights.length
      ? this.recentObservationWeights.reduce((sum, weight) => sum + weight, 0) /
        this.recentObservationWeights.length
      : Math.min(this.limit, frame.committed);
    this.nextObservationAt = Math.max(
      this.nextObservationAt,
      frame.started + this.observationPacingMs(pacedWeight),
    );
    const queued = this.observationQueue.get(frame.owner);
    if (queued)
      queued.demand =
        this.observationPlans.get(frame.owner)?.demand ?? this.limit;
    if (frame.complete) this.observations.completed++;
    if (frame.grew) this.observations.growth++;
    this.observation = undefined;
    this.pump();
  }
  private protectedWeight(observation?: AccountReadReservation) {
    if (this.observation) {
      const meter = this.observationMeter(observation);
      return meter
        ? Math.max(0, this.observation.remaining - meter.remaining)
        : this.observation.remaining;
    }
    return this.observationQueue.values().next().value?.demand ?? 0;
  }
  private canBorrowPacingWeight(waiter: Waiter) {
    const share = Math.floor(this.limit * 0.2);
    const head = this.observationQueue.values().next().value;
    return (
      waiter.lane === "source" &&
      !waiter.unknownSurcharge &&
      !waiter.observation &&
      !this.observation &&
      head !== undefined &&
      // Cold/full-window frames must retain an entirely free budget window.
      head.demand < this.limit &&
      this.clock() < this.nextObservationAt &&
      this.sourceUsed() < share &&
      waiter.cost <= share
    );
  }
  cooldownRemaining() {
    return Math.max(0, Math.ceil(this.providerUntil - this.clock()));
  }
  private coolingDown() {
    return new AgentError(
      "VENUE_RATE_LIMITED",
      "Venue reads are cooling down after a rate limit. Existing settings are preserved; execution needs fresh account evidence.",
      true,
      503,
      {
        retry_after_ms: Math.min(60000, Math.max(1, this.cooldownRemaining())),
      },
    );
  }
  note429(retryMs: number) {
    // A provider 429 proves that its shared IP window is unavailable even if
    // our process-local ledger has room. Do not probe after only 1–16 seconds,
    // or treat an unrelated in-flight success as a reset of that whole window.
    const providerWait = Number.isFinite(retryMs) ? Math.max(0, retryMs) : 0;
    this.providerUntil = Math.max(
      this.providerUntil,
      this.clock() + Math.max(60000, providerWait),
    );
    for (const lane of ["account", "source"] as const) {
      for (const waiter of this.queues[lane]) {
        waiter.signal.removeEventListener("abort", waiter.cancel);
        const meter = this.observationMeter(waiter.observation);
        if (meter) meter.sampleInvalid = true;
        waiter.reject(this.coolingDown());
      }
      this.queues[lane] = [];
    }
    this.pump();
  }
  private denied(budget: boolean, cost = 1) {
    const at = this.clock();
    this.prune();
    const used = this.used();
    let remaining = used;
    let next = at;
    // Expiring one cheap request may still leave no room for this request's
    // full reservation. Advise the first expiry that can admit its whole cost,
    // not the first expiry in the window (which caused premature retries).
    for (const charge of this.charges
      .filter((c) => c.sent && c.settled)
      .sort((a, b) => a.at - b.at)) {
      if (remaining + cost <= this.limit) break;
      remaining -= charge.weight;
      next = charge.at + 60000;
    }
    if (remaining + cost > this.limit) next = at + 60000;
    // An unsettled reservation can still refund unused response weight (or
    // be released before sending). Use that optimistic floor only to advise
    // a local recheck; admission continues to count every held charge.
    // Uncertain sent requests are settled at their retained weight and must
    // wait for the real rolling expiry, just like known completed requests.
    const pendingWeight = this.charges.reduce(
      (sum, charge) => sum + (charge.settled ? 0 : charge.weight),
      0,
    );
    if (
      budget &&
      pendingWeight > 0 &&
      used + cost > this.limit &&
      used - pendingWeight + cost <= this.limit
    )
      next = Math.min(next, at + 1000);
    next = Math.max(next, this.blockedUntil);
    return new AgentError(
      budget ? "VENUE_READ_BUDGET_EXHAUSTED" : "VENUE_READ_DEADLINE",
      budget
        ? "Local venue read budget could not admit this read before its deadline."
        : "Venue read queue deadline expired.",
      true,
      503,
      {
        retry_after_ms: Math.min(60000, Math.max(1, Math.ceil(next - at))),
        ...(budget ? { reason_code: UNSENT_READ_BUDGET_REASON } : {}),
      },
    );
  }
  private trialExhausted() {
    return new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "Complete account scope exceeds its explicit capacity trial; fresh complete evidence is still required.",
      true,
      503,
      { retry_after_ms: 60000, reason_code: "READ_FRAME_CAPACITY" },
    );
  }
  acquire(
    lane: ReadLane,
    cost: number,
    owner: string | undefined,
    signal: AbortSignal,
    unknownSurcharge = false,
    observation?: AccountReadReservation,
  ): Promise<ReadTicket> {
    const reject = (error: Error): Promise<ReadTicket> => {
      const meter = this.observationMeter(observation);
      if (meter) meter.sampleInvalid = true;
      return Promise.reject(error);
    };
    if (this.cooldownRemaining() > 0) return reject(this.coolingDown());
    if (
      !Number.isSafeInteger(cost) ||
      cost <= 0 ||
      cost > this.limit ||
      signal.aborted ||
      this.queues.account.length + this.queues.source.length >= 256
    )
      return reject(this.denied(true));
    if (
      observation &&
      (!this.ownsObservation(observation) ||
        this.observation!.closed ||
        this.observationMeter(observation)?.closed ||
        (this.observation!.bundle && observation === this.observation!.ticket))
    )
      return reject(this.observationDeferred(1000));
    if (observation) {
      const frame = this.observationMeter(observation)!;
      frame.peak = Math.max(frame.peak, frame.committed + cost);
      if (
        frame.capacityTrialLimit !== undefined &&
        (frame.trialExceeded || (cost > frame.remaining && frame.pending === 0))
      ) {
        frame.trialExceeded = true;
        return reject(this.trialExhausted());
      }
      if (
        !this.exclusive &&
        cost > frame.remaining &&
        this.used() + cost > this.limit
      ) {
        frame.grew = true;
        frame.sampleInvalid = true;
        return reject(this.denied(true, cost));
      }
    }
    const ownerKey = owner ?? "";
    {
      const owners = this.owners[lane];
      if (!owners.has(ownerKey)) {
        if (owners.size >= 2048) return reject(this.denied(true));
        const baseline = owners.size
          ? Math.min(...[...owners.values()].map((x) => x.served - x.pending))
          : 0;
        owners.set(ownerKey, {
          served: baseline,
          pending: 0,
          lastSeen: this.clock(),
          lastTurn: -1,
        });
      } else owners.get(ownerKey)!.lastSeen = this.clock();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        lane,
        owner: ownerKey,
        cost,
        unknownSurcharge,
        signal,
        resolve,
        reject,
        budgetBlocked: false,
        observation,
        cancel: () => {},
      };
      waiter.cancel = () => {
        const index = this.queues[lane].indexOf(waiter);
        if (index < 0) return;
        this.queues[lane].splice(index, 1);
        const meter = this.observationMeter(observation);
        if (meter) meter.sampleInvalid = true;
        signal.removeEventListener("abort", waiter.cancel);
        reject(this.denied(waiter.budgetBlocked, waiter.cost));
        this.pump();
      };
      this.queues[lane].push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
      this.pump();
    });
  }
  // Provider contract violations cannot be turned into cheap responses. Stop
  // further admission for a complete window; callers receive no fresh value.
  quarantine() {
    this.blockedUntil = this.clock() + 60000;
    this.pump();
  }
  private candidate(
    lane: ReadLane,
    deferredGrace?: (until: number) => void,
  ): Waiter | undefined {
    const queue =
      lane === "account" && this.observation
        ? this.queues.account.filter((w) => this.ownsObservation(w.observation))
        : this.queues[lane];
    // A reserved complete frame may use two bounded wire reads concurrently.
    // The same weighted ledger still reserves every request before dispatch;
    // unknown surcharges retain their global exclusive gate.
    const slots =
      lane === "account" && this.observation
        ? Math.max(2, this.slots)
        : this.slots;
    if (!queue.length || this.active[lane] >= slots) return;
    const now = this.clock(),
      turn = this.turns[lane];
    if (
      turn &&
      (turn.served >=
        (turn.owner === "" ? Math.min(160, this.limit) : this.limit) ||
        now - turn.started >= (lane === "account" ? 20000 : 12000))
    )
      delete this.turns[lane];
    const current = this.turns[lane];
    if (current) {
      const same = queue.find((w) => w.owner === current.owner);
      if (same) return same;
      const shared = queue.find((w) => w.owner === "");
      if (shared && current.owner !== "" && current.sharedReads < 3)
        return shared;
      // Allow dependent Promise.all stages to enqueue without switching
      // account halfway through its full-scope observation.
      if (now - current.lastActivity < 2) {
        deferredGrace?.(current.lastActivity + 2);
        return;
      }
      delete this.turns[lane];
    }
    const chosen = queue.reduce((best, next) => {
      const a = this.owners[lane].get(next.owner)!,
        b = this.owners[lane].get(best.owner)!;
      return a.served < b.served ||
        (a.served === b.served && a.lastTurn < b.lastTurn)
        ? next
        : best;
    });
    this.owners[lane].get(chosen.owner)!.lastTurn = ++this.turnSequence;
    this.turns[lane] = {
      owner: chosen.owner,
      started: now,
      lastActivity: now,
      served: 0,
      sharedReads: 0,
    };
    return chosen;
  }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    if (this.wake !== undefined) this.timers.clearTimeout(this.wake);
    this.wake = undefined;
    let deferredGrace: number | undefined;
    try {
      this.prune();
      for (;;) {
        if (this.cooldownRemaining() > 0) break;
        // An unknown response temporarily holds all free weight. Do not let
        // that provisional hold expire/switch its owner's turn before the
        // actual response cost is settled and the hold is refunded.
        if (this.exclusive) break;
        const first = this.lastLane === "account" ? "source" : "account";
        let candidateGrace: number | undefined;
        const defer = (until: number) => {
          candidateGrace = Math.min(candidateGrace ?? Infinity, until);
        };
        const candidates = [
          this.candidate(first, defer),
          this.candidate(first === "account" ? "source" : "account", defer),
        ];
        const next =
          candidates.find(
            (w) =>
              w &&
              this.ownsObservation(w.observation) &&
              this.observation !== undefined,
          ) ?? candidates.find(Boolean);
        if (!next) {
          // Preserve the deadline that actually prevented selection. It may
          // expire before the later scheduling clock read; reselect once then
          // instead of sleeping until the whole20s/12s owner turn expires.
          deferredGrace = candidateGrace;
          break;
        }
        const trialFrame = this.observationMeter(next.observation);
        if (
          trialFrame?.capacityTrialLimit !== undefined &&
          (trialFrame.trialExceeded || next.cost > trialFrame.remaining)
        ) {
          // A response already in flight may return conservative excess. Wait
          // for its actual settlement, but never dispatch against the unused
          // local1000 headroom outside this explicit trial's780 reservation.
          if (!trialFrame.trialExceeded && trialFrame.pending > 0) break;
          this.queues[next.lane].splice(
            this.queues[next.lane].indexOf(next),
            1,
          );
          next.signal.removeEventListener("abort", next.cancel);
          trialFrame.trialExceeded = true;
          trialFrame.sampleInvalid = true;
          next.reject(this.trialExhausted());
          continue;
        }
        if (
          next.unknownSurcharge &&
          (this.active.account > 0 || this.active.source > 0)
        )
          break;
        const used = this.used(),
          protectedWeight = this.protectedWeight(next.observation),
          borrow =
            used + next.cost + protectedWeight > this.limit &&
            this.canBorrowPacingWeight(next),
          protection = borrow ? 0 : protectedWeight;
        if (
          this.clock() < this.blockedUntil ||
          used + next.cost > this.limit ||
          used + next.cost + protection > this.limit
        ) {
          // Do not endlessly backfill cheap source reads in front of a larger
          // account request. The next turn owns the next available capacity.
          for (const waiter of [...this.queues.account, ...this.queues.source])
            waiter.budgetBlocked = true;
          break;
        }
        this.queues[next.lane].splice(this.queues[next.lane].indexOf(next), 1);
        next.signal.removeEventListener("abort", next.cancel);
        const frame = next.observation ? this.observation! : undefined;
        const meter = this.observationMeter(next.observation);
        const charge: Charge = {
          at: this.clock(),
          lane: next.lane,
          weight: next.unknownSurcharge
            ? Math.min(
                this.limit - used - protection,
                meter?.capacityTrialLimit !== undefined
                  ? meter.remaining
                  : Infinity,
              )
            : next.cost,
          sent: false,
          settled: false,
          ...(next.lane === "source" &&
          !next.unknownSurcharge &&
          next.cost >= 100
            ? { boundedSourceHold: next.cost }
            : {}),
        };
        // One bounded request may cross the soft source share before the FIFO
        // head's pacing time. It never predicts refunds or guarantees that the
        // head will fit then; every paid/held charge keeps its real expiry.
        if (borrow) this.sourcePacingLoans++;
        this.charges.push(charge);
        const held = frame ? Math.min(frame.remaining, charge.weight) : 0;
        const measured = next.unknownSurcharge ? next.cost : charge.weight;
        if (frame) {
          frame.remaining -= held;
          frame.committed += measured;
          frame.peak = Math.max(frame.peak, frame.committed);
          frame.admittedPeak = Math.max(frame.admittedPeak, frame.committed);
          frame.pending++;
        }
        if (meter && meter !== frame) {
          meter.remaining -= Math.min(meter.remaining, charge.weight);
          meter.committed += measured;
          meter.peak = Math.max(meter.peak, meter.committed);
          meter.admittedPeak = Math.max(meter.admittedPeak, meter.committed);
          meter.pending++;
        }
        this.active[next.lane]++;
        this.lastLane = next.lane;
        const turn = this.turns[next.lane];
        const reservation = charge.weight;
        if (next.unknownSurcharge) this.exclusive = charge;
        this.owners[next.lane].get(next.owner)!.served += reservation;
        this.owners[next.lane].get(next.owner)!.pending += reservation;
        if (turn) {
          turn.served += reservation;
          if (next.owner === "" && turn.owner !== "") turn.sharedReads++;
        }
        let released = false;
        const uncertain = () => {
          if (!charge.sent || charge.settled) return;
          charge.settled = true;
          if (frame) frame.hadUncertain = true;
          if (meter) meter.hadUncertain = true;
          charge.at = this.clock();
          this.owners[next.lane].get(next.owner)!.pending -= reservation;
          if (next.unknownSurcharge)
            this.blockedUntil = Math.max(this.blockedUntil, charge.at + 60000);
          if (frame && next.unknownSurcharge) {
            frame.committed += charge.weight - measured;
            frame.peak = Math.max(frame.peak, frame.committed);
          }
          if (meter && meter !== frame && next.unknownSurcharge) {
            meter.committed += charge.weight - measured;
            meter.peak = Math.max(meter.peak, meter.committed);
          }
        };
        next.resolve({
          reservation,
          sent: () => {
            if (released || charge.sent) return;
            charge.sent = true;
            charge.at = this.clock();
          },
          settle: (weight) => {
            if (released || charge.settled) return;
            if (!charge.sent)
              throw new RangeError("An unattempted venue read cannot settle");
            if (
              !Number.isSafeInteger(weight) ||
              weight < 0 ||
              (!next.unknownSurcharge && weight > charge.weight)
            )
              throw new RangeError("Invalid venue weight settlement");
            const refund = charge.weight - weight;
            if (frame && weight === 0) frame.sampleInvalid = true;
            charge.weight = weight;
            charge.settled = true;
            charge.at = this.clock();
            if (frame) {
              frame.committed += weight - measured;
              frame.remaining += Math.max(0, held - weight);
              frame.peak = Math.max(frame.peak, frame.committed);
              if (
                frame.capacityTrialLimit !== undefined &&
                frame.committed > frame.capacityTrialLimit
              ) {
                frame.trialExceeded = true;
                frame.sampleInvalid = true;
              }
            }
            if (meter && meter !== frame) {
              if (weight === 0) meter.sampleInvalid = true;
              meter.committed += weight - measured;
              meter.remaining += Math.max(0, held - weight);
              meter.peak = Math.max(meter.peak, meter.committed);
              if (meter.committed > meter.capacityTrialLimit!) {
                meter.trialExceeded = true;
                meter.sampleInvalid = true;
              }
            }
            this.owners[next.lane].get(next.owner)!.served -= refund;
            this.owners[next.lane].get(next.owner)!.pending -= reservation;
            if (turn) turn.served -= refund;
            this.pump();
            // The full actual fee is already recorded above, including debt.
            // It cannot become a successful or partial account observation.
            if (frame?.trialExceeded || meter?.trialExceeded)
              throw this.trialExhausted();
          },
          uncertain,
          release: () => {
            if (released) return;
            released = true;
            uncertain();
            if (!charge.sent) {
              if (frame) frame.sampleInvalid = true;
              this.charges = this.charges.filter((c) => c !== charge);
              this.owners[next.lane].get(next.owner)!.served -= charge.weight;
              this.owners[next.lane].get(next.owner)!.pending -= reservation;
              if (turn) turn.served -= charge.weight;
              if (frame) {
                frame.committed -= measured;
                frame.remaining += held;
              }
              if (meter && meter !== frame) {
                meter.sampleInvalid = true;
                meter.committed -= measured;
                meter.remaining += held;
              }
            }
            this.active[next.lane]--;
            if (this.exclusive === charge) this.exclusive = undefined;
            if (turn) turn.lastActivity = this.clock();
            if (frame) {
              frame.pending--;
              if (meter && meter !== frame) {
                meter.pending--;
                if (
                  meter.closed &&
                  !meter.pending &&
                  frame.bundle?.child === meter
                )
                  frame.bundle.child = undefined;
              }
              this.finishObservation();
            }
            this.pump();
          },
        });
      }
      if (this.queues.account.length || this.queues.source.length) {
        const now = this.clock();
        const expiry = this.charges
          .filter((c) => c.sent && c.settled)
          .reduce((n, c) => Math.min(n, c.at + 60000), now + 60000);
        const turnExpiry = Object.entries(this.turns).reduce((n, [lane, t]) => {
          const expires = t.started + (lane === "account" ? 20000 : 12000);
          return Math.min(n, expires > now ? expires : n);
        }, expiry);
        const grace = Object.values(this.turns)
          .filter((t) => now - t.lastActivity < 2)
          .reduce((n, t) => Math.min(n, t.lastActivity + 2), expiry);
        const interestExpiry = [...this.observationQueue.values()].reduce(
          (n, e) => Math.min(n, e.seen + 120000),
          expiry,
        );
        this.wake = this.timers.setTimeout(
          () => this.pump(),
          Math.max(
            1,
            Math.min(
              expiry,
              turnExpiry,
              grace,
              deferredGrace ?? expiry,
              interestExpiry,
              this.blockedUntil > now ? this.blockedUntil : expiry,
            ) - now,
          ),
        );
        (this.wake as { unref?: () => void })?.unref?.();
      }
    } finally {
      this.pumping = false;
    }
  }
}

export const sharedVenueReadBudget = new VenueReadBudget();
