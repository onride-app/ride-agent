import type { SourceSnapshot } from "./adapter.js";
import { AgentError } from "./contracts.js";

type TimerHandle = number | { unref?: () => unknown };
export interface SourceFeedOptions {
  clock?: () => number;
  intervalMs?: number;
  interestTtlMs?: number;
  maxAgeMs?: number;
  retryCooldownMs?: number;
  timers?: {
    setInterval(callback: () => void, intervalMs: number): TimerHandle;
    clearInterval(handle: TimerHandle): void;
  };
}
type Interest = {
  lastReadAt: number;
  snapshot?: SourceSnapshot;
  failure?: { error: unknown; retryAt: number };
};

// Public source evidence only. No follower identity, account initialization,
// signing, or submission callback is accepted by this sampler.
export class SourceFeed {
  private readonly clock: () => number;
  private readonly intervalMs: number;
  private readonly interestTtlMs: number;
  private readonly maxAgeMs: number;
  private readonly retryCooldownMs: number;
  private readonly timers: NonNullable<SourceFeedOptions["timers"]>;
  private readonly interests = new Map<string, Interest>();
  private readonly flights = new Map<string, Promise<SourceSnapshot>>();
  private readonly waiters: {
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private timer?: TimerHandle;
  private polling?: Promise<void>;
  private active = 0;
  private closed = false;

  constructor(
    private readonly fetchSource: (id: string) => Promise<SourceSnapshot>,
    options: SourceFeedOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.interestTtlMs = options.interestTtlMs ?? 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 5_000;
    this.retryCooldownMs = options.retryCooldownMs ?? 5_000;
    for (const duration of [
      this.intervalMs,
      this.interestTtlMs,
      this.maxAgeMs,
      this.retryCooldownMs,
    ])
      if (!Number.isFinite(duration) || duration <= 0)
        throw new RangeError(
          "Source feed durations must be positive finite milliseconds.",
        );
    this.timers = options.timers ?? {
      setInterval: (callback, interval) => setInterval(callback, interval),
      clearInterval: (handle) =>
        clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  async read(id: string): Promise<SourceSnapshot> {
    if (this.closed) throw this.closedError();
    const at = this.clock();
    let interest = this.interests.get(id);
    if (!interest) {
      interest = { lastReadAt: at };
      this.interests.set(id, interest);
    } else interest.lastReadAt = at;
    this.startTimer();
    const flight = this.flights.get(id);
    if (flight) return structuredClone(await flight);
    if (interest.failure) {
      if (interest.failure.retryAt > at) throw interest.failure.error;
      // A latest failure always requires a new successful observation. A prior
      // good value remains internal and cannot hide that failed observation.
    } else if (interest.snapshot && this.isFresh(interest.snapshot, at)) {
      return structuredClone(interest.snapshot);
    }
    return structuredClone(await this.refresh(id));
  }

  pollOnce(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.polling) return this.polling;
    const work = this.pollInterests();
    this.polling = work;
    void work.then(
      () => {
        if (this.polling === work) this.polling = undefined;
      },
      () => {
        if (this.polling === work) this.polling = undefined;
      },
    );
    return work;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    this.interests.clear();
    this.flights.clear();
    this.polling = undefined;
    for (const waiter of this.waiters.splice(0))
      waiter.reject(this.closedError());
  }

  private closedError() {
    return new AgentError(
      "SOURCE_FEED_CLOSED",
      "Public source sampling has stopped.",
      true,
      503,
    );
  }
  private isFresh(snapshot: SourceSnapshot, at: number): boolean {
    if (!snapshot || typeof snapshot !== "object") return false;
    const expires = (snapshot as SourceSnapshot & { expires_at?: number })
      .expires_at;
    return (
      snapshot.complete === true &&
      Array.isArray(snapshot.positions) &&
      Number.isFinite(snapshot.observed_at) &&
      snapshot.observed_at <= at &&
      at - snapshot.observed_at <= this.maxAgeMs &&
      snapshot.positions.every(
        (position) =>
          position &&
          Number.isFinite(position.observed_at) &&
          position.observed_at <= at &&
          at - position.observed_at <= this.maxAgeMs,
      ) &&
      (expires === undefined || (Number.isFinite(expires) && expires > at))
    );
  }
  private startTimer(): void {
    if (this.timer !== undefined || this.closed) return;
    this.timer = this.timers.setInterval(() => {
      void this.pollOnce().catch(() => {});
    }, this.intervalMs);
    if (typeof this.timer === "object") this.timer.unref?.();
  }
  private stopTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
  private async pollInterests(): Promise<void> {
    const at = this.clock();
    for (const [id, interest] of this.interests)
      if (at - interest.lastReadAt >= this.interestTtlMs)
        this.interests.delete(id);
    if (!this.interests.size) {
      this.stopTimer();
      return;
    }
    await Promise.allSettled(
      [...this.interests.keys()].map((id) => this.refresh(id)),
    );
  }
  private refresh(id: string): Promise<SourceSnapshot> {
    const existing = this.flights.get(id);
    if (existing) return existing;
    if (this.closed) return Promise.reject(this.closedError());
    const interest = this.interests.get(id);
    const at = this.clock();
    if (interest?.failure) {
      if (interest.failure.retryAt > at)
        return Promise.reject(interest.failure.error);
      // Expiring cooldown still requires a successful new observation. Never
      // let a prior cached frame hide the latest failed source read.
    } else if (interest?.snapshot && this.isFresh(interest.snapshot, at)) {
      // Polling shares the same existing freshness limit as on-demand reads.
      // Reuse the real frame; do not relabel its observation or expiry time,
      // renew interest, or spend another public REST read while it is fresh.
      return Promise.resolve(interest.snapshot);
    }
    const work = this.perform(id);
    this.flights.set(id, work);
    const cleanup = () => {
      if (this.flights.get(id) === work) this.flights.delete(id);
    };
    void work.then(cleanup, cleanup);
    return work;
  }
  private async acquire(): Promise<void> {
    if (this.closed) throw this.closedError();
    if (this.active < 2) this.active++;
    else
      await new Promise<void>((resolve, reject) =>
        this.waiters.push({ resolve, reject }),
      );
  }
  private release(): void {
    const next = this.waiters.shift();
    if (next) next.resolve();
    else this.active--;
  }
  private retryDelay(error: unknown): number {
    if (
      !(error instanceof AgentError) ||
      error.retryable !== true ||
      !["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_RATE_LIMITED"].includes(error.code)
    )
      return this.retryCooldownMs;
    const delay = error.details?.retry_after_ms;
    return typeof delay === "number" &&
      Number.isSafeInteger(delay) &&
      delay > 0 &&
      delay <= 60_000
      ? Math.max(this.retryCooldownMs, delay)
      : this.retryCooldownMs;
  }
  private async perform(id: string): Promise<SourceSnapshot> {
    await this.acquire();
    try {
      if (this.closed) throw this.closedError();
      const interest = this.interests.get(id);
      if (!interest || this.clock() - interest.lastReadAt >= this.interestTtlMs)
        throw new AgentError(
          "SOURCE_INTEREST_EXPIRED",
          "Public source sampling interest expired.",
          true,
          503,
        );
      const snapshot = structuredClone(await this.fetchSource(id));
      if (this.closed) throw this.closedError();
      if (!this.isFresh(snapshot, this.clock()))
        throw new AgentError(
          "SOURCE_STALE",
          "Public source evidence is stale or incomplete. Fresh evidence is required before execution.",
          true,
          503,
        );
      const current = this.interests.get(id);
      if (current) {
        current.snapshot = snapshot;
        current.failure = undefined;
      }
      return snapshot;
    } catch (error) {
      const current = this.interests.get(id);
      if (!this.closed && current)
        current.failure = {
          error,
          retryAt: this.clock() + this.retryDelay(error),
        };
      throw error;
    } finally {
      this.release();
    }
  }
}
