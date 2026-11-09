import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { candidate, FakeAdapter } from "./fixtures.js";
import { now, recommend, type Execution } from "./domain.js";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import { Cursor, MemoryRepository } from "./repository.js";
import type { VenueAdapter } from "./adapter.js";

it("a recovered accepted-but-failed original task is persisted even before expiry and never falls through to resubmission", async () => {
  const adapter = new FakeAdapter();
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
      [candidate(1)],
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.initial_equity = adapter.snap.account_value_usdc;
  p.ledger_started_at = now() - 60_000;
  p.state = "active";
  p.reconciliation = "complete";
  Object.assign(p.sleeves[0], {
    initialized: true,
    reviewed_at: now(),
    source_revision: "source_v1",
  });
  const e: Execution = {
    id: "execution_original_not_expired",
    key: "perps:BTC",
    target_quantity: "1",
    allocations: {},
    status: "uncertain",
    revision: p.revision,
    fingerprint: "f".repeat(64),
    created_at: now() - 5_000,
    expires_at: now() + 55_000,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "10",
    error: null,
  };
  p.executions.push(e);
  const task = randomUUID();
  let recovered = 0;
  adapter.source = async () => ({
    observed_at: now(),
    revision: "source_v1",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  const recoveryAdapter: VenueAdapter = adapter;
  recoveryAdapter.execution = async (_user, _portfolio, original) => {
    recovered++;
    assert.equal(original.id, e.id);
    return {
      task_id: task,
      status: "failed",
      observed_quantity: "0",
      settled: false,
    };
  };
  adapter.submit = async () =>
    assert.fail("A Core-accepted failed task must never be submitted again");
  const repo = new MemoryRepository();
  await repo.transact("fixture_owner", async (state) => {
    state.portfolios.push(p);
  });
  const runner = new AgentRunner(
    new AgentService(
      repo,
      adapter,
      "https://ride.test",
      new Cursor("fixture-cursor-key-at-least-32-bytes"),
    ),
  );
  await runner.tick("fixture_owner");
  const saved = await repo.transact("fixture_owner", async (state) =>
    structuredClone(state.portfolios[0].executions),
  );
  assert.equal(recovered, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual(
    {
      id: saved[0].id,
      fingerprint: saved[0].fingerprint,
      task_id: saved[0].task_id,
      status: saved[0].status,
    },
    { id: e.id, fingerprint: e.fingerprint, task_id: task, status: "failed" },
  );
  assert.equal(saved[0].expires_at, e.expires_at);
  assert.equal(saved[0].created_at, e.created_at);
});
