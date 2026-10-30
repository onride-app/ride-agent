import { randomUUID } from "node:crypto";
import type { VenueAdapter } from "./adapter.js";
import { localDay } from "./analytics.js";
import { AgentError } from "./contracts.js";
import type { Repository, State, Update } from "./repository.js";
import { monitorPhase, runNotificationTrace } from "./monitor-diagnostics.js";

type Options = {
  timeoutMs?: number;
  leaseMs?: number;
  maxBatch?: number;
  concurrency?: number;
  clock?: () => number;
};
type Flight = { controller: AbortController; work: Promise<void> };
type CompletedBatch = {
  claimed: Update[];
  results: Map<string, { error?: unknown }>;
};
export type PreparedNotifications = {
  user: string;
  claimed: Update[];
  completed?: CompletedBatch;
  reservation?: string;
};

function cancelDigest(state: State, update: Update, at: number): boolean {
  if (update.kind !== "daily_digest") return false;
  const prefs = state.notification_preferences;
  if (
    prefs?.daily_digest &&
    update.data.digest_day === localDay(at, prefs.timezone).day
  )
    return false;
  update.notification = "cancelled";
  delete update.notification_claim;
  return true;
}

async function cancellable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    throw signal.reason;
  }
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Durable claims surround external push I/O; no user row lock crosses a send. */
export class NotificationDispatcher {
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private readonly maxBatch: number;
  private readonly concurrency: number;
  private readonly clock: () => number;
  private readonly queued = new Set<string>();
  private readonly queue: string[] = [];
  private readonly flights = new Map<string, Flight>();
  private stopped = false;
  private readonly reservations = new Map<string, string>();
  private readonly waiting = new Map<string, number>();
  private readonly preparedBatches = new Map<string, Update[]>();
  private readonly completed = new Map<string, CompletedBatch>();

  private due(state: State): Update[] {
    const at = this.clock();
    return state.updates
      .filter((update) => {
        if (
          update.notification !== "pending" ||
          cancelDigest(state, update, at)
        )
          return false;
        const claim = update.notification_claim;
        return (
          (update.next_notification_at ?? 0) <= at &&
          !(
            claim &&
            Number.isSafeInteger(claim.expires_at) &&
            claim.expires_at > at
          )
        );
      })
      .sort(
        (a, b) =>
          (a.next_notification_at ?? a.at) - (b.next_notification_at ?? b.at) ||
          a.at - b.at ||
          a.id.localeCompare(b.id),
      )
      .slice(0, this.maxBatch);
  }
  private assign(state: State): Update[] {
    const due = this.due(state);
    for (const update of due)
      update.notification_claim = {
        token: randomUUID(),
        expires_at: this.clock() + this.leaseMs,
      };
    return structuredClone(due);
  }
  private merge(state: State, batch: CompletedBatch): void {
    for (const original of batch.claimed) {
      const update = state.updates.find((item) => item.id === original.id);
      if (
        !update ||
        update.notification !== "pending" ||
        update.notification_claim?.token !==
          original.notification_claim!.token ||
        update.notification_claim.expires_at <= this.clock()
      )
        continue;
      if (cancelDigest(state, update, this.clock())) continue;
      delete update.notification_claim;
      const result = batch.results.get(update.id);
      if (!result) continue;
      if (result.error === undefined) {
        update.notification = "delivered";
        delete update.notification_error;
        delete update.next_notification_at;
      } else {
        update.notification_attempts = (update.notification_attempts ?? 0) + 1;
        update.next_notification_at =
          this.clock() +
          Math.min(
            3600000,
            5000 * 2 ** Math.min(10, update.notification_attempts),
          );
        update.notification_error =
          result.error instanceof AgentError
            ? result.error.code
            : "PUSH_UNAVAILABLE";
      }
    }
  }
  /** Pure changes staged in the caller's existing durable transaction. */
  prepare(user: string, state: State): PreparedNotifications {
    const at = this.clock();
    for (const [owner, seen] of this.waiting)
      if (seen > at || at - seen >= this.leaseMs) this.waiting.delete(owner);
    // Owners can disappear after closing/cancelling their last pending work.
    // Expired volatile results have the same recovery boundary as a process
    // restart: durable event leases and per-device receipts remain untouched.
    for (const [owner, batch] of this.completed)
      if (
        batch.claimed.every(
          (update) => update.notification_claim!.expires_at <= at,
        )
      )
        this.completed.delete(owner);
    const completed = this.completed.get(user);
    if (completed) this.merge(state, completed);
    const prepared: PreparedNotifications = { user, claimed: [], completed };
    if (this.stopped) return prepared;
    if (
      this.flights.has(user) ||
      this.queued.has(user) ||
      this.reservations.has(user)
    ) {
      this.waiting.delete(user);
      return prepared;
    }
    if (!this.due(state).length) {
      this.waiting.delete(user);
      return prepared;
    }
    if (this.waiting.size >= 2000 && !this.waiting.has(user)) return prepared;
    this.waiting.set(user, this.clock());
    const occupied =
      this.flights.size + this.preparedBatches.size + this.reservations.size;
    if (
      occupied >= this.concurrency ||
      this.completed.size + occupied >= 2000 ||
      this.waiting.keys().next().value !== user
    )
      return prepared;
    this.waiting.delete(user);
    prepared.reservation = randomUUID();
    this.reservations.set(user, prepared.reservation);
    prepared.claimed = this.assign(state);
    return prepared;
  }
  /** Call only after the caller's real transaction commit succeeded. */
  committed(prepared: PreparedNotifications): void {
    if (
      prepared.completed &&
      this.completed.get(prepared.user) === prepared.completed
    )
      this.completed.delete(prepared.user);
    if (
      !prepared.reservation ||
      this.reservations.get(prepared.user) !== prepared.reservation
    )
      return;
    this.reservations.delete(prepared.user);
    if (this.stopped || !prepared.claimed.length) return;
    this.preparedBatches.set(prepared.user, structuredClone(prepared.claimed));
    this.queued.add(prepared.user);
    this.queue.push(prepared.user);
    this.pump();
  }
  rollback(prepared: PreparedNotifications): void {
    if (
      prepared.reservation &&
      this.reservations.get(prepared.user) === prepared.reservation
    )
      this.reservations.delete(prepared.user);
    // Completed delivery evidence stays buffered until a successful commit.
  }
  async flush(): Promise<void> {
    await this.idle();
    for (const [user, batch] of [...this.completed]) {
      await monitorPhase("notification_ack", () =>
        this.repository.transact(user, async (state) =>
          this.merge(state, batch),
        ),
      );
      if (this.completed.get(user) === batch) this.completed.delete(user);
    }
  }

