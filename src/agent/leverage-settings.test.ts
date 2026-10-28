import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import { CoreBridge } from "./core_bridge.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { FakeAdapter, candidate, snapshot } from "./fixtures.js";
import { compatibility } from "./conversational.js";
import { D, now, recommend, type Execution } from "./domain.js";

const pref = {
  budget_usdc: "20",
  loss_trigger_pct: 20,
  risk_tolerance: "low" as const,
  market: "perps" as const,
  assets: ["BTC", "ETH"],
  allow_altcoins: false,
  portfolio_kind: "basket" as const,
  basket_size: 2,
};
function env() {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = [1, 2].map((i) => ({
    ...candidate(i),
    atr_pct: null,
    venue_max_leverage: 40,
  }));
  adapter.snap.account_value_usdc = adapter.snap.available_usdc = "20";
  adapter.snap.max_leverages = { "perps:BTC": 40, "perps:ETH": 40 };
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("k".repeat(32)),
  );
  return { repo, adapter, api };
}

it("defaults to no extra cap despite missing ATR, and accepts editable App caps without execution", async () => {
  const { repo, adapter, api } = env();
  const first = (
    await api.tool("alice", "recommend_traders", { preferences: pref })
  ).data.plan as any;
  assert.ok(
    first.allocations.every(
      (a: any) =>
        a.leverage_cap === null && a.leverage_mode === "follow_source",
    ),
  );
  for (const cap of [1, 20, 40, null]) {
    const edited = (
      await api.tool("alice", "recalculate_plan", {
        plan_id: first.id,
        allocations: first.allocations.map((a: any) => ({
          trader_id: a.trader.id,
          amount_usdc: "10",
          leverage_cap: cap,
        })),
      })
    ).data.plan as any;
    assert.ok(
      edited.allocations.every(
        (a: any) =>
          a.leverage_cap === cap &&
          a.leverage_mode === (cap == null ? "follow_source" : "custom_cap"),
      ),
    );
    const refresh = (
      await api.tool("alice", "recalculate_plan", { plan_id: edited.id })
    ).data.plan as any;
    assert.ok(refresh.allocations.every((a: any) => a.leverage_cap === cap));
    const pinned = (await api.tool("alice", "recommend_traders", {})).data
      .plan as any;
    assert.ok(pinned.allocations.every((a: any) => a.leverage_cap === cap));
    const proposal = (
      await api.tool("alice", "start_copy", {
        plan_id: refresh.id,
        compatibility_ack: compatibility(refresh).fingerprint,
      })
    ).data.proposal as any;
    assert.equal(proposal.status, "requires_confirmation");
  }
  assert.equal(adapter.submitCount, 0);
  await repo.transact("alice", async (s) => {
    assert.equal(s.portfolios.length, 0);
    assert.ok(
      s.plans
        .find((p) => p.id === first.id)!
        .allocations.every((a) => a.leverage_cap === null),
    );
  });
});

it("preserves frozen 3x plans on refresh and changes a running cap only through a frozen proposal", async () => {
  const { repo, adapter, api } = env();
  const original = recommend(pref, adapter.pool);
  for (const a of original.allocations) {
    delete a.leverage_mode;
    a.leverage_cap = 3;
  }
  await repo.transact("alice", async (s) => {
    s.plans.push(original);
    s.portfolios.push(fromPlan(original));
  });
  const refreshed = (
    await api.tool("alice", "recalculate_plan", { plan_id: original.id })
  ).data.plan as any;
  assert.ok(
    refreshed.allocations.every(
      (a: any) =>
        a.leverage_cap === 3 &&
        a.leverage_mode == null &&
        a.leverage_cap_source === "inherited" &&
        a.leverage_cap_inherited_from_plan_id === original.id,
    ),
  );
  const cleared = await api.tool("alice", "recalculate_plan", {
    plan_id: refreshed.id,
    allocations: refreshed.allocations.map((a: any) => ({
      trader_id: a.trader.id,
      amount_usdc: a.amount_usdc,
      leverage_cap: null,
    })),
  });
  assert.ok(
    (cleared.data.plan as any).allocations.every(
      (a: any) =>
        a.leverage_cap === null &&
        a.leverage_mode === "follow_source" &&
        a.leverage_cap_source === "user" &&
        a.leverage_cap_inherited_from_plan_id == null,
    ),
  );
  assert.ok(original.allocations.every((a) => a.leverage_cap === 3));
  let copy = "";
  await repo.transact("alice", async (s) => {
    copy = s.portfolios[0].sleeves[0].copy_id;
  });
  const result = await api.tool("alice", "update_copy", {
    copy_id: copy,
    leverage_cap: 20,
  });
  assert.equal((result.data.proposal as any).status, "requires_confirmation");
  await repo.transact("alice", async (s) => {
    assert.equal(s.portfolios[0].sleeves[0].leverage_cap, 3);
  });
  assert.equal(adapter.submitCount, 0);
});

