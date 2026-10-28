import assert from "node:assert/strict";
import { it } from "node:test";
import type { SourceSnapshot } from "./adapter.js";
import { SourceFeed, type SourceFeedOptions } from "./source-feed.js";

const initialTime = 1_700_000_000_000;
function snapshot(at: number, revision = "r1"): SourceSnapshot {
  return {
    observed_at: at,
    revision,
    account_value_usdc: "100",
    complete: true,
    positions: [
      {
        key: "perps:BTC",
        asset: "BTC",
        market: "perps",
        quantity: "1",
        price: "60000",
        source_entry_price: "59000",
        source_leverage: 1,
        observed_at: at,
        source_revision: revision,
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function fakeTime() {
  let at = initialTime,
    started = 0,
    unrefs = 0;
  const callbacks = new Map<object, () => void>();
  const intervals: number[] = [];
  const timers: NonNullable<SourceFeedOptions["timers"]> = {
    setInterval(callback, interval) {
      started++;
      intervals.push(interval);
      const handle = {
        unref() {
          unrefs++;
        },
      };
      callbacks.set(handle, callback);
      return handle;
    },
    clearInterval(handle) {
      callbacks.delete(handle as object);
    },
  };
  return {
    clock: () => at,
    advance: (ms: number) => {
      at += ms;
    },
    tick: () => {
      for (const callback of callbacks.values()) callback();
    },
    counts: () => ({ active: callbacks.size, started, unrefs }),
    timers,
    intervals,
  };
}

it("starts lazy unref polling and keeps collecting public sources while an unrelated follower account read is hung", async () => {
  const time = fakeTime(),
    account = deferred<void>();
  let samples = 0,
    accountDone = false;
  void account.promise.then(() => {
    accountDone = true;
  });
  const feed = new SourceFeed(
    async () => snapshot(time.clock() - 100, `r${++samples}`),
    time,
  );
  try {
    assert.equal(time.counts().active, 0);
    const first = await feed.read("public-trader-a");
    assert.equal(first.observed_at, initialTime - 100);
    assert.deepEqual(time.intervals, [5000]);
    assert.deepEqual(time.counts(), { active: 1, started: 1, unrefs: 1 });
    for (let i = 0; i < 3; i++) {
      time.advance(5000);
      time.tick();
      await feed.pollOnce();
      const latest = await feed.read("public-trader-a");
      assert.equal(latest.revision, `r${i + 2}`);
      assert.equal(latest.observed_at, time.clock() - 100);
      assert.equal(accountDone, false);
    }
    assert.equal(samples, 4);
  } finally {
    feed.close();
    account.resolve();
  }
});

it("returns isolated clones and preserves the source's real observation time", async () => {
  const time = fakeTime();
  const source = snapshot(time.clock() - 1000);
  let calls = 0;
  const feed = new SourceFeed(async () => {
    calls++;
    return source;
  }, time);
  try {
    const first = await feed.read("a");
    first.positions[0].quantity = "999";
    source.positions[0].price = "1";
    source.observed_at = time.clock();
    const second = await feed.read("a");
    assert.equal(calls, 1);
    assert.equal(second.positions[0].quantity, "1");
    assert.equal(second.positions[0].price, "60000");
    assert.equal(second.observed_at, time.clock() - 1000);
    assert.notEqual(first.positions, second.positions);
  } finally {
    feed.close();
  }
});

it("shares same-id flights, limits all source fetches to two and never overlaps a poll round", async () => {
  const time = fakeTime();
  const gates = new Map<string, ReturnType<typeof deferred<SourceSnapshot>>>();
  const calls: string[] = [];
  let active = 0,
    maximum = 0;
  const feed = new SourceFeed(async (id) => {
    calls.push(id);
    active++;
    maximum = Math.max(maximum, active);
    const gate = deferred<SourceSnapshot>();
    gates.set(id, gate);
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  }, time);
  try {
    const reads = [
      feed.read("a"),
      feed.read("a"),
      feed.read("b"),
      feed.read("c"),
      feed.read("d"),
    ];
    await flush();
    assert.deepEqual(calls, ["a", "b"]);
    const poll = feed.pollOnce();
    assert.equal(feed.pollOnce(), poll);
    time.tick();
    gates.get("a")!.resolve(snapshot(time.clock(), "a"));
    await flush();
    assert.deepEqual(calls, ["a", "b", "c"]);
    gates.get("b")!.resolve(snapshot(time.clock(), "b"));
    await flush();
    assert.deepEqual(calls, ["a", "b", "c", "d"]);
    gates.get("c")!.resolve(snapshot(time.clock(), "c"));
    gates.get("d")!.resolve(snapshot(time.clock(), "d"));
    const values = await Promise.all(reads);
    await poll;
    assert.equal(maximum, 2);
    assert.equal(calls.filter((id) => id === "a").length, 1);
    assert.notEqual(values[0], values[1]);
  } finally {
    feed.close();
  }
});

it("a latest failure is surfaced instead of last-good data and retried only after cooldown", async () => {
  const time = fakeTime();
  let calls = 0,
    fail = false;
  const limited = new Error("public source rate limited");
  const feed = new SourceFeed(async () => {
    calls++;
    if (fail) throw limited;
    return snapshot(time.clock(), `r${calls}`);
  }, time);
  try {
    await feed.read("a");
    time.advance(5001);
    fail = true;
    await feed.pollOnce();
    assert.equal(calls, 2);
    await assert.rejects(feed.read("a"), (error) => error === limited);
    await feed.pollOnce();
    await feed.pollOnce();
    assert.equal(calls, 2);
    time.advance(5000);
    await assert.rejects(feed.read("a"), (error) => error === limited);
    assert.equal(calls, 3);
    await assert.rejects(feed.read("a"), (error) => error === limited);
    assert.equal(calls, 3);
    fail = false;
    time.advance(5000);
    const latest = await feed.read("a");
    assert.equal(calls, 4);
    assert.equal(latest.revision, "r4");
    assert.equal(latest.observed_at, time.clock());
  } finally {
    feed.close();
  }
});

it("rejects stale, future, expired and incomplete observations without relabeling them fresh", async () => {
  for (const patch of [
    { observed_at: initialTime - 5001 },
    { observed_at: initialTime + 1 },
    { observed_at: NaN },
    { complete: false },
    { expires_at: initialTime - 1 },
    { positions: null },
    { positions: snapshot(initialTime - 5001).positions },
  ]) {
    const time = fakeTime();
    let calls = 0;
    const feed = new SourceFeed(async () => {
      calls++;
      return { ...snapshot(initialTime), ...patch } as SourceSnapshot;
    }, time);
    try {
      await assert.rejects(feed.read("a"), { code: "SOURCE_STALE" });
      await assert.rejects(feed.read("a"), { code: "SOURCE_STALE" });
      await feed.pollOnce();
      assert.equal(calls, 1);
    } finally {
      feed.close();
    }
  }
});

it("rechecks observation age after an in-flight fetch and before returning a cached value", async () => {
  const time = fakeTime(),
    gate = deferred<SourceSnapshot>();
  let calls = 0;
  const feed = new SourceFeed(async () => {
    calls++;
    return calls === 1 ? snapshot(initialTime - 4999) : gate.promise;
  }, time);
  try {
    const old = await feed.read("a");
    assert.equal(old.observed_at, initialTime - 4999);
    time.advance(2);
    const pending = feed.read("a");
    const rejected = assert.rejects(pending, { code: "SOURCE_STALE" });
    await flush();
    assert.equal(calls, 2);
    const observationTime = time.clock();
    time.advance(5001);
    gate.resolve(snapshot(observationTime));
    await rejected;
    await assert.rejects(feed.read("a"), { code: "SOURCE_STALE" });
    assert.equal(calls, 2);
  } finally {
    feed.close();
  }
});

it("expires unread interests, stops the idle timer and restarts lazily for a new read", async () => {
  const time = fakeTime();
  const calls = new Map<string, number>();
  const feed = new SourceFeed(async (id) => {
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return snapshot(time.clock());
  }, time);
  try {
    await feed.read("a");
    await feed.read("b");
    time.advance(40_000);
    await feed.read("a");
    time.advance(20_000);
    time.tick();
    await feed.pollOnce();
    assert.equal(calls.get("a"), 3);
    assert.equal(calls.get("b"), 1);
    time.advance(40_000);
    await feed.pollOnce();
    assert.equal(time.counts().active, 0);
    assert.equal(calls.get("a"), 3);
    await feed.read("b");
    assert.equal(calls.get("b"), 2);
    assert.deepEqual(time.counts(), { active: 1, started: 2, unrefs: 2 });
  } finally {
    feed.close();
  }
});

it("close clears timers and queued work and refuses late in-flight results", async () => {
  const time = fakeTime();
  const gates = [deferred<SourceSnapshot>(), deferred<SourceSnapshot>()];
  let calls = 0;
  const feed = new SourceFeed(async () => gates[calls++].promise, time);
  const reads = [feed.read("a"), feed.read("b"), feed.read("c")];
  const settled = Promise.allSettled(reads);
  await flush();
  assert.equal(calls, 2);
  feed.close();
  feed.close();
  assert.equal(time.counts().active, 0);
  await assert.rejects(feed.read("d"), { code: "SOURCE_FEED_CLOSED" });
  time.tick();
  await feed.pollOnce();
  gates.forEach((gate) => gate.resolve(snapshot(time.clock())));
  for (const outcome of await settled) {
    assert.equal(outcome.status, "rejected");
    assert.equal(
      (outcome as PromiseRejectedResult).reason.code,
      "SOURCE_FEED_CLOSED",
    );
  }
  assert.equal(calls, 2);
});

it("polling reuses a fresh on-demand observation at the unchanged 5s boundary without relabeling it", async () => {
  const time = fakeTime();
  let calls = 0;
  const feed = new SourceFeed(async () => ({
    ...snapshot(time.clock(), `r${++calls}`),
    expires_at: time.clock() + 20_000,
  }), time);
  try {
    const first = await feed.read("a");
    for (const elapsed of [0, 4999, 1]) {
      time.advance(elapsed);
      time.tick();
      await feed.pollOnce();
      const reused = await feed.read("a");
      assert.equal(calls, 1);
      assert.deepEqual(reused, first);
      assert.equal(reused.observed_at, initialTime);
      assert.equal(reused.positions[0].observed_at, initialTime);
      assert.equal((reused as SourceSnapshot & {expires_at: number}).expires_at, initialTime + 20_000);
    }
    time.advance(1);
    await feed.pollOnce();
    const latest = await feed.read("a");
    assert.equal(calls, 2);
    assert.equal(latest.observed_at, initialTime + 5001);
    assert.equal(latest.revision, "r2");
  } finally { feed.close(); }
});

it("an on-demand refresh just before the next poll prevents a duplicate source REST fetch", async () => {
  const time = fakeTime();
  let calls = 0;
  const feed = new SourceFeed(async () => snapshot(time.clock(), `r${++calls}`), time);
  try {
    await feed.read("a");
    time.advance(5001);
    const refreshed = await feed.read("a");
    assert.equal(calls, 2);
    time.advance(1000);
    time.tick();
    await feed.pollOnce();
    assert.equal(calls, 2);
    assert.deepEqual(await feed.read("a"), refreshed);
    assert.equal(refreshed.observed_at, initialTime + 5001);
  } finally { feed.close(); }
});

it("polling refreshes when any position timestamp or frame expiry is stale even while the top-level timestamp is fresh", async () => {
  for (const variant of ["position", "expiry"] as const) {
    const time = fakeTime();
    let calls = 0;
    const feed = new SourceFeed(async () => {
      const observed = snapshot(time.clock(), `r${++calls}`);
      if (calls === 1 && variant === "position") observed.positions[0].observed_at -= 4000;
      return variant === "expiry" && calls === 1 ? { ...observed, expires_at: time.clock() + 1000 } : observed;
    }, time);
    try {
      const initial = await feed.read("a");
      time.advance(variant === "expiry" ? 1000 : 1001);
      await feed.pollOnce();
      assert.equal(calls, 2, variant);
      const refreshed = await feed.read("a");
      assert.equal(refreshed.revision, "r2");
      assert.notEqual(refreshed.observed_at, initial.observed_at);
    } finally { feed.close(); }
  }
});

it("a cached flat observation is reused without inventing positions, timestamps or another live interest", async () => {
  const time = fakeTime();
  let calls = 0;
  const feed = new SourceFeed(async () => ({ ...snapshot(time.clock(), `r${++calls}`), positions: [] }), time);
  try {
    const initial = await feed.read("a");
    time.advance(1000);
    await feed.pollOnce();
    assert.equal(calls, 1);
    assert.deepEqual(await feed.read("a"), initial);
    // Only explicit reads renew lastReadAt; repeated timer polling does not.
    for (let i = 0; i < 12; i++) {
      time.advance(5000);
      await feed.pollOnce();
    }
    assert.equal(time.counts().active, 0);
  } finally { feed.close(); }
});

it("a known failure cannot be hidden by a previous frame that appears fresh after clock rollback", async () => {
  const time = fakeTime();
  const failure = new Error("latest source read failed");
  let calls = 0, fail = false;
  const feed = new SourceFeed(async () => {
    calls++;
    if (fail) throw failure;
    return snapshot(time.clock());
  }, time);
  try {
    await feed.read("a");
    time.advance(5001);
    fail = true;
    await feed.pollOnce();
    assert.equal(calls, 2);
    time.advance(-4000); // Old successful frame now looks young; failure wins.
    await feed.pollOnce();
    await assert.rejects(feed.read("a"), error => error === failure);
    assert.equal(calls, 2);
    time.advance(9000);
    await feed.pollOnce();
    assert.equal(calls, 3);
    await assert.rejects(feed.read("a"), error => error === failure);
  } finally { feed.close(); }
});
