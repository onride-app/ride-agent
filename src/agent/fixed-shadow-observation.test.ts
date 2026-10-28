import assert from "node:assert/strict";
import { it } from "node:test";
import { candidate, FakeAdapter } from "./fixtures.js";
import { now, recommend, type Execution } from "./domain.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan, portfolioView } from "./service.js";
import { Cursor, MemoryRepository } from "./repository.js";

const key = "perps:SOL";
const preferences = {
  budget_usdc: "60",
  market: "perps" as const,
  assets: [],
  allow_altcoins: true,
  loss_trigger_pct: 10,
  risk_tolerance: "medium" as const,
  portfolio_kind: "basket" as const,
  basket_size: 3,
};

async function fixture(eligibleOtherSources = false) {
  const adapter = new FakeAdapter();
  adapter.pool = [
    candidate(1),
    candidate(2),
    { ...candidate(3), assets: ["SOL"], direction: "long" as const },
  ];
  const p = fromPlan(recommend(preferences, adapter.pool));
  p.account_id = adapter.snap.account_id;
  p.initial_equity = "500";
  p.ledger_started_at = now() - 10_000;
  p.state = "active";
  p.reconciliation = "complete";
  for (const s of p.sleeves) {
    s.initialized = true;
    s.reviewed_at = now();
    s.source_revision = "previous_source";
    s.suppressed =
      eligibleOtherSources && s !== p.sleeves[2]
        ? []
        : [`perps:${s.trader.assets[0]}`];
  }
  const fixed = p.sleeves[2];
  fixed.copy_mode = "fixed";
  fixed.fixed_margin_usdc = "2";
  fixed.fixed_last_fill_at = now() - 1000;
  fixed.fixed_targets = { [key]: "0.25" };
  fixed.source_quantities = { [key]: "12" };
  fixed.fixed_seen_fills = ["previously_verified_fill_id"];
  const originalSource = adapter.source.bind(adapter);
  adapter.source = async (trader) =>
    trader.id === fixed.trader.id
      ? {
          observed_at: now(),
          revision: "verified_source_flat",
          account_value_usdc: "0",
          complete: true,
          positions: [],
        }
      : originalSource(trader);
  adapter.sourceFills = async () => ({ complete: true, fills: [] });
  const repo = new MemoryRepository();
  const service = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  return {
    adapter,
    p,
    fixed,
    repo,
    service,
    async run() {
      await repo.transact("fixture-user", async (state) => {
        state.portfolios.push(structuredClone(p));
      });
      await new AgentRunner(service).tick("fixture-user");
      return repo.transact("fixture-user", async (state) =>
        structuredClone(state.portfolios[0]),
      );
    },
  };
}

it("retires a never-admitted suppressed fixed shadow on verified flat evidence without inventing a follower close or chasing other suppressed entries", async () => {
  const f = await fixture(),
    before = structuredClone(f.p);
  const saved = await f.run();
  assert.equal(saved.state, "active");
  assert.equal(saved.last_error, undefined);
  assert.equal(saved.sleeves[2].fixed_targets?.[key], "0");
  assert.equal(saved.sleeves[2].source_quantities?.[key], "0");
  assert.ok(
    saved.sleeves[2].fixed_last_fill_at! >
      before.sleeves[2].fixed_last_fill_at!,
  );
  assert.deepEqual(
    saved.sleeves[2].fixed_seen_fills,
    before.sleeves[2].fixed_seen_fills,
  );
  assert.deepEqual(saved.sleeves[0].suppressed, before.sleeves[0].suppressed);
  assert.deepEqual(saved.sleeves[1].suppressed, before.sleeves[1].suppressed);
  assert.deepEqual(saved.preferences, before.preferences);
  assert.deepEqual(
    saved.sleeves.map((s) => s.amount_usdc),
    before.sleeves.map((s) => s.amount_usdc),
  );
  assert.ok(
    saved.sleeves.every(
      (s) =>
        Object.keys(s.intents).length === 0 && Object.keys(s.lots).length === 0,
    ),
  );
  assert.equal(saved.executions.length, 0);
  assert.equal(saved.receipts?.length ?? 0, 0);
  assert.equal(f.adapter.submitCount, 0);
  assert.equal((portfolioView(saved).data.portfolio as any).operational, true);
});

it("allows independently verified future targets in the same basket to proceed after retiring only the unowned shadow", async () => {
  const f = await fixture(true);
  const saved = await f.run();
  assert.equal(saved.last_error, undefined);
  assert.equal(saved.target_blocker, undefined);
  assert.equal(saved.executions.length, 2);
  assert.deepEqual(saved.executions.map((e) => e.key).sort(), [
    "perps:BTC",
    "perps:ETH",
  ]);
  assert.equal(f.adapter.submitCount, 2);
  assert.ok(
    saved.executions.every(
      (e) => !Object.hasOwn(e.allocations, f.fixed.copy_id),
    ),
  );
  assert.equal(saved.sleeves[2].fixed_targets?.[key], "0");
  assert.equal(saved.receipts?.length ?? 0, 0);
});

it("still applies basket concentration limits when a shadow can otherwise be retired", async () => {
  const f = await fixture();
  f.p.sleeves[0].suppressed = [];
  const saved = await f.run();
  assert.equal(saved.target_blocker?.code, "ASSET_CONCENTRATION");
  assert.equal(saved.executions.length, 0);
  assert.equal(f.adapter.submitCount, 0);
});

