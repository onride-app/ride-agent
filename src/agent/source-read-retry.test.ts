import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { now, recommend, type Execution, type MonitorError } from "./domain.js";
import { FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const base = 1793200000000;
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
  at = base;
  private sequence = 0;
  private events = new Map<number, { at: number; run(): void }>();
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
      assert.ok(
        ++fired < 1000,
        "an expired account hint must not spin on the same user",
      );
      this.at = first[1].at;
      this.events.delete(first[0]);
      first[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
function sourceError(delay = 45000): MonitorError {
  return {
    at: base,
    code: "VENUE_READ_BUDGET_EXHAUSTED",
    message: "Public history capacity",
    retryable: true,
    read_scope: "source",
    details: { retry_after_ms: delay },
  };
}
function budgetError(delay = 45000) {
  return new AgentError(
    "VENUE_READ_BUDGET_EXHAUSTED",
    "Fixture capacity",
    true,
    503,
    { retry_after_ms: delay },
  );
}
async function fixture(t: TestContext) {
  const time = new Clock(t),
    repository = new MemoryRepository(),
    adapter = new FakeAdapter();
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
        copy_mode: "fixed",
        fixed_margin_usdc: "4",
      },
      [adapter.pool[0]],
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = base - 1000;
  p.reconciliation = "complete";
  const sleeve = p.sleeves[0];
  sleeve.reviewed_at = base;
  sleeve.initialized = true;
  sleeve.fixed_last_fill_at = base - 1000;
  sleeve.fixed_targets = {};
  sleeve.source_quantities = {};
  sleeve.fixed_seen_fills = [];
  await repository.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  const accountTimes: number[] = [],
    sourceTimes: number[] = [];
  adapter.account = async () => {
    accountTimes.push(now());
    return adapter.preflight();
  };
  const flat = () => ({
    observed_at: now(),
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  adapter.source = async () => {
    sourceTimes.push(now());
    return flat();
  };
  adapter.sourceFills = async () => ({ fills: [], complete: true });
  const service = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  return {
    time,
    repository,
    adapter,
    accountTimes,
    sourceTimes,
    flat,
    runner: () => new AgentRunner(service),
    read: async () => (await repository.read("alice")).portfolios[0],
  };
}

it("keeps public history retry independent across restart, account failure and repeated audits without renewing its deadline", async (t) => {
  const f = await fixture(t),
    ids: string[] = [];
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.executions.push({
      id: "original_uncertain",
      key: "perps:BTC",
      target_quantity: "0.1",
      allocations: {},
      revision: p.revision,
      fingerprint: "frozen_original",
      created_at: base,
      expires_at: base + 120000,
      status: "uncertain",
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "2",
      error: null,
    });
  });
  f.adapter.execution = async (
    _user?: string,
    _p?: unknown,
    execution?: Execution,
  ) => {
    assert.ok(execution);
    ids.push(execution.id);
    return {
      status: "uncertain" as const,
      observed_quantity: null,
      settled: false,
    };
  };
  let histories = 0;
  f.adapter.sourceFills = async () => {
    if (++histories === 1) throw budgetError();
    return { fills: [], complete: true };
  };
  f.adapter.account = async () => {
    f.accountTimes.push(now());
    if (f.accountTimes.length === 2) throw budgetError(10000);
    return f.adapter.preflight();
  };
  await f.runner().tick("alice");
  const stored = structuredClone((await f.read()).source_read_error);
  assert.ok(stored);
  assert.equal(stored.at, base);
  assert.equal(stored.read_scope, "source");
  await f.time.advance(5000);
  await f.runner().tick("alice");
  assert.equal((await f.read()).last_error?.read_scope, "account");
  assert.deepEqual(
    (await f.read()).source_read_error,
    stored,
    "an account rejection cannot erase public retry metadata",
  );
  await f.time.advance(10000);
  await f.runner().tick("alice");
  const audited = await f.read();
  assert.equal(audited.snapshot?.observed_at, base + 15000);
  assert.equal(audited.audit_verified_at, base + 15000);
  assert.deepEqual(audited.source_read_error, stored);
  assert.equal(
    audited.last_error?.at,
    base,
    "rethrowing pending source evidence must not extend its deadline",
  );
  assert.equal(audited.sleeves[0].fixed_last_fill_at, base - 1000);
  assert.equal(histories, 1);
  assert.equal(
    f.sourceTimes.length,
    1,
    "pending public retry does not issue a new prefetch",
  );
  await f.time.advance(29999);
  await f.runner().tick("alice");
  assert.deepEqual((await f.read()).source_read_error, stored);
  assert.equal((await f.read()).last_error?.at, base);
  assert.equal(histories, 1);
  await f.time.advance(1);
  await f.runner().tick("alice");
  const recovered = await f.read();
  assert.equal(histories, 2);
  assert.equal(f.sourceTimes.length, 2);
  assert.equal(recovered.source_read_error, undefined);
  assert.equal(recovered.last_error, undefined);
  assert.equal(recovered.sleeves[0].fixed_last_fill_at, base + 45000);
  assert.equal(recovered.snapshot?.observed_at, base + 45000);
  assert.deepEqual(
    ids,
    Array(5).fill("original_uncertain"),
    "durable unknown reconciliation keeps the same ID on every tick",
  );
  assert.equal(f.adapter.submitCount, 0);
});

for (const phase of [
  "profile",
  "prefetch error",
  "stale refresh",
  "source fills",
] as const)
  it(`classifies only a real pure-public ${phase} failure as source retry`, async (t) => {
    const f = await fixture(t);
    let failures = 0;
    const fail = () => {
      failures++;
      throw budgetError(2000);
    };
    if (phase === "profile") {
      await f.repository.transact("alice", async (state) => {
        state.portfolios[0].sleeves[0].reviewed_at = 0;
      });
      f.adapter.profile = async () => fail();
    } else if (phase === "prefetch error")
      f.adapter.source = async () => fail();
    else if (phase === "stale refresh") {
      let calls = 0;
      f.adapter.source = async () =>
        ++calls === 1 ? { ...f.flat(), observed_at: base - 6000 } : fail();
    } else f.adapter.sourceFills = async () => fail();
    await f.runner().tick("alice");
    const failed = await f.read();
    assert.equal(failed.last_error?.read_scope, "source");
    assert.equal(failed.source_read_error?.at, base);
    assert.equal(failed.source_read_error?.code, "VENUE_READ_BUDGET_EXHAUSTED");
    await f.time.advance(1000);
    await f.runner().tick("alice");
    assert.equal(
      f.accountTimes.length,
      2,
      "a public local retry cannot block fresh account audits",
    );
    assert.equal((await f.read()).snapshot?.observed_at, base + 1000);
    assert.equal((await f.read()).last_error?.at, base);
    assert.equal(
      failures,
      1,
      "the pending wrapper must replay rather than issue the failed public request",
    );
    assert.equal(f.adapter.submitCount, 0);
  });

it("lazily starts missing prefetch when a public retry expires during the account read", async (t) => {
  const f = await fixture(t),
    account = deferred();
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.state = "attention";
    p.last_error = sourceError(1000);
    p.source_read_error = sourceError(1000);
  });
  await f.time.advance(500);
  f.adapter.account = async () => {
    f.accountTimes.push(now());
    await account.promise;
    return f.adapter.preflight();
  };
  const running = f.runner().tick("alice");
  try {
    await flush();
    assert.equal(
      f.sourceTimes.length,
      0,
      "A cannot prefetch while the public retry is pending",
    );
    await f.time.advance(1000);
    account.resolve();
    await running;
  } finally {
    account.resolve();
    await running;
  }
  const saved = await f.read();
  assert.deepEqual(f.sourceTimes, [base + 1500]);
  assert.equal(saved.source_read_error, undefined);
  assert.equal(saved.last_error, undefined);
  assert.equal(saved.sleeves[0].fixed_last_fill_at, base + 1500);
});

