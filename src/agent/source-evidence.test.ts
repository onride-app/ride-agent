import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { D, recommend, type Portfolio } from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan, portfolioView } from "./service.js";
import { SourceFeed } from "./source-feed.js";

type FixtureSource = Awaited<ReturnType<FakeAdapter["source"]>>;

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
const flatSource = (): FixtureSource => ({
  observed_at: Date.now(),
  revision: "source_flat_zero",
  account_value_usdc: "0.0",
  positions: [],
  complete: true,
});
const intent = (quantity = "0.2") => ({
  key: "perps:BTC",
  asset: "BTC",
  market: "perps" as const,
  quantity,
  price: "100",
  source_entry_price: "100",
  source_leverage: 3,
  observed_at: Date.now() - 500,
  source_revision: "source_previous",
});

function ownedPosition(quantity = "0.2") {
  const adapter = new FakeAdapter();
  adapter.pool = [candidate(1)];
  const p = fromPlan(recommend(preferences, adapter.pool));
  p.account_id = adapter.snap.account_id;
  p.initial_equity = "500";
  p.ledger_started_at = Date.now() - 1000;
  p.state = "active";
  p.reconciliation = "complete";
  const sleeve = p.sleeves[0];
  sleeve.initialized = true;
  sleeve.reviewed_at = Date.now();
  sleeve.last_source_at = Date.now() - 500;
  sleeve.source_revision = "source_previous";
  sleeve.intents["perps:BTC"] = intent(quantity);
  sleeve.lots["perps:BTC"] = {
    key: "perps:BTC",
    asset: "BTC",
    market: "perps",
    quantity,
    cost: D(quantity).times(100).toString(),
    realized: "0",
    fees: "0",
    funding: "0",
  };
  adapter.snap.positions["perps:BTC"] = quantity;
  return { adapter, p };
}

async function runFixture(adapter: FakeAdapter, p: Portfolio) {
  const repo = new MemoryRepository();
  await repo.transact("fixture-user", async (state) => {
    state.portfolios.push(p);
  });
  const service = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  await new AgentRunner(service).tick("fixture-user");
  return repo.transact("fixture-user", async (state) =>
    structuredClone(state.portfolios[0]),
  );
}

it("initializes a verified zero-equity empty source alongside two healthy sources without changing the three allocations", async () => {
  const adapter = new FakeAdapter();
  adapter.pool = [1, 2, 3].map(candidate);
  const originalSource = adapter.source.bind(adapter);
  adapter.source = async (trader) => {
    if (trader.id === adapter.pool[2].id) return flatSource();
    const source = await originalSource(trader);
    // Existing positions beyond the 0.2% entry limit stay suppressed. Making
    // the flat source observable must not force an entry for the other slots.
    for (const position of source.positions)
      position.source_entry_price = "101";
    return source;
  };
  const p = fromPlan(
    recommend(
      {
        ...preferences,
        budget_usdc: "43",
        portfolio_kind: "basket",
        basket_size: 3,
      },
      adapter.pool,
    ),
  );
  const original = {
    preferences: structuredClone(p.preferences),
    traders: p.sleeves.map((s) => s.trader.id),
    amounts: p.sleeves.map((s) => s.amount_usdc),
  };
  const observed = await runFixture(adapter, p);
  assert.equal(observed.state, "active");
  assert.equal(observed.last_error, undefined);
  assert.equal(observed.sleeves.length, 3);
  assert.ok(observed.sleeves.every((s) => s.initialized));
  assert.ok(observed.sleeves.every((s) => s.last_source_at != null));
  assert.equal(
    (portfolioView(observed).data.portfolio as any).operational,
    true,
  );
  assert.deepEqual(observed.preferences, original.preferences);
  assert.deepEqual(
    observed.sleeves.map((s) => s.trader.id),
    original.traders,
  );
  assert.deepEqual(
    observed.sleeves.map((s) => s.amount_usdc),
    original.amounts,
  );
  assert.equal(adapter.submitCount, 0);
});

it("uses a verified zero-equity empty source only to reduce existing attributed long or short positions", async () => {
  for (const quantity of ["0.2", "-0.2"]) {
    const { adapter, p } = ownedPosition(quantity);
    adapter.source = async () => flatSource();
    const originalAmount = p.sleeves[0].amount_usdc;
    const observed = await runFixture(adapter, p);
    assert.equal(observed.last_error, undefined);
    assert.equal(observed.sleeves[0].intents["perps:BTC"].quantity, "0");
    assert.equal(observed.sleeves[0].amount_usdc, originalAmount);
    assert.equal(observed.executions.length, 1);
    assert.equal(adapter.submitCount, 1);
    const execution = observed.executions[0];
    assert.equal(execution.key, "perps:BTC");
    assert.equal(execution.target_quantity, "0");
    assert.equal(execution.reserve_usdc, "0.000000");
    assert.equal(
      execution.allocations[observed.sleeves[0].copy_id],
      D(quantity).negated().toString(),
    );
    // A queued close is not a verified fill; ownership remains until receipts.
    assert.equal(observed.sleeves[0].lots["perps:BTC"].quantity, quantity);
  }
});

