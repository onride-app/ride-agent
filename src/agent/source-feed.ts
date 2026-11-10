import type { SourceSnapshot } from "./adapter.js";
import { AgentError } from "./contracts.js";
import { isUnsentReadBudgetDenial } from "./venue-read-transport.js";

export interface PreparedSourceRetryLimits {
  readonly signal: AbortSignal;
  remainingMs(): number;
  wait(delayMs: number, signal: AbortSignal): Promise<void>;
}
export interface PreparedSourceSelection {
  readonly id: string;
  onDemand(work: () => Promise<SourceSnapshot>): Promise<SourceSnapshot>;
  validate(): void;
}
type SourceWork = (
  work: () => Promise<SourceSnapshot>,
) => Promise<SourceSnapshot>;
type SourceFailure = { error: unknown; retryAt: number };
type PreparedRetry = {
  failure: SourceFailure;
  onDemand: SourceWork;
  limits: PreparedSourceRetryLimits;
  validate(): void;
  signal: AbortSignal;
  cancelled: AbortController;
  used: boolean;
};

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
  failure?: SourceFailure;
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
  private readonly flightReceipts = new WeakMap<
    Promise<SourceSnapshot>,
    { failure?: SourceFailure }
  >();
  private readonly preparedRetries = new Map<string, Set<PreparedRetry>>();
  private readonly closedSignal = new AbortController();
  private preparedRetryCount = 0;
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

  async read(
    id: string,
    onDemand?: (work: () => Promise<SourceSnapshot>) => Promise<SourceSnapshot>,
  ): Promise<SourceSnapshot> {
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
    return structuredClone(await this.refresh(id, onDemand));
  }

  /** Server-owned prepared source only. No caller error or retry token is accepted. */
  async readPrepared(
    id: string,
    onDemand: SourceWork,
    limits: PreparedSourceRetryLimits,
    validate: () => void,
  ): Promise<SourceSnapshot> {
    validate();
    const signal = AbortSignal.any([limits.signal, this.closedSignal.signal]);
    if (signal.aborted) throw signal.reason;
    if (!Number.isFinite(limits.remainingMs()) || limits.remainingMs() <= 0)
      throw this.preparedDeadline();
    const knownFailure = this.interests.get(id)?.failure;
    const attempt = this.read(id, onDemand);
    const flight = this.flights.get(id);
    try {
      // Existing flights keep their original context and cost ownership.
      const value = await this.untilCancelled(attempt, signal);
      validate();
      if (limits.remainingMs() <= 0) throw this.preparedDeadline();
      return value;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const failure = flight
        ? this.flightReceipts.get(flight)?.failure
        : knownFailure;
      if (
        !isUnsentReadBudgetDenial(error) ||
        !failure ||
        this.interests.get(id)?.failure !== failure ||
        failure.error !== error ||
        !Number.isFinite(failure.retryAt) ||
        this.preparedRetryCount >= 64
      )
        throw error;
      validate();
      const delay = Math.max(0, failure.retryAt - this.clock());
      if (delay >= limits.remainingMs()) throw error;
      const cancelled = new AbortController(),
        retrySignal = AbortSignal.any([signal, cancelled.signal]),
        entry: PreparedRetry = {
          failure,
          onDemand,
          limits,
          validate,
          signal: retrySignal,
          cancelled,
          used: false,
        };
      const remove = () => this.removePreparedRetry(id, entry);
      let entries = this.preparedRetries.get(id);
      if (!entries) this.preparedRetries.set(id, (entries = new Set()));
      entries.add(entry);
      this.preparedRetryCount++;
      retrySignal.addEventListener("abort", remove, { once: true });
      if (retrySignal.aborted) remove();
      try {
        // Do not clear/renew failure or shorten its original backoff. The
        // refresh gate also sees this live waiter if its timer wins this turn.
        await limits.wait(delay, retrySignal);
        if (retrySignal.aborted) throw retrySignal.reason;
        validate();
        if (limits.remainingMs() <= 0) throw this.preparedDeadline();
        // Exactly one normal retry. Its cache/singleflight/backoff/5s checks
        // stay authoritative; another failure is returned, never looped.
        const value = await this.untilCancelled(
          this.read(id, onDemand),
          retrySignal,
        );
        validate();
        if (limits.remainingMs() <= 0) throw this.preparedDeadline();
        return value;
      } finally {
        remove();
        retrySignal.removeEventListener("abort", remove);
      }
    }
  }

  /** Successful-audit selection only. Registration performs no source read. */
  registerPreparedSources(
    selected: readonly PreparedSourceSelection[],
    limits: PreparedSourceRetryLimits,
  ): () => void {
    const entries: { id: string; entry: PreparedRetry; stop(): void }[] = [];
    const dispose = () => {
      for (const { id, entry, stop } of entries.splice(0)) {
        this.removePreparedRetry(id, entry);
        entry.signal.removeEventListener("abort", stop);
      }
    };
    try {
      if (this.closed) throw this.closedError();
      if (limits.signal.aborted) throw limits.signal.reason;
      if (limits.remainingMs() <= 0) throw this.preparedDeadline();
      if (new Set(selected.map((source) => source.id)).size !== selected.length)
        throw this.preparedDeadline();
      for (const source of selected) {
        source.validate();
        const failure = this.interests.get(source.id)?.failure;
        if (
          !failure ||
          !Number.isFinite(failure.retryAt) ||
          !isUnsentReadBudgetDenial(failure.error)
        )
          continue;
        if (this.preparedRetryCount >= 64) throw this.preparedDeadline();
        const cancelled = new AbortController(),
          signal = AbortSignal.any([
            limits.signal,
            this.closedSignal.signal,
            cancelled.signal,
          ]),
          entry: PreparedRetry = {
            failure,
            onDemand: (work) => source.onDemand(work),
            validate: () => source.validate(),
            limits,
            signal,
            cancelled,
            used: false,
          },
          stop = () => this.removePreparedRetry(source.id, entry);
        let group = this.preparedRetries.get(source.id);
        if (!group) this.preparedRetries.set(source.id, (group = new Set()));
        group.add(entry);
        this.preparedRetryCount++;
        signal.addEventListener("abort", stop, { once: true });
        entries.push({ id: source.id, entry, stop });
        if (signal.aborted) stop();
      }
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private preparedDeadline() {
    return new AgentError(
      "VENUE_READ_DEADLINE",
      "Prepared source wait expired.",
      true,
      503,
    );
  }
  private removePreparedRetry(id: string, entry: PreparedRetry) {
    const entries = this.preparedRetries.get(id);
    if (!entries?.delete(entry)) return;
    this.preparedRetryCount--;
    if (!entries.size) this.preparedRetries.delete(id);
  }
  private preparedSourceWork(id: string): SourceWork | undefined {
    for (const entry of this.preparedRetries.get(id) ?? []) {
      if (entry.used) continue;
      try {
        if (entry.signal.aborted) throw entry.signal.reason;
        const current = this.interests.get(id)?.failure;
        if (current !== entry.failure)
          throw current?.error ?? this.preparedDeadline();
        if (entry.limits.remainingMs() <= 0) throw this.preparedDeadline();
        entry.validate();
      } catch (error) {
        this.removePreparedRetry(id, entry);
        entry.cancelled.abort(error);
        continue;
      }
      entry.used = true;
      return async (work) => {
        if (entry.signal.aborted) throw entry.signal.reason;
        entry.validate();
        if (entry.limits.remainingMs() <= 0) throw this.preparedDeadline();
        return entry.onDemand(work);
      };
    }
  }
  private async untilCancelled<T>(
    work: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      void work.catch(() => {});
      throw signal.reason;
    }
    let stop!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason);
      signal.addEventListener("abort", stop, { once: true });
    });
    try {
      return await Promise.race([work, cancelled]);
    } finally {
      signal.removeEventListener("abort", stop);
    }
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
    this.preparedRetries.clear();
    this.preparedRetryCount = 0;
    this.closedSignal.abort(this.closedError());
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
      if (at - interest.lastReadAt >= this.interestTtlMs) {
        this.interests.delete(id);
        for (const entry of this.preparedRetries.get(id) ?? []) {
          this.removePreparedRetry(id, entry);
          entry.cancelled.abort(
            new AgentError(
              "SOURCE_INTEREST_EXPIRED",
              "Public source sampling interest expired.",
              true,
              503,
            ),
          );
        }
      }
    if (!this.interests.size) {
      this.stopTimer();
      return;
    }
    await Promise.allSettled(
      [...this.interests.keys()].map((id) => this.refresh(id)),
    );
  }
  private refresh(
    id: string,
    onDemand?: (work: () => Promise<SourceSnapshot>) => Promise<SourceSnapshot>,
  ): Promise<SourceSnapshot> {
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
    // Select synchronously before creating a new flight. A same-turn ordinary
    // timer can join this real prepared fetch, never race it with a new
    // unframed request. An already existing flight returned above is unchanged.
    const receipt: { failure?: SourceFailure } = {};
    const work = this.perform(
      id,
      this.preparedSourceWork(id) ?? onDemand,
      receipt,
    );
    this.flightReceipts.set(work, receipt);
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
      !["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_RATE_LIMITED"].includes(
        error.code,
      )
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
  private async perform(
    id: string,
    onDemand?: (work: () => Promise<SourceSnapshot>) => Promise<SourceSnapshot>,
    receipt: { failure?: SourceFailure } = {},
  ): Promise<SourceSnapshot> {
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
      const snapshot = structuredClone(
        await (onDemand
          ? onDemand(() => this.fetchSource(id))
          : this.fetchSource(id)),
      );
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
      if (!this.closed && current) {
        const failure = {
          error,
          retryAt: this.clock() + this.retryDelay(error),
        };
        current.failure = failure;
        receipt.failure = failure;
      }
      throw error;
    } finally {
      this.release();
    }
  }
}
