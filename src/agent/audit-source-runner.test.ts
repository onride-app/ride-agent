import assert from "node:assert/strict";
import { AgentError } from "./contracts.js";
import { it, type TestContext } from "node:test";
import type {
  ExecutionProposal,
  PreparedPortfolioResult,
  PreparedPortfolioWindow,
} from "./adapter.js";
import {
  fingerprint,
  now,
  recommend,
  type Candidate,
  type Execution,
} from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import type { PreparedPortfolioInput } from "./prepared-portfolio.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const USER = "blocked_routing_fixture",
  BASE = 1793200000000;
const assets = ["BTC", "ETH", "SOL"];

class Adapter extends FakeAdapter {
  changed = true;
  pending = false;
  cleanupFails = false;
  windows = 0;
  readonlyWindows = 0;
  pairedWindows = 0;
  unsupportedReadonly = false;
  releaseFails = false;
  releaseFailure: unknown = new Error("fixture release unknown");
  mono = 0;
  activePurpose: "audit_source" | "audit_submit" = "audit_submit";
  prepares = 0;
  accounts = 0;
  sources = 0;
  reconciled = 0;
  cancelledRisk = 0;
  active = false;
  events: string[] = [];
  cancelled: PreparedPortfolioInput[] = [];
  proposals: ExecutionProposal[] = [];
  submitted: Execution[] = [];
  bound = new Map<string, string>();
  async withPreparedPortfolio<T>(
    _user: string,
    _p: PreparedPortfolioInput,
    work: (window: PreparedPortfolioWindow) => Promise<T>,
  ): Promise<PreparedPortfolioResult<T>> {
    this.windows++;
    const purpose = _p.purpose ?? "audit_submit";
    if (purpose === "audit_source") this.readonlyWindows++;
    else this.pairedWindows++;
    if (this.unsupportedReadonly && purpose === "audit_source")
      return { state: "unsupported" };
    if (this.pending) return { state: "pending", retry_after_ms: 1000 };
    this.active = true;
    this.activePurpose = purpose;
    const expiry = now() + 20000,
      monoExpiry = this.mono + 20000;
    const release = async () => {
      if (!this.active) return;
      if (this.releaseFails) throw this.releaseFailure;
      this.active = false;
      this.events.push("window:release");
      this.bound.clear();
    };
    try {
      return {
        state: "complete",
        value: await work({
          mode: "warm",
          expires_at: expiry,
          release,
          ...(purpose === "audit_source"
            ? {
                purpose,
                execution_eligible: false as const,
                assertLive: () => {
                  if (now() >= expiry || this.mono >= monoExpiry)
                    throw new AgentError(
                      "VENUE_READ_DEADLINE",
                      "fixture original lifetime",
                      true,
                      503,
                    );
                },
              }
            : {}),
        }),
      };
    } finally {
      await release().catch(() => {});
    }
  }
  async cancelPreparedPortfolio(_user: string, p: PreparedPortfolioInput) {
    this.cancelled.push(structuredClone(p));
    if (this.cleanupFails) throw new Error("fixture cleanup unavailable");
    if (p.purpose === "audit_source" && this.active)
      throw new AgentError(
        "VENUE_COST_PLAN_UNAVAILABLE",
        "fixture READY peer is not cancelled",
        true,
        503,
      );
  }
  async prepareExecution(
    _user: string,
    _p: unknown,
    proposal: ExecutionProposal,
  ) {
    assert.equal(this.active, true);
    assert.notEqual(this.activePurpose, "audit_source");
    this.prepares++;
    this.proposals.push(structuredClone(proposal));
    return {
      expires_at: now() + 10000,
      bind: (e: Execution) => {
        this.bound.set(e.id, e.fingerprint);
      },
      cancel: async () => {
        this.bound.clear();
      },
    };
  }
  async account() {
    this.accounts++;
    this.events.push("account");
    return super.account();
  }
  async source(trader: Candidate) {
    this.sources++;
    this.events.push("source");
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
  async submit(_user?: string, _p?: unknown, e?: Execution) {
    assert.ok(e);
    if (this.active) assert.equal(this.bound.get(e.id), e.fingerprint);
    // The routing fixture models the adapter's separate fresh preflight, not
    // permission to reuse the earlier audit or make a real financial request.
    await this.account();
    this.events.push("submit");
    this.submitted.push(structuredClone(e));
    return super.submit();
  }
  async execution() {
    this.reconciled++;
    return super.execution();
  }
  async cancelIncreasing() {
    this.cancelledRisk++;
  }
}

async function fixture(t: TestContext) {
  let clock = BASE;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(console, "info", () => {});
  const adapter = new Adapter(),
    repository = new MemoryRepository();
  adapter.pool = assets.map((asset, i) => ({
    ...candidate(i + 1),
    assets: [asset],
    direction: "long" as const,
  }));
  for (const asset of assets) {
    const key = `perps:${asset}`;
    adapter.snap.prices[key] = "100";
    adapter.snap.max_leverages[key] = 8;
    adapter.snap.min_notionals[key] = "10";
    adapter.snap.quantity_decimals![key] = 8;
  }
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
      },
    };
  }
  await repository.transact(USER, async (s) => {
    s.portfolios.push(p);
  });
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://fixture.invalid",
      new Cursor("s".repeat(32)),
    ),
    () => adapter.mono,
  );
  t.after(() => runner.closeNotifications());
  const read = async () => (await repository.read(USER)).portfolios[0];
  const tick = async () => {
    await runner.tick(USER);
    await runner.notificationsIdle();
  };
  return {
    adapter,
    repository,
    runner,
    read,
    tick,
    advance: (ms: number) => {
      clock += ms;
      adapter.mono += ms;
    },
    shiftWall: (ms: number) => {
      clock += ms;
    },
  };
}

