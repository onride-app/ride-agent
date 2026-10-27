import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { recommend, risk, type Portfolio } from "./domain.js";
import { FakeAdapter } from "./fixtures.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { fromPlan, AgentService, portfolioView } from "./service.js";
import { describeRiskBlocker, executionStatus } from "./risk-status.js";

async function fixture() {
  const adapter = new FakeAdapter();
  adapter.snap.prices["perps:HYPE"] = "100";
  adapter.snap.max_leverages["perps:HYPE"] = 8;
  adapter.snap.quantity_decimals!["perps:HYPE"] = 8;
  adapter.snap.min_notionals["perps:HYPE"] = "10";
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "40",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        portfolio_kind: "basket",
        basket_size: 4,
        risk_tolerance: "medium",
      },
      adapter.pool,
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.state = "active";
  p.initial_equity = adapter.snap.account_value_usdc;
  p.snapshot = structuredClone(adapter.snap);
  p.reconciliation = "complete";
  p.ledger_started_at = Date.now() - 1000;
  for (const s of p.sleeves) {
    s.initialized = true;
    s.source_revision = "old";
    s.last_source_at = Date.now();
  }
  let blocked = true;
  adapter.source = async (c) => ({
    observed_at: Date.now(),
    revision: blocked ? "proposed_hype" : "empty",
    account_value_usdc: "1000",
    complete: true,
    positions:
      blocked && c.id === p.sleeves[1].trader.id
        ? [
            {
              key: "perps:HYPE",
              asset: "HYPE",
              market: "perps",
              quantity: "5",
              price: "100",
              source_entry_price: "100",
              source_leverage: 5,
              observed_at: Date.now(),
              source_revision: "proposed_hype",
            },
          ]
        : [],
  });
  const repo = new MemoryRepository();
  await repo.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  const service = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  return {
    adapter,
    repo,
    service,
    runner: new AgentRunner(service),
    read: () =>
      repo.transact("alice", async (s) => structuredClone(s.portfolios[0])),
    clear: () => {
      blocked = false;
    },
  };
}

const configuration = (p: Portfolio) => ({
  preferences: p.preferences,
  revision: p.revision,
  control_id: p.control_id,
  sleeves: p.sleeves.map((s) => ({
    trader: s.trader.id,
    amount: s.amount_usdc,
    leverage: s.leverage_cap,
    stop: s.stop_loss_pct,
    intents: s.intents,
    source_revision: s.source_revision,
  })),
});

it("persists an actual staged concentration rejection without committing targets or changing approved configuration", async () => {
  const f = await fixture();
  const before = configuration(await f.read());
  await f.runner.tick("alice");
  const p = await f.read();
  assert.deepEqual(configuration(p), before);
  assert.equal(p.state, "active");
  assert.equal(p.last_error, undefined);
  assert.equal(f.adapter.submitCount, 0);
  assert.equal(p.executions.length, 0);
  const view = portfolioView(p).data.portfolio as any;
  assert.equal(view.operational, true);
  assert.equal(view.execution_status.status, "blocked_by_risk");
  assert.equal(view.execution_status.summary_zh, "因风控暂未下单");
  assert.deepEqual(
    { ...p.target_blocker, at: 0 },
    {
      code: "ASSET_CONCENTRATION",
      evaluated_revision: p.revision,
      asset: "HYPE",
      concentration_pct: 100,
      limit_pct: 60,
      message:
        "HYPE accounts for 100% of proposed gross sleeve exposure; the limit is 60%.",
      message_zh: "HYPE 占拟议组合总暴露的 100%，超过 60% 的资产集中度上限。",
      at: 0,
    },
  );
  f.clear();
  await f.runner.tick("alice");
  const clear = await f.read();
  assert.equal(clear.target_blocker, undefined);
  assert.equal(executionStatus(clear, true).status, "monitoring");
  assert.equal(f.adapter.submitCount, 0);
});

