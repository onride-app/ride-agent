import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { now, recommend, type Execution } from "./domain.js";
import { FakeAdapter, snapshot } from "./fixtures.js";
import {
  runMonitorTrace,
  type MonitorTimingRecord,
} from "./monitor-diagnostics.js";
import { Cursor, MemoryRepository, type State } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
class Clock {
  // Keep synthetic wall times positive without changing elapsed retry intervals.
  at = 1;
  private sequence = 0;
  readonly events = new Map<number, { at: number; run(): void }>();
  constructor(t: TestContext) {
    t.mock.method(Date, "now", () => this.at);
    t.mock.method(globalThis, "setTimeout", ((run: () => void, ms = 0) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    }) as unknown as typeof setTimeout);
    t.mock.method(globalThis, "clearTimeout", (id: unknown) =>
      this.events.delete(id as number),
    );
    t.mock.method(console, "info", () => {});
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    let fired = 0;
    for (;;) {
      const next = [...this.events]
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++fired < 1000, "no expired-hint spin");
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
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
    state.updates.push({
      id: "original_notification",
      at: 0,
      kind: "fixture",
      portfolio_id: p.id,
      message: "Pending original",
      data: { frozen: true },
      notification: "pending",
    });
  });
  repository.users = async () => ["alice"];
  const accounts: number[] = [],
    ids: string[] = [],
    delivered: string[] = [];
  adapter.account = async () => {
    accounts.push(now());
    throw exhausted(5200);
  };
  adapter.execution = async (
    _user?: string,
    _p?: unknown,
    execution?: Execution,
  ) => {
    assert.ok(execution);
    ids.push(execution.id);
    return {
      status: "uncertain" as const,
      observed_quantity: "0.125",
      settled: false,
    };
  };
  adapter.source = async () => ({
    observed_at: now(),
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  adapter.notify = async (_user?: string, event?: { id: string }) => {
    assert.ok(event);
    delivered.push(event.id);
  };
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  const records: MonitorTimingRecord[] = [];
  const tick = () =>
    runMonitorTrace(() => runner.tick("alice"), {
      thresholdMs: 0,
      clock: () => time.at,
      report: (r) => records.push(r),
    });
  return {
    time,
    repository,
    adapter,
    p,
    runner,
    records,
    tick,
    accounts,
    ids,
    delivered,
  };
}
const financialPhases = (records: MonitorTimingRecord[]) =>
  records
    .filter(
      (r) =>
        r.kind === "phase" &&
        ["audit_control", "observe_plan", "durable_notify"].includes(r.phase),
    )
    .map((r) => r.phase);

it("skips only the empty planning phase while retaining complete audit, unknown, frozen payload and notification state", async (t) => {
  const f = await fixture(t),
    committed: State[] = [],
    original = f.repository.transact.bind(f.repository),
    read = f.repository.read.bind(f.repository);
  f.repository.transact = async (user, work) => {
    const result = await original(user, work);
    committed.push(await read(user));
    return result;
  };
  await f.tick();
  await f.runner.notificationsIdle();
  const audit = committed[0],
    expected = structuredClone(audit);
  assert.equal(
    audit.portfolios[0].last_error?.code,
    "VENUE_READ_BUDGET_EXHAUSTED",
  );
  assert.equal(audit.portfolios[0].last_error?.read_scope, "account");
  assert.equal(
    audit.performance?.length,
    1,
    "audit failure performance is still durable",
  );
  assert.equal(
    audit.updates.filter((u) => u.kind === "VENUE_READ_BUDGET_EXHAUSTED")
      .length,
    1,
  );
  expected.portfolios[0].executions[0].observed_quantity = "0.125";
  for (const event of expected.updates) event.notification = "delivered";
  assert.deepEqual(
    await f.repository.read("alice"),
    expected,
    "all state, events, histories and frozen execution fields differ only by original-ID reconciliation and ACK",
  );
  assert.deepEqual(f.ids, ["original_uncertain"]);
  assert.deepEqual(f.delivered.sort(), audit.updates.map((u) => u.id).sort());
  assert.equal(f.adapter.submitCount, 0);
  assert.ok(
    committed[1].updates.every((u) => u.notification_claim?.token),
    "claims must commit before external notification sends",
  );
  assert.deepEqual(financialPhases(f.records), [
    "audit_control",
    "durable_notify",
  ]);
  assert.equal(
    committed.length,
    3,
    "two financial transactions plus the real notification ACK",
  );
});

it("keeps all three financial transactions after a successful audit", async (t) => {
  const f = await fixture(t);
  f.adapter.account = async () => snapshot();
  await f.tick();
  await f.runner.notificationsIdle();
  assert.deepEqual(financialPhases(f.records), [
    "audit_control",
    "observe_plan",
    "durable_notify",
  ]);
  assert.equal(
    (await f.repository.read("alice")).portfolios[0].snapshot?.observed_at,
    1,
  );
  assert.equal(f.adapter.submitCount, 0);
});

it("reacquires concurrent state in durable_notify without planning a new unaudited portfolio", async (t) => {
  const f = await fixture(t),
    original = f.repository.transact.bind(f.repository);
  let changed = false,
    sources = 0,
    profiles = 0;
  f.adapter.source = async () => {
    sources++;
    return {
      observed_at: now(),
      revision: "flat",
      account_value_usdc: "1000",
      complete: true,
      positions: [],
    };
  };
  f.adapter.profile = async () => {
    profiles++;
    throw new Error("must not profile unaudited configuration");
  };
  f.repository.transact = async (user, work) => {
    const result = await original(user, work);
    if (!changed) {
      changed = true;
      await original(user, async (state) => {
        const added = structuredClone(f.p);
        added.id = "new_concurrent_portfolio";
        added.executions = [];
        added.last_error = {
          at: 0,
          code: "VENUE_READ_BUDGET_EXHAUSTED",
          message: "Concurrent pacing",
          retryable: true,
          read_scope: "account",
          details: { retry_after_ms: 2200 },
        };
        added.sleeves[0].fixed_last_fill_at = -1234;
        state.portfolios.push(added);
        state.selected_trader_ids = ["external_choice"];
        state.portfolios[0].sleeves[0].fixed_targets = { "perps:BTC": "0.37" };
      });
    }
    return result;
  };
  await f.tick();
  await f.runner.notificationsIdle();
  const current = await f.repository.read("alice");
  assert.deepEqual(current.selected_trader_ids, ["external_choice"]);
  assert.deepEqual(current.portfolios[0].sleeves[0].fixed_targets, {
    "perps:BTC": "0.37",
  });
  assert.equal(current.portfolios[1].sleeves[0].fixed_last_fill_at, -1234);
  assert.equal(current.portfolios[1].executions.length, 0);
  assert.deepEqual(f.accounts, [1]);
  assert.equal(sources, 1, "only the original audit may prefetch sources");
  assert.equal(profiles, 0);
  assert.equal(
    (
      f.runner as unknown as { venueRetryAt: Map<string, number> }
    ).venueRetryAt.get("alice"),
    2200,
    "retry is read from the current locked durable state",
  );
  assert.deepEqual(financialPhases(f.records), [
    "audit_control",
    "durable_notify",
  ]);
});

for (const delay of [216, 5200])
  it(`uses the absolute retry deadline after two real delayed commits (${delay}ms hint)`, async (t) => {
    const f = await fixture(t),
      stop = new AbortController(),
      original = f.repository.transact.bind(f.repository);
    // Exclude optional asynchronous notification ACKs from this scheduling fixture.
    await original("alice", async (state) => {
      state.updates = [];
    });
    f.adapter.notify = async () => {
      throw new Error("financial failure notifications are held");
    };
    f.repository.transact = (user, work) =>
      original(user, async (state) => {
        await f.time.sleep(600);
        const result = await work(state);
        for (const update of state.updates)
          update.next_notification_at = 100000;
        await f.time.sleep(700);
        return result;
      });
    f.adapter.account = async () => {
      f.accounts.push(now());
      if (f.accounts.length === 1) throw exhausted(delay);
      stop.abort();
      return snapshot();
    };
    const running = f.runner.run(stop.signal);
    try {
      await f.time.advance(15000);
      await running;
      assert.deepEqual(
        f.accounts,
        [601, delay === 216 ? 3201 : 6401],
        "finish first, then wait only the remaining absolute retry delay",
      );
      assert.deepEqual(f.ids, ["original_uncertain", "original_uncertain"]);
      assert.equal(f.adapter.submitCount, 0);
    } finally {
      stop.abort();
      await f.time.advance(20000);
      await running;
    }
    assert.equal(f.time.events.size, 0);
  });

it("does not publish claims, notification sends or a new retry hint after a durable commit failure", async (t) => {
  const f = await fixture(t),
    original = f.repository.transact.bind(f.repository),
    read = f.repository.read.bind(f.repository);
  let durable = false,
    audit: State | undefined;
  const execution = f.adapter.execution.bind(f.adapter);
  f.adapter.execution = async (...args) => {
    durable = true;
    return execution(...args);
  };
  f.repository.transact = async (user, work) => {
    const result = await original(user, async (state) => {
      const value = await work(state);
      if (durable) throw new Error("fixture durable commit failure");
      return value;
    });
    audit = await read(user);
    return result;
  };
  await assert.rejects(f.tick(), /fixture durable commit failure/);
  await f.runner.notificationsIdle();
  assert.deepEqual(await f.repository.read("alice"), audit);
  assert.deepEqual(f.delivered, []);
  assert.equal(
    (
      f.runner as unknown as { venueRetryAt: Map<string, number> }
    ).venueRetryAt.has("alice"),
    false,
  );
  // A second transaction can reserve and deliver the original events after rollback.
  f.repository.transact = original;
  f.adapter.execution = execution;
  await f.tick();
  await f.runner.notificationsIdle();
  assert.ok(
    (await read("alice")).updates.every((u) => u.notification === "delivered"),
  );
  assert.deepEqual(f.ids, ["original_uncertain", "original_uncertain"]);
  assert.equal(f.adapter.submitCount, 0);
});
