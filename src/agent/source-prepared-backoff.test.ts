import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { it } from "node:test";
import { SourceFeed, type PreparedSourceRetryLimits } from "./source-feed.js";
import { CoordinatedReadError } from "./venue-read-transport.js";
import { AgentError } from "./contracts.js";
import type { SourceSnapshot, VenueAdapter } from "./adapter.js";
import type { Candidate } from "./domain.js";
import { observeSources } from "./source-observations.js";

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
class Time {
  at = 1700000000000;
  sequence = 0;
  events = new Map<number, { at: number; run(): void; interval?: number }>();
  clock = () => this.at;
  timeout = (run: () => void, ms: number) => {
    const id = ++this.sequence;
    this.events.set(id, { at: this.at + ms, run });
    return id;
  };
  clear = (id: number) => {
    this.events.delete(id);
  };
  timers = {
    setInterval: (run: () => void, ms: number) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run, interval: ms });
      return id;
    },
    clearInterval: this.clear,
  };
  async advance(ms: number) {
    const end = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      if (next[1].interval)
        this.events.set(next[0], {
          ...next[1],
          at: this.at + next[1].interval,
        });
      next[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
}
function snapshot(at: number, id = "source"): SourceSnapshot {
  return {
    observed_at: at,
    revision: id,
    account_value_usdc: "1",
    complete: true,
    positions: [],
  };
}
function parent(time: Time, owner: string, lifetime = 20000) {
  const abort = new AbortController(),
    until = time.at + lifetime;
  const expiry = time.timeout(
    () =>
      abort.abort(
        new AgentError("VENUE_READ_DEADLINE", "fixture deadline", true, 503),
      ),
    lifetime,
  );
  const limits: PreparedSourceRetryLimits = {
    signal: abort.signal,
    remainingMs: () => until - time.at,
    wait: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        if (ms >= until - time.at) {
          reject(
            new AgentError(
              "VENUE_READ_DEADLINE",
              "fixture deadline",
              true,
              503,
            ),
          );
          return;
        }
        const timer = time.timeout(() => {
          signal.removeEventListener("abort", stop);
          resolve();
        }, ms);
        const stop = () => {
          time.clear(timer);
          signal.removeEventListener("abort", stop);
          reject(signal.reason);
        };
        signal.addEventListener("abort", stop, { once: true });
      }),
  };
  return {
    owner,
    limits,
    signal: abort.signal,
    validate: () => {
      if (abort.signal.aborted) throw abort.signal.reason;
    },
    close: () => {
      time.clear(expiry);
      abort.abort(new Error("fixture parent closed"));
    },
  };
}
const unsent = () =>
  new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", false, 2000);
const context = new AsyncLocalStorage<string>();
function selection(p: ReturnType<typeof parent>, id: string, calls: string[]) {
  return {
    id,
    validate: p.validate,
    onDemand: (work: () => Promise<SourceSnapshot>) => {
      p.validate();
      calls.push(p.owner + ":" + id);
      return context.run(p.owner, work);
    },
  };
}

it("waits the existing backoff exactly and lets the earlier background timer create the one real prepared flight", async () => {
  const time = new Time(),
    p = parent(time, "A"),
    wrappers: string[] = [],
    fetches: { owner?: string; at: number }[] = [];
  const feed = new SourceFeed(
    async () => {
      fetches.push({ owner: context.getStore(), at: time.at });
      if (!context.getStore()) throw unsent();
      return snapshot(time.at);
    },
    { clock: time.clock, timers: time.timers },
  );
  await assert.rejects(feed.read("one"));
  const old = (feed as any).interests.get("one").failure;
  const s = selection(p, "one", wrappers);
  const result = feed.readPrepared("one", s.onDemand, p.limits, p.validate);
  await flush();
  await time.advance(4999);
  assert.equal(fetches.length, 1);
  assert.equal((feed as any).interests.get("one").failure, old);
  await time.advance(1);
  const value = await result;
  assert.deepEqual(fetches, [
    { owner: undefined, at: 1700000000000 },
    { owner: "A", at: 1700000005000 },
  ]);
  assert.equal(value.observed_at, 1700000005000);
  assert.deepEqual(wrappers, ["A:one"]);
  assert.equal((feed as any).preparedRetryCount, 0);
  p.close();
  feed.close();
  assert.equal(time.events.size, 0);
});

