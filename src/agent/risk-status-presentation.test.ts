import assert from "node:assert/strict";
import { it } from "node:test";
import { invokeAccountRead } from "../account_reads.js";
import { publicResult } from "./contracts.js";
import { recommend, type Portfolio } from "./domain.js";
import { candidate, snapshot } from "./fixtures.js";
import { fromPlan, portfolioView } from "./service.js";

function operationalPortfolio(): Portfolio {
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "40",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "basket",
        basket_size: 4,
      },
      [1, 2, 3, 4].map(candidate),
    ),
  );
  p.account_id = "account_bound_fixture";
  p.state = "active";
  p.reconciliation = "complete";
  p.snapshot = snapshot();
  for (const s of p.sleeves) {
    s.initialized = true;
    s.last_source_at = Date.now();
  }
  return p;
}

function addCompletedExecution(p: Portfolio) {
  p.executions.push({
    id: "execution_prior_completed",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: { [p.sleeves[0].copy_id]: "0.1" },
    status: "completed",
    revision: p.revision,
    fingerprint: "prior_completed_fixture",
    created_at: Date.now() - 60_000,
    expires_at: Date.now() - 30_000,
    task_id: "task_prior_completed",
    observed_quantity: "0.1",
    reserve_usdc: "0",
    error: null,
  });
}

function addConcentrationBlocker(p: Portfolio) {
  p.target_blocker = {
    evaluated_revision: p.revision,
    code: "ASSET_CONCENTRATION",
    message:
      "HYPE accounts for 100% of proposed gross sleeve exposure; the limit is 60%.",
    message_zh: "HYPE 占拟议组合总暴露的 100%，超过 60% 的资产集中度上限。",
    asset: "HYPE",
    concentration_pct: 100,
    limit_pct: 60,
    at: Date.now(),
  };
}

it("keeps legacy portfolios operational without inventing a risk blocker or order", () => {
  const p = operationalPortfolio();
  const before = structuredClone(p);
  const value = publicResult(portfolioView(p));
  const portfolio = value.data.portfolio as any;
  assert.equal(value.status, "ok");
  assert.equal(portfolio.operational, true);
  assert.equal(portfolio.activation.status, "activated");
  assert.equal(portfolio.execution_status.status, "monitoring");
  assert.equal(portfolio.execution_status.reason, null);
  assert.equal(value.data.conversation_display, undefined);
  assert.deepEqual(portfolio.executions, []);
  assert.deepEqual(p, before);
});

it("clearly reports a target risk blocker while monitoring remains operational", () => {
  const p = operationalPortfolio();
  addConcentrationBlocker(p);
  const before = structuredClone(p);
  const value = publicResult(portfolioView(p));
  const portfolio = value.data.portfolio as any;
  const display = value.data.conversation_display as any;
  assert.equal(value.status, "ok");
  assert.equal(portfolio.operational, true);
  assert.equal(portfolio.activation.status, "activated");
  assert.equal(portfolio.activation.last_error, null);
  assert.equal(portfolio.execution_status.status, "blocked_by_risk");
  assert.equal(portfolio.execution_status.summary_zh, "因风控暂未下单");
  assert.equal(portfolio.execution_status.applies_to, "proposed_target_update");
  assert.deepEqual(portfolio.execution_status.reason, p.target_blocker);
  assert.equal(portfolio.execution_status.updated_at, p.target_blocker!.at);
  assert.match(display.markdown, /因风控暂未下单/);
  assert.match(display.markdown, /HYPE.*100%.*60%/);
  assert.match(display.markdown, /仅指本次目标调整/);
  assert.match(display.markdown_en, /for this target update: blocked by risk/);
  assert.equal(display.portfolio_id, p.id);
  assert.deepEqual(portfolio.executions, []);
  assert.deepEqual(p, before);
});