for (const issue of [
  "zero historic lot",
  "zero intent",
  "historic receipt",
  "completed allocation",
  "consumed zero allocation",
  "unfilled allocation",
  "uncertain allocation",
  "previous admitted decision",
  "not suppressed",
])
  it(`requires verified closing fills instead of clearing a disappeared fixed target with ${issue}`, async () => {
    const f = await fixture(),
      s = f.fixed;
    if (issue === "zero historic lot")
      s.lots[key] = {
        key,
        asset: "SOL",
        market: "perps",
        quantity: "0",
        cost: "0",
        realized: "1",
        fees: "0",
        funding: "0",
      };
    if (issue === "zero intent")
      s.intents[key] = {
        key,
        asset: "SOL",
        market: "perps",
        quantity: "0",
        price: "100",
        source_entry_price: "100",
        source_leverage: 5,
        source_revision: s.source_revision!,
        observed_at: now(),
      };
    if (issue === "historic receipt")
      f.p.receipts = [
        {
          copy_id: s.copy_id,
          quantity: "0.1",
          fee_usdc: "0",
          realized_usdc: "0",
          config: null,
          fill: {
            id: "historic_fill",
            key,
            task_id: "historic_task",
            order_id: "historic_order",
            quantity: "0.1",
            price: "100",
            fee_usdc: "0",
            at: now() - 2000,
          },
        },
      ];
    if (
      [
        "completed allocation",
        "consumed zero allocation",
        "unfilled allocation",
        "uncertain allocation",
      ].includes(issue)
    ) {
      const e: Execution = {
        id: "execution_history",
        key,
        target_quantity: "0.1",
        allocations: {
          [s.copy_id]: issue === "consumed zero allocation" ? "0" : "0.1",
        },
        status: issue === "uncertain allocation" ? "uncertain" : "completed",
        revision: 0,
        fingerprint: "fixed_fingerprint",
        created_at: now() - 2000,
        expires_at: now() + 1000,
        task_id: null,
        observed_quantity: null,
        reserve_usdc: "2",
        error: null,
      };
      if (issue === "unfilled allocation") {
        e.unfilled_allocations = e.allocations;
        e.allocations = {};
      }
      f.p.executions = [e];
    }
    if (issue === "previous admitted decision")
      f.p.decisions = [
        {
          at: now() - 2000,
          copy_id: s.copy_id,
          key,
          source_revision: "old",
          source_quantity: "12",
          target_quantity: "0",
          source_entry_price: "100",
          follower_mark: "100",
          reason: "TARGET_EVALUATED",
          config: {} as any,
        },
      ];
    if (issue === "not suppressed") s.suppressed = [];
    const before = structuredClone(s);
    const saved = await f.run();
    assert.equal(saved.state, "attention");
    assert.equal(saved.last_error?.code, "SOURCE_FILL_EVIDENCE_MISSING");
    assert.deepEqual(saved.sleeves[2].fixed_targets, before.fixed_targets);
    assert.deepEqual(
      saved.sleeves[2].source_quantities,
      before.source_quantities,
    );
    assert.equal(
      saved.sleeves[2].fixed_last_fill_at,
      before.fixed_last_fill_at,
    );
    assert.deepEqual(saved.sleeves[2].suppressed, before.suppressed);
    assert.equal(f.adapter.submitCount, 0);
  });

for (const issue of [
  "incomplete fill coverage",
  "stale source",
  "incomplete source",
])
  it(`does not retire a never-admitted shadow with ${issue}`, async () => {
    const f = await fixture(),
      before = structuredClone(f.fixed);
    if (issue === "incomplete fill coverage")
      f.adapter.sourceFills = async () => ({ complete: false, fills: [] });
    else {
      const read = f.adapter.source.bind(f.adapter);
      f.adapter.source = async (trader) => {
        const s = await read(trader);
        if (trader.id === f.fixed.trader.id) {
          if (issue === "stale source") s.observed_at -= 45_000;
          else s.complete = false;
        }
        return s;
      };
    }
    const saved = await f.run();
    assert.equal(saved.state, "attention");
    assert.deepEqual(saved.sleeves[2].fixed_targets, before.fixed_targets);
    assert.deepEqual(
      saved.sleeves[2].source_quantities,
      before.source_quantities,
    );
    assert.equal(
      saved.sleeves[2].fixed_last_fill_at,
      before.fixed_last_fill_at,
    );
    assert.equal(f.adapter.submitCount, 0);
  });

it("keeps suppression and the shadow target while the source position still exists", async () => {
  const f = await fixture(),
    before = structuredClone(f.fixed);
  const original = f.adapter.source.bind(f.adapter);
  f.adapter.source = async (trader) =>
    trader.id !== f.fixed.trader.id
      ? original(trader)
      : {
          observed_at: now(),
          revision: "still_open",
          account_value_usdc: "1000",
          complete: true,
          positions: [
            {
              key,
              asset: "SOL",
              market: "perps",
              quantity: "12",
              price: "100",
              source_entry_price: "90",
              source_leverage: 5,
              observed_at: now(),
              source_revision: "still_open",
            },
          ],
        };
  f.adapter.snap.prices[key] = "100";
  f.adapter.snap.max_leverages[key] = 8;
  const saved = await f.run();
  assert.equal(saved.last_error, undefined);
  assert.deepEqual(saved.sleeves[2].fixed_targets, before.fixed_targets);
  assert.deepEqual(
    saved.sleeves[2].source_quantities,
    before.source_quantities,
  );
  assert.deepEqual(saved.sleeves[2].suppressed, before.suppressed);
  assert.equal(f.adapter.submitCount, 0);
});