it("preserves existing targets and timestamps for invalid zero, negative, malformed, stale or incomplete source evidence", async () => {
  const cases: { name: string; patch: Partial<FixtureSource> }[] = [
    { name: "zero with a live position", patch: { positions: [intent("1")] } },
    { name: "zero with a zero-size row", patch: { positions: [intent("0")] } },
    { name: "negative equity", patch: { account_value_usdc: "-1" } },
    { name: "not-a-number equity", patch: { account_value_usdc: "NaN" } },
    { name: "infinite equity", patch: { account_value_usdc: "Infinity" } },
    { name: "malformed equity", patch: { account_value_usdc: "unknown" } },
    { name: "missing equity", patch: { account_value_usdc: undefined } },
    { name: "missing position coverage", patch: { positions: undefined } },
    {
      name: "stale observation",
      patch: { account_value_usdc: "1000", observed_at: Date.now() - 50_000 },
    },
    { name: "incomplete coverage", patch: { complete: false } },
  ];
  for (const { name, patch } of cases) {
    const { adapter, p } = ownedPosition();
    adapter.source = async () =>
      ({ ...flatSource(), ...patch }) as FixtureSource;
    const before = structuredClone(p.sleeves[0]);
    const observed = await runFixture(adapter, p);
    assert.equal(observed.state, "attention", name);
    assert.equal(observed.last_error?.code, "SOURCE_STALE", name);
    assert.deepEqual(observed.sleeves[0].intents, before.intents, name);
    assert.equal(
      observed.sleeves[0].source_revision,
      before.source_revision,
      name,
    );
    assert.equal(
      observed.sleeves[0].last_source_at,
      before.last_source_at,
      name,
    );
    assert.equal(observed.sleeves[0].amount_usdc, before.amount_usdc, name);
    assert.equal(observed.executions.length, 0, name);
    assert.equal(adapter.submitCount, 0, name);
  }
});

it("records verified zero-equity flat observations even when follower account reads fail", async () => {
  const adapter = new FakeAdapter();
  adapter.pool = [candidate(1)];
  const p = fromPlan(recommend(preferences, adapter.pool));
  p.account_id = adapter.snap.account_id;
  adapter.source = async () => flatSource();
  adapter.account = async () => {
    throw new AgentError(
      "ACCOUNT_STALE",
      "Follower account unavailable.",
      true,
    );
  };
  const observed = await runFixture(adapter, p);
  assert.equal(observed.last_error?.code, "ACCOUNT_STALE");
  assert.ok(observed.sleeves[0].last_source_at != null);
  assert.equal(observed.sleeves[0].initialized, false);
  assert.equal(adapter.submitCount, 0);
});

it("source retry cooldown and later recovery never mark a failed follower account observation successful", async t => {
  let at = Date.now(), sourceCalls = 0, sourceFails = true;
  t.mock.method(Date, "now", () => at);
  const { adapter, p } = ownedPosition();
  p.snapshot = structuredClone(adapter.snap);
  p.audit_verified_at = at;
  const original = structuredClone(p);
  const sourceError = new AgentError("VENUE_READ_BUDGET_EXHAUSTED", "fixture", true, 503, { retry_after_ms: 60_000 });
  const feed = new SourceFeed(async () => {
    sourceCalls++;
    if (sourceFails) throw sourceError;
    return flatSource();
  }, { clock: () => at, timers: { setInterval: () => 1, clearInterval: () => {} } });
  adapter.source = async trader => (await feed.read(trader.id)) as FixtureSource;
  adapter.account = async () => { throw new AgentError("ACCOUNT_STALE", "fixture", true, 503); };
  try {
    let observed = await runFixture(adapter, p);
    assert.equal(sourceCalls, 1);
    at += 5000;
    observed = await runFixture(adapter, observed);
    assert.equal(sourceCalls, 1);
    sourceFails = false;
    at += 55_000;
    observed = await runFixture(adapter, observed);
    assert.equal(sourceCalls, 2);
    assert.equal((await feed.read(p.sleeves[0].trader.id)).observed_at, at);
    assert.equal(observed.state, "attention");
    assert.equal(observed.last_error?.code, "ACCOUNT_STALE");
    assert.deepEqual(observed.snapshot, original.snapshot);
    assert.equal(observed.audit_verified_at, original.audit_verified_at);
    assert.deepEqual(observed.executions, original.executions);
    assert.equal(adapter.submitCount, 0);
  } finally { feed.close(); }
});

