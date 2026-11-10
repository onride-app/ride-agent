import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type { VenueAdapter } from "./adapter.js";
import { CoreBridge } from "./core_bridge.js";
import {
  fingerprint,
  now,
  recommend,
  type Candidate,
  type Execution,
  type Portfolio,
} from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const USER = "blocked_source_fixture",
  BASE = 1793200000000;
const assets = ["BTC", "ETH", "SOL"];

class Adapter extends FakeAdapter {
  changed = true;
  strictSourceGuard = false;
  attempted: Execution[] = [];
  guardFailures = 0;
  financialCalls = 0;
  reconciled = 0;
  cancelled = 0;
  readonly bridge: CoreBridge;
  constructor() {
    super();
    this.pool = assets.map((asset, i) => ({
      ...candidate(i + 1),
      assets: [asset],
      direction: "long" as const,
    }));
    for (const asset of assets) {
      const key = `perps:${asset}`;
      this.snap.prices[key] = "100";
      this.snap.max_leverages[key] = 8;
      this.snap.min_notionals[key] = "10";
      this.snap.quantity_decimals![key] = 8;
    }
    const bridge = Object.create(CoreBridge.prototype) as any;
    bridge.pool = {
      query: async (sql: string) => {
        assert.ok(sql.startsWith("SELECT fingerprint,payload,response"));
        return { rowCount: 0, rows: [] };
      },
    };
    bridge.perpsAccount = () => this.account();
    bridge.source = (id: string) =>
      this.source(this.pool.find((c) => c.id === id)!);
    bridge.core = async () => {
      this.financialCalls++;
      assert.fail("Source rejection must precede every financial Core call");
    };
    this.bridge = bridge;
  }
  async source(trader: Candidate) {
    const asset = this.changed ? "BTC" : trader.assets[0];
    const revision = this.changed ? "source-new" : "source-old";
    return {
      observed_at: now(),
      revision,
      account_value_usdc: "1000",
      complete: true,
      positions: [
        {
          key: `perps:${asset}`,
          asset,
          market: "perps" as const,
          quantity: "5",
          price: "100",
          source_entry_price: "100",
          source_leverage: 5,
          source_leverage_verified: true,
          observed_at: now(),
          source_revision: revision,
        },
      ],
    };
  }
  async submit(user?: string, p?: Portfolio, e?: Execution) {
    assert.ok(p && e);
    this.attempted.push(structuredClone(e));
    if (this.strictSourceGuard) {
      try {
        return await this.bridge.submit(user!, p, e);
      } catch (error) {
        if (
          (error as Error).message ===
          "Fresh equivalent source-position evidence is required before increasing exposure."
        )
          this.guardFailures++;
        throw error;
      }
    }
    return super.submit();
  }
  async execution(): ReturnType<VenueAdapter["execution"]> {
    this.reconciled++;
    return { status: "uncertain", observed_quantity: null, settled: false };
  }
  async cancelIncreasing() {
    this.cancelled++;
  }
}

async function fixture(t: TestContext) {
  t.mock.method(Date, "now", () => BASE);
  const adapter = new Adapter(),
    repository = new MemoryRepository();
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "100",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "basket",
        basket_size: 3,
      },
      adapter.pool,
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.initial_equity = "500";
  p.ledger_started_at = now() - 60000;
  p.state = "active";
  p.reconciliation = "complete";
  for (const [i, sleeve] of p.sleeves.entries()) {
    const asset = assets[i],
      key = `perps:${asset}`;
    sleeve.initialized = true;
    sleeve.reviewed_at = now();
    sleeve.source_revision = "source-old";
    sleeve.intents = {
      [key]: {
        key,
        asset,
        market: "perps",
        quantity: "0.1",
        price: "100",
        source_entry_price: "100",
        source_leverage: 5,
        source_leverage_verified: true,
        observed_at: now() - 1000,
        source_revision: "source-old",
        raw_source_quantity: "5",
      } as any,
    };
  }
  await repository.transact(USER, async (state) => {
    state.portfolios.push(p);
  });
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://fixture.invalid",
      new Cursor("s".repeat(32)),
    ),
  );
  t.after(() => runner.closeNotifications());
  const read = async () => (await repository.read(USER)).portfolios[0];
  const tick = async () => {
    await runner.tick(USER);
    await runner.notificationsIdle();
  };
  return { adapter, repository, runner, p, read, tick };
}

