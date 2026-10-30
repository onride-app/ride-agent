import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { AgentError } from "./contracts.js";
import { recommend, type Candidate, type Portfolio } from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository, type State } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const base = 1793359000000;
const user = "source-review-fixture";
const preferences = {
  budget_usdc: "80",
  market: "perps" as const,
  assets: [],
  allow_altcoins: true,
  loss_trigger_pct: 10,
  risk_tolerance: "medium" as const,
  portfolio_kind: "basket" as const,
  basket_size: 2,
};
const unavailable = () =>
  new AgentError(
    "SCORE_UNAVAILABLE",
    "fixture private upstream details must not be copied into a review notice",
    true,
    503,
  );

type ReviewSleeve = Portfolio["sleeves"][number] & {
  review_retry_at?: number;
};

async function fixture(t: TestContext) {
  let clock = base;
  t.mock.method(Date, "now", () => clock);
  const adapter = new FakeAdapter();
  adapter.pool = [candidate(1), candidate(2)];
  const p = fromPlan(recommend(preferences, adapter.pool));
  p.account_id = adapter.snap.account_id;
  p.state = "active";
  p.initial_equity = adapter.snap.account_value_usdc;
  p.ledger_started_at = clock - 1000;
  p.reconciliation = "complete";
  for (const sleeve of p.sleeves) sleeve.reviewed_at = 0;
  const repository = new MemoryRepository();
  await repository.transact(user, async (state) => {
    state.portfolios.push(p);
  });
  const runners: AgentRunner[] = [];
  const runnerFor = (repo: MemoryRepository) => {
    const runner = new AgentRunner(
      new AgentService(
        repo,
        adapter,
        "https://ride.test",
        new Cursor("s".repeat(32)),
      ),
    );
    runners.push(runner);
    return runner;
  };
  t.after(async () => {
    for (const runner of runners) await runner.closeNotifications();
  });
  const runner = runnerFor(repository);
  let profileCalls = 0;
  let profileResult: Candidate | Error = unavailable();
  const missingId = p.sleeves[0].trader.id;
  const originalProfile = adapter.profile.bind(adapter);
  adapter.profile = async (id) => {
    if (id !== missingId) return originalProfile(id);
    profileCalls++;
    if (profileResult instanceof Error) throw profileResult;
    return structuredClone(profileResult);
  };
  const read = () => repository.read(user);
  return {
    adapter,
    repository,
    runner,
    runnerFor,
    read,
    now: () => clock,
    advance: (duration: number) => {
      clock += duration;
    },
    profileCalls: () => profileCalls,
    profileResult: (result: Candidate | Error) => {
      profileResult = result;
    },
    missingId,
  };
}

it("keeps both original sources and ordinary target admission running when only the daily score is unavailable", async (t) => {
  const f = await fixture(t);
  const before = await f.read();
  const originalTrader = structuredClone(
    before.portfolios[0].sleeves[0].trader,
  );
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  const state = await f.read(),
    p = state.portfolios[0];
  assert.equal(p.state, "active");
  assert.equal(p.last_error, undefined);
  assert.equal(p.target_blocker, undefined);
  assert.ok(p.sleeves.every((s) => s.initialized));
  assert.ok(p.sleeves.every((s) => s.last_source_at === f.now()));
  assert.deepEqual(p.sleeves[0].trader, originalTrader);
  assert.equal(p.sleeves[0].reviewed_at, 0);
  assert.equal((p.sleeves[0] as ReviewSleeve).review_retry_at, f.now() + 60000);
  assert.equal(p.executions.length, 2);
  assert.equal(f.adapter.submitCount, 2);
  assert.deepEqual(
    p.executions.map((e) => e.status),
    ["submitted", "submitted"],
  );
  assert.ok(p.decisions?.some((d) => d.reason === "TARGET_EVALUATED"));
  const notices = state.updates.filter(
    (u) => u.kind === "daily_review" && u.data.reason === "SCORE_UNAVAILABLE",
  );
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.copy_id, p.sleeves[0].copy_id);
  assert.ok(!JSON.stringify(notices).includes("fixture private"));
  assert.deepEqual(p.preferences, before.portfolios[0].preferences);
  assert.deepEqual(
    p.sleeves.map((s) => [
      s.trader.id,
      s.amount_usdc,
      s.copy_mode,
      s.stop_loss_pct,
      s.leverage_cap,
    ]),
    before.portfolios[0].sleeves.map((s) => [
      s.trader.id,
      s.amount_usdc,
      s.copy_mode,
      s.stop_loss_pct,
      s.leverage_cap,
    ]),
  );
});

