import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { CoreBridge } from "./core_bridge.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { fingerprint, now, recommend, type Execution } from "./domain.js";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import { Cursor, MemoryRepository } from "./repository.js";

const preferences = {
  budget_usdc: "20",
  market: "perps" as const,
  assets: [],
  allow_altcoins: true,
  loss_trigger_pct: 10,
  risk_tolerance: "medium" as const,
  portfolio_kind: "single" as const,
  basket_size: 1,
};
const key = "perps:BTC";
const source = () => ({
  observed_at: now(),
  revision: "source_v1",
  account_value_usdc: "1000",
  complete: true,
  positions: [
    {
      key,
      asset: "BTC",
      market: "perps" as const,
      quantity: "5",
      price: "100",
      source_entry_price: "100",
      source_leverage: 5,
      source_leverage_verified: true,
      observed_at: now(),
      source_revision: "source_v1",
    },
  ],
});
function portfolio() {
  const p = fromPlan(recommend(preferences, [candidate(1)]));
  p.account_id = snapshot().account_id;
  p.initial_equity = "500";
  p.ledger_started_at = now() - 60_000;
  p.state = "active";
  p.reconciliation = "complete";
  Object.assign(p.sleeves[0], {
    initialized: true,
    reviewed_at: now(),
    source_revision: "source_v1",
    intents: {
      [key]: {
        ...source().positions[0],
        quantity: "0.1",
        raw_source_quantity: "5",
        observed_at: now() - 45_000,
      },
    },
  });
  return p;
}
function execution(
  status: Execution["status"] = "queued",
  expired = false,
): Execution {
  const frozen = {
    id: "execution_original",
    key,
    target_quantity: "0.1",
    allocations: {},
    revision: 0,
    created_at: now() - 50_000,
    expires_at: now() + (expired ? -1 : 10_000),
  };
  return {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  };
}
function bridgeFixture() {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any,
    snap = snapshot(),
    p = portfolio(),
    e = execution();
  const outbox = new Map<string, any>(),
    submissions: any[] = [];
  stub.pool.query = async (sql: string, values: any[]) => {
    if (sql.startsWith("SELECT")) {
      const row = outbox.get(values[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.startsWith("INSERT")) {
      if (!outbox.has(values[0]))
        outbox.set(values[0], {
          fingerprint: values[3],
          payload: structuredClone(values[4]),
          response: null,
        });
    }
    if (sql.startsWith("UPDATE"))
      outbox.get(values[0]).response = structuredClone(values[1]);
    return { rowCount: 1, rows: [] };
  };
  stub.perpsAccount = async () => snap;
  stub.account = async () => snap;
  stub.source = async () => source();
  stub.core = async (op: string, payload: any) => {
    if (op === "perps_submit") {
      submissions.push(structuredClone(payload));
      return { task_id: "task_original" };
    }
    if (op === "perps_execution") return { status: 2, legs: [] };
    return { policy_revision: 1 };
  };
  return { bridge, stub, snap, p, e, outbox, submissions };
}

it("recovers pre-outbox read throttling with fresh unchanged-source proof while preserving the old target and price anchor", async () => {
  const f = bridgeFixture();
  const before = structuredClone(f.p.sleeves[0].intents[key]);
  let first = true;
  f.stub.perpsAccount = async () => {
    if (first) {
      first = false;
      throw new AgentError("VENUE_RATE_LIMITED", "read throttled", true, 503);
    }
    return f.snap;
  };
  try {
    await assert.rejects(
      f.bridge.submit("alice", f.p, f.e),
      (e: any) => e.code === "VENUE_RATE_LIMITED",
    );
    assert.equal(f.outbox.size, 0);
    f.snap.prices[key] = "100.1";
    assert.deepEqual(await f.bridge.submit("alice", f.p, f.e), {
      task_id: "task_original",
    });
    assert.equal(f.submissions.length, 1);
    assert.equal(f.submissions[0].target_quantity, "0.1");
    assert.equal(f.submissions[0].execution_id, f.e.id);
    assert.equal(f.submissions[0].expires_at, f.e.expires_at);
    assert.deepEqual(f.p.sleeves[0].intents[key], before);
  } finally {
    await f.bridge.close();
  }
});

it("fresh unchanged-source proof cannot roll the frozen 0.2% price anchor forward", async () => {
  const f = bridgeFixture();
  f.snap.prices[key] = "100.21";
  try {
    await assert.rejects(f.bridge.submit("alice", f.p, f.e), /0.2%/);
    assert.equal(f.outbox.size, 0);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.p.sleeves[0].intents[key].price, "100");
  } finally {
    await f.bridge.close();
  }
});

for (const issue of [
  "stale snapshot",
  "stale position",
  "incomplete",
  "changed revision",
  "missing position",
  "changed quantity",
  "changed leverage",
  "higher leverage",
  "unverified leverage",
])
  it(`does not recover stale target evidence using ${issue} source evidence`, async () => {
    const f = bridgeFixture();
    f.stub.source = async () => {
      const s = source();
      if (issue === "stale snapshot") s.observed_at -= 45_000;
      if (issue === "stale position") s.positions[0].observed_at -= 45_000;
      if (issue === "incomplete") s.complete = false;
      if (issue === "changed revision") s.revision = "source_v2";
      if (issue === "missing position") s.positions = [];
      if (issue === "changed quantity") s.positions[0].quantity = "6";
      if (issue === "changed leverage") s.positions[0].source_leverage = 4;
      if (issue === "higher leverage") s.positions[0].source_leverage = 6;
      if (issue === "unverified leverage")
        s.positions[0].source_leverage_verified = false;
      return s;
    };
    try {
      await assert.rejects(
        f.bridge.submit("alice", f.p, f.e),
        (e: any) => e.code === "EXECUTION_REJECTED",
      );
      assert.equal(f.outbox.size, 0);
      assert.equal(f.submissions.length, 0);
    } finally {
      await f.bridge.close();
    }
  });

it("keeps a user leverage cap effective when source leverage is higher without increasing the target", async () => {
  const f = bridgeFixture();
  f.p.sleeves[0].leverage_cap = 3;
  f.p.sleeves[0].leverage_mode = "custom_cap";
  f.p.sleeves[0].intents[key].source_leverage = 3;
  f.stub.source = async () => {
    const s = source();
    s.positions[0].source_leverage = 7;
    return s;
  };
  try {
    await f.bridge.submit("alice", f.p, f.e);
    assert.equal(f.submissions[0].leverage, 3);
    assert.equal(f.submissions[0].target_quantity, "0.1");
  } finally {
    await f.bridge.close();
  }
});

it("reconciles an existing outbox using its original identifier and payload after expiry and revision changes", async () => {
  const f = bridgeFixture();
  f.e.expires_at = now() - 1000;
  f.p.revision += 1;
  f.p.state = "attention";
  const payload = {
    execution_id: f.e.id,
    target_quantity: "0.1",
    entry_reference_price: "100",
    created_at: f.e.created_at,
    expires_at: f.e.expires_at,
    policy_revision: 7,
  };
  f.outbox.set(f.e.id, {
    fingerprint: f.e.fingerprint,
    payload: structuredClone(payload),
    response: null,
  });
  f.stub.perpsAccount = () =>
    assert.fail("Recovery must not prepare a fresh payload");
  f.stub.source = () =>
    assert.fail(
      "Recovery must not use a new source position to replace the payload",
    );
  try {
    const recovered = await f.bridge.execution("alice", f.p, f.e);
    assert.equal(recovered.task_id, "task_original");
    assert.equal(recovered.status, "submitted");
    assert.deepEqual(f.submissions, [payload]);
    assert.deepEqual(f.outbox.get(f.e.id).payload, payload);
  } finally {
    await f.bridge.close();
  }
});

it("recovers a Core-accepted response loss by the same execution id and frozen payload after expiry", async () => {
  const f = bridgeFixture(),
    accepted = new Set<string>();
  let lost = false;
  f.stub.core = async (op: string, payload: any) => {
    if (op === "perps_submit") {
      accepted.add(payload.execution_id);
      f.submissions.push(structuredClone(payload));
      if (!lost) {
        lost = true;
        throw Error("Accepted but response lost");
      }
      return { task_id: "task_original" };
    }
    if (op === "perps_execution") return { status: 2, legs: [] };
    return { policy_revision: 1 };
  };
  try {
    await assert.rejects(f.bridge.submit("alice", f.p, f.e), /response lost/);
    const frozen = structuredClone(f.outbox.get(f.e.id).payload);
    f.e.expires_at = now() - 1000;
    f.p.revision++;
    f.p.state = "attention";
    f.stub.perpsAccount = () =>
      assert.fail("Do not prepare new account-based payload");
    f.stub.source = () =>
      assert.fail("Do not replan accepted work from a later source");
    const status = await f.bridge.execution("alice", f.p, f.e);
    assert.equal(status.task_id, "task_original");
    assert.equal(accepted.size, 1);
    assert.deepEqual(f.submissions, [frozen, frozen]);
    assert.deepEqual(f.outbox.get(f.e.id).payload, frozen);
  } finally {
    await f.bridge.close();
  }
});

async function runnerFixture(p = portfolio(), adapter = new FakeAdapter()) {
  adapter.pool = [candidate(1)];
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
    runner: new AgentRunner(service),
    read: () =>
      repo.transact("alice", async (s) => structuredClone(s.portfolios[0])),
  };
}