for (const sleeveState of ["closing", "loss_triggered", "closed"] as const)
  it(`does not defer ${sleeveState} controls or release when no sleeve needs a public await`, async (t) => {
    const f = await fixture(t);
    await f.repository.transact("alice", async (state) => {
      const p = state.portfolios[0];
      p.state = "attention";
      p.last_error = sourceError();
      p.source_read_error = sourceError();
      p.sleeves[0].state = sleeveState;
    });
    f.adapter.source = async () =>
      assert.fail("closing cannot start an unnecessary public read");
    f.adapter.profile = async () =>
      assert.fail("closing cannot wait on public profile");
    f.adapter.sourceFills = async () =>
      assert.fail("closing cannot wait on public history");
    await f.runner().tick("alice");
    const saved = await f.read();
    assert.equal(saved.state, "closed");
    assert.equal(saved.sleeves[0].state, "closed");
    assert.equal(saved.last_error, undefined);
    assert.equal(saved.source_read_error, undefined);
    assert.equal(f.adapter.releases, 1);
    assert.equal(f.accountTimes.length, 1);
    assert.equal(f.adapter.submitCount, 0);
  });

it("retains unexpired public backoff when incomplete reconciliation skips every public sleeve await", async (t) => {
  const f = await fixture(t);
  await f.repository.transact("alice", async (state) => {
    state.portfolios[0].source_read_error = sourceError();
  });
  f.adapter.snap.positions = { "perps:BTC": "0.1" };
  f.adapter.sourceFills = async () =>
    assert.fail("incomplete initialized sleeves cannot consume public history");
  await f.runner().tick("alice");
  const saved = await f.read();
  assert.equal(saved.reconciliation, "incomplete");
  assert.deepEqual(saved.source_read_error, sourceError());
  assert.equal(f.sourceTimes.length, 0);
  assert.equal(saved.sleeves[0].fixed_last_fill_at, base - 1000);
  await f.time.advance(45000);
  await f.runner().tick("alice");
  assert.equal((await f.read()).source_read_error, undefined);
  assert.equal(f.adapter.submitCount, 0);
});

