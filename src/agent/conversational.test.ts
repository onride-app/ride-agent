import { it } from "node:test";
import assert from "node:assert/strict";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import { Cursor, MemoryRepository, emptyState } from "./repository.js";
import { FakeAdapter, candidate, snapshot } from "./fixtures.js";
import { recommend, now, D } from "./domain.js";
import {
  performanceView,
  recordPerformance,
  recordConfigurations,
  recordReceipt,
  localDay,
} from "./analytics.js";
import { applyFill } from "./ledger.js";
import { inputs, publicResult } from "./contracts.js";
import { compatibility } from "./conversational.js";
import { parseCommand } from "../cli/commands.js";
const pref = {
  budget_usdc: "500",
  loss_trigger_pct: 40,
  market: "perps" as const,
  assets: ["BTC", "ETH"],
  allow_altcoins: false,
};
function env() {
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  const api = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("x".repeat(32)),
  );
  return { repository, adapter, api };
}
it("previews with zero funds and refreshes an expired plan into a new immutable plan before funding", async () => {
  const { repository, adapter, api } = env();
  adapter.snap.available_usdc = "0";
  const plan = (
    await api.tool("alice", "recommend_traders", { preferences: pref })
  ).data.plan as any;
  const resumed = await api.tool("alice", "get_portfolio", {});
  assert.equal(resumed.status, "empty");
  assert.equal((resumed.data.plan as any).id, plan.id);
  await assert.rejects(
    api.tool("alice", "start_copy", {
      plan_id: plan.id,
      compatibility_ack: compatibility(plan).fingerprint,
    }),
    /funds/,
  );
  await repository.transact("alice", async (s) => {
    s.plans[0].expires_at = 0;
  });
  const refreshed = (
    await api.tool("alice", "recalculate_plan", { plan_id: plan.id })
  ).data.plan as any;
  assert.notEqual(refreshed.id, plan.id);
  await repository.transact("alice", async (s) => {
    assert.equal(s.plans[0].expires_at, 0);
    assert.equal(s.portfolios.length, 0);
  });
  await assert.rejects(
    api.tool("bob", "recalculate_plan", { plan_id: plan.id }),
    /not found/,
  );
  adapter.snap.available_usdc = "500";
  const proposal = (
    await api.tool("alice", "start_copy", {
      plan_id: refreshed.id,
      compatibility_ack: compatibility(refreshed).fingerprint,
    })
  ).data.proposal as any;
  assert.equal(proposal.status, "requires_confirmation");
  assert.equal(proposal.execution_state, "not_submitted");
  assert.equal(proposal.actual_portfolio_state, null);
  assert.equal(
    proposal.preview.state_semantics,
    "projected_after_confirmation",
  );
  const projected = proposal.preview.portfolio.portfolio;
  assert.equal(projected.state, undefined);
  assert.equal(projected.projected_state, "activating");
  assert.ok(
    projected.sleeves.every(
      (s: any) =>
        s.state == null && s.projected_state === "awaiting_activation",
    ),
  );
  assert.equal(projected.reserved_usdc, "0.000000");
  assert.equal(adapter.submitCount, 0);
  adapter.pool[0].eligibility = "REJECT";
  await assert.rejects(
    api.confirm("alice", proposal.id, proposal.preview_hash),
    /eligibility/,
  );
});
it("validates changed selections, exact amounts, concentration, risk caps and prediction semantics", async () => {
  const { api } = env();
  const plan = (
    await api.tool("alice", "recommend_traders", { preferences: pref })
  ).data.plan as any;
  const allocations = plan.allocations.map((a: any) => ({
    trader_id: a.trader.id,
    amount_usdc: a.amount_usdc,
    leverage_cap: 3,
    stop_loss_pct: 30,
  }));
  const edited = (
    await api.tool("alice", "recalculate_plan", {
      plan_id: plan.id,
      allocations,
    })
  ).data.plan as any;
  assert.equal(
    edited.allocations
      .reduce((n: any, a: any) => n.plus(a.amount_usdc), D(0))
      .toString(),
    "500",
  );
  await assert.rejects(
    api.tool("alice", "recalculate_plan", {
      plan_id: plan.id,
      allocations: [allocations[0], allocations[0], allocations[2]],
    }),
    /only once/,
  );
  await assert.rejects(
    api.tool("alice", "recalculate_plan", {
      plan_id: plan.id,
      allocations: allocations.map((a: any) => ({ ...a, amount_usdc: "200" })),
    }),
    /exceed/,
  );
  await assert.rejects(
    api.tool("alice", "recalculate_plan", {
      plan_id: plan.id,
      allocations: allocations.map((a: any, i: number) => ({
        ...a,
        amount_usdc: i === 0 ? "400" : "20",
      })),
    }),
    /55%/,
  );
  const two = await api.tool("alice", "recalculate_plan", {
    plan_id: plan.id,
    allocations: allocations.slice(0, 2),
  });
  assert.equal((two.data.plan as any).allocations.length, 2);
  assert.throws(() =>
    inputs.recalculate_plan.parse({
      plan_id: plan.id,
      allocations: allocations.map((a: any) => ({ ...a, leverage_cap: 41 })),
    }),
  );
});
it("freezes event-time configuration, fill attribution and historical trader identities across later edits", () => {
  const p = fromPlan(recommend(pref, [1, 2, 3].map(candidate))),
    s = p.sleeves[0],
    key = "perps:BTC";
  p.initial_equity = "500";
  p.snapshot = snapshot();
  p.ledger_started_at = p.snapshot.observed_at;
  p.reconciliation = "complete";
  p.state = "active";
  recordConfigurations(p);
  const at = now() + 100;
  s.intents[key] = {
    key,
    asset: "BTC",
    market: "perps",
    quantity: "1",
    price: "100",
    source_entry_price: "100",
    source_leverage: 3,
    observed_at: now(),
    source_revision: "v1",
  };
  p.executions.push({
    id: "execution_test",
    key,
    target_quantity: "1",
    allocations: { [s.copy_id]: "1" },
    revision: 0,
    created_at: now(),
    expires_at: now() + 1000,
    fingerprint: "test",
    status: "submitted",
    task_id: "task_test",
    observed_quantity: null,
    reserve_usdc: "0",
    error: null,
  });
  const fill = {
    id: "fill_test",
    order_id: "order_test",
    task_id: "task_test",
    key,
    quantity: "1",
    price: "100",
    fee_usdc: "0.1",
    at,
  };
  const before = structuredClone(p.sleeves);
  applyFill(p, fill);
  recordReceipt(p, fill, before);
  s.leverage_cap = 1;
  assert.equal(p.receipts![0].config!.leverage_cap, 6);
  assert.equal(p.receipts![0].fee_usdc, "0.1");
  p.snapshot.positions[key] = "1";
  p.snapshot.account_value_usdc = "499.9";
  const state = emptyState();
  recordPerformance(state, p);
  const frozen = JSON.stringify(state.performance);
  s.trader = candidate(99);
  s.state = "closed";
  p.revision++;
  p.snapshot.observed_at += 1000;
  recordPerformance(state, p);
  assert.equal(JSON.stringify(state.performance!.slice(0, 1)), frozen);
  assert.notEqual(
    state.performance![0].sleeves[0].trader_id,
    state.performance![1].sleeves[0].trader_id,
  );
});
it("returns missing periods as null and excludes external deposits from verified inception profit", () => {
  const p = fromPlan(recommend(pref, [1, 2, 3].map(candidate))),
    state = emptyState();
  p.snapshot = snapshot();
  p.initial_equity = "500";
  p.ledger_started_at = p.snapshot.observed_at;
  p.reconciliation = "complete";
  recordPerformance(state, p);
  p.snapshot.account_value_usdc = "550";
  p.flow_total = "50";
  p.seen_flows.push("deposit");
  p.snapshot.observed_at += 1;
  recordPerformance(state, p);
  assert.equal(
    performanceView(state, p, "inception").net_profit_usdc,
    "0.000000",
  );
  assert.equal(performanceView(state, p, "weekly").net_profit_usdc, null);
  p.snapshot.coverage_complete = false;
  assert.equal(
    performanceView(state, p, "inception").inception_net_profit_usdc,
    null,
  );
});
it("persists skipped entry decisions and keeps diagnostic reads account scoped", async () => {
  const { repository, adapter, api } = env();
  const p = fromPlan(recommend(pref, adapter.pool));
  adapter.source = async (c) => ({
    observed_at: now(),
    revision: "entry_v2",
    account_value_usdc: "1000",
    complete: true,
    positions: [
      {
        key: "perps:BTC",
        asset: "BTC",
        market: "perps" as const,
        quantity: "5",
        price: "100",
        source_entry_price: "99",
        source_leverage: 5,
        observed_at: now(),
        source_revision: "entry_v2",
      },
    ],
  });
  await repository.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  await new AgentRunner(api).tick("alice");
  const stored = await repository.transact(
    "alice",
    async (s) => s.portfolios[0],
  );
  assert.equal(
    stored.decisions![0].reason,
    "ENTRY_DEVIATION_OR_MISSING_SOURCE_PRICE",
  );
  assert.equal(stored.decisions![0].source_quantity, "5");
  assert.equal(adapter.submitCount, 0);
  const args = {
    copy_id: p.sleeves[0].copy_id,
    start_at: now() - 60000,
    end_at: now(),
  };
  const r = publicResult(await api.tool("alice", "diagnose_copy", args));
  assert.equal((r.data.diagnostic as any).profit_difference_usdc, null);
  assert.equal((r.data.diagnostic as any).source_coverage, "incomplete");
  await assert.rejects(api.tool("bob", "diagnose_copy", args), /not found/);
  assert.throws(() =>
    inputs.diagnose_copy.parse({
      ...args,
      end_at: args.start_at + 32 * 86400_000,
    }),
  );
});
it("schedules an opted-in local digest once across restarts, retries failed pushes and cancels opt-out backlog", async (t) => {
  let at = Date.UTC(2026, 9, 10, 1, 1);
  t.mock.method(Date, "now", () => at);
  const { repository, adapter, api } = env();
  const p = fromPlan(recommend(pref, adapter.pool));
  p.state = "closed";
  await repository.transact("alice", async (s) => {
    s.portfolios.push(p);
    s.notification_preferences = {
      daily_digest: true,
      local_time: "09:00",
      timezone: "Asia/Shanghai",
      enabled_at: at - 86400_000,
    };
  });
  adapter.notify = async () => {
    throw Error("push unavailable");
  };
  const tickAndDeliver = async () => {
    const runner = new AgentRunner(api);
    await runner.tick("alice");
    await runner.notificationsIdle();
    await runner.closeNotifications();
  };
  await tickAndDeliver();
  await tickAndDeliver();
  await repository.transact("alice", async (s) => {
    assert.equal(s.updates.filter((x) => x.kind === "daily_digest").length, 1);
    assert.equal(s.updates[0].notification, "pending");
  });
  adapter.notify = async () => {
    adapter.notifyCount++;
  };
  at += 10000;
  await tickAndDeliver();
  assert.equal(adapter.notifyCount, 1);
  assert.equal(localDay(at, "Asia/Shanghai").time, "09:01");
  await repository.transact("alice", async (s) => {
    s.updates[0].notification = "pending";
  });
  await api.tool("alice", "set_notification_preferences", {
    daily_digest: false,
    local_time: "09:00",
    timezone: "Asia/Shanghai",
  });
  await tickAndDeliver();
  await repository.transact("alice", async (s) => {
    assert.equal(s.updates[0].notification, "cancelled");
  });
  assert.throws(() =>
    inputs.set_notification_preferences.parse({
      daily_digest: true,
      local_time: "25:00",
      timezone: "Not/AZone",
    }),
  );
});
it("maps conversational CLI commands to their exact MCP contracts", () => {
  assert.equal(
    parseCommand(["plan", "recalculate", "plan_test"]).name,
    "recalculate_plan",
  );
  assert.equal(
    parseCommand(["performance", "portfolio_test", "--period", "inception"])
      .args.period,
    "inception",
  );
  assert.equal(
    parseCommand([
      "diagnose",
      "copy_test",
      "--start-at",
      "1000",
      "--end-at",
      "2000",
    ]).args.start_at,
    1000,
  );
  assert.equal(
    parseCommand(["notifications"]).name,
    "get_notification_preferences",
  );
});
