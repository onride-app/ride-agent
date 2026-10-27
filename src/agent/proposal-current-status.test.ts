import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError, publicResult } from "./contracts.js";
import { fingerprint, recommend, type Portfolio } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository, type Proposal } from "./repository.js";
import { AgentService, fromPlan } from "./service.js";

function operationalPortfolio(id: string, revision = 3): Portfolio {
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
    id,
  );
  p.account_id = "account_bound_fixture";
  p.state = "active";
  p.revision = revision;
  p.reconciliation = "complete";
  p.snapshot = snapshot();
  for (const sleeve of p.sleeves) {
    sleeve.initialized = true;
    sleeve.last_source_at = Date.now();
  }
  p.target_blocker = {
    evaluated_revision: revision,
    code: "ASSET_CONCENTRATION",
    message:
      "HYPE accounts for 100% of proposed gross sleeve exposure; the limit is 60%.",
    message_zh: "HYPE 占拟议组合总暴露的 100%，超过 60% 的资产集中度上限。",
    asset: "HYPE",
    concentration_pct: 100,
    limit_pct: 60,
    at: Date.now(),
  };
  return p;
}

async function fixture(status: Proposal["status"] = "completed") {
  const repository = new MemoryRepository();
  const adapter = new FakeAdapter();
  let venueCalls = 0;
  for (const method of [
    "candidates",
    "profile",
    "preflight",
    "bind",
    "account",
    "source",
    "submit",
    "notify",
  ])
    (adapter as any)[method] = async () => {
      venueCalls++;
      throw Error(`Proposal status must not call ${method}`);
    };
  const service = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  const portfolio = operationalPortfolio("portfolio_current_owned_fixture");
  const proposal: Proposal = {
    id: "proposal_current_owned_fixture",
    action: "start_copy",
    arguments: { plan_id: "plan_frozen_fixture" },
    portfolio_id: portfolio.id,
    expected_revision: 0,
    committed_revision: 1,
    created_at: Date.now() - 120_000,
    expires_at: Date.now() + 120_000,
    status,
    snapshot_hash: "frozen_snapshot_hash",
    amount_usdc: "40.000000",
    warnings: ["Original frozen warning"],
    preview: {
      state_semantics: "projected_after_confirmation",
      frozen_fixture: true,
      portfolio: {
        portfolio: {
          id: portfolio.id,
          revision: 0,
          projected_state: "activating",
        },
      },
    },
  };
  await repository.transact("alice", async (s) => {
    s.portfolios.push(portfolio);
    s.proposals.push(proposal);
  });
  const readState = (user = "alice") =>
    repository.transact(user, async (s) => structuredClone(s));
  const assertNoVenueCalls = () => {
    assert.equal(venueCalls, 0);
    assert.equal(adapter.submitCount, 0);
  };
  return {
    service,
    repository,
    portfolio,
    proposal,
    readState,
    assertNoVenueCalls,
  };
}

it("includes a separate current owned portfolio status on saved queued and completed proposals", async () => {
  for (const status of ["queued", "completed"] as const) {
    const f = await fixture(status);
    const before = await f.readState();
    const value = publicResult(
      await f.service.proposal("alice", f.proposal.id),
    );
    const current = value.data.current_portfolio as any;
    const proposal = value.data.proposal as any;
    assert.equal(value.status, status);
    assert.deepEqual(Object.keys(current).sort(), [
      "as_of",
      "execution_status",
      "id",
      "operational",
      "revision",
    ]);
    assert.equal(current.id, f.portfolio.id);
    assert.equal(current.revision, 3);
    assert.equal(current.operational, true);
    assert.equal(current.as_of, f.portfolio.snapshot!.observed_at);
    assert.equal(current.execution_status.status, "blocked_by_risk");
    assert.equal(current.execution_status.summary_zh, "因风控暂未下单");
    assert.match(current.execution_status.reason.message, /HYPE.*100%.*60%/);
    assert.equal(proposal.portfolio_id, current.id);
    assert.deepEqual(proposal.preview, f.proposal.preview);
    assert.equal(proposal.preview_hash, fingerprint(f.proposal.preview));
    assert.deepEqual(proposal.execution_tasks, []);
    assert.equal(value.data.portfolio, undefined);
    assert.deepEqual(await f.readState(), before);
    f.assertNoVenueCalls();
  }
});

