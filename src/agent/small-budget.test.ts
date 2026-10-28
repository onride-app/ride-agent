import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import { CoreBridge } from "./core_bridge.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter, candidate, snapshot } from "./fixtures.js";
import {
  D,
  now,
  recommend,
  minimumAllocation,
  type Execution,
} from "./domain.js";
import { checkPerpsOrder } from "./order_rules.js";

const key = "perps:BTC";
const preferences = {
  budget_usdc: "20",
  loss_trigger_pct: 20,
  market: "perps" as const,
  assets: ["BTC", "ETH"],
  allow_altcoins: false,
  portfolio_kind: "single" as const,
  basket_size: 1,
};

it("removes only new Agent Perps allocation floors and preserves legacy and Prediction rules", () => {
  const c = candidate(1);
  assert.equal(minimumAllocation(preferences, c).toString(), "0.000001");
  const { portfolio_kind, basket_size, ...legacy } = preferences;
  assert.equal(minimumAllocation(legacy, c).toString(), "10");
  assert.throws(() =>
    recommend({ ...legacy, budget_usdc: "20" }, [1, 2, 3].map(candidate)),
  );
  assert.equal(
    minimumAllocation(preferences, {
      ...c,
      market: "prediction",
      min_notional_usdc: "5",
    }).toString(),
    "50",
  );
  assert.equal(
    minimumAllocation(preferences, {
      ...c,
      market: "prediction",
      min_notional_usdc: "75",
    }).toString(),
    "75",
  );
});

for (const [current, target, price, minimum, expected] of [
  ["0", "0.1", "100", "10", true],
  ["0", "0.099", "100", "10", false],
  ["0", "0.1", "99.99", "10", false],
  ["0", "-0.1", "100", "10", true],
  ["0.1", "0.15", "100", "10", false],
  ["0.1", "0.2", "100", "10", true],
  ["0.2", "-0.05", "100", "10", false],
  ["0.2", "-0.1", "100", "10", true],
  ["0.02", "0.01", "100", "10", true],
  ["-0.02", "0", "100", "10", true],
  ["0", "0.1", "100", "15", false],
] as const)
  it(`checks opening leg ${current} -> ${target} at ${price} against venue minimum ${minimum}`, () => {
    const snap = snapshot();
    snap.positions[key] = current;
    snap.prices[key] = price;
    snap.min_notionals[key] = minimum;
    const result = checkPerpsOrder(snap, key, target);
    assert.equal(result.ok, expected);
    if (!result.ok) assert.equal(result.code, "BELOW_MINIMUM_NOTIONAL");
  });

it("fails closed on unavailable/invalid live rules and rejects excess precision without rounding up", () => {
  for (const minimum of [undefined, "0", "-10", "NaN", "Infinity", "bad"]) {
    const snap = snapshot();
    if (minimum == null) delete snap.min_notionals[key];
    else snap.min_notionals[key] = minimum;
    assert.equal(checkPerpsOrder(snap, key, "0.1").ok, false);
    // Reduce-only dust closes remain possible without an opening-order rule.
    snap.positions[key] = "0.01";
    assert.equal(checkPerpsOrder(snap, key, "0").ok, true);
  }
  const snap = snapshot();
  snap.quantity_decimals![key] = 2;
  const result = checkPerpsOrder(snap, key, "0.105");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INVALID_ORDER_QUANTITY");
  delete snap.quantity_decimals![key];
  assert.equal(checkPerpsOrder(snap, key, "0.1").ok, false);
});