it("persists the score-only retry across a JSON state reload and runner restart, then retries at its unchanged deadline", async (t) => {
  const f = await fixture(t);
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  assert.equal(f.profileCalls(), 1);
  const persisted = JSON.parse(JSON.stringify(await f.read())) as State;
  const restored = new MemoryRepository();
  await restored.transact(user, async (state) => {
    Object.assign(state, persisted);
  });
  const restarted = f.runnerFor(restored);
  f.advance(59999);
  await restarted.tick(user);
  await restarted.notificationsIdle();
  assert.equal(f.profileCalls(), 1);
  assert.equal(
    (await restored.read(user)).portfolios[0].sleeves[0].reviewed_at,
    0,
  );
  f.advance(1);
  await restarted.tick(user);
  await restarted.notificationsIdle();
  assert.equal(f.profileCalls(), 2);
  const state = await restored.read(user);
  assert.equal(
    (state.portfolios[0].sleeves[0] as ReviewSleeve).review_retry_at,
    base + 120000,
  );
  assert.equal(
    state.updates.filter(
      (u) => u.kind === "daily_review" && u.data.reason === "SCORE_UNAVAILABLE",
    ).length,
    1,
  );
  assert.equal(state.portfolios[0].last_error, undefined);
});

it("clears only the score retry after a real current profile update and keeps the score's original evidence times", async (t) => {
  const f = await fixture(t);
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  f.advance(60000);
  const actual = {
    ...candidate(1),
    score: 88,
    scored_at: base + 30000,
    expires_at: base + 120000,
  };
  f.profileResult(actual);
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  const sleeve = (await f.read()).portfolios[0].sleeves[0] as ReviewSleeve;
  assert.deepEqual(sleeve.trader, actual);
  assert.equal(sleeve.reviewed_at, base + 60000);
  assert.equal(sleeve.review_retry_at, undefined);
  assert.equal(sleeve.trader.scored_at, base + 30000);
  assert.equal(sleeve.trader.expires_at, base + 120000);
});

it("does not bypass the original basket concentration rejection when a daily score is missing", async (t) => {
  const f = await fixture(t);
  const source = f.adapter.source.bind(f.adapter);
  f.adapter.source = async (trader) => {
    const value = await source(trader);
    value.positions[0].key = "perps:BTC";
    value.positions[0].asset = "BTC";
    return value;
  };
  const before = await f.read();
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  const p = (await f.read()).portfolios[0];
  assert.equal(p.last_error, undefined);
  assert.equal(p.target_blocker?.code, "ASSET_CONCENTRATION");
  assert.equal(p.executions.length, 0);
  assert.equal(f.adapter.submitCount, 0);
  assert.deepEqual(
    p.sleeves.map((s) => s.intents),
    before.portfolios[0].sleeves.map((s) => s.intents),
  );
  assert.deepEqual(
    p.sleeves.map((s) => s.source_revision),
    before.portfolios[0].sleeves.map((s) => s.source_revision),
  );
});

for (const [name, error, expected] of [
  [
    "unknown identity",
    new AgentError("NOT_FOUND", "fixture", false, 404),
    "NOT_FOUND",
  ],
  [
    "Core transport",
    new AgentError("CORE_UNAVAILABLE", "fixture", true, 503),
    "CORE_UNAVAILABLE",
  ],
  [
    "untyped score error",
    new Error("SCORE_UNAVAILABLE"),
    "MONITOR_UNAVAILABLE",
  ],
] as const)
  it(`keeps a ${name} daily-profile error failclosed instead of treating it as a missing score`, async (t) => {
    const f = await fixture(t);
    f.profileResult(error);
    await f.runner.tick(user);
    await f.runner.notificationsIdle();
    const state = await f.read(),
      p = state.portfolios[0];
    assert.equal(p.state, "attention");
    assert.equal(p.last_error?.code, expected);
    assert.equal(p.last_error?.read_scope, "source");
    assert.equal(p.executions.length, 0);
    assert.equal(f.adapter.submitCount, 0);
    assert.equal((p.sleeves[0] as ReviewSleeve).review_retry_at, undefined);
    assert.ok(
      !state.updates.some(
        (u) =>
          u.kind === "daily_review" && u.data.reason === "SCORE_UNAVAILABLE",
      ),
    );
  });

it("still rejects stale source positions after classifying a missing daily score", async (t) => {
  const f = await fixture(t);
  const source = f.adapter.source.bind(f.adapter);
  f.adapter.source = async (trader) => {
    const value = await source(trader);
    if (trader.id === f.missingId) value.positions[0].observed_at -= 6000;
    return value;
  };
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  const p = (await f.read()).portfolios[0];
  assert.equal(p.last_error?.code, "SOURCE_STALE");
  assert.equal(p.executions.length, 0);
  assert.equal(f.adapter.submitCount, 0);
});

it("does not honor malformed or unbounded future score-review retry data", async (t) => {
  const f = await fixture(t);
  await f.repository.transact(user, async (state) => {
    (state.portfolios[0].sleeves[0] as ReviewSleeve).review_retry_at =
      base + 10 * 86400000;
  });
  await f.runner.tick(user);
  await f.runner.notificationsIdle();
  assert.equal(f.profileCalls(), 1);
  assert.equal((await f.read()).portfolios[0].last_error, undefined);
  assert.equal(
    ((await f.read()).portfolios[0].sleeves[0] as ReviewSleeve).review_retry_at,
    base + 60000,
  );
});