it("keeps fixed-copy fill coverage required for an initialized zero-equity flat source", async () => {
  const { adapter, p } = ownedPosition();
  const sleeve = p.sleeves[0];
  sleeve.copy_mode = "fixed";
  sleeve.fixed_margin_usdc = "10";
  sleeve.fixed_last_fill_at = Date.now() - 1000;
  adapter.source = async () => flatSource();
  adapter.sourceFills = async () => ({ complete: false, fills: [] });
  const before = structuredClone(sleeve.intents);
  const observed = await runFixture(adapter, p);
  assert.equal(observed.last_error?.code, "SOURCE_FILL_EVIDENCE_MISSING");
  assert.deepEqual(observed.sleeves[0].intents, before);
  assert.equal(observed.executions.length, 0);
  assert.equal(adapter.submitCount, 0);
});

function fixedPosition() {
  const fixture = ownedPosition();
  const sleeve = fixture.p.sleeves[0];
  sleeve.copy_mode = "fixed";
  sleeve.fixed_margin_usdc = "10";
  sleeve.fixed_last_fill_at = Date.now() - 1000;
  sleeve.source_quantities = { "perps:BTC": "5" };
  sleeve.fixed_targets = { "perps:BTC": "0.2" };
  sleeve.fixed_seen_fills = [];
  return fixture;
}

it("keeps fixed targets and cursors when a disappeared position lacks verified closing fills, even with complete fill coverage", async () => {
  for (const equity of ["0", "1000"]) {
    for (const knownQuantity of [true, false]) {
      const { adapter, p } = fixedPosition();
      if (!knownQuantity) p.sleeves[0].source_quantities = undefined;
      adapter.source = async () => ({
        ...flatSource(),
        account_value_usdc: equity,
      });
      adapter.sourceFills = async () => ({ complete: true, fills: [] });
      const before = structuredClone(p.sleeves[0]);
      const observed = await runFixture(adapter, p);
      const sleeve = observed.sleeves[0];
      assert.equal(observed.last_error?.code, "SOURCE_FILL_EVIDENCE_MISSING");
      assert.deepEqual(sleeve.intents, before.intents);
      assert.deepEqual(sleeve.fixed_targets, before.fixed_targets);
      assert.deepEqual(sleeve.source_quantities, before.source_quantities);
      assert.deepEqual(sleeve.fixed_seen_fills, before.fixed_seen_fills);
      assert.equal(sleeve.fixed_last_fill_at, before.fixed_last_fill_at);
      assert.equal(observed.executions.length, 0);
      assert.equal(adapter.submitCount, 0);
    }
  }
});

it("allows a fixed-copy close only after verified fills explain the disappeared source position reaching zero", async () => {
  for (const equity of ["0", "1000"]) {
    const { adapter, p } = fixedPosition();
    const previousCursor = p.sleeves[0].fixed_last_fill_at!;
    adapter.source = async () => ({
      ...flatSource(),
      account_value_usdc: equity,
    });
    adapter.sourceFills = async () => ({
      complete: true,
      fills: [
        {
          id: "verified_source_close",
          key: "perps:BTC",
          quantity: "-5",
          start_quantity: "5",
          price: "100",
          fee_usdc: "0",
          realized_usdc: null,
          at: previousCursor + 1,
        },
      ],
    });
    const observed = await runFixture(adapter, p);
    const sleeve = observed.sleeves[0];
    assert.equal(observed.last_error, undefined);
    assert.equal(sleeve.intents["perps:BTC"].quantity, "0");
    assert.equal(sleeve.source_quantities?.["perps:BTC"], "0");
    assert.equal(sleeve.fixed_targets?.["perps:BTC"], "0");
    assert.deepEqual(sleeve.fixed_seen_fills, ["verified_source_close"]);
    assert.ok(sleeve.fixed_last_fill_at! > previousCursor);
    assert.equal(observed.executions.length, 1);
    assert.equal(observed.executions[0].target_quantity, "0");
    assert.equal(observed.executions[0].reserve_usdc, "0.000000");
    assert.equal(adapter.submitCount, 1);
  }
});

it("does not treat a fixed source position excluded by saved asset filters as a disappearance", async () => {
  const { adapter, p } = fixedPosition();
  p.preferences.assets = ["ETH"];
  adapter.source = async () => ({
    ...flatSource(),
    account_value_usdc: "1000",
    positions: [intent("5")],
  });
  adapter.sourceFills = async () => ({ complete: true, fills: [] });
  const observed = await runFixture(adapter, p);
  assert.equal(observed.last_error, undefined);
  assert.equal(observed.sleeves[0].intents["perps:BTC"].quantity, "0");
  assert.equal(observed.executions.length, 1);
  assert.equal(observed.executions[0].target_quantity, "0");
  assert.equal(adapter.submitCount, 1);
});