it("readonly clearing of a blocker cannot create an increase until a later complete pair", async (t) => {
  const f = await fixture(t);
  await f.tick();
  f.adapter.changed = false;
  await f.tick();
  assert.equal((await f.read()).target_blocker, undefined);
  assert.equal((await f.read()).executions.length, 0);
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.pairedWindows, 0);
  assert.equal(f.adapter.prepares, 0);
  await f.tick();
  assert.equal(f.adapter.pairedWindows, 1);
  assert.equal(f.adapter.submitted.length, 1);
});

for (const route of ["pending", "unsupported"] as const)
  it(`readonly ${route} keeps the source barrier appropriate without materializing an increase`, async (t) => {
    const f = await fixture(t);
    await f.tick();
    const before = await f.read(),
      sourceReadsBefore = f.adapter.sources;
    f.adapter.changed = false;
    if (route === "pending") f.adapter.pending = true;
    else f.adapter.unsupportedReadonly = true;
    await f.tick();
    if (route === "pending") {
      assert.deepEqual((await f.read()).target_blocker, before.target_blocker);
      assert.equal(f.adapter.sources, sourceReadsBefore);
    } else {
      assert.equal((await f.read()).target_blocker, undefined);
      assert.ok(f.adapter.sources > sourceReadsBefore);
    }
    assert.equal((await f.read()).executions.length, 0);
    assert.equal(f.adapter.prepares, 0);
    assert.equal(f.adapter.submitted.length, 0);
  });

