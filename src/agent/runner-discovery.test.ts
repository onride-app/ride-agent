import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { recommend } from "./domain.js";
import { FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Clock {
  at = 0;
  sequence = 0;
  readonly events = new Map<number, { at: number; run(): void }>();
  constructor(t: TestContext) {
    t.mock.method(Date, "now", () => this.at);
    t.mock.method(globalThis, "setTimeout", ((run: () => void, ms = 0) => {
      assert.ok(
        Number.isFinite(ms),
        "pending discovery must not schedule Infinity",
      );
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    }) as unknown as typeof setTimeout);
    t.mock.method(globalThis, "clearTimeout", (id: unknown) =>
      this.events.delete(id as number),
    );
    t.mock.method(console, "info", () => {});
  }
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    let fired = 0;
    for (;;) {
      const next = [...this.events]
        .filter(([, value]) => value.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++fired < 1000, "discovery must not busy-loop");
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
function fixture(t: TestContext) {
  const time = new Clock(t),
    repository = new MemoryRepository(),
    adapter = new FakeAdapter(),
    stop = new AbortController();
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  return { time, repository, adapter, runner, stop };
}
async function seed(f: ReturnType<typeof fixture>) {
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "single",
        basket_size: 1,
      },
      [f.adapter.pool[0]],
    ),
  );
  p.account_id = snapshot().account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = -1000;
  p.sleeves[0].reviewed_at = 0;
  await f.repository.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
}

