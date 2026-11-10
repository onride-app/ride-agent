import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError, failure } from "./contracts.js";
import { configAt } from "./analytics.js";
import { now, recommend } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentService, fromPlan, portfolioView } from "./service.js";

const details = {
  reason_code: "READ_FRAME_CAPACITY",
  retry_after_ms: 60000,
  read_stage: "history" as const,
  requested_weight: 120,
  remaining_weight: 75,
};
const publicDetails = {
  reason_code: details.reason_code,
  retry_after_ms: 60000,
};

function portfolio() {
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 90,
        risk_tolerance: "medium",
        portfolio_kind: "single",
        basket_size: 1,
      },
      [candidate(1)],
    ),
  );
  p.account_id = "account_test0000000";
  p.snapshot = snapshot();
  p.initial_equity = "500";
  p.ledger_started_at = now() - 60000;
  p.reconciliation = "complete";
  p.state = "attention";
  p.last_error = {
    at: now(),
    code: "VENUE_READ_BUDGET_EXHAUSTED",
    message: "capacity",
    retryable: true,
    read_scope: "source",
    details: structuredClone(details),
  };
  p.source_read_error = structuredClone(p.last_error);
  p.activation_check = {
    at: now(),
    eligible: false,
    blockers: [],
    error: {
      code: p.last_error.code,
      message: "capacity",
      retryable: true,
      details: structuredClone(details),
    },
  };
  return p;
}

it("portfolio activation errors retain their legacy shape without mutating private monitor evidence", () => {
  const p = portfolio(),
    before = structuredClone(p);
  const view = portfolioView(p).data.portfolio as any;
  assert.deepEqual(view.activation.last_error, {
    ...p.last_error,
    details: publicDetails,
  });
  assert.deepEqual(view.activation.readiness.error, {
    ...p.activation_check!.error,
    details: publicDetails,
  });
  assert.equal(Object.hasOwn(view, "source_read_error"), false);
  assert.deepEqual(p, before);
  assert.deepEqual(p.source_read_error!.details, details);
});

it("an old portfolio error keeps every original field and the same public projection", () => {
  const p = portfolio(),
    legacy = structuredClone(p);
  legacy.last_error!.details = publicDetails;
  legacy.source_read_error!.details = publicDetails;
  legacy.activation_check!.error!.details = publicDetails;
  const { as_of: _newTime, ...actual } = portfolioView(p);
  const { as_of: _oldTime, ...expected } = portfolioView(legacy);
  assert.deepEqual(actual, expected);
});

it("large unchanged public error subtrees keep their identity and frozen legacy data", () => {
  const p = portfolio();
  p.last_error!.details = Object.freeze({ ...publicDetails });
  p.activation_check!.error!.details = Object.freeze({ ...publicDetails });
  const tree = Object.freeze(
    Array.from({ length: 100 }, (_, index) =>
      Object.freeze({
        index,
        values: Object.freeze(
          Array.from({ length: 8 }, (_, n) =>
            Object.freeze({
              code: "LEGACY",
              retryable: false,
              details: Object.freeze({
                reason_code: "OTHER",
                retry_after_ms: n,
              }),
            }),
          ),
        ),
      }),
    ),
  );
  Object.assign(p.activation_check!, { legacy_tree: tree });
  Object.freeze(p.activation_check!.error);
  Object.freeze(p.activation_check);
  Object.freeze(p.last_error);
  const view = portfolioView(p).data.portfolio as any;
  assert.equal(view.activation.last_error, p.last_error);
  assert.equal(view.activation.readiness, p.activation_check);
  assert.equal(view.activation.readiness.legacy_tree, tree);
  assert.equal(
    view.activation.readiness.legacy_tree[99].values,
    tree[99].values,
  );
  assert.equal(Object.isFrozen(tree[99].values[7].details), true);
});