for (const scope of ["account", undefined] as const)
  it(`ignores a new source-only field with invalid public scope ${scope}`, async (t) => {
    const f = await fixture(t);
    await f.repository.transact("alice", async (state) => {
      state.portfolios[0].source_read_error = {
        ...sourceError(),
        read_scope: scope,
      };
    });
    await f.runner().tick("alice");
    assert.equal(f.accountTimes.length, 1);
    assert.equal(f.sourceTimes.length, 1);
    assert.equal((await f.read()).source_read_error, undefined);
    assert.equal((await f.read()).sleeves[0].fixed_last_fill_at, base);
  });

it("keeps release account failures as an account barrier while preserving an independent public retry", async (t) => {
  const f = await fixture(t);
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0];
    p.source_read_error = sourceError();
    p.sleeves[0].state = "closing";
  });
  let releases = 0;
  f.adapter.release = async () => {
    releases++;
    throw budgetError();
  };
  await f.runner().tick("alice");
  const failed = await f.read();
  assert.equal(failed.last_error?.read_scope, "account");
  assert.deepEqual(failed.source_read_error, sourceError());
  await f.time.advance(5000);
  await f.runner().tick("alice");
  assert.equal(f.accountTimes.length, 1);
  assert.equal(releases, 1);
  assert.deepEqual((await f.read()).source_read_error, sourceError());
});

it("keeps a provider 429 global even when it came from a public await", async (t) => {
  const f = await fixture(t);
  f.adapter.source = async () => {
    throw new AgentError("VENUE_RATE_LIMITED", "Provider cooldown", true, 503, {
      retry_after_ms: 60000,
    });
  };
  await f.runner().tick("alice");
  const failed = await f.read();
  assert.equal(failed.last_error?.read_scope, "source");
  assert.equal(
    failed.source_read_error,
    undefined,
    "the source-only field must never carry global 429 backoff",
  );
  await f.time.advance(5000);
  await f.runner().tick("alice");
  assert.equal(f.accountTimes.length, 1);
  assert.equal((await f.read()).snapshot?.observed_at, base);
});

it("treats legacy unscoped budget metadata conservatively as account backoff", async (t) => {
  const f = await fixture(t);
  await f.repository.transact("alice", async (state) => {
    const error = sourceError();
    delete error.read_scope;
    state.portfolios[0].last_error = error;
  });
  await f.time.advance(5000);
  await f.runner().tick("alice");
  assert.equal(f.accountTimes.length, 0);
  assert.equal(f.sourceTimes.length, 0);
});

for (const oldCode of ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_RATE_LIMITED"])
  it(`does not reuse an expired old ${oldCode} UI hint after a successful audit is invalidated before planning`, async (t) => {
    const f = await fixture(t),
      stop = new AbortController();
    await f.repository.transact("alice", async (state) => {
      const p = state.portfolios[0];
      p.state = "attention";
      p.last_error = {
        ...sourceError(1000),
        code: oldCode,
        read_scope: "account",
      };
      p.source_read_error = sourceError();
    });
    const transact = f.repository.transact.bind(f.repository);
    let transactions = 0;
    f.repository.transact = async (user, work) => {
      const result = await transact(user, work);
      if (++transactions === 1)
        await transact(user, async (state) => {
          state.portfolios[0].revision++;
        });
      return result;
    };
    f.repository.users = async () => ["alice"];
    f.adapter.account = async () => {
      f.accountTimes.push(now());
      if (f.accountTimes.length === 2) stop.abort();
      return f.adapter.preflight();
    };
    await f.time.advance(2000);
    const running = f.runner().run(stop.signal);
    try {
      await flush();
      assert.deepEqual(f.accountTimes, [base + 2000]);
      await f.time.advance(4999);
      assert.deepEqual(f.accountTimes, [base + 2000]);
      await f.time.advance(1);
      await running;
      assert.deepEqual(f.accountTimes, [base + 2000, base + 7000]);
    } finally {
      stop.abort();
      await running;
    }
  });
