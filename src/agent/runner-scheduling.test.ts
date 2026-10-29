import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { FakeAdapter, candidate, snapshot } from "./fixtures.js";
import { AgentError } from "./contracts.js";
import { recommend, type Execution, type Portfolio } from "./domain.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
class SchedulerClock {
  at = 0;
  private sequence = 0;
  readonly events = new Map<number, { at: number; run(): void }>();
  constructor(t: TestContext) {
    t.mock.method(Date, "now", () => this.at);
    t.mock.method(globalThis, "setTimeout", ((run: () => void, ms = 0) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    }) as unknown as typeof setTimeout);
    t.mock.method(globalThis, "clearTimeout", (id: unknown) => {
      this.events.delete(id as number);
    });
  }
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    for (;;) {
      const first = [...this.events]
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.at = first[1].at;
      this.events.delete(first[0]);
      first[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
function fixture(users: string[]) {
  const repository = new MemoryRepository();
  const adapter = new FakeAdapter();
  repository.users = async () => users;
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  return { repository, adapter, runner, controller: new AbortController() };
}

async function retryPortfolio(f: ReturnType<typeof fixture>) {
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
      [candidate(1)],
    ),
  );
  p.account_id = snapshot().account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = -1000;
  await f.repository.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  return p;
}

it("checks a healthy user while the first user's account read is blocked, and drains that read on abort", async () => {
  const f = fixture(["slow", "healthy"]),
    slow = deferred(),
    started: string[] = [];
  f.runner.tick = async (user) => {
    started.push(user);
    if (user === "slow") await slow.promise;
  };
  let finished = false;
  const running = f.runner.run(f.controller.signal, 60_000).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(started, ["slow", "healthy"]);
    f.controller.abort();
    await flush();
    assert.equal(finished, false, "shutdown must await the in-flight user");
  } finally {
    f.controller.abort();
    slow.resolve();
    await running;
  }
  assert.equal(finished, true);
  assert.deepEqual(started, ["slow", "healthy"]);
});

it("limits monitoring to two users and starts no queued user after abort", async () => {
  const f = fixture(["a", "b", "c", "d", "e"]),
    gates = new Map(
      ["a", "b", "c", "d", "e"].map((user) => [user, deferred()]),
    ),
    started: string[] = [];
  let active = 0,
    maximum = 0,
    finished = false;
  f.runner.tick = async (user) => {
    started.push(user);
    maximum = Math.max(maximum, ++active);
    await gates.get(user)!.promise;
    active--;
  };
  const running = f.runner.run(f.controller.signal, 60_000).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(started, ["a", "b"]);
    gates.get("a")!.resolve();
    await flush();
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(maximum, 2);
    f.controller.abort();
    await flush();
    assert.equal(finished, false);
  } finally {
    f.controller.abort();
    for (const gate of gates.values()) gate.resolve();
    await running;
  }
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.equal(active, 0);
});

it("keeps monitoring other users after one user fails and drains both workers", async (t) => {
  const f = fixture(["broken", "healthy", "last"]),
    healthy = deferred(),
    started: string[] = [],
    errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  f.runner.tick = async (user) => {
    started.push(user);
    if (user === "broken") throw new Error("fixture user read failed");
    if (user === "healthy") await healthy.promise;
    if (user === "last") f.controller.abort();
  };
  let finished = false;
  const running = f.runner.run(f.controller.signal, 60_000).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(started, ["broken", "healthy", "last"]);
    assert.equal(errors.length, 1);
    assert.equal(finished, false);
  } finally {
    f.controller.abort();
    healthy.resolve();
    await running;
  }
});

it("keeps both scheduling slots usable after synchronous user failures", async (t) => {
  const f = fixture(["broken-1", "broken-2", "healthy"]),
    started: string[] = [];
  t.mock.method(console, "error", () => {});
  f.runner.tick = (user) => {
    started.push(user);
    if (user.startsWith("broken"))
      throw new Error("fixture synchronous failure");
    f.controller.abort();
    return Promise.resolve();
  };
  const running = f.runner.run(f.controller.signal, 60_000);
  try {
    await flush();
    assert.deepEqual(started, ["broken-1", "broken-2", "healthy"]);
  } finally {
    f.controller.abort();
    await running;
  }
});