for (const prepared of [false, true])
  it(`does not create old-intent increases after rejecting a changed-source basket (${prepared ? "prepared" : "ordinary"})`, async (t) => {
    const f = await fixture(t),
      before = f.p.sleeves.map((s) => structuredClone(s.intents));
    f.adapter.strictSourceGuard = true;
    let preparations = 0;
    if (prepared) {
      const adapter: VenueAdapter = f.adapter;
      adapter.withPreparedPortfolio = async (_u, _p, work) => ({
        state: "complete",
        value: await work({
          mode: "warm",
          expires_at: now() + 20000,
          release: async () => {},
        }),
      });
      adapter.prepareExecution = async () => {
        preparations++;
        assert.fail(
          "Rejected source targets cannot claim an execution capability",
        );
      };
      await f.tick(); // discover/cache the routing projection, without an ID
    }
    await f.tick();
    const p = await f.read();
    assert.equal(p.target_blocker?.code, "ASSET_CONCENTRATION");
    assert.deepEqual(
      p.sleeves.map((s) => s.intents),
      before,
    );
    assert.ok(p.sleeves.every((s) => s.source_revision === "source-old"));
    assert.equal(p.executions.length, 0);
    assert.equal(preparations, 0);
    assert.equal(f.adapter.attempted.length, 0);
    assert.equal(f.adapter.guardFailures, 0);
    assert.equal(f.adapter.financialCalls, 0);
  });

it("keeps a valid owned reduction while rejecting new increases from the same old source intents", async (t) => {
  const f = await fixture(t);
  await f.repository.transact(USER, async (state) => {
    const p = state.portfolios[0];
    for (const [i, sleeve] of p.sleeves.entries()) {
      const asset = assets[i],
        key = `perps:${asset}`,
        quantity = i === 0 ? "0.2" : "0.1";
      sleeve.lots[key] = {
        key,
        asset,
        market: "perps",
        quantity,
        cost: String(Number(quantity) * 100),
        realized: "0",
        fees: "0",
        funding: "0",
      };
      f.adapter.snap.positions[key] = quantity;
    }
  });
  await f.tick();
  const p = await f.read();
  assert.equal(p.target_blocker?.code, "ASSET_CONCENTRATION");
  assert.equal(f.adapter.attempted.length, 1);
  assert.equal(f.adapter.attempted[0].key, "perps:BTC");
  assert.equal(f.adapter.attempted[0].target_quantity, "0.1");
  assert.equal(p.executions[0].status, "submitted");
});

for (const net of ["same", "increase", "reduction"] as const)
  it(`does not cross stale sleeve ownership when the retained net target is a ${net}`, async (t) => {
    const f = await fixture(t);
    await f.repository.transact(USER, async (state) => {
      const p = state.portfolios[0];
      for (const [i, sleeve] of p.sleeves.entries()) {
        const asset = assets[i],
          key = `perps:${asset}`;
        const quantity =
          i === 0 ? (net === "reduction" ? "0.3" : "0.2") : "0.1";
        sleeve.lots[key] = {
          key,
          asset,
          market: "perps",
          quantity,
          cost: i === 0 ? (net === "reduction" ? "28" : "18") : "10",
          realized: "0",
          fees: "0",
          funding: "0",
        };
        f.adapter.snap.positions[key] = quantity;
      }
      p.sleeves[1].intents["perps:BTC"] = {
        ...p.sleeves[0].intents["perps:BTC"],
        quantity: net === "increase" ? "0.2" : "0.1",
      };
    });
    f.adapter.snap.account_value_usdc = "502";
    const before = await f.read();
    const checkpoints = (await f.repository.read(USER)).checkpoints;
    await f.tick();
    const after = await f.read();
    assert.equal(after.target_blocker?.code, "ASSET_CONCENTRATION");
    assert.deepEqual(
      after.sleeves.map((s) => s.lots),
      before.sleeves.map((s) => s.lots),
    );
    assert.deepEqual(
      after.sleeves.map((s) => s.intents),
      before.sleeves.map((s) => s.intents),
    );
    assert.deepEqual((await f.repository.read(USER)).checkpoints, checkpoints);
    assert.equal(after.executions.length, 0);
    assert.equal(f.adapter.attempted.length, 0);
  });

