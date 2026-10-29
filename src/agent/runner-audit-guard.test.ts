import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { recommend, type Portfolio } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository, type State } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

async function flush() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: TestContext, count = 1) {
  const at = 1793200000000;
  t.mock.method(Date, "now", () => at);
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  const p = fromPlan(
    recommend(
      {
        budget_usdc: count === 1 ? "20" : "100",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 90,
        risk_tolerance: "medium",
        portfolio_kind: count === 1 ? "single" : "basket",
        basket_size: count,
      },
      Array.from({ length: count }, (_, i) => candidate(i + 1)),
    ),
  );
  p.account_id = adapter.snap.account_id;
  p.venue_accounts = { perps: p.account_id };
  p.state = "active";
  p.initial_equity = "500";
  p.ledger_started_at = at - 60000;
  p.snapshot = { ...snapshot(), observed_at: at - 1000 };
  p.reconciliation = "complete";
  await repository.transact("alice", async (state) => {
    state.portfolios.push(p);
  });
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  return { at, repository, adapter, runner, p };
}

for (const changed of [
  "preferences",
  "same-timestamp snapshot",
  "source cursor and target",
] as const)
  it(`skips source planning after an external ${changed} edit between audit and planning without a revision increment`, async (t) => {
    const f = await fixture(t);
    const transact = f.repository.transact.bind(f.repository);
    let transactions = 0,
      external!: Portfolio,
      profiles = 0;
    f.adapter.profile = async () => {
      profiles++;
      return candidate(1);
    };
    f.repository.transact = async (user, work) => {
      const transaction = ++transactions;
      const result = await transact(user, work);
      if (transaction === 1) {
        await transact(user, async (state) => {
          const p = state.portfolios[0];
          const before = {
            revision: p.revision,
            control_id: p.control_id,
            account_id: p.account_id,
            observed_at: p.snapshot?.observed_at,
          };
          if (changed === "preferences") p.preferences.loss_trigger_pct = 85;
          if (changed === "same-timestamp snapshot")
            p.snapshot!.account_value_usdc = "501";
          if (changed === "source cursor and target") {
            p.sleeves[0].source_revision = "external_source_revision";
            p.sleeves[0].fixed_last_fill_at = f.at - 100;
            p.sleeves[0].intents["perps:BTC"] = {
              key: "perps:BTC",
              asset: "BTC",
              market: "perps",
              quantity: "0.07",
              price: "100",
              source_entry_price: "100",
              source_leverage: 5,
              observed_at: f.at,
              source_revision: "external_source_revision",
            };
          }
          assert.deepEqual(
            {
              revision: p.revision,
              control_id: p.control_id,
              account_id: p.account_id,
              observed_at: p.snapshot?.observed_at,
            },
            before,
            "the older four-field guard would not detect this edit",
          );
          external = structuredClone(p);
        });
      }
      return result;
    };
    await f.runner.tick("alice");
    assert.ok(
      transactions >= 3,
      "audit, source planning and durable work remain separate transactions",
    );
    const saved = (await f.repository.read("alice")).portfolios[0];
    assert.deepEqual(
      saved,
      external,
      "planning must not overwrite the newly locked current portfolio",
    );
    assert.equal(
      profiles,
      0,
      "an invalidated audit cannot proceed into public source planning",
    );
    assert.equal(saved.executions.length, 0);
    assert.equal(f.adapter.submitCount, 0);
  });

it("publishes audited account evidence and every sleeve's loss controls before an earlier sleeve's source finishes", async (t) => {
  const f = await fixture(t, 2),
    blocked = deferred<Awaited<ReturnType<FakeAdapter["source"]>>>();
  const first = f.p.sleeves[0],
    later = f.p.sleeves[1];
  const key = `perps:${later.trader.assets[0]}`;
  const source = f.adapter.source.bind(f.adapter),
    controls: string[] = [];
  f.adapter.snap.account_value_usdc = "490";
  f.adapter.snap.positions = { [key]: "1" };
  await f.repository.transact("alice", async (state) => {
    const p = state.portfolios[0],
      sleeve = p.sleeves[1];
    sleeve.stop_loss_pct = 10;
    sleeve.loss_policy = "exit";
    sleeve.initialized = true;
    sleeve.lots[key] = {
      key,
      asset: sleeve.trader.assets[0],
      market: "perps",
      quantity: "1",
      cost: "110",
      realized: "0",
      fees: "0",
      funding: "0",
    };
    sleeve.intents[key] = {
      key,
      asset: sleeve.trader.assets[0],
      market: "perps",
      quantity: "1",
      price: "100",
      source_entry_price: "110",
      source_leverage: 5,
      observed_at: f.at,
      source_revision: "owned_prior_source",
    };
  });
  f.adapter.source = async (trader) =>
    trader.id === first.trader.id ? blocked.promise : source(trader);
  f.adapter.fence = async () => {
    controls.push("fence");
  };
  f.adapter.cancelIncreasing = async () => {
    controls.push("cancel");
  };
  const transact = f.repository.transact.bind(f.repository);
  let transactions = 0,
    auditedState: State | undefined;
  f.repository.transact = async (user, callback) => {
    const transaction = ++transactions;
    const result = await transact(user, callback);
    if (transaction === 1) auditedState = await f.repository.read(user);
    return result;
  };
  let completed = false;
  const work = f.runner.tick("alice").then(() => {
    completed = true;
  });
  try {
    await flush();
    assert.equal(
      completed,
      false,
      "the planner still waits for complete source evidence",
    );
    assert.ok(
      auditedState,
      "the first phase must have committed before the planner starts waiting",
    );
    const state = auditedState,
      p = state.portfolios[0];
    assert.equal(
      p.snapshot?.observed_at,
      f.at,
      "the audit must already be committed while planning waits",
    );
    assert.equal(p.snapshot?.account_value_usdc, "490");
    assert.equal(p.reconciliation, "complete");
    assert.equal(p.audit_verified_at, f.at);
    assert.equal(
      Boolean(p.loss_latched),
      false,
      "this scenario triggers only the later sleeve's threshold",
    );
    assert.equal(p.sleeves[1].state, "loss_triggered");
    assert.equal(p.sleeves[1].intents[key].quantity, "0");
    assert.deepEqual(controls, ["fence", "cancel"]);
    assert.ok(
      state.performance?.some(
        (point) =>
          point.portfolio_id === p.id && point.net_profit_usdc === "-10.000000",
      ),
    );
    assert.equal(f.adapter.submitCount, 0);
  } finally {
    blocked.resolve(await source(first.trader));
    await work;
  }
});