for (const [price, sourceQuantity, minimum, submitted, reason] of [
  ["100", "5", "10", 1, "TARGET_EVALUATED"],
  ["99.99", "5.004", "10", 0, "BELOW_MINIMUM_NOTIONAL"],
  ["100", "5", "15", 0, "BELOW_MINIMUM_NOTIONAL"],
  ["100", "5", null, 0, "VENUE_RULES_UNAVAILABLE"],
  ["100", "0.001", "10", 0, "BELOW_MINIMUM_QUANTITY"],
] as const)
  it(`20-USDC runner sizes and rounds before checking live minimum ${minimum} at ${price}`, async () => {
    const repo = new MemoryRepository(),
      adapter = new FakeAdapter();
    adapter.pool = [{ ...candidate(1), venue_max_leverage: 3 }];
    adapter.snap.account_value_usdc = adapter.snap.available_usdc = "20";
    adapter.snap.prices[key] = price;
    adapter.snap.quantity_decimals![key] = 3;
    if (minimum == null) delete adapter.snap.min_notionals[key];
    else adapter.snap.min_notionals[key] = minimum;
    adapter.source = async (c) => ({
      observed_at: now(),
      revision: "source_v1",
      account_value_usdc: "1000",
      complete: true,
      positions: [
        {
          key,
          asset: "BTC",
          market: "perps",
          quantity: sourceQuantity,
          price,
          source_entry_price: price,
          source_leverage: 3,
          observed_at: now(),
          source_revision: "source_v1",
        },
      ],
    });
    const api = new AgentService(
      repo,
      adapter,
      "https://ride.test",
      new Cursor("k".repeat(32)),
    );
    await repo.transact("alice", async (state) => {
      state.portfolios.push(fromPlan(recommend(preferences, adapter.pool)));
    });
    await new AgentRunner(api).tick("alice");
    assert.equal(adapter.submitCount, submitted);
    await repo.transact("alice", async (state) => {
      const p = state.portfolios[0];
      assert.equal(p.preferences.budget_usdc, "20");
      assert.equal(p.preferences.loss_trigger_pct, 20);
      assert.equal(p.sleeves[0].amount_usdc, "20.000000");
      assert.equal(p.sleeves[0].leverage_cap, null);
      assert.equal(p.sleeves[0].leverage_mode, "follow_source");
      assert.ok(
        p.decisions?.some((d) => d.reason === reason),
        JSON.stringify(state.updates),
      );
      if (submitted) {
        assert.equal(p.executions[0].target_quantity, "0.1");
        assert.ok(D(p.executions[0].reserve_usdc).lte(20));
      } else {
        assert.equal(p.executions.length, 0);
        assert.ok(
          state.updates
            .filter((u) => u.kind === reason)
            .every((u) => u.notification === "cancelled"),
        );
      }
    });
  });

it("closes the existing position while skipping a sub-minimum opposite opening leg", async () => {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = [candidate(1)];
  adapter.snap.account_value_usdc = adapter.snap.available_usdc = "20";
  adapter.snap.positions[key] = "0.2";
  adapter.source = async () => ({
    observed_at: now(),
    revision: "source_v2",
    account_value_usdc: "1000",
    complete: true,
    positions: [
      {
        key,
        asset: "BTC",
        market: "perps",
        quantity: "-2.5",
        price: "100",
        source_entry_price: "100",
        source_leverage: 3,
        observed_at: now(),
        source_revision: "source_v2",
      },
    ],
  });
  const p = fromPlan(recommend(preferences, adapter.pool));
  p.account_id = adapter.snap.account_id;
  p.initial_equity = "20";
  p.ledger_started_at = now() - 1000;
  p.state = "active";
  p.sleeves[0].initialized = true;
  p.sleeves[0].lots[key] = {
    key,
    asset: "BTC",
    market: "perps",
    quantity: "0.2",
    cost: "20",
    realized: "0",
    fees: "0",
    funding: "0",
  };
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("k".repeat(32)),
  );
  await repo.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  await new AgentRunner(api).tick("alice");
  assert.equal(adapter.submitCount, 1);
  await repo.transact("alice", async (state) => {
    const portfolio = state.portfolios[0];
    assert.equal(portfolio.executions[0].target_quantity, "0");
    assert.equal(portfolio.executions[0].reserve_usdc, "0.000000");
    assert.equal(
      portfolio.executions[0].allocations[portfolio.sleeves[0].copy_id],
      "-0.2",
    );
    assert.equal(portfolio.sleeves[0].intents[key].quantity, "0");
    assert.ok(
      portfolio.decisions?.some((d) => d.reason === "BELOW_MINIMUM_NOTIONAL"),
    );
  });
});

