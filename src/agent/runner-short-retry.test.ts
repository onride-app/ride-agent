import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { now, recommend, type Execution } from "./domain.js";
import { FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Clock {
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
    t.mock.method(console, "info", () => {});
  }
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    let fired = 0;
    for (;;) {
      const first = [...this.events]
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      assert.ok(++fired < 1000, "a persisted hint must not spin on one user");
      this.at = first[1].at;
      this.events.delete(first[0]);
      first[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
async function fixture(t: TestContext) {
  const time = new Clock(t),
    repository = new MemoryRepository(),
    adapter = new FakeAdapter(),
    stop = new AbortController();
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
      [adapter.pool[0]],
    ),
  );
  p.account_id = snapshot().account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = -1000;
  p.snapshot = snapshot();
  p.sleeves[0].reviewed_at = 0;
  p.executions.push({
    id: "original_uncertain",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: p.revision,
    fingerprint: "frozen_original",
    created_at: 0,
    expires_at: 120000,
    status: "uncertain",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  });
  await repository.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  repository.users = async () => ["alice"];
  adapter.source = async () => ({
    observed_at: now(),
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  const accounts: number[] = [],
    durable: number[] = [],
    ids: string[] = [];
  const execution = async (_user?: string, _p?: unknown, task?: Execution) => {
    assert.ok(task);
    durable.push(now());
    ids.push(task.id);
    return {
      status: "uncertain" as const,
      observed_quantity: null,
      settled: false,
    };
  };
  adapter.execution = execution;
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  return {
    time,
    repository,
    adapter,
    stop,
    runner,
    accounts,
    durable,
    ids,
    execution,
  };
}
function exhausted(delay: number) {
  return new AgentError(
    "VENUE_READ_BUDGET_EXHAUSTED",
    "Account pacing",
    true,
    503,
    { retry_after_ms: delay },
  );
}

for (const scenario of ["near future", "expired during drain"] as const)
  it(`finishes the full durable phase before a ${scenario} account deadline and avoids an early extra durable tick`, async (t) => {
    const f = await fixture(t),
      gate = deferred(),
      retry = scenario === "near future" ? 5200 : 216;
    let drained = false;
    f.adapter.account = async () => {
      f.accounts.push(now());
      if (f.accounts.length === 1) throw exhausted(retry);
      assert.equal(
        drained,
        true,
        "a retried account may not overlap its previous durable phase",
      );
      f.stop.abort();
      return f.adapter.preflight();
    };
    f.adapter.execution = async (...args) => {
      const result = await f.execution(...args);
      if (f.durable.length === 1) {
        await gate.promise;
        drained = true;
      } else if (now() < retry)
        await new Promise<void>((resolve) => setTimeout(resolve, 2300));
      return result;
    };
    const running = f.runner.run(f.stop.signal);
    try {
      await flush();
      assert.deepEqual(f.accounts, [0]);
      assert.deepEqual(f.durable, [0]);
      await f.time.advance(2300);
      gate.resolve();
      await flush();
      if (scenario === "near future") {
        await f.time.advance(2700);
        assert.deepEqual(
          f.durable,
          [0],
          "normalDue=5000 is 200ms too early and must not start skip-A plus another 2.3s C",
        );
        assert.deepEqual(f.accounts, [0]);
        await f.time.advance(199);
        assert.deepEqual(f.durable, [0]);
        await f.time.advance(1);
      }
      await running;
      const expected = scenario === "near future" ? 5200 : 2300;
      assert.deepEqual(f.accounts, [0, expected]);
      assert.deepEqual(
        f.durable,
        [0, expected],
        "the abort still drains the second tick's durable reconciliation",
      );
      assert.deepEqual(f.ids, ["original_uncertain", "original_uncertain"]);
      assert.equal(f.adapter.submitCount, 0);
    } finally {
      f.stop.abort();
      gate.resolve();
      await f.time.advance(3000);
      await running;
    }
    assert.equal(f.time.events.size, 0);
  });

it("keeps normal durable reconciliation cycles while an account deadline is farther than one interval away", async (t) => {
  const f = await fixture(t);
  f.adapter.account = async () => {
    f.accounts.push(now());
    if (f.accounts.length === 1) throw exhausted(20000);
    f.stop.abort();
    return f.adapter.preflight();
  };
  const running = f.runner.run(f.stop.signal);
  try {
    await flush();
    await f.time.advance(15000);
    assert.deepEqual(f.accounts, [0]);
    assert.deepEqual(f.durable, [0, 5000, 10000, 15000]);
    assert.deepEqual(f.ids, Array(4).fill("original_uncertain"));
    await f.time.advance(5000);
    await running;
    assert.deepEqual(f.accounts, [0, 20000]);
    assert.deepEqual(f.durable, [0, 5000, 10000, 15000, 20000]);
    assert.equal(f.adapter.submitCount, 0);
  } finally {
    f.stop.abort();
    await running;
  }
  assert.equal(f.time.events.size, 0);
});

it("clears a still-future account hint after an uncaught durable transaction error and backs off from completion", async (t) => {
  const f = await fixture(t),
    failure = deferred(),
    errors: unknown[][] = [];
  t.mock.method(console, "error", (...items: unknown[]) => errors.push(items));
  const transact = f.repository.transact.bind(f.repository);
  let transactions = 0;
  f.repository.transact = (user, work) => {
    const current = ++transactions;
    return transact(user, async (state) => {
      const result = await work(state);
      if (current === 3) {
        await failure.promise;
        throw new Error("fixture durable commit failure");
      }
      return result;
    });
  };
  f.adapter.account = async () => {
    f.accounts.push(now());
    if (f.accounts.length === 1) throw exhausted(5200);
    f.stop.abort();
    return f.adapter.preflight();
  };
  const running = f.runner.run(f.stop.signal);
  try {
    await flush();
    await f.time.advance(2300);
    failure.resolve();
    await flush();
    assert.equal(errors.length, 1);
    await f.time.advance(2900);
    assert.deepEqual(
      f.accounts,
      [0],
      "the failed tick must not reuse its 5200 future hint",
    );
    await f.time.advance(2099);
    assert.deepEqual(f.accounts, [0]);
    await f.time.advance(1);
    await running;
    assert.deepEqual(f.accounts, [0, 7300]);
    assert.deepEqual(f.ids, ["original_uncertain", "original_uncertain"]);
    assert.equal(f.adapter.submitCount, 0);
  } finally {
    f.stop.abort();
    failure.resolve();
    await running;
  }
  assert.equal(f.time.events.size, 0);
});

it("leaves the account cadence independent of a short public source-only retry", async (t) => {
  const f = await fixture(t);
  f.adapter.account = async () => {
    f.accounts.push(now());
    if (f.accounts.length === 2) f.stop.abort();
    return f.adapter.preflight();
  };
  f.adapter.source = async () => {
    throw exhausted(216);
  };
  const running = f.runner.run(f.stop.signal);
  try {
    await flush();
    await f.time.advance(216);
    assert.deepEqual(f.accounts, [0]);
    assert.deepEqual(f.durable, [0]);
    await f.time.advance(4783);
    assert.deepEqual(f.accounts, [0]);
    await f.time.advance(1);
    await running;
    assert.deepEqual(f.accounts, [0, 5000]);
    assert.deepEqual(f.durable, [0, 5000]);
    assert.equal(f.adapter.submitCount, 0);
  } finally {
    f.stop.abort();
    await running;
  }
  assert.equal(f.time.events.size, 0);
});