async function owned(f: Awaited<ReturnType<typeof fixture>>) {
  await f.repository.transact(USER, async (s) => {
    for (const [i, sleeve] of s.portfolios[0].sleeves.entries()) {
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
}
for (const route of ["pending", "unsupported"] as const)
  it(`readonly ${route} owned-only reduction confirms exact cancellation and uses an ordinary fresh preflight`, async (t) => {
    const f = await fixture(t);
    await f.tick();
    await owned(f);
    if (route === "pending") f.adapter.pending = true;
    else f.adapter.unsupportedReadonly = true;
    const before = f.adapter.accounts;
    await f.tick();
    assert.equal(f.adapter.prepares, 0);
    assert.equal(f.adapter.submitted.length, 1);
    assert.equal(f.adapter.submitted[0].target_quantity, "0.1");
    assert.ok(f.adapter.cancelled.some((p) => p.purpose === "audit_source"));
    assert.equal(f.adapter.accounts - before, 2);
  });

it("failed readonly pending cancellation preserves owned risk state and creates no financial identifier", async (t) => {
  const f = await fixture(t);
  await f.tick();
  await owned(f);
  f.adapter.pending = true;
  f.adapter.cleanupFails = true;
  await f.tick();
  assert.equal((await f.read()).executions.length, 0);
  assert.equal(f.adapter.submitted.length, 0);
  assert.equal((await f.read()).sleeves[0].lots["perps:BTC"].quantity, "0.2");
});

for (const failure of [new Error("unknown close"), undefined])
  it(`readonly release rejection (${failure === undefined ? "undefined" : "Error"}) cannot create a reduction ID but does not suppress loss fencing`, async (t) => {
    const f = await fixture(t);
    await f.tick();
    await owned(f);
    f.adapter.releaseFails = true;
    f.adapter.releaseFailure = failure;
    f.adapter.snap.account_value_usdc = "470";
    // Increase the owned cost so this is a real loss-triggered path.
    await f.repository.transact(USER, async (s) => {
      for (const sleeve of s.portfolios[0].sleeves)
        for (const lot of Object.values(sleeve.lots)) {
          lot.quantity = "0.2";
          lot.cost = "30";
          f.adapter.snap.positions[lot.key] = "0.2";
        }
    });
    await f.tick();
    assert.equal((await f.read()).executions.length, 0);
    assert.equal(f.adapter.submitted.length, 0);
    assert.equal((await f.read()).loss_latched, true);
    assert.ok(f.adapter.fences > 0 && f.adapter.cancelledRisk > 0);
  });

it("readonly unchanged-source planning cannot internally cross ownership even when the fresh blocker clears", async (t) => {
  const f = await fixture(t);
  await f.tick();
  f.adapter.changed = false;
  await f.repository.transact(USER, async (s) => {
    const p = s.portfolios[0];
    for (const [i, sleeve] of p.sleeves.entries()) {
      const asset = i < 2 ? "BTC" : "SOL",
        key = `perps:${asset}`,
        desired = i === 0 ? "0.2" : i === 1 ? "0" : "0.2",
        quantity = i === 0 ? "0" : "0.2";
      sleeve.trader.assets = [asset];
      sleeve.leverage_rules_revision = fingerprint([[key, 8]]);
      sleeve.intents = {
        [key]: {
          key,
          asset,
          market: "perps",
          quantity: desired,
          price: "100",
          source_entry_price: "100",
          source_leverage: 5,
          observed_at: now(),
          source_revision: "source-old",
        },
      };
      sleeve.lots = {
        [key]: {
          key,
          asset,
          market: "perps",
          quantity,
          cost: String(Number(quantity) * 100),
          realized: "0",
          fees: "0",
          funding: "0",
        },
      };
      f.adapter.snap.positions[key] = "0.2";
    }
  });
  const before = (await f.read()).sleeves.map((s) => structuredClone(s.lots));
  await f.tick();
  assert.equal((await f.read()).target_blocker, undefined);
  assert.deepEqual(
    (await f.read()).sleeves.map((s) => s.lots),
    before,
  );
  assert.equal((await f.read()).executions.length, 0);
  assert.equal(f.adapter.submitted.length, 0);
});

for (const clockRollback of [false, true])
  it(`readonly slow history rejects stale planning before fixed cursor/target/blocker commit (${clockRollback})`, async (t) => {
    const f = await fixture(t);
    await f.repository.transact(USER, async (s) => {
      const sleeve = s.portfolios[0].sleeves[0];
      sleeve.copy_mode = "fixed";
      sleeve.fixed_margin_usdc = "2";
      sleeve.fixed_last_fill_at = now() - 5000;
      sleeve.source_quantities = { "perps:BTC": "5" };
      sleeve.fixed_targets = { "perps:BTC": "0.1" };
    });
    f.adapter.sourceFills = async () => ({ fills: [], complete: true });
    await f.tick();
    const before = await f.read();
    assert.ok(before.target_blocker);
    f.adapter.changed = false;
    f.advance(100);
    f.adapter.sourceFills = async () => {
      if (clockRollback) {
        f.adapter.mono += 20001;
        f.shiftWall(-1000);
      } else f.advance(6001);
      return { fills: [], complete: true };
    };
    await f.tick();
    const after = await f.read();
    assert.equal(
      after.sleeves[0].fixed_last_fill_at,
      before.sleeves[0].fixed_last_fill_at,
    );
    assert.deepEqual(
      after.sleeves[0].fixed_targets,
      before.sleeves[0].fixed_targets,
    );
    assert.deepEqual(after.sleeves[0].intents, before.sleeves[0].intents);
    assert.deepEqual(after.target_blocker, before.target_blocker);
    assert.equal(after.executions.length, 0);
    assert.equal(f.adapter.prepares, 0);
    assert.equal(f.adapter.submitted.length, 0);
    assert.equal(
      after.last_error?.code,
      clockRollback ? "VENUE_READ_DEADLINE" : "SOURCE_STALE",
    );
    assert.equal(
      after.snapshot?.observed_at,
      BASE + 100,
      "A audit remains independently committed",
    );
  });

it("an unacknowledged readonly release stays read-only on the next Fixed callback until cancellation confirms no READY peer", async (t) => {
  const f = await fixture(t);
  await f.repository.transact(USER, async (s) => {
    const sleeve = s.portfolios[0].sleeves[0];
    sleeve.copy_mode = "fixed";
    sleeve.fixed_margin_usdc = "2";
    sleeve.fixed_last_fill_at = now() - 5000;
    sleeve.source_quantities = { "perps:BTC": "5" };
    sleeve.fixed_targets = { "perps:BTC": "0.1" };
  });
  f.adapter.sourceFills = async () => ({ fills: [], complete: true });
  await f.tick();
  await owned(f);
  f.adapter.changed = false;
  f.adapter.releaseFails = true;
  await f.tick();
  assert.equal((await f.read()).target_blocker, undefined);
  assert.equal((await f.read()).executions.length, 0);
  assert.equal(f.adapter.active, true);
  await f.tick();
  assert.equal((await f.read()).executions.length, 0);
  assert.equal(f.adapter.submitted.length, 0);
  f.adapter.active = false;
  f.adapter.releaseFails = false;
  await f.tick();
  assert.equal(f.adapter.submitted.length, 1);
  assert.equal(f.adapter.submitted[0].target_quantity, "0.1");
});

it("a failed readonly pending cancellation is confirmed on a later callback before normal paired execution resumes", async (t) => {
  const f = await fixture(t);
  await f.tick();
  const pendingRevision = (await f.read()).revision;
  // A metadata edit invalidates the original pending scope and requires its
  // exact cancellation. An unchanged pending scope now defers source planning.
  await f.repository.transact(USER, async (state) => {
    state.portfolios[0].revision++;
  });
  f.adapter.pending = true;
  f.adapter.cleanupFails = true;
  f.adapter.changed = false;
  await f.tick();
  assert.ok(
    f.adapter.cancelled.some(
      (p) => p.purpose === "audit_source" && p.revision === pendingRevision,
    ),
  );
  assert.equal((await f.read()).target_blocker, undefined);
  assert.equal((await f.read()).executions.length, 0);
  f.adapter.pending = false;
  f.adapter.cleanupFails = false;
  await f.tick();
  assert.equal(f.adapter.pairedWindows, 1);
  assert.equal(f.adapter.submitted.length, 1);
});

for (const failedPhase of [1, 3])
  it(`readonly outer owner remembers failed release even when PG phase ${failedPhase} never enters`, async (t) => {
    const f = await fixture(t);
    await f.tick();
    await f.repository.transact(USER, async (s) => {
      const x = s.portfolios[0].sleeves[0];
      x.copy_mode = "fixed";
      x.fixed_margin_usdc = "2";
      x.fixed_last_fill_at = now() - 1000;
      x.source_quantities = { "perps:BTC": "5" };
      x.fixed_targets = { "perps:BTC": "0.1" };
    });
    f.adapter.sourceFills = async () => ({ fills: [], complete: true });
    await f.tick();
    await owned(f);
    f.adapter.changed = false;
    f.adapter.releaseFails = true;
    // No owned reduction in this callback: cleanup must survive a DB phase
    // failure before the durable callback that normally closes the window.
    await f.repository.transact(USER, async (s) => {
      for (const [i, x] of s.portfolios[0].sleeves.entries()) {
        const key = `perps:${assets[i]}`;
        x.lots[key].quantity = "0.1";
        x.lots[key].cost = "10";
        f.adapter.snap.positions[key] = "0.1";
      }
    });
    const original = f.repository.transact.bind(f.repository);
    let phase = 0;
    f.repository.transact = ((...args: Parameters<typeof original>) => {
      if (++phase === failedPhase)
        throw new Error("fixture PG phase unavailable");
      return original(...args);
    }) as typeof f.repository.transact;
    await assert.rejects(f.tick(), /fixture PG phase unavailable/);
    f.repository.transact = original;
    if (failedPhase === 3)
      assert.equal((await f.read()).target_blocker, undefined);
    assert.equal(f.adapter.active, true);
    const windows = f.adapter.windows;
    await owned(f);
    await f.tick();
    assert.equal(
      f.adapter.windows,
      windows,
      "unconfirmed READY is not replaced by another capability",
    );
    assert.equal((await f.read()).executions.length, 0);
    assert.equal(f.adapter.submitted.length, 0);
    f.adapter.active = false;
    f.adapter.releaseFails = false;
    await f.tick();
    assert.equal((await f.read()).executions.length, 1);
    assert.equal(f.adapter.submitted.length, 1);
  });