it("registers three existing failure generations without reading and gives the third source the original timer's S context before its worker arrives", async () => {
  const time = new Time(),
    p = parent(time, "A"),
    ids = ["one", "two", "three"],
    wrappers: string[] = [],
    fetches: { id: string; owner?: string; at: number }[] = [];
  const feed = new SourceFeed(
    async (id) => {
      fetches.push({ id, owner: context.getStore(), at: time.at });
      if (!context.getStore()) throw unsent();
      return snapshot(time.at, id);
    },
    { clock: time.clock, timers: time.timers },
  );
  await Promise.all(ids.map((id) => assert.rejects(feed.read(id))));
  const old = ids.map((id) => ({
    id,
    entry: (feed as any).interests.get(id),
    failure: (feed as any).interests.get(id).failure,
    last: (feed as any).interests.get(id).lastReadAt,
  }));
  const release = feed.registerPreparedSources(
    [...ids, "missing"].map((id) => selection(p, id, wrappers)),
    p.limits,
  );
  assert.equal(fetches.length, 3);
  assert.equal((feed as any).interests.size, 3);
  for (const x of old) {
    assert.equal(x.entry.failure, x.failure);
    assert.equal(x.entry.lastReadAt, x.last);
  }
  const results = observeSources(
    {
      source: (trader: Candidate) => {
        const s = selection(p, trader.id, wrappers);
        return feed.readPrepared(trader.id, s.onDemand, p.limits, p.validate);
      },
    } as VenueAdapter,
    ids.map((id) => ({ id })) as Candidate[],
  ).finish();
  await time.advance(4999);
  assert.equal(fetches.length, 3);
  await time.advance(1);
  const values = await results;
  assert.equal(fetches.length, 6);
  assert.deepEqual(
    wrappers,
    ids.map((id) => "A:" + id),
  );
  for (const id of ids) {
    const x = values.get(id)!;
    assert.equal(x.ok, true);
    if (x.ok) {
      assert.equal(x.value.revision, id);
      assert.equal(x.value.observed_at, time.at);
    }
  }
  assert.ok(
    fetches.slice(3).every((x) => x.owner === "A" && x.at === 1700000005000),
  );
  release();
  p.close();
  feed.close();
  assert.equal(time.events.size, 0);
});

it("removes a closed parent's group synchronously without retaining its S wrapper for later ordinary polling", async () => {
  const time = new Time(),
    p = parent(time, "A"),
    wrappers: string[] = [];
  let calls = 0;
  const feed = new SourceFeed(
    async () => {
      calls++;
      throw unsent();
    },
    { clock: time.clock, timers: time.timers },
  );
  await assert.rejects(feed.read("one"));
  const release = feed.registerPreparedSources(
    [selection(p, "one", wrappers)],
    p.limits,
  );
  assert.equal((feed as any).preparedRetryCount, 1);
  p.close();
  assert.equal((feed as any).preparedRetryCount, 0);
  await time.advance(5000);
  assert.equal(calls, 2);
  assert.deepEqual(wrappers, []);
  release();
  release();
  feed.close();
  assert.equal(time.events.size, 0);
});

it("keeps cancellation isolated between two parent groups sharing the same public source", async () => {
  const time = new Time(),
    a = parent(time, "A"),
    b = parent(time, "B"),
    wrappers: string[] = [];
  const feed = new SourceFeed(
    async () => {
      if (!context.getStore()) throw unsent();
      return snapshot(time.at);
    },
    { clock: time.clock, timers: time.timers },
  );
  await assert.rejects(feed.read("one"));
  const sa = selection(a, "one", wrappers),
    sb = selection(b, "one", wrappers);
  const da = feed.registerPreparedSources([sa], a.limits),
    db = feed.registerPreparedSources([sb], b.limits);
  const ra = feed.readPrepared("one", sa.onDemand, a.limits, a.validate),
    rb = feed.readPrepared("one", sb.onDemand, b.limits, b.validate);
  const cancelled = assert.rejects(ra);
  await flush();
  a.close();
  await cancelled;
  assert.equal(b.signal.aborted, false);
  await time.advance(5000);
  await rb;
  assert.deepEqual(wrappers, ["B:one"]);
  da();
  db();
  b.close();
  feed.close();
  assert.equal(time.events.size, 0);
});