it("rechecks healthy users independently after completion without duplicating or overlapping discovered users", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["slow", "healthy", "healthy"]),
    slow = deferred(),
    firstHealthy = deferred(),
    calls = new Map<string, number[]>(),
    active = new Map<string, number>();
  let maximumPerUser = 0;
  f.runner.tick = async (user) => {
    const times = calls.get(user) ?? [];
    times.push(time.at);
    calls.set(user, times);
    active.set(user, (active.get(user) ?? 0) + 1);
    maximumPerUser = Math.max(maximumPerUser, active.get(user)!);
    if (user === "slow") await slow.promise;
    if (user === "healthy" && times.length === 1) await firstHealthy.promise;
    active.set(user, active.get(user)! - 1);
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    assert.deepEqual(calls.get("healthy"), [0]);
    await time.advance(3000);
    firstHealthy.resolve();
    await flush();
    await time.advance(4999);
    assert.deepEqual(calls.get("healthy"), [0]);
    await time.advance(1);
    assert.deepEqual(calls.get("healthy"), [0, 8000]);
    await time.advance(10000);
    assert.deepEqual(calls.get("healthy"), [0, 8000, 13000, 18000]);
    assert.deepEqual(calls.get("slow"), [0]);
    assert.equal(maximumPerUser, 1);
  } finally {
    f.controller.abort();
    slow.resolve();
    firstHealthy.resolve();
    await running;
  }
  assert.equal(time.events.size, 0);
});

it("refreshes user discovery while another user is blocked and drops removed users", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["slow", "old"]),
    slow = deferred(),
    started: string[] = [];
  let discovered = ["slow", "old"];
  f.repository.users = async () => discovered;
  f.runner.tick = async (user) => {
    started.push(user);
    if (user === "slow") await slow.promise;
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    assert.deepEqual(started, ["slow", "old"]);
    discovered = ["slow", "new"];
    await time.advance(5000);
    assert.deepEqual(started, ["slow", "old", "new"]);
    await time.advance(5000);
    assert.deepEqual(started, ["slow", "old", "new", "new"]);
  } finally {
    f.controller.abort();
    slow.resolve();
    await running;
  }
  assert.equal(time.events.size, 0);
});

it("does not enter a user callback when aborted during user discovery", async () => {
  const f = fixture(["queued"]),
    discovery = deferred();
  let started = 0;
  f.repository.users = async () => {
    await discovery.promise;
    return ["queued"];
  };
  f.runner.tick = async () => {
    started++;
  };
  const running = f.runner.run(f.controller.signal);
  f.controller.abort();
  discovery.resolve();
  await running;
  assert.equal(started, 0);
});

it("wakes a persisted short venue retry at its due time while preserving the normal notification cadence", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["alice"]),
    calls: number[] = [];
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
      [candidate(1)],
    ),
  );
  p.account_id = snapshot().account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = -1000;
  await f.repository.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  f.adapter.account = async () => {
    calls.push(time.at);
    throw new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "frame pacing",
      true,
      503,
      { retry_after_ms: 1250 },
    );
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    await flush();
    assert.deepEqual(calls, [0]);
    await time.advance(1249);
    assert.deepEqual(calls, [0]);
    await time.advance(1);
    await flush();
    assert.deepEqual(calls, [0, 1250]);
    await time.advance(1250);
    await flush();
    assert.deepEqual(calls, [0, 1250, 2500]);
  } finally {
    f.controller.abort();
    await running;
  }
});

for (const delayed of ["notification", "uncertain reconciliation"] as const)
  it(`retries immediately after a short venue deadline expires during durable ${delayed}`, async (t) => {
    const time = new SchedulerClock(t),
      f = fixture(["alice"]),
      gate = deferred(),
      accounts: number[] = [],
      reconciled: string[] = [];
    const p = await retryPortfolio(f);
    if (delayed === "uncertain reconciliation")
      await f.repository.transact("alice", async (state) => {
        state.portfolios[0].executions.push({
          id: "execution_original",
          key: "perps:BTC",
          target_quantity: "0.1",
          allocations: {},
          revision: p.revision,
          fingerprint: "original",
          created_at: 0,
          expires_at: 60000,
          status: "uncertain",
          task_id: null,
          observed_quantity: null,
          reserve_usdc: "2",
          error: null,
        });
      });
    let drained = false;
    f.adapter.account = async () => {
      accounts.push(time.at);
      if (accounts.length === 2) {
        assert.equal(
          drained,
          true,
          "pending durable work must finish before retrying the account",
        );
        f.controller.abort();
      }
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "frame pacing",
        true,
        503,
        { retry_after_ms: 216 },
      );
    };
    if (delayed === "notification")
      f.adapter.notify = async () => {
        f.adapter.notifyCount++;
        await gate.promise;
        drained = true;
      };
    else
      f.adapter.execution = async (
        _user?: string,
        _portfolio?: Portfolio,
        execution?: Execution,
      ) => {
        assert.ok(execution);
        reconciled.push(execution.id);
        await gate.promise;
        drained = true;
        return {
          status: "uncertain" as const,
          observed_quantity: null,
          settled: false,
        };
      };
    const running = f.runner.run(f.controller.signal);
    try {
      await flush();
      await flush();
      assert.deepEqual(accounts, [0]);
      await time.advance(1000);
      assert.deepEqual(
        accounts,
        [0],
        "an elapsed retry cannot interrupt durable work",
      );
      gate.resolve();
      await flush();
      await flush();
      assert.deepEqual(
        accounts,
        [0, 1000],
        "do not append another five seconds after the retry has already elapsed",
      );
    } finally {
      f.controller.abort();
      gate.resolve();
      await running;
    }
    const saved = await f.repository.read("alice");
    assert.ok(
      saved.updates.every((update) => update.notification === "delivered"),
    );
    if (delayed === "uncertain reconciliation") {
      assert.ok(
        reconciled.length > 0 &&
          reconciled.every((id) => id === "execution_original"),
      );
      assert.equal(saved.portfolios[0].executions[0].id, "execution_original");
    }
    assert.equal(f.adapter.submitCount, 0);
  });