  constructor(
    private repository: Repository,
    private adapter: VenueAdapter,
    options: Options = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.leaseMs = options.leaseMs ?? 60000;
    this.maxBatch = options.maxBatch ?? 4;
    this.concurrency = options.concurrency ?? 2;
    this.clock = options.clock ?? Date.now;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 20000 ||
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs <= this.timeoutMs ||
      this.leaseMs > 60000 ||
      !Number.isSafeInteger(this.maxBatch) ||
      this.maxBatch < 1 ||
      this.maxBatch > 4 ||
      !Number.isSafeInteger(this.concurrency) ||
      this.concurrency < 1 ||
      this.concurrency > 2
    )
      throw new RangeError("Invalid bounded notification dispatcher limits");
  }
  enqueue(user: string): void {
    if (
      this.stopped ||
      this.queued.has(user) ||
      this.reservations.has(user) ||
      this.flights.has(user) ||
      this.queue.length >= 2000
    )
      return;
    this.queued.add(user);
    this.queue.push(user);
    this.pump();
  }
  private pump(): void {
    while (
      !this.stopped &&
      this.flights.size < this.concurrency &&
      this.queue.length
    ) {
      const user = this.queue.shift()!;
      this.queued.delete(user);
      const prepared = this.preparedBatches.get(user);
      this.preparedBatches.delete(user);
      const controller = new AbortController();
      const until = this.clock() + this.timeoutMs;
      const timer = setTimeout(
        () =>
          controller.abort(
            new AgentError(
              "PUSH_DELIVERY_TIMEOUT",
              "Notification result is unknown; retained for retry.",
              true,
              503,
            ),
          ),
        this.timeoutMs,
      );
      const work = Promise.resolve()
        .then(() =>
          runNotificationTrace(() =>
            this.deliver(user, controller.signal, until, prepared),
          ),
        )
        .catch(() => {
          /* Claims remain durable when a state transaction fails. */
        })
        .finally(() => {
          clearTimeout(timer);
          this.flights.delete(user);
          this.pump();
        });
      this.flights.set(user, { controller, work });
    }
  }
  private async claim(user: string, signal: AbortSignal): Promise<Update[]> {
    return monitorPhase("notification_claim", () =>
      this.repository.transact(user, async (state) =>
        signal.aborted || this.stopped ? [] : this.assign(state),
      ),
    );
  }
  private async deliver(
    user: string,
    signal: AbortSignal,
    until: number,
    prepared?: Update[],
  ): Promise<void> {
    let claimed = prepared ?? (await this.claim(user, signal));
    if (prepared) {
      // Ordinary read only: never queue another owner row-lock transaction.
      // A delayed job cannot send after cancellation, expiry or replacement.
      const current = await this.repository.read(user);
      claimed = claimed.filter((original) => {
        const update = current.updates.find((item) => item.id === original.id);
        return (
          update?.notification === "pending" &&
          update.notification_claim?.token ===
            original.notification_claim!.token &&
          update.notification_claim.expires_at > this.clock()
        );
      });
    }
    if (!claimed.length) return;
    const results = new Map<string, { error?: unknown }>();
    for (const update of claimed) {
      if (
        signal.aborted ||
        this.stopped ||
        update.notification_claim!.expires_at <= this.clock()
      )
        break;
      try {
        // Stable event ids are retained across partial fanout, timeout and restart.
        await cancellable(
          this.adapter.notify(
            user,
            {
              id: update.id,
              kind: update.kind,
              message: update.message,
              portfolio_id: update.portfolio_id,
            },
            signal,
            until,
          ),
          signal,
        );
        results.set(update.id, {});
      } catch (error) {
        results.set(update.id, {
          error: error ?? new Error("Unknown notification result"),
        });
      }
    }
    const batch = { claimed, results };
    if (prepared) {
      this.completed.set(user, batch);
      return;
    }
    await monitorPhase("notification_ack", () =>
      this.repository.transact(user, async (state) => this.merge(state, batch)),
    );
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.preparedBatches.clear();
    this.reservations.clear();
    this.waiting.clear();
    this.queued.clear();
    for (const flight of this.flights.values())
      flight.controller.abort(
        new AgentError(
          "PUSH_DELIVERY_CANCELLED",
          "Notification result is unknown; retained for retry.",
          true,
          503,
        ),
      );
  }
  async idle(): Promise<void> {
    while (this.flights.size)
      await Promise.all(
        [...this.flights.values()].map((flight) => flight.work),
      );
  }
  async close(): Promise<void> {
    this.stop();
    await this.idle();
  }
}