it("reports observed historical execution without claiming the account has no orders", () => {
  const p = operationalPortfolio();
  addCompletedExecution(p);
  const before = structuredClone(p);
  const value = publicResult(portfolioView(p));
  const portfolio = value.data.portfolio as any;
  assert.equal(portfolio.execution_status.status, "orders_observed");
  assert.equal(portfolio.execution_status.reason, null);
  assert.equal(portfolio.executions.length, 1);
  assert.equal(portfolio.executions[0].id, "execution_prior_completed");
  assert.equal(portfolio.executions[0].status, "completed");
  assert.equal(portfolio.executions[0].observed_quantity, "0.1");
  assert.equal(portfolio.executions[0].task_id, "task_prior_completed");
  assert.equal("allocations" in portfolio.executions[0], false);
  assert.equal("fingerprint" in portfolio.executions[0], false);
  assert.equal(value.data.conversation_display, undefined);
  assert.deepEqual(p, before);
});

it("keeps prior executed orders visible alongside a blocker on the new target update", () => {
  const p = operationalPortfolio();
  addCompletedExecution(p);
  addConcentrationBlocker(p);
  const before = structuredClone(p);
  const value = publicResult(portfolioView(p));
  const portfolio = value.data.portfolio as any;
  const display = value.data.conversation_display as any;
  assert.equal(portfolio.operational, true);
  assert.equal(portfolio.execution_status.status, "blocked_by_risk");
  assert.equal(portfolio.execution_status.applies_to, "proposed_target_update");
  assert.equal(portfolio.executions.length, 1);
  assert.equal(portfolio.executions[0].id, "execution_prior_completed");
  assert.equal(portfolio.executions[0].status, "completed");
  assert.equal(portfolio.executions[0].task_id, "task_prior_completed");
  assert.equal(portfolio.executions[0].observed_quantity, "0.1");
  assert.match(display.markdown, /历史订单与成交按实际执行记录单独展示/);
  assert.match(
    display.markdown_en,
    /Existing orders and fills are reported separately/,
  );
  assert.doesNotMatch(
    JSON.stringify({
      status: portfolio.execution_status,
      markdown: display.markdown,
      markdown_en: display.markdown_en,
    }),
    /从未下单|尚无订单记录|has never traded|no order recorded yet/,
  );
  assert.deepEqual(p, before);
});

it("does not present a stale blocker as the current reason for no orders", () => {
  const p = operationalPortfolio();
  addConcentrationBlocker(p);
  p.target_blocker!.at = Date.now() - 60_000;
  const before = structuredClone(p);
  const value = publicResult(portfolioView(p));
  const portfolio = value.data.portfolio as any;
  assert.equal(portfolio.operational, true);
  assert.equal(portfolio.execution_status.status, "monitoring");
  assert.equal(portfolio.execution_status.reason, null);
  assert.equal(value.data.conversation_display, undefined);
  assert.deepEqual(p, before);
});

it("preserves the risk explanation through the existing partial account-read contract", async () => {
  const p = operationalPortfolio();
  addConcentrationBlocker(p);
  const direct = portfolioView(p);
  let attempts = 0;
  const unavailable = (async () => {
    attempts++;
    throw Error("Fixture account coverage unavailable");
  }) as typeof fetch;
  const value = publicResult(
    await invokeAccountRead(
      "get_portfolio",
      {},
      "fixture-session",
      "https://core.test/graphql",
      async () => direct,
      unavailable,
    ),
  );
  assert(attempts > 0);
  assert.equal(value.status, "stale");
  assert.equal(value.data.agent_portfolio_status, "ok");
  assert.equal(value.data.account_coverage_status, "partial");
  assert.equal(
    (value.data.status_breakdown as any).authentication,
    "authenticated",
  );
  assert.deepEqual(value.data.portfolio, direct.data.portfolio);
  assert.deepEqual(
    value.data.conversation_display,
    direct.data.conversation_display,
  );
  assert.match(
    (value.data.conversation_display as any).markdown,
    /因风控暂未下单/,
  );
});