it("retains a validated retry that expires while the first transaction is committing", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["alice"]),
    commit = deferred(),
    accounts: number[] = [];
  await retryPortfolio(f);
  const transact = f.repository.transact.bind(f.repository);
  let transactions = 0;
  f.repository.transact = (user, work) => {
    const first = ++transactions === 1;
    return transact(user, async (state) => {
      const result = await work(state);
      if (first) await commit.promise;
      return result;
    });
  };
  f.adapter.account = async () => {
    accounts.push(time.at);
    if (accounts.length === 2) f.controller.abort();
    throw new AgentError(
      "VENUE_RATE_LIMITED",
      "fixture short cooldown",
      true,
      503,
      { retry_after_ms: 216 },
    );
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    await time.advance(1000);
    assert.deepEqual(accounts, [0]);
    commit.resolve();
    await flush();
    await flush();
    assert.deepEqual(accounts, [0, 1000]);
  } finally {
    f.controller.abort();
    commit.resolve();
    await running;
  }
});

it("retains an elapsed portfolio retry while another portfolio finishes the first transaction", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["alice"]),
    otherAccount = deferred(),
    accounts: number[] = [];
  const first = await retryPortfolio(f),
    second = structuredClone(first);
  second.id = "portfolio_other";
  second.account_id = "account_other";
  second.venue_accounts = { perps: "account_other" };
  await f.repository.transact("alice", async (state) => {
    state.portfolios.push(second);
  });
  f.adapter.account = async (_user?: string, portfolio?: Portfolio) => {
    assert.ok(portfolio);
    if (portfolio.id === first.id) {
      accounts.push(time.at);
      if (accounts.length === 2) f.controller.abort();
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "frame pacing",
        true,
        503,
        { retry_after_ms: 216 },
      );
    }
    await otherAccount.promise;
    throw new AgentError(
      "ACCOUNT_NOT_READY",
      "fixture other account unavailable",
      true,
      503,
    );
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    await time.advance(1000);
    assert.deepEqual(accounts, [0]);
    otherAccount.resolve();
    await flush();
    await flush();
    assert.deepEqual(accounts, [0, 1000]);
  } finally {
    f.controller.abort();
    otherAccount.resolve();
    await running;
  }
});

for (const invalid of [0, 1.5, 60001])
  it(`keeps the normal five-second cadence for invalid venue retry ${invalid}`, async (t) => {
    const time = new SchedulerClock(t),
      f = fixture(["alice"]),
      accounts: number[] = [];
    await retryPortfolio(f);
    f.adapter.account = async () => {
      accounts.push(time.at);
      if (accounts.length === 2) f.controller.abort();
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "invalid fixture hint",
        true,
        503,
        { retry_after_ms: invalid },
      );
    };
    const running = f.runner.run(f.controller.signal);
    try {
      await flush();
      await time.advance(4999);
      assert.deepEqual(accounts, [0]);
      await time.advance(1);
      await flush();
      assert.deepEqual(accounts, [0, 5000]);
    } finally {
      f.controller.abort();
      await running;
    }
  });

it("clears an elapsed retry after an uncaught transaction error and backs off without spinning", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["alice"]),
    failure = deferred(),
    accounts: number[] = [],
    logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  await retryPortfolio(f);
  const transact = f.repository.transact.bind(f.repository);
  let transactions = 0;
  f.repository.transact = async (user, work) => {
    transactions++;
    if (transactions === 1) return transact(user, work);
    if (transactions === 2) await failure.promise;
    // Bound a regression's immediate retries so this test reports failure
    // instead of leaving an infinite microtask loop in the test runner.
    if (transactions > 6) f.controller.abort();
    throw new Error("fixture database write failure");
  };
  f.adapter.account = async () => {
    accounts.push(time.at);
    throw new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "frame pacing",
      true,
      503,
      { retry_after_ms: 216 },
    );
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    await time.advance(1000);
    failure.resolve();
    await flush();
    await flush();
    assert.equal(transactions, 2);
    assert.equal(logs.length, 1);
    await time.advance(4999);
    assert.equal(transactions, 2);
    await time.advance(1);
    assert.equal(transactions, 3);
    assert.equal(logs.length, 2);
    await time.advance(4999);
    assert.equal(transactions, 3);
    assert.deepEqual(accounts, [0]);
  } finally {
    f.controller.abort();
    failure.resolve();
    await running;
  }
});