it("refreshes live status and its current revision without changing the saved proposal or its hash", async () => {
  const f = await fixture();
  const first = publicResult(await f.service.proposal("alice", f.proposal.id));
  const originalProposal = structuredClone(first.data.proposal);
  await f.repository.transact("alice", async (s) => {
    const p = s.portfolios[0];
    p.revision = 4;
    p.target_blocker!.evaluated_revision = 4;
    p.target_blocker!.concentration_pct = 80;
    p.target_blocker!.message =
      "HYPE accounts for 80% of proposed gross sleeve exposure; the limit is 60%.";
    p.target_blocker!.message_zh =
      "HYPE 占拟议组合总暴露的 80%，超过 60% 的资产集中度上限。";
    p.target_blocker!.at = Date.now();
  });
  const beforeSecond = await f.readState();
  const second = publicResult(await f.service.proposal("alice", f.proposal.id));
  const current = second.data.current_portfolio as any;
  assert.equal(current.revision, 4);
  assert.match(current.execution_status.reason.message, /HYPE.*80%.*60%/);
  assert.deepEqual(second.data.proposal, originalProposal);
  assert.deepEqual(await f.readState(), beforeSecond);
  await f.repository.transact("alice", async (s) => {
    delete s.portfolios[0].target_blocker;
  });
  const beforeThird = await f.readState();
  const third = publicResult(await f.service.proposal("alice", f.proposal.id));
  assert.equal(
    (third.data.current_portfolio as any).execution_status.status,
    "monitoring",
  );
  assert.equal(
    (third.data.current_portfolio as any).execution_status.reason,
    null,
  );
  assert.deepEqual(third.data.proposal, originalProposal);
  assert.deepEqual(await f.readState(), beforeThird);
  assert.deepEqual(beforeThird.proposals[0], f.proposal);
  f.assertNoVenueCalls();
});

it("uses the proposal's exact owned portfolio rather than the most recent portfolio", async () => {
  const f = await fixture();
  await f.repository.transact("alice", async (s) => {
    const newer = operationalPortfolio("portfolio_newer_unrelated_fixture", 9);
    delete newer.target_blocker;
    s.portfolios.push(newer);
  });
  const before = await f.readState();
  const value = publicResult(await f.service.proposal("alice", f.proposal.id));
  const current = value.data.current_portfolio as any;
  assert.equal(current.id, f.proposal.portfolio_id);
  assert.equal(current.revision, 3);
  assert.equal(current.execution_status.status, "blocked_by_risk");
  assert.match(current.execution_status.reason.message, /HYPE/);
  assert.deepEqual(await f.readState(), before);
  f.assertNoVenueCalls();
});

it("returns no current portfolio when its exact saved association is missing", async () => {
  const f = await fixture();
  await f.repository.transact("alice", async (s) => {
    s.proposals[0].portfolio_id = "portfolio_missing_fixture";
  });
  const before = await f.readState();
  const value = publicResult(await f.service.proposal("alice", f.proposal.id));
  assert.equal(value.data.current_portfolio, null);
  assert.equal((value.data.proposal as any).actual_portfolio_state, null);
  assert.deepEqual((value.data.proposal as any).execution_tasks, []);
  assert.deepEqual(await f.readState(), before);
  f.assertNoVenueCalls();
});

it("keeps another account's proposal and current status inaccessible", async () => {
  const f = await fixture();
  await f.repository.transact("bob", async (s) => {
    s.portfolios.push(operationalPortfolio("portfolio_bob_owned_fixture"));
  });
  const alice = await f.readState();
  const bob = await f.readState("bob");
  await assert.rejects(
    f.service.proposal("bob", f.proposal.id),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "NOT_FOUND" &&
      error.httpStatus === 404,
  );
  assert.deepEqual(await f.readState(), alice);
  assert.deepEqual(await f.readState("bob"), bob);
  f.assertNoVenueCalls();
});

it("does not add a live portfolio panel to unsubmitted or cancelled proposals", async () => {
  for (const status of ["requires_confirmation", "rejected"] as const) {
    const f = await fixture(status);
    const before = await f.readState();
    const value = publicResult(
      await f.service.proposal("alice", f.proposal.id),
    );
    assert.equal(value.data.current_portfolio, null);
    assert.equal((value.data.proposal as any).status, status);
    assert.equal(
      (value.data.proposal as any).preview_hash,
      fingerprint(f.proposal.preview),
    );
    assert.deepEqual((value.data.proposal as any).preview, f.proposal.preview);
    assert.deepEqual(await f.readState(), before);
    f.assertNoVenueCalls();
  }
});
