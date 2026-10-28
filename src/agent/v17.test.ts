import { it } from "node:test";
import assert from "node:assert/strict";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import { D, now, recommend, uid } from "./domain.js";
import { inputs, publicResult } from "./contracts.js";
import { DepositReads, type Deposit } from "./deposits.js";
import { compatibility } from "./conversational.js";

const legacy = {
  budget_usdc: "500",
  loss_trigger_pct: 90,
  market: "perps" as const,
  assets: ["BTC", "ETH"],
  allow_altcoins: false,
};
const pref = {
  ...legacy,
  portfolio_kind: "basket" as const,
  basket_size: 4,
  risk_tolerance: "medium" as const,
  loss_policy: "pause_then_exit" as const,
  emergency_exit_pct: 70,
};
function env() {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter(),
    api = new AgentService(
      repo,
      adapter,
      "https://ride.test",
      new Cursor("k".repeat(32)),
    );
  adapter.pool = Array.from({ length: 24 }, (_, i) => candidate(i + 1));
  return { repo, adapter, api };
}
it("single and 2–8 trader plans require explicit new preferences; legacy plans retain their limits", async () => {
  const { api, adapter, repo } = env();
  const one = (
    await api.tool("alice", "recommend_traders", {
      preferences: { ...pref, portfolio_kind: "single", basket_size: 1 },
      trader_ids: [adapter.pool[0].id],
    })
  ).data.plan as any;
  assert.equal(one.allocations.length, 1);
  assert.equal(one.allocations[0].amount_usdc, "500.000000");
  const eight = (
    await api.tool("bob", "recommend_traders", {
      preferences: { ...pref, basket_size: 8 },
    })
  ).data.plan as any;
  assert.equal(eight.allocations.length, 8);
  const original = recommend(legacy, adapter.pool);
  await repo.transact("old", async (s) => {
    s.plans.push(original);
  });
  assert.equal(original.allocations.length, 6);
  await assert.rejects(
    api.tool("old", "recalculate_plan", {
      plan_id: original.id,
      preferences: legacy,
      allocations: original.allocations.slice(0, 2).map((a: any) => ({
        trader_id: a.trader.id,
        amount_usdc: a.amount_usdc,
        leverage_cap: a.leverage_cap,
        stop_loss_pct: a.stop_loss_pct,
      })),
    }),
    /explicit|Select/,
  );
  const low = recommend({ ...pref, risk_tolerance: "low" }, adapter.pool);
  assert.ok(
    low.allocations.every(
      (a) => a.leverage_cap === null && a.leverage_mode === "follow_source",
    ),
  );
  const oldLow = recommend({ ...legacy, risk_tolerance: "low" }, adapter.pool);
  assert.ok(
    oldLow.allocations.every(
      (a) => a.leverage_cap != null && a.leverage_cap <= 3,
    ),
  );
});
it("legacy page inputs preserve edited plans without one-free-change limits and isolate accounts", async () => {
  const { api, adapter, repo } = env();
  const first = await api.tool("alice", "recommend_traders", {
      preferences: pref,
      batch_action: "first",
    }),
    plan = first.data.plan as any;
  const edited = (
    await api.tool("alice", "recalculate_plan", {
      plan_id: plan.id,
      preferences: pref,
      allocations: plan.allocations.map((a: any) => ({
        trader_id: a.trader.id,
        amount_usdc: "100",
        leverage_cap: 3,
        stop_loss_pct: 25,
        loss_policy: "pause_then_exit",
        emergency_exit_pct: 70,
      })),
    })
  ).data.plan as any;
  const next = await api.tool("alice", "recommend_traders", {
    preferences: pref,
    batch_action: "next",
  });
  assert.equal((next.data.plan as any).id, edited.id);
  assert.equal(
    (next.data.plan as any).allocations[0].amount_usdc,
    "100.000000",
  );
  const third = await api.tool("alice", "recommend_traders", {
    preferences: pref,
    batch_action: "next",
  });
  assert.equal(
    (third.data.recommendation_batches as any).displayed_candidates.length,
    8,
  );
  await api.tool("alice", "recommend_traders", {
    preferences: { ...pref, risk_tolerance: "high" },
    batch_action: "first",
  });
  await api.tool("alice", "recommend_traders", {
    preferences: { ...pref, risk_tolerance: "high" },
    batch_action: "next",
  });
  const bob = await api.tool("bob", "recommend_traders", {
    preferences: pref,
    batch_action: "first",
  });
  assert.equal((bob.data.recommendation_batches as any).change_used, false);
  assert.equal(
    (bob.data.recommendation_batches as any).preview_quota_applies,
    false,
  );
  await repo.transact("alice", async (s) =>
    assert.equal(s.portfolios.length, 0),
  );
  assert.equal(adapter.submitCount, 0);
  await repo.transact("alice", async (s) => {
    const active = fromPlan(s.plans.at(-1)!);
    active.state = "active";
    s.portfolios.push(active);
  });
  const active = await api.tool("alice", "recommend_traders", {
    preferences: { ...pref, risk_tolerance: "high" },
    batch_action: "next",
  });
  assert.equal(
    (active.data.recommendation_batches as any).preview_quota_applies,
    false,
  );
});
it("compatibility acknowledgment binds to immutable allocation parameters; alternatives never execute", async () => {
  const { api, adapter } = env();
  adapter.pool[0].assets = ["BTC"];
  adapter.pool[1].assets = ["BTC"];
  adapter.pool[0].direction = adapter.pool[1].direction = "long";
  const response = await api.tool("alice", "recommend_traders", {
      preferences: { ...pref, basket_size: 2 },
      trader_ids: [adapter.pool[0].id, adapter.pool[1].id],
    }),
    plan = response.data.plan as any,
    report = response.data.compatibility as any;
  assert.ok(report.warnings > 0);
  assert.ok((response.data.alternatives as any[]).length > 0);
  await assert.rejects(
    api.tool("alice", "start_copy", { plan_id: plan.id }),
    /overlap/,
  );
  await assert.rejects(
    api.tool("alice", "start_copy", {
      plan_id: plan.id,
      compatibility_ack: "a".repeat(64),
    }),
    /overlap/,
  );
  const q = (
    await api.tool("alice", "start_copy", {
      plan_id: plan.id,
      compatibility_ack: report.fingerprint,
    })
  ).data.proposal as any;
  assert.equal(q.status, "requires_confirmation");
  assert.equal(adapter.submitCount, 0);
  const changed = structuredClone(plan);
  changed.allocations[0].amount_usdc = "240";
  assert.notEqual(compatibility(changed).fingerprint, report.fingerprint);
});
it("new pause policy keeps reductions at 30% and exits at 70%; legacy still exits at its threshold", async () => {
  for (const policy of ["pause_then_exit", "exit"] as const) {
    const { api, repo, adapter } = env();
    const p = fromPlan(
      recommend(
        {
          ...legacy,
          portfolio_kind: "single",
          basket_size: 1,
          loss_policy: policy,
          emergency_exit_pct: 70,
        },
        [adapter.pool[0]],
      ),
    );
    p.state = "active";
    p.account_id = adapter.snap.account_id;
    p.initial_equity = "500";
    p.ledger_started_at = now() - 1000;
    p.reconciliation = "complete";
    const s = p.sleeves[0],
      key = "perps:BTC";
    s.initialized = true;
    s.source_revision = "previous";
    s.lots[key] = {
      key,
      asset: "BTC",
      market: "perps",
      quantity: "1",
      cost: "100",
      realized: "-170",
      fees: "0",
      funding: "0",
    };
    s.intents[key] = {
      key,
      asset: "BTC",
      market: "perps",
      quantity: "1",
      price: "100",
      source_entry_price: "100",
      source_leverage: 3,
      observed_at: now(),
      source_revision: "previous",
    };
    adapter.snap.positions[key] = "1";
    adapter.snap.account_value_usdc = "330";
    await repo.transact("alice", async (state) => {
      state.portfolios.push(p);
    });
    await new AgentRunner(api).tick("alice");
    await repo.transact("alice", async (state) => {
      const sleeve = state.portfolios[0].sleeves[0];
      assert.equal(
        sleeve.state,
        policy === "exit" ? "loss_triggered" : "risk_off",
      );
      assert.ok(D(sleeve.intents[key].quantity).lte(1));
      if (policy === "exit") assert.equal(sleeve.intents[key].quantity, "0");
    });
    if (policy === "pause_then_exit") {
      await repo.transact("alice", async (state) => {
        state.portfolios[0].sleeves[0].lots[key].realized = "-360";
      });
      adapter.snap.account_value_usdc = "140";
      await new AgentRunner(api).tick("alice");
      await repo.transact("alice", async (state) => {
        assert.equal(state.portfolios[0].sleeves[0].state, "loss_triggered");
        assert.equal(state.portfolios[0].sleeves[0].intents[key].quantity, "0");
      });
    }
  }
});
it("Fixed copying adds margin for each verified entry and reduces proportionally; incomplete fills cannot add exposure", async (context) => {
  let clock = Date.now();
  context.mock.method(Date, "now", () => clock);
  const { api, repo, adapter } = env();
  const c = adapter.pool[0];
  const p = fromPlan(
    recommend(
      {
        ...legacy,
        portfolio_kind: "single",
        copy_mode: "fixed",
        fixed_margin_usdc: "10",
      },
      [c],
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.initial_equity = "500";
  p.state = "active";
  p.ledger_started_at = now() - 1000;
  p.reconciliation = "complete";
  await repo.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  await new AgentRunner(api).tick("alice");
  let first = 0,
    lastAt = 0;
  await repo.transact("alice", async (state) => {
    const s = state.portfolios[0].sleeves[0];
    first = Number(s.intents["perps:BTC"].quantity);
    lastAt = s.fixed_last_fill_at!;
  });
  assert.equal(first, 0.5);
  const originalSource = adapter.source.bind(adapter);
  adapter.source = async (c) => {
    const source = await originalSource(c);
    source.positions[0].quantity = "10";
    source.revision = "v2";
    return source;
  };
  adapter.sourceFills = async () => ({
    complete: true,
    fills: [1, 2].map((i) => ({
      id: `fill_${i}`,
      key: "perps:BTC",
      quantity: "2.5",
      start_quantity: i === 1 ? "5" : "7.5",
      price: "100",
      fee_usdc: "0",
      realized_usdc: null,
      at: lastAt + i,
    })),
  });
  // The new snapshot must follow the synthetic fills at lastAt + 1/+2.
  clock += 1000;
  await new AgentRunner(api).tick("alice");
  await repo.transact("alice", async (state) =>
    assert.equal(
      state.portfolios[0].sleeves[0].intents["perps:BTC"].quantity,
      "1.5",
    ),
  );
  adapter.sourceFills = async () => ({ complete: false, fills: [] });
  clock += 1000;
  await new AgentRunner(api).tick("alice");
  await repo.transact("alice", async (state) =>
    assert.equal(
      state.portfolios[0].sleeves[0].intents["perps:BTC"].quantity,
      "1.5",
    ),
  );
});
it("Fixed copying rejects unexplained new assets and direction flips even when fill coverage reports complete", async () => {
  const { api, repo, adapter } = env();
  const p = fromPlan(
    recommend(
      {
        ...legacy,
        portfolio_kind: "single",
        copy_mode: "fixed",
        fixed_margin_usdc: "10",
      },
      [adapter.pool[0]],
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.initial_equity = "500";
  p.state = "active";
  p.ledger_started_at = now() - 1000;
  p.reconciliation = "complete";
  await repo.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  await new AgentRunner(api).tick("alice");
  const originalSource = adapter.source.bind(adapter);
  adapter.sourceFills = async () => ({ complete: true, fills: [] });
  adapter.source = async (c) => {
    const source = await originalSource(c);
    source.revision = "new_asset_without_fill";
    source.positions.push({
      ...source.positions[0],
      key: "perps:ETH",
      asset: "ETH",
    });
    return source;
  };
  await new AgentRunner(api).tick("alice");
  await repo.transact("alice", async (state) => {
    assert.equal(
      state.portfolios[0].sleeves[0].intents["perps:ETH"]?.quantity ?? "0",
      "0",
    );
    assert.ok(
      state.updates.some((e) => e.kind === "SOURCE_FILL_EVIDENCE_MISSING"),
    );
  });
  adapter.source = async (c) => {
    const source = await originalSource(c);
    source.revision = "direction_flip_without_fill";
    source.positions[0].quantity = "-5";
    return source;
  };
  await new AgentRunner(api).tick("alice");
  await repo.transact("alice", async (state) => {
    assert.equal(
      state.portfolios[0].sleeves[0].intents["perps:BTC"].quantity,
      "0.5",
    );
  });
});
it("portfolio stop changes are proposals and a triggered stop cannot be restarted", async () => {
  const { api, repo, adapter } = env();
  const p = fromPlan(recommend(legacy, adapter.pool));
  p.state = "active";
  p.account_id = adapter.snap.account_id;
  p.snapshot = adapter.snap;
  await repo.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  const q = (
    await api.tool("alice", "update_portfolio", {
      portfolio_id: p.id,
      loss_trigger_pct: 35,
    })
  ).data.proposal as any;
  await repo.transact("alice", async (s) =>
    assert.equal(s.portfolios[0].preferences.loss_trigger_pct, 90),
  );
  await api.confirm("alice", q.id, q.preview_hash);
  await repo.transact("alice", async (s) => {
    assert.equal(s.portfolios[0].preferences.loss_trigger_pct, 35);
    s.portfolios[0].loss_latched = true;
  });
  await assert.rejects(
    api.tool("alice", "update_portfolio", {
      portfolio_id: p.id,
      loss_trigger_pct: 80,
    }),
    /triggered/,
  );
  await assert.rejects(
    api.tool("bob", "update_portfolio", {
      portfolio_id: p.id,
      loss_trigger_pct: 35,
    }),
    /not found/,
  );
});
it("deposit tickets and QR expose only the requested owned receiving address and preserve trader identity filtering", async () => {
  const { api, adapter } = env();
  const address = "0x" + "1".repeat(40);
  adapter.depositAddress = async (_user, input) => ({
    id: uid("deposit"),
    market: input.market,
    asset: input.asset,
    network: input.network,
    address,
    provider: "wallet",
    created_at: now(),
  });
  adapter.depositStatus = async (d) => ({
    deposit_id: d.id,
    status: "awaiting_deposit",
    available_to_copy: false,
  });
  const result = await api.tool("alice", "get_deposit_address", {
      market: "perps",
      asset: "USDC",
      network: "Arbitrum",
    }),
    d = result.data.deposit as any;
  assert.ok(d.qr_data_url.startsWith("data:image/png;base64,"));
  publicResult(result);
  await assert.rejects(
    api.tool("bob", "check_deposit_status", { deposit_id: d.id }),
    /not found/,
  );
  assert.equal(
    (await api.tool("alice", "check_deposit_status", { deposit_id: d.id })).data
      .saved_plan_id,
    null,
  );
  assert.throws(
    () =>
      publicResult({
        ...result,
        data: { ...result.data, trader_address: address },
      }),
    /private trading/,
  );
});
it("provider routes are validated before an address is created and provider completions stay distinct from copy readiness", async () => {
  let creations = 0;
  const fetcher = (async (url: any, init: any) => {
    const path = String(url).split("/").at(-1);
    if (path === "supported-assets")
      return Response.json({
        supportedAssets: [
          {
            chainId: "8453",
            token: { symbol: "USDC", address: "0x" + "4".repeat(40) },
            minCheckoutUsd: 2,
          },
        ],
      });
    if (path === "deposit") {
      creations++;
      return Response.json({ address: { evm: "0x" + "2".repeat(40) } });
    }
    return Response.json({ transactions: [] });
  }) as typeof fetch;
  const provider = new DepositReads(
    async () => ({ wallet: "0x" + "3".repeat(40) }),
    "mainnet",
    fetcher,
  );
  await assert.rejects(
    provider.address("alice", {
      market: "prediction",
      asset: "USDT",
      network: "Base",
    }),
    /not currently supported/,
  );
  assert.equal(creations, 0);
  await assert.rejects(
    provider.address("alice", {
      market: "prediction",
      asset: "USDC",
      network: "Base",
      amount_usdc: "1",
    }),
    /minimum/,
  );
  const deposit = await provider.address("alice", {
    market: "prediction",
    asset: "USDC",
    network: "Base",
  });
  assert.equal(creations, 1);
  assert.equal((await provider.status(deposit)).available_to_copy, null);
});
it("daily check-ins persist once per local date, isolate owners and reject invalid timezone", async (t) => {
  let at = Date.UTC(2026, 9, 12, 1, 0);
  t.mock.method(Date, "now", () => at);
  const { api, repo, adapter } = env();
  await repo.transact("alice", async (s) => {
    s.portfolios.push(fromPlan(recommend(pref, adapter.pool)));
  });
  assert.equal(
    (
      await api.tool("alice", "get_daily_checkin", {
        timezone: "Asia/Shanghai",
      })
    ).data.daily_checkin &&
      (
        (
          await api.tool("alice", "get_daily_checkin", {
            timezone: "Asia/Shanghai",
          })
        ).data.daily_checkin as any
      ).offer_review,
    false,
  );
  at += 86400000;
  assert.equal(
    (
      (
        await api.tool("alice", "get_daily_checkin", {
          timezone: "Asia/Shanghai",
        })
      ).data.daily_checkin as any
    ).offer_review,
    true,
  );
  assert.equal(
    (
      (
        await api.tool("bob", "get_daily_checkin", {
          timezone: "Asia/Shanghai",
        })
      ).data.daily_checkin as any
    ).offer_review,
    false,
  );
  await assert.rejects(
    api.tool("alice", "get_daily_checkin", { timezone: "invalid" }),
    /timezone/,
  );
});

it("RWA is independently filtered and requires its own DEX collateral at proposal and confirmation", async () => {
  const { api, adapter } = env();
  const rwa = {
    ...candidate(1),
    asset_category: "rwa" as const,
    assets: ["xyz:TSLA"],
    asset_categories: { "xyz:TSLA": "rwa" as const },
  };
  adapter.pool = [rwa, ...adapter.pool];
  const response = await api.tool("alice", "recommend_traders", {
      preferences: {
        ...pref,
        portfolio_kind: "single",
        basket_size: 1,
        asset_category: "rwa",
        assets: [],
        allow_altcoins: true,
      },
    }),
    plan = response.data.plan as any;
  assert.equal(plan.allocations[0].trader.id, rwa.id);
  adapter.snap.available_by_scope = { core: "500", xyz: "0" };
  await assert.rejects(
    api.tool("alice", "start_copy", { plan_id: plan.id }),
    /each selected DEX/,
  );
  adapter.snap.available_by_scope = { core: "0", xyz: "500" };
  const q = (await api.tool("alice", "start_copy", { plan_id: plan.id })).data
    .proposal as any;
  adapter.snap.available_by_scope = { core: "500", xyz: "0" };
  await assert.rejects(
    api.confirm("alice", q.id, q.preview_hash),
    /each selected DEX/,
  );
  adapter.pool = [{ ...rwa, execution_supported: false }];
  const unavailable = await api.tool("bob", "recommend_traders", {
    preferences: {
      ...pref,
      portfolio_kind: "single",
      basket_size: 1,
      asset_category: "rwa",
    },
  });
  assert.equal(unavailable.data.plan, null);
  assert.equal(adapter.submitCount, 0);
});