it("retains the existing below-minimum flip-to-flat close without crossing old sleeve ownership", async (t) => {
  const f = await fixture(t);
  await f.repository.transact(USER, async (state) => {
    const p = state.portfolios[0];
    p.sleeves[0].intents["perps:BTC"].quantity = "-0.05";
    for (const [i, sleeve] of p.sleeves.entries()) {
      const asset = assets[i],
        key = `perps:${asset}`,
        quantity = i === 0 ? "0.2" : "0.1";
      sleeve.lots[key] = {
        key,
        asset,
        market: "perps",
        quantity,
        cost: i === 0 ? "20" : "10",
        realized: "0",
        fees: "0",
        funding: "0",
      };
      f.adapter.snap.positions[key] = quantity;
    }
  });
  const before = (await f.read()).sleeves.map((s) => structuredClone(s.lots));
  await f.tick();
  const p = await f.read();
  assert.equal(p.target_blocker?.code, "ASSET_CONCENTRATION");
  assert.equal(f.adapter.attempted.length, 1);
  assert.equal(f.adapter.attempted[0].key, "perps:BTC");
  assert.equal(f.adapter.attempted[0].target_quantity, "0");
  assert.deepEqual(f.adapter.attempted[0].allocations, {
    [p.sleeves[0].copy_id]: "-0.2",
  });
  assert.deepEqual(
    p.sleeves.map((s) => s.lots),
    before,
  );
});

it("retains loss fencing, cancellation and owned exits after a source basket is rejected", async (t) => {
  const f = await fixture(t);
  await f.repository.transact(USER, async (state) => {
    const p = state.portfolios[0];
    for (const [i, sleeve] of p.sleeves.entries()) {
      const asset = assets[i],
        key = `perps:${asset}`;
      sleeve.lots[key] = {
        key,
        asset,
        market: "perps",
        quantity: "0.2",
        cost: "30",
        realized: "0",
        fees: "0",
        funding: "0",
      };
      f.adapter.snap.positions[key] = "0.2";
    }
  });
  f.adapter.snap.account_value_usdc = "470";
  await f.tick();
  const p = await f.read();
  assert.equal(p.loss_latched, true);
  assert.ok(f.adapter.fences > 0);
  assert.ok(f.adapter.cancelled > 0);
  assert.equal(f.adapter.attempted.length, 3);
  assert.ok(f.adapter.attempted.every((e) => e.target_quantity === "0"));
});

it("preserves existing unknown original-ID reconciliation while deferring stale new increases", async (t) => {
  const f = await fixture(t);
  const frozen = {
    id: "existing_original",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: f.p.revision,
    created_at: now() - 30000,
    expires_at: now() + 30000,
  };
  const original: Execution = {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "uncertain",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  };
  await f.repository.transact(USER, async (state) => {
    state.portfolios[0].executions.push(structuredClone(original));
  });
  await f.tick();
  assert.equal(f.adapter.reconciled, 1);
  assert.deepEqual((await f.read()).executions, [original]);
  assert.equal(f.adapter.attempted.length, 0);
});

it("still creates normal fresh targets when the source is unchanged and the existing basket is safe", async (t) => {
  const f = await fixture(t);
  f.adapter.changed = false;
  await f.tick();
  const p = await f.read();
  assert.equal(p.target_blocker, undefined);
  assert.equal(f.adapter.attempted.length, 3);
  assert.ok(p.executions.every((e) => e.status === "submitted"));
});
