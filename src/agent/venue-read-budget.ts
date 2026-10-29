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
  private providerFailures = 0;
  private turnSequence = 0;
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
    };
  }
  private prune() {
    const now = this.clock();
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
    this.providerFailures = Math.min(5, this.providerFailures + 1);
    this.providerUntil = Math.max(
      this.providerUntil,
      this.clock() +
        Math.max(
          Math.min(60000, 1000 * 2 ** (this.providerFailures - 1)),
          retryMs,
        ),
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
  noteSuccess() {
    if (this.cooldownRemaining() === 0) this.providerFailures = 0;
  }
  private denied(budget: boolean, cost = 1) {
    const at = this.clock();
    this.prune();
    let remaining = this.used();
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
    const queue = this.queues[lane];
    if (!queue.length || this.active[lane] >= this.slots) return;
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
        const next = candidates.find(Boolean);
        if (!next) break;
        if (
          next.unknownSurcharge &&
          (this.active.account > 0 || this.active.source > 0)
        )
          break;
        if (
          this.clock() < this.blockedUntil ||
          this.used() + next.cost > this.limit
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
          weight: next.unknownSurcharge ? this.limit - this.used() : next.cost,
          sent: false,
          settled: false,
        };
        this.charges.push(charge);
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
            }
            this.active[next.lane]--;
            if (this.exclusive === charge) this.exclusive = undefined;
            if (turn) turn.lastActivity = this.clock();
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
        this.wake = this.timers.setTimeout(
          () => this.pump(),
          Math.max(
            1,
            Math.min(
              expiry,
              turnExpiry,
              grace,
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
