import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { recommend } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import {
  runMonitorTrace,
  type MonitorTimingRecord,
} from "./monitor-diagnostics.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const privateUser = "private_user_do_not_log",
  privatePortfolio = "private_portfolio_do_not_log",
  privateMessage = "private_notification_or_error_do_not_log";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}
async function fixture(t: TestContext) {
  let clock = 0;
  const base = 1793200000000;
  t.mock.method(Date, "now", () => base + clock);
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter(),
    p = fromPlan(
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
  p.id = privatePortfolio;
  p.account_id = snapshot().account_id;
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = base - 1000;
  p.reconciliation = "complete";
  p.sleeves[0].reviewed_at = base;
  adapter.source = async () => ({
    observed_at: base + clock,
    revision: "flat",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  await repository.transact(privateUser, async (state) => {
    state.portfolios.push(p);
    state.updates.push({
      id: "private_update_do_not_log",
      at: base,
      kind: "fixture",
      portfolio_id: privatePortfolio,
      message: privateMessage,
      data: { secret: privateMessage },
      notification: "pending",
    });
  });
  return {
    repository,
    adapter,
    base,
    runner: new AgentRunner(
      new AgentService(
        repository,
        adapter,
        "https://ride.test",
        new Cursor("s".repeat(32)),
      ),
    ),
    clock: () => clock,
    advance(at: number) {
      clock = at;
    },
  };
}
function assertPrivate(records: MonitorTimingRecord[]) {
  const text = JSON.stringify(records);
  for (const value of [
    privateUser,
    privatePortfolio,
    privateMessage,
    "private_update_do_not_log",
    snapshot().account_id,
  ])
    assert.ok(
      !text.includes(value),
      "diagnostics must contain no user, account, portfolio, event, message, or payload values",
    );
  assert.ok(records.length > 0);
  assert.equal(
    new Set(records.map((record) => record.tick_ref)).size,
    1,
    "nested Runner instrumentation must reuse one ephemeral trace",
  );
  assert.match(records[0].tick_ref, /^[0-9a-f-]{36}$/);
}

it("separates account work, early audit publication, source planning and durable notification timing", async (t) => {
  const f = await fixture(t),
    account = deferred(),
    source = deferred(),
    commit = deferred(),
    notification = deferred(),
    records: MonitorTimingRecord[] = [],
    order: string[] = [];
  f.adapter.account = async () => {
    order.push("account_start");
    await account.promise;
    order.push("account_done");
    return { ...snapshot(), observed_at: f.base };
  };
  f.adapter.source = async () => {
    await source.promise;
    order.push("source_done");
    return {
      observed_at: f.base + f.clock(),
      revision: "flat",
      account_value_usdc: "1000",
      complete: true,
      positions: [],
    };
  };
  f.adapter.notify = async () => {
    order.push("notify_start");
    await notification.promise;
    order.push("notify_done");
  };
  const transact = f.repository.transact.bind(f.repository);
  let transactions = 0;
  f.repository.transact = (user, work) => {
    const first = ++transactions === 1;
    return transact(user, async (state) => {
      const result = await work(state);
      if (first) {
        order.push("audit_ready");
        await commit.promise;
        order.push("audit_committing");
      }
      return result;
    });
  };
  let finished = false;
  const running = runMonitorTrace(() => f.runner.tick(privateUser), {
    clock: f.clock,
    report: (record) => records.push(record),
    thresholdMs: 0,
  }).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(order, ["account_start"]);
    f.advance(300);
    account.resolve();
    await flush();
    assert.deepEqual(order, ["account_start", "account_done", "audit_ready"]);
    assert.deepEqual(
      records
        .filter((record) => record.kind === "phase")
        .map((record) => [record.phase, record.duration_ms]),
      [["account_observation", 300]],
    );
    assert.equal(order.at(-1), "audit_ready");
    assert.ok(
      !order.includes("notify_start"),
      "notification may not start before the audit transaction commits",
    );
    f.advance(500);
    commit.resolve();
    await flush();
    assert.equal(order.at(-1), "audit_committing");
    assert.ok(
      !order.includes("notify_start"),
      "source planning must complete before durable notifications start",
    );
    f.advance(1100);
    source.resolve();
    await flush();
    assert.equal(order.at(-1), "notify_start");
    assert.equal(finished, false);
    f.advance(1700);
    notification.resolve();
    await running;
  } finally {
    account.resolve();
    source.resolve();
    commit.resolve();
    notification.resolve();
    await running;
  }
  assert.deepEqual(
    records
      .filter((record) => record.kind === "phase")
      .map((record) => [record.phase, record.duration_ms, record.outcome]),
    [
      ["account_observation", 300, "ok"],
      ["audit_control", 500, "ok"],
      ["observe_plan", 600, "ok"],
      ["durable_notify", 600, "ok"],
    ],
  );
  assert.ok(
    records.some(
      (record) =>
        record.kind === "account_age" && record.account_age_ms === 300,
    ),
  );
  assert.ok(
    records.some(
      (record) =>
        record.kind === "tick" &&
        record.duration_ms === 1700 &&
        record.outcome === "ok",
    ),
  );
  const saved = await f.repository.read(privateUser);
  assert.equal(saved.portfolios[0].snapshot?.observed_at, f.base);
  assert.ok(
    saved.updates.every((update) => update.notification === "delivered"),
  );
  assert.equal(f.adapter.submitCount, 0);
  assert.equal(f.adapter.fences, 0);
  assert.equal(f.adapter.releases, 0);
  assertPrivate(records);
});

it("records binding failures while preserving the caught error and draining notifications", async (t) => {
  const f = await fixture(t),
    binding = deferred(),
    notification = deferred(),
    records: MonitorTimingRecord[] = [];
  await f.repository.transact(privateUser, async (state) => {
    state.portfolios[0].account_id = null;
  });
  f.adapter.bind = async () => {
    await binding.promise;
    throw new AgentError("OWNERSHIP_CONFLICT", privateMessage, true);
  };
  f.adapter.account = async () =>
    assert.fail("binding failure must not proceed to account observation");
  let notified = 0;
  f.adapter.notify = async () => {
    notified++;
    await notification.promise;
  };
  let finished = false;
  const running = runMonitorTrace(() => f.runner.tick(privateUser), {
    clock: f.clock,
    report: (record) => records.push(record),
    thresholdMs: 0,
  }).then(() => {
    finished = true;
  });
  try {
    await flush();
    f.advance(300);
    binding.resolve();
    await flush();
    assert.ok(notified > 0);
    assert.equal(finished, false);
    f.advance(700);
    notification.resolve();
    await running;
  } finally {
    binding.resolve();
    notification.resolve();
    await running;
  }
  assert.deepEqual(
    records
      .filter((record) => record.kind === "phase")
      .map((record) => [record.phase, record.duration_ms, record.outcome]),
    [
      ["account_binding", 300, "error"],
      ["audit_control", 300, "ok"],
      ["observe_plan", 0, "ok"],
      ["durable_notify", 400, "ok"],
    ],
  );
  const saved = await f.repository.read(privateUser);
  assert.equal(saved.portfolios[0].last_error?.code, "OWNERSHIP_CONFLICT");
  assert.equal(saved.portfolios[0].last_error?.message, privateMessage);
  assert.ok(
    saved.updates.every((update) => update.notification === "delivered"),
  );
  assert.equal(f.adapter.submitCount, 0);
  assertPrivate(records);
});

it("propagates an uncaught audit transaction failure without starting later phases or logging its content", async (t) => {
  const f = await fixture(t),
    original = new Error(privateMessage),
    records: MonitorTimingRecord[] = [];
  f.repository.transact = async () => {
    f.advance(350);
    throw original;
  };
  f.adapter.account = async () =>
    assert.fail("the failed repository must not enter its callback");
  await assert.rejects(
    runMonitorTrace(() => f.runner.tick(privateUser), {
      clock: f.clock,
      report: (record) => records.push(record),
      thresholdMs: 0,
    }),
    (error) => error === original,
  );
  assert.deepEqual(
    records
      .filter((record) => record.kind === "phase")
      .map((record) => [record.phase, record.duration_ms, record.outcome]),
    [["audit_control", 350, "error"]],
  );
  assert.equal(f.adapter.notifyCount, 0);
  assert.equal(f.adapter.submitCount, 0);
  assertPrivate(records);
});

it("preserves the committed audit when the planning transaction fails without starting durable work or logging its content", async (t) => {
  const f = await fixture(t),
    original = new Error(privateMessage),
    records: MonitorTimingRecord[] = [],
    transact = f.repository.transact.bind(f.repository);
  let transactions = 0;
  f.repository.transact = async (user, work) => {
    if (++transactions === 1) return transact(user, work);
    f.advance(350);
    throw original;
  };
  await assert.rejects(
    runMonitorTrace(() => f.runner.tick(privateUser), {
      clock: f.clock,
      report: (record) => records.push(record),
      thresholdMs: 0,
    }),
    (error) => error === original,
  );
  assert.deepEqual(
    records
      .filter((record) => record.kind === "phase")
      .map((record) => [record.phase, record.duration_ms, record.outcome]),
    [
      ["account_observation", 0, "ok"],
      ["audit_control", 0, "ok"],
      ["observe_plan", 350, "error"],
    ],
  );
  assert.equal(
    transactions,
    2,
    "an uncaught transaction error stops before durable work",
  );
  const saved = await f.repository.read(privateUser);
  assert.equal(saved.portfolios[0].snapshot?.observed_at, f.base);
  assert.equal(saved.portfolios[0].audit_verified_at, f.base);
  assert.ok(saved.updates.every((update) => update.notification === "pending"));
  assert.equal(f.adapter.notifyCount, 0);
  assert.equal(f.adapter.submitCount, 0);
  assertPrivate(records);
});
