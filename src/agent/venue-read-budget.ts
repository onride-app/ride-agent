import { AgentError } from "./contracts.js";

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

type Charge = { at: number; weight: number; sent: boolean; settled: boolean };
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
  close(complete?: boolean): void;
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
  started: number;
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
    { demand: number; seen: number }
  >();
  private observationPlans = new Map<
    string,
    { demand: number; seen: number; peaks: number[] }
  >();
  private nextObservationAt = 0;
  private recentObservationWeights: number[] = [];
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
  private prune() {
    const now = this.clock();
    for (const [key, entry] of this.observationQueue)
      if (entry.seen <= now - 120000) this.observationQueue.delete(key);
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
  // Whole observations join a FIFO before spending any venue weight. A retry
  // keeps its place; cheap background reads cannot consume the head's capacity.
  // No account payload or completed evidence is retained here.
  beginObservation(owner: string): AccountReadReservation {
    this.prune();
    const now = this.clock();
    for (const [key, entry] of this.observationPlans)
      if (entry.seen < now - 600000) this.observationPlans.delete(key);
    if (this.cooldownRemaining() > 0) throw this.coolingDown();
    let entry = this.observationQueue.get(owner);
    if (!entry) {
      if (
        this.observationQueue.size >= 256 ||
        (this.observationPlans.size >= 2048 &&
          !this.observationPlans.has(owner))
      )
        throw this.denied(true);
      entry = {
        demand: this.observationPlans.get(owner)?.demand ?? this.limit,
        seen: now,
      };
      this.observationQueue.set(owner, entry);
    }
    entry.seen = now;
    const first = this.observationQueue.keys().next().value;
    if (this.observation || first !== owner) {
      this.observations.deferred++;
      this.pump();
      throw this.observationDeferred(
        Math.min(
          60000,
          Math.max(1000, Math.ceil(this.nextObservationAt - now)),
        ),
      );
    }
    if (now < this.nextObservationAt) {
      this.observations.deferred++;
      throw this.observationDeferred(
        Math.min(60000, Math.max(1, Math.ceil(this.nextObservationAt - now))),
      );
    }
    if (this.exclusive) {
      this.observations.deferred++;
      throw this.observationDeferred(1000);
    }
    if (now < this.blockedUntil || this.used() + entry.demand > this.limit) {
      this.observations.deferred++;
      const error = this.denied(true, entry.demand);
      this.pump();
      throw error;
    }
    this.observationQueue.delete(owner);
    const ticket: AccountReadReservation = {
      id: ++this.observationSequence,
      close: (complete = false) => {
        if (this.observation?.ticket !== ticket) return;
        this.observation.closed = true;
        this.observation.complete = complete;
        this.finishObservation();
      },
    };
    this.observation = {
      ticket,
      owner,
      remaining: entry.demand,
      committed: 0,
      peak: 0,
      pending: 0,
      closed: false,
      complete: false,
      grew: false,
      started: now,
    };
    this.observations.started++;
    if (this.recentObservationWeights.length) {
      const weight =
        this.recentObservationWeights.reduce((sum, value) => sum + value, 0) /
        this.recentObservationWeights.length;
      this.nextObservationAt = Math.max(
        this.nextObservationAt,
        now + Math.ceil((weight * 60000) / (this.limit * 0.8)),
      );
    }
    return ticket;
  }
  private observationDeferred(retry: number) {
    return new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "Complete account observation is queued before venue reads begin.",
      true,
      503,
      { retry_after_ms: retry },
    );
  }
  private finishObservation() {
    const frame = this.observation;
    if (!frame?.closed || frame.pending) return;
    // Include a metadata miss margin. An expanding scope/history raises the
    // high-water mark before admission and fails closed if it cannot fit.
    const previous =
      this.observationPlans.get(frame.owner)?.demand ??
      (frame.complete ? 0 : this.limit);
    const peaks = frame.complete
      ? [
          ...(this.observationPlans.get(frame.owner)?.peaks ?? []),
          frame.peak,
        ].slice(-3)
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
    });
    // Spread complete frames rather than spending a minute's capacity in a
    // short burst followed by stale snapshots. Actual sent weight determines
    // pacing; bounded/unknown provisional holds never manufacture a delay.
    // Leave twenty percent for public sources and independent account reads.
    if (frame.complete)
      this.recentObservationWeights = [
        ...this.recentObservationWeights,
        Math.min(this.limit, frame.committed),
      ].slice(-5);
    const pacedWeight = this.recentObservationWeights.length
      ? this.recentObservationWeights.reduce((sum, weight) => sum + weight, 0) /
        this.recentObservationWeights.length
      : Math.min(this.limit, frame.committed);
    this.nextObservationAt = Math.max(
      this.nextObservationAt,
      frame.started + Math.ceil((pacedWeight * 60000) / (this.limit * 0.8)),
    );
    const queued = this.observationQueue.get(frame.owner);
    if (queued) queued.demand = this.observationPlans.get(frame.owner)!.demand;
    if (frame.complete) this.observations.completed++;
    if (frame.grew) this.observations.growth++;
    this.observation = undefined;
    this.pump();
  }
  private protectedWeight(observation?: AccountReadReservation) {
    if (this.observation)
      return this.observation.ticket === observation
        ? 0
        : this.observation.remaining;
    return this.observationQueue.values().next().value?.demand ?? 0;
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
      },
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
    if (this.cooldownRemaining() > 0) return Promise.reject(this.coolingDown());
    if (
      !Number.isSafeInteger(cost) ||
      cost <= 0 ||
      cost > this.limit ||
      signal.aborted ||
      this.queues.account.length + this.queues.source.length >= 256
    )
      return Promise.reject(this.denied(true));
    if (
      observation &&
      (this.observation?.ticket !== observation || this.observation.closed)
    )
      return Promise.reject(this.observationDeferred(1000));
    if (observation) {
      const frame = this.observation!;
      frame.peak = Math.max(frame.peak, frame.committed + cost);
      if (
        !this.exclusive &&
        cost > frame.remaining &&
        this.used() + cost > this.limit
      ) {
        frame.grew = true;
        return Promise.reject(this.denied(true, cost));
      }
    }
    const ownerKey = owner ?? "";
    {
      const owners = this.owners[lane];
      if (!owners.has(ownerKey)) {
        if (owners.size >= 2048) return Promise.reject(this.denied(true));
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
  private candidate(lane: ReadLane): Waiter | undefined {
    const queue =
      lane === "account" && this.observation
        ? this.queues.account.filter(
            (w) => w.observation === this.observation!.ticket,
          )
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
      if (now - current.lastActivity < 2) return;
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
    try {
      this.prune();
      for (;;) {
        if (this.cooldownRemaining() > 0) break;
        // An unknown response temporarily holds all free weight. Do not let
        // that provisional hold expire/switch its owner's turn before the
        // actual response cost is settled and the hold is refunded.
        if (this.exclusive) break;
        const first = this.lastLane === "account" ? "source" : "account";
        const candidates = [
          this.candidate(first),
          this.candidate(first === "account" ? "source" : "account"),
        ];
        const next =
          candidates.find(
            (w) =>
              w &&
              w.observation === this.observation?.ticket &&
              this.observation !== undefined,
          ) ?? candidates.find(Boolean);
        if (!next) break;
        if (
          next.unknownSurcharge &&
          (this.active.account > 0 || this.active.source > 0)
        )
          break;
        if (
          this.clock() < this.blockedUntil ||
          this.used() + next.cost + this.protectedWeight(next.observation) >
            this.limit
        ) {
          // Do not endlessly backfill cheap source reads in front of a larger
          // account request. The next turn owns the next available capacity.
          for (const waiter of [...this.queues.account, ...this.queues.source])
            waiter.budgetBlocked = true;
          break;
        }
        this.queues[next.lane].splice(this.queues[next.lane].indexOf(next), 1);
        next.signal.removeEventListener("abort", next.cancel);
        const charge: Charge = {
          at: this.clock(),
          weight: next.unknownSurcharge
            ? this.limit - this.used() - this.protectedWeight(next.observation)
            : next.cost,
          sent: false,
          settled: false,
        };
        this.charges.push(charge);
        const frame = next.observation ? this.observation! : undefined;
        const held = frame ? Math.min(frame.remaining, charge.weight) : 0;
        const measured = next.unknownSurcharge ? next.cost : charge.weight;
        if (frame) {
          frame.remaining -= held;
          frame.committed += measured;
          frame.peak = Math.max(frame.peak, frame.committed);
          frame.pending++;
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
          charge.at = this.clock();
          this.owners[next.lane].get(next.owner)!.pending -= reservation;
          if (next.unknownSurcharge)
            this.blockedUntil = Math.max(this.blockedUntil, charge.at + 60000);
          if (frame && next.unknownSurcharge) {
            frame.committed += charge.weight - measured;
            frame.peak = Math.max(frame.peak, frame.committed);
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
            charge.weight = weight;
            charge.settled = true;
            charge.at = this.clock();
            if (frame) {
              frame.committed += weight - measured;
              frame.remaining += Math.max(0, held - weight);
              frame.peak = Math.max(frame.peak, frame.committed);
            }
            this.owners[next.lane].get(next.owner)!.served -= refund;
            this.owners[next.lane].get(next.owner)!.pending -= reservation;
            if (turn) turn.served -= refund;
            this.pump();
          },
          uncertain,
          release: () => {
            if (released) return;
            released = true;
            uncertain();
            if (!charge.sent) {
              this.charges = this.charges.filter((c) => c !== charge);
              this.owners[next.lane].get(next.owner)!.served -= charge.weight;
              this.owners[next.lane].get(next.owner)!.pending -= reservation;
              if (turn) turn.served -= charge.weight;
              if (frame) {
                frame.committed -= measured;
                frame.remaining += held;
              }
            }
            this.active[next.lane]--;
            if (this.exclusive === charge) this.exclusive = undefined;
            if (turn) turn.lastActivity = this.clock();
            if (frame) {
              frame.pending--;
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