for (const [cap, sourceLeverage, venueLimit, expectedNotional] of [
  [3, 20, 40, 0],
  [20, 20, 40, 10],
  [40, 40, 40, 10],
  [20, 5, 40, 10],
  [20, 20, 10, 0],
  [null, 50, 50, 10],
] as const)
  it(`sizes two 10-USDC sleeves at source ${sourceLeverage}x, user ${cap}x and venue ${venueLimit}x`, async () => {
    const { repo, adapter, api } = env();
    adapter.snap.max_leverages = {
      "perps:BTC": venueLimit,
      "perps:ETH": venueLimit,
    };
    adapter.source = async (c) => ({
      observed_at: now(),
      revision: "source_v1",
      account_value_usdc: "1000",
      complete: true,
      positions: [
        {
          key: `perps:${c.assets[0]}`,
          asset: c.assets[0],
          market: "perps",
          quantity: "10",
          price: "100",
          source_entry_price: "100",
          source_leverage: sourceLeverage,
          source_leverage_verified: true,
          observed_at: now(),
          source_revision: "source_v1",
        },
      ],
    });
    const p = fromPlan(recommend(pref, adapter.pool));
    for (const s of p.sleeves) {
      s.leverage_cap = cap;
      s.leverage_mode = cap == null ? "follow_source" : "custom_cap";
    }
    await repo.transact("alice", async (s) => {
      s.portfolios.push(p);
    });
    await new AgentRunner(api).tick("alice");
    assert.equal(adapter.submitCount, expectedNotional ? 2 : 0);
    await repo.transact("alice", async (s) => {
      const p = s.portfolios[0];
      if (expectedNotional) {
        assert.ok(
          p.executions.every((e) =>
            D(e.target_quantity).times(100).eq(expectedNotional),
          ),
        );
        assert.ok(
          p.executions.reduce((n, e) => n.plus(e.reserve_usdc), D(0)).lte(20),
        );
        assert.ok(
          p.sleeves.every((s) =>
            Object.values(s.intents).every(
              (x) =>
                x.source_leverage ===
                Math.min(cap ?? Infinity, sourceLeverage, venueLimit),
            ),
          ),
        );
      } else
        assert.ok(s.updates.some((u) => u.kind === "BELOW_MINIMUM_NOTIONAL"));
    });
  });

for (const missing of ["source", "venue"] as const)
  it(`blocks new risk when ${missing} leverage is unverified`, async () => {
    const { repo, adapter, api } = env();
    const source = adapter.source.bind(adapter);
    adapter.source = async (c) => {
      const s = await source(c);
      if (missing === "source")
        Object.assign(s.positions[0], { source_leverage_verified: false });
      return s;
    };
    if (missing === "venue") adapter.snap.max_leverages = {};
    await repo.transact("alice", async (s) => {
      s.portfolios.push(fromPlan(recommend(pref, adapter.pool)));
    });
    await new AgentRunner(api).tick("alice");
    assert.equal(adapter.submitCount, 0);
    await repo.transact("alice", async (s) => {
      assert.ok(
        s.updates.some(
          (u) =>
            u.kind ===
            (missing === "source"
              ? "SOURCE_LEVERAGE_UNAVAILABLE"
              : "VENUE_RULES_UNAVAILABLE"),
        ),
      );
    });
  });