it("reuses an already verified fixed snapshot without requesting a zero-width fill history window or replaying entries", async () => {
  const p = portfolio(),
    s = p.sleeves[0],
    at = now();
  s.copy_mode = "fixed";
  s.fixed_margin_usdc = "2";
  s.fixed_last_fill_at = at;
  s.fixed_targets = { [key]: "0.1" };
  s.source_quantities = { [key]: "5" };
  s.fixed_seen_fills = ["already_seen"];
  const f = await runnerFixture(p);
  f.adapter.snap.positions[key] = "0.1";
  s.lots[key] = {
    key,
    asset: "BTC",
    market: "perps",
    quantity: "0.1",
    cost: "10",
    realized: "0",
    fees: "0",
    funding: "0",
  };
  // Set the attributed lot in the repository as well, keeping reconciliation complete.
  await f.repo.transact("alice", async (state) => {
    state.portfolios[0].sleeves[0].lots = structuredClone(s.lots);
  });
  f.adapter.source = async () => {
    const value = source();
    value.observed_at = at;
    value.positions[0].observed_at = at;
    return value;
  };
  let fillReads = 0;
  f.adapter.sourceFills = async (_trader, start, end) => {
    fillReads++;
    assert.ok(end > start, "No empty history query");
    return { complete: true, fills: [] };
  };
  await f.runner.tick("alice");
  const saved = await f.read();
  assert.equal(saved.last_error, undefined);
  assert.equal(saved.state, "active");
  assert.equal(fillReads, 0);
  assert.equal(saved.sleeves[0].fixed_last_fill_at, at);
  assert.deepEqual(saved.sleeves[0].fixed_seen_fills, ["already_seen"]);
  assert.equal(saved.sleeves[0].fixed_targets?.[key], "0.1");
  assert.equal(f.adapter.submitCount, 0);
});