async function serviceFixture() {
  const p = portfolio(),
    repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  const at = now() - 100;
  const data = {
    diagnostics: {
      ...details,
      legacy_marker: "preserve",
      nested: { ...details },
    },
    source_error: {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
      retryable: true,
      message: "source",
      details: { ...details },
    },
    nested: [
      {
        error: {
          code: "VENUE_READ_BUDGET_EXHAUSTED",
          retryable: true,
          message: "account",
          details: { ...details },
        },
      },
    ],
    business: {
      read_stage: "ordinary-data",
      requested_weight: 7,
      remaining_weight: 8,
    },
  };
  await repository.transact("user", async (state) => {
    p.decisions = [
      {
        copy_id: p.sleeves[0].copy_id,
        at,
        key: "perps:BTC",
        source_revision: "source_v1",
        reason: "READ_FRAME_CAPACITY",
        config: configAt(p.sleeves[0]),
        source_quantity: "1",
        target_quantity: null,
        source_entry_price: null,
        follower_mark: "100",
        observation_episode: {
          first_at: at,
          last_at: at,
          count: 2,
        },
      },
    ];
    state.portfolios.push(p);
    state.updates.push({
      id: "update",
      at,
      kind: "VENUE_READ_BUDGET_EXHAUSTED",
      portfolio_id: p.id,
      message: "capacity",
      data,
      notification: "pending",
      observation_episode: {
        first_at: at,
        last_at: at,
        count: 2,
        latest_data: { diagnostics: { ...details } },
      },
    });
  });
  adapter.sourceFills = async () => ({ fills: [], complete: true });
  const service = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  return { service, repository, p, at };
}

function assertPublicData(data: any) {
  assert.deepEqual(data.diagnostics, {
    ...publicDetails,
    legacy_marker: "preserve",
    nested: publicDetails,
  });
  assert.deepEqual(data.source_error.details, publicDetails);
  assert.deepEqual(data.nested[0].error.details, publicDetails);
  assert.deepEqual(data.business, {
    read_stage: "ordinary-data",
    requested_weight: 7,
    remaining_weight: 8,
  });
}

it("get_portfolio and every public update/diagnostic projection omit only managed read counters", async () => {
  const { service, repository, p, at } = await serviceFixture();
  const before = await repository.read("user");
  const get = await service.tool("user", "get_portfolio", {
    portfolio_id: p.id,
  });
  assert.deepEqual(
    (get.data.portfolio as any).activation.last_error.details,
    publicDetails,
  );
  const updates = await service.tool("user", "get_updates", { limit: 20 });
  const update = (updates.data.updates as any[])[0];
  assertPublicData(update.data);
  assert.deepEqual(
    update.observation_episode.latest_data.diagnostics,
    publicDetails,
  );
  const single = (await service.update("user", "update")).data.update as any;
  assertPublicData(single.data);
  const diagnosed = await service.tool("user", "diagnose_copy", {
    copy_id: p.sleeves[0].copy_id,
    start_at: at - 1,
    end_at: now(),
  });
  const diagnostic = diagnosed.data.diagnostic as any;
  assertPublicData(diagnostic.events[0].data);
  assert.deepEqual(diagnostic.decisions, before.portfolios[0].decisions);
  const after = await repository.read("user");
  assert.deepEqual(after.updates, before.updates);
  assert.deepEqual(
    after.portfolios[0].last_error,
    before.portfolios[0].last_error,
  );
  assert.deepEqual(
    after.portfolios[0].source_read_error,
    before.portfolios[0].source_read_error,
  );
  assert.deepEqual(
    after.portfolios[0].decisions,
    before.portfolios[0].decisions,
  );
});

it("managed errors retain private counters while default public failure preserves old reason and retry fields", () => {
  const error = new AgentError(
    "VENUE_READ_BUDGET_EXHAUSTED",
    "capacity",
    true,
    503,
    details,
  );
  assert.deepEqual(failure(error).error!.details, publicDetails);
  assert.deepEqual(
    failure(error, { internalReadDiagnostics: true }).error!.details,
    details,
  );
  assert.deepEqual(error.details, details);
});
