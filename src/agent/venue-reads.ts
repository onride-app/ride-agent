import { AgentError } from "./contracts.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { readCost, responseCost } from "./venue-read-cost.js";
import {
  sharedVenueReadBudget,
  readTimers,
  type BudgetTimers,
  type ReadLane,
  type ReadTicket,
  type AccountReadReservation,
  VenueReadBudget,
} from "./venue-read-budget.js";

type Entry = { at: number; until: number; value: unknown };
type AccountReadScope = {
  id: number;
  until: number;
  admission: AbortController;
  owner?: string;
  reservation?: AccountReadReservation;
  admissionError?: unknown;
  observedAt?: number;
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
  unsupported_method: number;
  invalid_response: number;
  reserved_weight: number;
  charged_weight: number;
  unknown_fetch: number;
  unknown_uncertain: number;
  unknown_overrun: number;
  unknown_debt_weight: number;
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
  unsupported_method: 0,
  invalid_response: 0,
  reserved_weight: 0,
  charged_weight: 0,
  unknown_fetch: 0,
  unknown_uncertain: 0,
  unknown_overrun: 0,
  unknown_debt_weight: 0,
});
export interface VenueReadOptions {
  budget?: VenueReadBudget;
  timers?: BudgetTimers;
  deadlineMs?: number;
  signal?: AbortSignal;
  report?: (record: Record<string, unknown>) => void;
}

// Completed account evidence is never reused. Metadata TTL and same-lane
// single-flight are unchanged. Both HL hosts share one process weighted gate.
export class VenueReads {
  private flights = new Map<string, Promise<unknown>>();
  private cache = new Map<string, Entry>();
  private readonly budget: VenueReadBudget;
  private readonly timers: BudgetTimers;
  private readonly deadlineMs: number;
  private readonly callerSignal?: AbortSignal;
  private readonly report: NonNullable<VenueReadOptions["report"]>;
  private counts = counters();
  private byMethod = new Map<string, Counters>();
  private lastReport: number;
  private readonly accountScope = new AsyncLocalStorage<AccountReadScope>();
  private accountSequence = 0;
  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly clock = Date.now,
    concurrency = 2,
    options: VenueReadOptions = {},
  ) {
    if (!Number.isFinite(concurrency) || concurrency < 1)
      throw new RangeError("Venue concurrency must be positive");
    this.budget = options.budget ?? sharedVenueReadBudget;
    this.timers = options.timers ?? readTimers;
    this.deadlineMs = options.deadlineMs ?? 12000;
    this.callerSignal = options.signal;
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
      interval_ms: Math.max(0, this.clock() - this.lastReport),
      budget: this.budget.snapshot(),
      counts: { ...this.counts },
      methods: [...this.byMethod].map(([purpose_method, values]) => ({
        purpose_method,
        ...values,
      })),
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
    this.byMethod.clear();
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
    const scope: AccountReadScope = {
      id: ++this.accountSequence,
      until: this.clock() + 20000,
      admission: new AbortController(),
      owner,
    };
    const timer = this.timers.setTimeout(
      () => scope.admission.abort(this.accountDeadline()),
      20000,
    );
    return this.accountScope.run(scope, async () => {
      let abort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(scope.admission.signal.reason);
        scope.admission.signal.addEventListener("abort", abort, { once: true });
      });
      let complete = false;
      try {
        const value = await Promise.race([work(), cancelled]);
        this.accountReadTimeout();
        complete = true;
        return value;
      } catch (error) {
        scope.admission.abort(error);
        throw error;
      } finally {
        this.timers.clearTimeout(timer);
        scope.admission.signal.removeEventListener("abort", abort);
        scope.reservation?.close(complete);
      }
    });
  }
  accountObservedAt(): number {
    return this.accountScope.getStore()?.observedAt ?? this.clock();
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
  async read(
    url: string,
    payload: unknown,
    ttlMs = 0,
    lane: ReadLane = "account",
  ): Promise<any> {
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
          scope.reservation = this.budget.beginObservation(scope.owner);
        } catch (error) {
          scope.admissionError = error;
          this.count(method, lane, "local_budget_denied");
          throw error;
        }
      }
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
          scope.observedAt = Math.min(scope.observedAt ?? cached.at, cached.at);
        return structuredClone(cached.value);
      }
      if (cached) this.cache.delete(key);
      let flight = this.flights.get(flightKey);
      if (!flight) {
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
        flight = this.perform(url, payload, lane, cost, controller.signal)
          .then((value) => {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (ttlMs > 0) {
              if (this.cache.size >= 2000)
                this.cache.delete(this.cache.keys().next().value!);
              this.cache.set(key, {
                at: this.clock(),
                value: structuredClone(value),
                until: this.clock() + ttlMs,
              });
            }
            return value;
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
  ): Promise<unknown> {
    let ticket: ReadTicket | undefined,
      sent = false,
      settled = false;
    let wireTimer: unknown;
    let wireSignal = signal;
    const user = (payload as { user?: unknown })?.user;
    const owner = typeof user === "string" && user.length ? user : undefined;
    const scope = this.accountScope.getStore();
    const requestSignal = this.callerSignal
      ? AbortSignal.any([signal, this.callerSignal])
      : signal;
    const admissionSignal = scope
      ? AbortSignal.any([requestSignal, scope.admission.signal])
      : requestSignal;
    try {
      ticket = await this.budget.acquire(
        lane,
        cost.reserve,
        owner,
        admissionSignal,
        cost.unknownSurcharge,
        scope?.reservation,
      );
      this.checkCooldown(cost.method, lane, false);
      if (admissionSignal.aborted) throw admissionSignal.reason;
      if (signal.aborted) throw signal.reason;
      // Queue time belongs to the enclosing 20-second account observation.
      // Bound HTTP/JSON work to 12 seconds after admission instead of consuming
      // its wire window in the queue; the whole-operation boundary stays 20s.
      const wire = new AbortController();
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
        this.accountReadTimeout(this.deadlineMs),
      );
      wireSignal = AbortSignal.any([requestSignal, wire.signal]);
      ticket.sent();
      if (scope) scope.observedAt ??= this.clock();
      sent = true;
      this.count(cost.method, lane, "actual_fetch");
      this.count(cost.method, lane, "reserved_weight", ticket.reservation);
      if (cost.unknownSurcharge) this.count(cost.method, lane, "unknown_fetch");
      let response: Response;
      try {
        response = await this.abortable(
          this.fetcher(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: wireSignal,
            redirect: "error",
          }),
          wireSignal,
        );
      } catch {
        this.count(cost.method, lane, "transport_failure");
        if (wireSignal.aborted) throw wireSignal.reason;
        throw new AgentError(
          "VENUE_UNAVAILABLE",
          "Venue read did not complete. Fresh account evidence is required before execution.",
          true,
          503,
        );
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
}