for (const issue of ["backwards time", "changed revision at the same time"])
  it(`does not treat ${issue} as already verified fixed-copy evidence`, async () => {
    const p = portfolio(),
      s = p.sleeves[0],
      at = now();
    s.copy_mode = "fixed";
    s.fixed_margin_usdc = "2";
    s.fixed_last_fill_at = at;
    s.fixed_targets = { [key]: "0.1" };
    s.source_quantities = { [key]: "5" };
    s.fixed_seen_fills = [];
    const f = await runnerFixture(p);
    f.adapter.source = async () => {
      const value = source();
      value.observed_at = at - (issue === "backwards time" ? 1 : 0);
      if (issue !== "backwards time") value.revision = "source_v2";
      return value;
    };
    f.adapter.sourceFills = async () =>
      assert.fail(
        "Unordered source evidence must not query or advance fill history",
      );
    await f.runner.tick("alice");
    const saved = await f.read();
    assert.equal(saved.state, "attention");
    assert.equal(saved.sleeves[0].fixed_last_fill_at, at);
    assert.equal(saved.sleeves[0].fixed_targets?.[key], "0.1");
    assert.equal(f.adapter.submitCount, 0);
  });

it("does not submit an expired uncertain target after reconciliation reports it was not accepted", async () => {
  const p = portfolio();
  p.executions = [execution("uncertain", true)];
  const f = await runnerFixture(p);
  f.adapter.execution = async () => ({
    status: "failed",
    observed_quantity: null,
    settled: false,
  });
  await f.runner.tick("alice");
  const saved = await f.read();
  assert.equal(f.adapter.submitCount, 0);
  assert.equal(saved.executions[0].status, "failed");
});

it("keeps expired uncertain work unresolved when acceptance cannot be determined", async () => {
  const p = portfolio();
  p.executions = [execution("uncertain", true)];
  const f = await runnerFixture(p);
  f.adapter.execution = async () => {
    throw new AgentError("EXECUTOR_UNAVAILABLE", "unknown", true, 503);
  };
  await f.runner.tick("alice");
  const saved = await f.read();
  assert.equal(f.adapter.submitCount, 0);
  assert.equal(saved.executions[0].status, "uncertain");
});