it("does not reuse a failure generation even when the producer rethrows the same Error object", async () => {
  const time = new Time(),
    p = parent(time, "A"),
    cause = unsent(),
    wrappers: string[] = [];
  let calls = 0;
  const feed = new SourceFeed(
    async () => {
      calls++;
      throw cause;
    },
    { clock: time.clock, timers: time.timers },
  );
  await assert.rejects(feed.read("one"));
  const old = (feed as any).interests.get("one").failure;
  const s = selection(p, "one", wrappers),
    dispose = feed.registerPreparedSources([s], p.limits);
  const result = feed.readPrepared("one", s.onDemand, p.limits, p.validate),
    rejected = assert.rejects(result, (e) => e === cause);
  await time.advance(5000);
  await rejected;
  assert.equal(calls, 2);
  assert.equal(wrappers.length, 1);
  assert.notEqual((feed as any).interests.get("one").failure, old);
  assert.equal((feed as any).interests.get("one").failure.error, cause);
  dispose();
  p.close();
  feed.close();
  assert.equal(time.events.size, 0);
});

for (const cause of [
  new CoordinatedReadError("VENUE_RATE_LIMITED", false, 60000),
  new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", true, 2000),
  new CoordinatedReadError("VENUE_READ_DEADLINE", false),
  new Error("unverified"),
  new AgentError("VENUE_READ_BUDGET_EXHAUSTED", "unmarked", true, 503),
])
  it(
    "does not register or retry an ineligible source failure: " +
      (cause instanceof AgentError
        ? cause.code + ":" + (cause.details?.reason_code ?? "none")
        : "unverified"),
    async () => {
      const time = new Time(),
        p = parent(time, "A"),
        wrappers: string[] = [];
      let calls = 0;
      const feed = new SourceFeed(
        async () => {
          calls++;
          throw cause;
        },
        { clock: time.clock, timers: time.timers },
      );
      await assert.rejects(feed.read("one"));
      const s = selection(p, "one", wrappers);
      const dispose = feed.registerPreparedSources([s], p.limits);
      assert.equal((feed as any).preparedRetryCount, 0);
      await assert.rejects(
        feed.readPrepared("one", s.onDemand, p.limits, p.validate),
        (e) => e === cause,
      );
      assert.equal(calls, 1);
      assert.deepEqual(wrappers, []);
      dispose();
      p.close();
      feed.close();
      assert.equal(time.events.size, 0);
    },
  );

it("cannot wait past the original parent cutoff and clears waiters when the feed closes", async () => {
  for (const mode of ["short", "close"] as const) {
    const time = new Time(),
      p = parent(time, "A", mode === "short" ? 4999 : 20000),
      wrappers: string[] = [];
    let calls = 0;
    const feed = new SourceFeed(
      async () => {
        calls++;
        throw unsent();
      },
      { clock: time.clock, timers: time.timers },
    );
    await assert.rejects(feed.read("one"));
    const s = selection(p, "one", wrappers);
    const result = feed.readPrepared("one", s.onDemand, p.limits, p.validate),
      rejected = assert.rejects(result);
    await flush();
    if (mode === "close") feed.close();
    await rejected;
    assert.equal(calls, 1);
    assert.equal((feed as any).preparedRetryCount, 0);
    assert.deepEqual(wrappers, []);
    p.close();
    feed.close();
    assert.equal(time.events.size, 0);
  }
});

it("does not recreate an expired source interest from a retained group and rejects foreign validation without affecting a peer", async () => {
  const time = new Time(),
    p = parent(time, "A"),
    wrappers: string[] = [];
  let calls = 0;
  const feed = new SourceFeed(
    async () => {
      calls++;
      throw unsent();
    },
    { clock: time.clock, timers: time.timers, interestTtlMs: 100 },
  );
  await assert.rejects(feed.read("one"));
  const s = selection(p, "one", wrappers),
    dispose = feed.registerPreparedSources([s], p.limits);
  assert.throws(() =>
    feed.registerPreparedSources(
      [
        {
          ...s,
          validate: () => {
            throw new Error("foreign");
          },
        },
      ],
      p.limits,
    ),
  );
  assert.equal((feed as any).preparedRetryCount, 1);
  await time.advance(5000);
  assert.equal((feed as any).interests.size, 0);
  assert.equal((feed as any).preparedRetryCount, 0);
  assert.equal(calls, 1);
  assert.deepEqual(wrappers, []);
  dispose();
  p.close();
  feed.close();
  assert.equal(time.events.size, 0);
});
