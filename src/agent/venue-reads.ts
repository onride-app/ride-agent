import { AgentError } from "./contracts.js";

type Entry = { at: number; until: number; value: unknown };
type Lane = "account" | "source";

// One process-wide read budget per venue origin. Account evidence is never
// reused after a completed request; identical concurrent reads share one flight.
// Public metadata may use a short explicit TTL. Failed reads are never cached.
export class VenueReads {
  private lanes = {
    account: { active: 0, waiters: [] as (() => void)[] },
    source: { active: 0, waiters: [] as (() => void)[] },
  };
  private flights = new Map<string, Promise<unknown>>();
  private cache = new Map<string, Entry>();
  private cooldownUntil = 0;
  private failures = 0;
  constructor(
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
    private readonly clock = Date.now,
    private readonly concurrency = 2,
  ) {}
  private unavailable() {
    return new AgentError(
      "VENUE_RATE_LIMITED",
      "Venue reads are cooling down after a rate limit. Existing settings are preserved; execution needs fresh account evidence.",
      true,
      503,
      { retry_after_ms: Math.max(1, this.cooldownUntil - this.clock()) },
    );
  }
  async read(
    url: string,
    payload: unknown,
    ttlMs = 0,
    lane: Lane = "account",
  ): Promise<any> {
    if (this.cooldownUntil > this.clock()) throw this.unavailable();
    const key = JSON.stringify([url, payload]);
    const flightKey = `${lane}:${key}`;
    const cached = this.cache.get(key);
    if (
      ttlMs > 0 &&
      cached &&
      Math.min(cached.until, cached.at + ttlMs) > this.clock()
    )
      return structuredClone(cached.value);
    if (cached) this.cache.delete(key);
    let flight = this.flights.get(flightKey);
    if (!flight) {
      flight = this.perform(url, payload, lane).then((value) => {
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
      });
      this.flights.set(flightKey, flight);
      // Attach cleanup to both outcomes without creating an unhandled rejection.
      void flight.then(
        () => this.flights.delete(flightKey),
        () => this.flights.delete(flightKey),
      );
    }
    return structuredClone(await flight);
  }
  private async perform(
    url: string,
    payload: unknown,
    lane: Lane,
  ): Promise<unknown> {
    const pool = this.lanes[lane];
    // Reserve a lane for public sources so a hung follower request cannot
    // consume every slot. Both lanes still obey the same venue cooldown.
    if (pool.active >= Math.max(1, Math.floor(this.concurrency / 2)))
      await new Promise<void>((resolve) => pool.waiters.push(resolve));
    else pool.active++;
    try {
      if (this.cooldownUntil > this.clock()) throw this.unavailable();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(12000),
          redirect: "error",
        });
      } catch {
        throw new AgentError(
          "VENUE_UNAVAILABLE",
          "Venue read did not complete. Fresh account evidence is required before execution.",
          true,
          503,
        );
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) {
          this.failures = Math.min(this.failures + 1, 5);
          const retry = response.headers.get("retry-after");
          const seconds = retry == null ? NaN : Number(retry);
          const retryMs =
            Number.isFinite(seconds) && seconds > 0
              ? seconds * 1000
              : retry && Number.isFinite(Date.parse(retry))
                ? Date.parse(retry) - this.clock()
                : 0;
          const backoff = Math.min(
            60_000,
            Math.max(1000 * 2 ** (this.failures - 1), retryMs),
          );
          this.cooldownUntil = Math.max(
            this.cooldownUntil,
            this.clock() + backoff,
          );
          this.cache.clear();
          throw this.unavailable();
        }
        throw new AgentError(
          "VENUE_UNAVAILABLE",
          "Venue read failed. Existing settings are preserved.",
          response.status >= 500,
          503,
        );
      }
      const data = await response.json();
      if (this.clock() >= this.cooldownUntil) this.failures = 0;
      return data;
    } finally {
      const next = pool.waiters.shift();
      if (next) next();
      else pool.active--;
    }
  }
}