it("checks net exchange orders after combining sub-minimum sleeves", async () => {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = [candidate(1), candidate(3), candidate(2)].map((c) => ({
    ...c,
    direction: "long" as const,
  }));
  adapter.snap.account_value_usdc = adapter.snap.available_usdc = "20";
  adapter.source = async (c) => {
    const asset = c.assets[0],
      key = `perps:${asset}`;
    return {
      observed_at: now(),
      revision: "source_v1",
      account_value_usdc: "1000",
      complete: true,
      positions: [
        {
          key,
          asset,
          market: "perps",
          quantity: asset === "BTC" ? "9" : "12",
          price: "100",
          source_entry_price: "100",
          source_leverage: 3,
          observed_at: now(),
          source_revision: "source_v1",
        },
      ],
    };
  };
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("k".repeat(32)),
  );
  await repo.transact("alice", async (state) => {
    state.portfolios.push(
      fromPlan(
        recommend(
          { ...preferences, portfolio_kind: "basket", basket_size: 3 },
          adapter.pool,
        ),
      ),
    );
  });
  await new AgentRunner(api).tick("alice");
  assert.equal(adapter.submitCount, 1);
  await repo.transact("alice", async (state) => {
    const p = state.portfolios[0];
    assert.equal(p.executions[0].key, key);
    assert.ok(D(p.executions[0].target_quantity).times(100).gte(10));
    assert.ok(
      p.sleeves
        .filter((s) => s.intents[key])
        .every((s) => D(s.intents[key].quantity).times(100).lt(10)),
    );
    assert.ok(
      state.updates.some(
        (u) =>
          u.kind === "BELOW_MINIMUM_NOTIONAL" && u.data.key === "perps:ETH",
      ),
    );
  });
});

for (const [price, expected] of [
  ["100", true],
  ["99.99", false],
] as const)
  it(`bridge revalidates the live order minimum immediately before submission at ${price}`, async () => {
    const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "testnet",
    );
    const stub = bridge as any;
    let outbox: any = null,
      submissions = 0;
    stub.pool.query = async (sql: string, values: any[]) => {
      if (sql.startsWith("SELECT"))
        return { rowCount: outbox ? 1 : 0, rows: outbox ? [outbox] : [] };
      if (sql.startsWith("INSERT"))
        outbox = { fingerprint: values[3], payload: values[4], response: null };
      if (sql.startsWith("UPDATE")) outbox.response = values[1];
      return { rowCount: 1, rows: [] };
    };
    const snap = snapshot();
    snap.account_value_usdc = snap.available_usdc = "20";
    snap.prices[key] = price;
    stub.perpsAccount = async () => snap;
    stub.core = async (operation: string) => {
      if (operation === "perps_submit") {
        submissions++;
        return { task_id: "test_task" };
      }
      return { policy_revision: 1 };
    };
    stub.source = async () => ({
      revision: "source_v1",
      observed_at: now(),
      account_value_usdc: "1000",
      complete: true,
      positions: [
        { ...p.sleeves[0].intents[key], quantity: "5", observed_at: now() },
      ],
    });
    const p = fromPlan(recommend(preferences, [candidate(1)]));
    p.account_id = snap.account_id;
    p.sleeves[0].source_revision = "source_v1";
    p.sleeves[0].intents[key] = {
      key,
      asset: "BTC",
      market: "perps",
      quantity: "0.1",
      price: "100",
      source_entry_price: "100",
      source_leverage: 3,
      observed_at: now(),
      source_revision: "source_v1",
    };
    const execution: Execution = {
      id: "execution_test",
      key,
      target_quantity: "0.1",
      allocations: {},
      status: "queued",
      revision: 0,
      fingerprint: "test_fingerprint",
      created_at: now(),
      expires_at: now() + 60000,
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "4",
      error: null,
    };
    try {
      if (expected) {
        assert.deepEqual(await bridge.submit("alice", p, execution), {
          task_id: "test_task",
        });
        assert.equal(outbox.payload.target_quantity, "0.1");
        await bridge.submit("alice", p, execution);
        assert.equal(submissions, 1);
      } else {
        await assert.rejects(
          bridge.submit("alice", p, execution),
          /BELOW_MINIMUM_NOTIONAL/,
        );
        assert.equal(submissions, 0);
        assert.equal(outbox, null);
      }
    } finally {
      await bridge.close();
    }
  });