it("does not let risk status metadata prevent an already approved owned exit", async () => {
  const f = await fixture();
  f.adapter.snap.positions["perps:ETH"] = "0.2";
  await f.repo.transact("alice", async (s) => {
    const p = s.portfolios[0],
      sleeve = p.sleeves[0];
    sleeve.state = "closing";
    sleeve.lots["perps:ETH"] = {
      key: "perps:ETH",
      asset: "ETH",
      market: "perps",
      quantity: "0.2",
      cost: "20",
      realized: "0",
      fees: "0",
      funding: "0",
    };
  });
  await f.runner.tick("alice");
  const p = await f.read();
  assert.equal(p.target_blocker?.code, "ASSET_CONCENTRATION");
  assert.equal(p.state, "active");
  assert.equal(p.executions.length, 1);
  assert.equal(p.executions[0].key, "perps:ETH");
  assert.equal(p.executions[0].target_quantity, "0");
  assert.equal(p.executions[0].reserve_usdc, "0.000000");
  assert.equal(p.executions[0].status, "submitted");
  assert.equal(f.adapter.submitCount, 1);
  assert.equal(executionStatus(p, true).applies_to, "proposed_target_update");
});

it("does not present an expired or superseded risk rejection as the current cause", async () => {
  const f = await fixture();
  await f.runner.tick("alice");
  const p = await f.read();
  assert.equal(executionStatus(p, true).status, "blocked_by_risk");
  for (const mutate of [
    (q: Portfolio) => {
      q.revision++;
    },
    (q: Portfolio) => {
      q.target_blocker!.at -= 60_000;
    },
    (q: Portfolio) => {
      q.snapshot!.observed_at -= 60_000;
    },
    (q: Portfolio) => {
      q.sleeves[0].last_source_at! -= 60_000;
    },
    (q: Portfolio) => {
      q.last_error = {
        at: Date.now(),
        code: "SOURCE_STALE",
        message: "Source unavailable",
        retryable: true,
      };
    },
    (q: Portfolio) => {
      q.state = "closing";
    },
  ]) {
    const q = structuredClone(p);
    mutate(q);
    assert.notEqual(executionStatus(q, false).status, "blocked_by_risk");
  }
});

it("does not carry a saved target rejection into a control preview or a newly confirmed revision", async () => {
  const f = await fixture();
  await f.runner.tick("alice");
  const before = await f.read();
  const result = await f.service.tool("alice", "stop_copy", {
    copy_id: before.sleeves[1].copy_id,
    mode: "close_now",
  });
  const proposal = result.data.proposal as any;
  assert.notEqual(
    proposal.preview.portfolio.portfolio.execution_status.status,
    "blocked_by_risk",
  );
  assert.deepEqual(await f.read(), before);
  await f.service.confirm("alice", proposal.id, proposal.preview_hash);
  const after = await f.read();
  assert.equal(after.revision, before.revision + 1);
  assert.notEqual(executionStatus(after, true).status, "blocked_by_risk");
  assert.equal(f.adapter.submitCount, 0);
});

it("uses safe fixed risk reasons and never turns non-risk errors into a risk rejection", async () => {
  const p = await (await fixture()).read();
  assert.equal(
    describeRiskBlocker(new AgentError("SOURCE_STALE", "secret"), p, {}),
    undefined,
  );
  for (const code of [
    "BUDGET_EXCEEDED",
    "SCOPED_COLLATERAL_REQUIRED",
    "INVALID_OUTCOME_POSITION",
  ]) {
    const b = describeRiskBlocker(
      new AgentError(code, "private upstream data"),
      p,
      {},
    );
    assert.equal(b?.code, code);
    assert.doesNotMatch(b!.message, /private/);
  }
  const b = describeRiskBlocker(
    new AgentError("ASSET_CONCENTRATION", "private"),
    p,
    {},
  );
  assert.ok(b);
  assert.doesNotThrow(() => risk(p, {}, true));
  assert.doesNotMatch(b.message, /private/);
});