it("re-evaluates unchanged sources when live venue leverage changes", async () => {
  const { repo, adapter, api } = env();
  const p = fromPlan(recommend(pref, adapter.pool));
  p.sleeves.forEach((s) => {
    s.leverage_cap = 40;
    s.leverage_mode = "custom_cap";
  });
  // Sub-minimum first evaluation has no in-flight order. A venue change alone
  // must invalidate sizing even when the source's revision stays the same.
  adapter.snap.min_notionals = { "perps:BTC": "100", "perps:ETH": "100" };
  await repo.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  const runner = new AgentRunner(api);
  await runner.tick("alice");
  adapter.snap.max_leverages = { "perps:BTC": 2, "perps:ETH": 2 };
  await runner.tick("alice");
  await repo.transact("alice", async (s) => {
    assert.ok(
      s.portfolios[0].sleeves.every((s) =>
        Object.values(s.intents).every((x) => x.source_leverage === 2),
      ),
    );
  });
  assert.equal(adapter.submitCount, 0);
});

it("carries 40x through the mock Core boundary and rejects a changed venue limit before writing an outbox", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "k".repeat(32),
    "testnet",
  );
  const stub = bridge as any,
    snap = snapshot(),
    policies: any[] = [];
  let outbox: any = null,
    submissions = 0;
  snap.max_leverages["perps:BTC"] = 40;
  stub.perpsAccount = async () => snap;
  stub.source = async () => ({
    revision: "source_v1",
    observed_at: now(),
    account_value_usdc: "1000",
    complete: true,
    positions: [
      {
        ...p.sleeves[0].intents["perps:BTC"],
        quantity: "5",
        observed_at: now(),
      },
    ],
  });
  stub.control = async (op: string, payload: any) => {
    if (op === "perps_policy") policies.push(payload);
  };
  stub.pool.query = async (sql: string, values: any[]) => {
    if (sql.startsWith("SELECT")) return { rows: outbox ? [outbox] : [] };
    if (sql.startsWith("INSERT"))
      outbox = { fingerprint: values[3], payload: values[4], response: null };
    if (sql.startsWith("UPDATE")) outbox.response = values[1];
    return { rows: [], rowCount: 1 };
  };
  stub.core = async (op: string) => {
    if (op === "perps_submit") {
      submissions++;
      return { task_id: "mock_task" };
    }
    return { policy_revision: 1 };
  };
  const p = fromPlan(
    recommend({ ...pref, portfolio_kind: "single", basket_size: 1 }, [
      { ...candidate(1), venue_max_leverage: 40 },
    ]),
  );
  p.account_id = snap.account_id;
  p.sleeves[0].leverage_cap = 40;
  p.sleeves[0].leverage_mode = "custom_cap";
  p.sleeves[0].source_revision = "source_v1";
  p.sleeves[0].intents["perps:BTC"] = {
    key: "perps:BTC",
    asset: "BTC",
    market: "perps",
    quantity: "0.1",
    price: "100",
    source_entry_price: "100",
    source_leverage: 40,
    observed_at: now(),
    source_revision: "source_v1",
  };
  const e: Execution = {
    id: "mock_execution",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    status: "queued",
    revision: 0,
    fingerprint: "mock_fingerprint",
    created_at: now(),
    expires_at: now() + 60000,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "1",
    error: null,
  };
  try {
    await stub.configure("alice", p, { ...snap, account_value_usdc: "20" });
    assert.equal(policies[0].max_leverage, 40);
    assert.equal(policies[0].max_total_position_pct, "4000.0000");
    snap.max_leverages[e.key] = 10;
    await assert.rejects(
      bridge.submit("alice", p, e),
      /leverage rules changed/,
    );
    assert.equal(outbox, null);
    snap.max_leverages[e.key] = 40;
    await bridge.submit("alice", p, e);
    assert.equal((outbox as any).payload.leverage, 40);
    assert.equal(submissions, 1);
    outbox = null;
    snap.max_leverages[e.key] = 50;
    p.sleeves[0].leverage_cap = null;
    p.sleeves[0].leverage_mode = "follow_source";
    p.sleeves[0].intents[e.key].source_leverage = 50;
    await stub.configure("alice", p, snap);
    assert.equal(policies[1].max_leverage, 50);
    await bridge.submit("alice", p, {
      ...e,
      id: "mock_execution_uncapped",
      fingerprint: "uncapped_fingerprint",
    });
    assert.equal((outbox as any).payload.leverage, 50);
    assert.equal(submissions, 2);
    snap.max_leverages[e.key] = 100;
    await stub.configure("alice", p, { ...snap, account_value_usdc: "20" });
    assert.equal(policies[2].max_leverage, 100);
    assert.equal(policies[2].max_total_position_pct, "9999.9999");
  } finally {
    await bridge.close();
  }
});
