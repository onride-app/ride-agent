import assert from "node:assert/strict";
import { it } from "node:test";
import { recommend } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentService, fromPlan } from "./service.js";

it("notification claims stay private in updates, copy diagnostics and human reports without mutating the durable event", async () => {
  const repository = new MemoryRepository();
  const adapter = new FakeAdapter();
  adapter.sourceFills = async () => ({ fills: [], complete: true });
  const service = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  const end = Date.now() - 1000,
    start = end - 10_000;
  const portfolio = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 90,
        risk_tolerance: "medium",
        portfolio_kind: "single",
      },
      [candidate(1)],
    ),
  );
  portfolio.account_id = snapshot().account_id;
  portfolio.state = "active";
  portfolio.audit_started_at = start - 1000;
  portfolio.audit_verified_at = end;
  const claimToken = "private_notification_lease_token_do_not_expose";
  const event = {
    id: "update_privacy_fixture",
    at: start + 100,
    kind: "fixture",
    portfolio_id: portfolio.id,
    message: "Preserved public report",
    data: { visible: "original public data" },
    notification: "pending" as const,
    notification_claim: { token: claimToken, expires_at: Date.now() + 60_000 },
  };
  await repository.transact("alice", async (state) => {
    state.portfolios.push(portfolio);
    state.updates.push(event);
  });
  const before = await repository.read("alice");
  const updates = await service.tool("alice", "get_updates", { limit: 20 });
  const diagnostic = await service.tool("alice", "diagnose_copy", {
    copy_id: portfolio.sleeves[0].copy_id,
    start_at: start,
    end_at: end,
  });
  const report = await service.update("alice", event.id);
  const records = [
    (updates.data as any).updates[0],
    (diagnostic.data as any).diagnostic.events[0],
    (report.data as any).update,
  ];
  for (const record of records) {
    assert.equal(record.id, event.id);
    assert.equal(record.message, event.message);
    assert.deepEqual(record.data, event.data);
    assert.equal(Object.hasOwn(record, "notification_claim"), false);
    assert.equal(JSON.stringify(record).includes(claimToken), false);
  }
  assert.deepEqual(await repository.read("alice"), before);
  await repository.close();
});