it("does not block an existing user's actual absolute account retry on a pending discovery refresh", async (t) => {
  const f = fixture(t),
    refresh = deferred<string[]>();
  await seed(f);
  let reads = 0,
    finished = false;
  f.repository.users = async () =>
    ++reads === 1 ? ["alice"] : refresh.promise;
  const starts: number[] = [];
  f.adapter.source = async () => ({
    observed_at: f.time.at,
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  f.adapter.account = async () => {
    starts.push(f.time.at);
    if (starts.length === 1)
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "Fixture retry",
        true,
        503,
        { retry_after_ms: 5200 },
      );
    f.stop.abort();
    return snapshot();
  };
  const running = f.runner.run(f.stop.signal).then(() => {
    finished = true;
  });
  try {
    await f.time.advance(5200);
    assert.equal(reads, 2);
    assert.deepEqual(starts, [0, 5200]);
    assert.equal(
      finished,
      false,
      "shutdown still drains the already-started discovery read",
    );
    refresh.resolve(["alice", "late_user"]);
    await running;
    assert.deepEqual(starts, [0, 5200]);
    assert.equal(f.adapter.submitCount, 0);
  } finally {
    f.stop.abort();
    refresh.resolve([]);
    await running;
  }
  assert.equal(f.time.events.size, 0);
});

it("awaits initial discovery and ignores its late result after abort", async (t) => {
  const f = fixture(t),
    initial = deferred<string[]>();
  let reads = 0,
    finished = false;
  f.repository.users = () => {
    reads++;
    return initial.promise;
  };
  const starts: string[] = [];
  f.runner.tick = async (user) => {
    starts.push(user);
  };
  const running = f.runner.run(f.stop.signal).then(() => {
    finished = true;
  });
  try {
    await f.time.advance(10000);
    assert.equal(reads, 1);
    assert.deepEqual(starts, []);
    f.stop.abort();
    await flush();
    assert.equal(finished, false);
    initial.resolve(["alice", "late_user"]);
    await running;
    assert.deepEqual(starts, []);
  } finally {
    f.stop.abort();
    initial.resolve([]);
    await running;
  }
  assert.equal(f.time.events.size, 0);
});

it("coalesces refreshes while known users keep their cadence and starts the next discovery after completion", async (t) => {
  const f = fixture(t),
    refresh = deferred<string[]>();
  const queries: number[] = [],
    starts: number[] = [];
  f.repository.users = async () => {
    queries.push(f.time.at);
    return queries.length === 2 ? refresh.promise : ["alice"];
  };
  f.runner.tick = async () => {
    starts.push(f.time.at);
  };
  const running = f.runner.run(f.stop.signal);
  try {
    await f.time.advance(21000);
    assert.deepEqual(queries, [0, 5000], "only one discovery may be in flight");
    assert.deepEqual(starts, [0, 5000, 10000, 15000, 20000]);
    refresh.resolve(["alice"]);
    await flush();
    await f.time.advance(4999);
    assert.deepEqual(queries, [0, 5000]);
    await f.time.advance(1);
    assert.deepEqual(queries, [0, 5000, 26000]);
  } finally {
    f.stop.abort();
    refresh.resolve([]);
    await running;
  }
  assert.equal(f.time.events.size, 0);
});

it("waits without polling timers when an empty worklist has a pending refresh", async (t) => {
  const f = fixture(t),
    refresh = deferred<string[]>();
  let reads = 0;
  f.repository.users = async () => (++reads === 1 ? [] : refresh.promise);
  const starts: string[] = [];
  f.runner.tick = async (user) => {
    starts.push(user);
    f.stop.abort();
  };
  const running = f.runner.run(f.stop.signal);
  try {
    await f.time.advance(1000000);
    assert.equal(reads, 2);
    assert.equal(f.time.events.size, 0);
    assert.deepEqual(starts, []);
    refresh.resolve(["new_user"]);
    await flush();
    await running;
    assert.deepEqual(starts, ["new_user"]);
  } finally {
    f.stop.abort();
    refresh.resolve([]);
    await running;
  }
});

it("prunes removed users at completed refresh, defers new users until then, and drains running removed work", async (t) => {
  const f = fixture(t),
    refresh = deferred<string[]>(),
    a = deferred<void>(),
    b = deferred<void>();
  let reads = 0,
    active = 0,
    maximum = 0,
    finished = false;
  f.repository.users = async () =>
    ++reads === 1
      ? ["running_a", "running_b", "removed_queued"]
      : refresh.promise;
  const starts: string[] = [],
    perUser = new Map<string, number>();
  f.runner.tick = async (user) => {
    starts.push(user);
    maximum = Math.max(maximum, ++active);
    perUser.set(user, (perUser.get(user) ?? 0) + 1);
    assert.equal(perUser.get(user), 1);
    try {
      if (user === "running_a") await a.promise;
      else if (user === "running_b") await b.promise;
      else if (user === "fresh") f.stop.abort();
    } finally {
      active--;
      perUser.set(user, perUser.get(user)! - 1);
    }
  };
  const running = f.runner.run(f.stop.signal).then(() => {
    finished = true;
  });
  try {
    await f.time.advance(5000);
    assert.deepEqual(starts, ["running_a", "running_b"]);
    refresh.resolve(["running_a", "fresh", "fresh"]);
    await flush();
    a.resolve();
    await flush();
    assert.deepEqual(starts.slice(0, 2), ["running_a", "running_b"]);
    assert.ok(starts.includes("fresh"));
    assert.equal(starts.includes("removed_queued"), false);
    assert.equal(starts.filter((user) => user === "running_b").length, 1);
    const beforeDrain = [...starts];
    assert.equal(maximum, 2);
    assert.equal(finished, false, "removed running_b must still drain");
    b.resolve();
    await running;
    assert.equal(active, 0);
    assert.deepEqual(starts, beforeDrain);
  } finally {
    f.stop.abort();
    refresh.resolve([]);
    a.resolve();
    b.resolve();
    await running;
  }
});

it("fails run with the original refresh rejection and drains existing ticks without dispatching queued work", async (t) => {
  const f = fixture(t),
    refresh = deferred<string[]>(),
    a = deferred<void>(),
    b = deferred<void>();
  const error = new Error("fixture discovery rejection"),
    starts: string[] = [];
  let reads = 0,
    finished = false;
  f.repository.users = async () =>
    ++reads === 1 ? ["a", "b", "queued"] : refresh.promise;
  f.runner.tick = async (user) => {
    starts.push(user);
    await (user === "a" ? a.promise : b.promise);
  };
  const result = f.runner.run(f.stop.signal).then(
    () => {
      finished = true;
      return undefined;
    },
    (e: unknown) => {
      finished = true;
      return e;
    },
  );
  try {
    await f.time.advance(5000);
    refresh.reject(error);
    await flush();
    assert.equal(finished, false);
    a.resolve();
    await flush();
    assert.deepEqual(starts, ["a", "b"]);
    assert.equal(finished, false);
    b.resolve();
    assert.equal(await result, error);
    await f.time.advance(20000);
    assert.equal(reads, 2);
    assert.deepEqual(starts, ["a", "b"]);
  } finally {
    f.stop.abort();
    refresh.resolve([]);
    a.resolve();
    b.resolve();
    await result;
  }
});

it("fails run on a synchronous refresh throw before another ready tick starts", async (t) => {
  const f = fixture(t),
    error = new Error("fixture synchronous discovery throw"),
    starts: number[] = [];
  let reads = 0;
  f.repository.users = () => {
    if (++reads > 1) throw error;
    return Promise.resolve(["alice"]);
  };
  f.runner.tick = async () => {
    starts.push(f.time.at);
  };
  const result = f.runner.run(f.stop.signal).then(
    () => undefined,
    (e: unknown) => e,
  );
  try {
    await f.time.advance(20000);
    assert.equal(await result, error);
    assert.equal(reads, 2);
    assert.deepEqual(starts, [0]);
  } finally {
    f.stop.abort();
    await result;
  }
});

for (const rejection of [false, true])
  it(`drains refresh on abort and ${rejection ? "propagates its rejection" : "ignores late discovery changes"}`, async (t) => {
    const f = fixture(t),
      refresh = deferred<string[]>(),
      tick = deferred<void>();
    const error = new Error("fixture shutdown discovery rejection"),
      starts: string[] = [];
    let reads = 0,
      finished = false;
    f.repository.users = async () =>
      ++reads === 1 ? ["alice"] : refresh.promise;
    f.runner.tick = async (user) => {
      starts.push(user);
      await tick.promise;
    };
    const result = f.runner.run(f.stop.signal).then(
      () => {
        finished = true;
        return undefined;
      },
      (e: unknown) => {
        finished = true;
        return e;
      },
    );
    try {
      await f.time.advance(5000);
      f.stop.abort();
      tick.resolve();
      await flush();
      assert.equal(finished, false);
      if (rejection) refresh.reject(error);
      else refresh.resolve(["late_new"]);
      assert.equal(await result, rejection ? error : undefined);
      await f.time.advance(10000);
      assert.equal(reads, 2);
      assert.deepEqual(starts, ["alice"]);
    } finally {
      f.stop.abort();
      refresh.resolve([]);
      tick.resolve();
      await result;
    }
  });

it("reacquires current closed portfolio state while its old worklist remains pending", async (t) => {
  const f = fixture(t),
    refresh = deferred<string[]>();
  await seed(f);
  let reads = 0;
  f.repository.users = async () =>
    ++reads === 1 ? ["alice"] : refresh.promise;
  const accounts: number[] = [],
    starts: number[] = [],
    tick = f.runner.tick.bind(f.runner);
  f.runner.tick = async (user) => {
    starts.push(f.time.at);
    return tick(user);
  };
  f.adapter.account = async () => {
    accounts.push(f.time.at);
    return snapshot();
  };
  f.adapter.source = async () => ({
    observed_at: f.time.at,
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  const running = f.runner.run(f.stop.signal);
  try {
    await f.time.advance(4500);
    await f.runner.notificationsIdle();
    await f.repository.transact("alice", async (state) => {
      state.portfolios[0].state = "closed";
      state.portfolios[0].revision++;
    });
    const expected = await f.repository.read("alice");
    await f.time.advance(500);
    assert.deepEqual(starts, [0, 5000]);
    assert.deepEqual(
      accounts,
      [0],
      "cached worklist does not authorize a financial read for current closed state",
    );
    assert.deepEqual(await f.repository.read("alice"), expected);
    assert.equal(f.adapter.submitCount, 0);
  } finally {
    f.stop.abort();
    refresh.resolve([]);
    await running;
  }
});
