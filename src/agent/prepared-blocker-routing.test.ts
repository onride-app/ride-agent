import assert from "node:assert/strict";
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
  pairedWindows = 0;
  readonlyWindows = 0;
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
    if (_p.purpose === "audit_source") this.readonlyWindows++;
    else this.pairedWindows++;
    if (this.pending) return { state: "pending", retry_after_ms: 1000 };
    this.active = true;
    this.activePurpose = _p.purpose ?? "audit_submit";
    const expires = now() + 20000;
    const release = async () => {
      if (!this.active) return;
      this.active = false;
      this.events.push("window:release");
      this.bound.clear();
    };
    try {
      return {
        state: "complete",
        value: await work({
          mode: "warm",
          expires_at: expires,
          release,
          ...(_p.purpose === "audit_source"
            ? {
                purpose: "audit_source" as const,
                execution_eligible: false as const,
                assertLive: () => {
                  assert.ok(this.active && now() < expires);
                },
              }
            : {}),
        }),
      };
    } finally {
      await release();
    }
  }
  async cancelPreparedPortfolio(_user: string, p: PreparedPortfolioInput) {
    this.cancelled.push(structuredClone(p));
    if (this.cleanupFails) throw new Error("fixture cleanup unavailable");
  }
  async prepareExecution(
    _user: string,
    _p: unknown,
    proposal: ExecutionProposal,
  ) {
    assert.equal(this.active, true);
    assert.equal(this.activePurpose, "audit_submit");
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
    if (this.active) {
      assert.equal(
        this.activePurpose,
        "audit_submit",
        "a readonly capability cannot submit",
      );
      assert.equal(this.bound.get(e.id), e.fingerprint);
    }
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
  t.mock.method(Date, "now", () => BASE);
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
  );
  t.after(() => runner.closeNotifications());
  const read = async () => (await repository.read(USER)).portfolios[0];
  const tick = async () => {
    await runner.tick(USER);
    await runner.notificationsIdle();
  };
  return { adapter, repository, runner, read, tick };
}

it("a rejected source basket keeps full readonly audits and source advancement without repeatedly booking2W", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 4; i++) await f.tick();
  const p = await f.read();
  assert.equal(p.target_blocker?.code, "ASSET_CONCENTRATION");
  assert.equal(f.adapter.accounts, 4);
  assert.equal(f.adapter.sources, 12);
  assert.equal(f.adapter.readonlyWindows, 3);
  assert.equal(f.adapter.pairedWindows, 0);
  assert.equal(f.adapter.prepares, 0);
  assert.equal(p.executions.length, 0);
});

it("only a fresh successful source/risk pass clears the routing blocker and the next pair retains a separate preflight", async (t) => {
  const f = await fixture(t);
  await f.tick();
  assert.equal((await f.read()).target_blocker?.code, "ASSET_CONCENTRATION");
  f.adapter.changed = false;
  await f.tick();
  assert.equal((await f.read()).target_blocker, undefined);
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.pairedWindows, 0);
  assert.equal((await f.read()).executions.length, 0);
  const before = f.adapter.accounts;
  await f.tick();
  assert.equal(f.adapter.pairedWindows, 1);
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.prepares, 1);
  assert.equal(f.adapter.submitted.length, 1);
  assert.equal(
    f.adapter.accounts - before,
    2,
    "audit and fresh submit preflight remain separate",
  );
  const p = await f.read();
  assert.equal(p.executions[0].fingerprint, f.adapter.submitted[0].fingerprint);
  assert.equal(p.executions[0].expires_at - p.executions[0].created_at, 60000);
});

it("a persisted blocker still permits the original owned-only reduction without a paired capability", async (t) => {
  const f = await fixture(t);
  await f.tick();
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
  await f.tick();
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.pairedWindows, 0);
  assert.ok(
    f.adapter.events.indexOf("window:release") <
      f.adapter.events.indexOf("submit"),
  );
  assert.equal(f.adapter.submitted.length, 1);
  assert.equal(f.adapter.submitted[0].key, "perps:BTC");
  assert.equal(f.adapter.submitted[0].target_quantity, "0.1");
  assert.equal((await f.read()).target_blocker?.code, "ASSET_CONCENTRATION");
});

it("the ordinary blocked route still triggers loss fences, cancellation and owned exits", async (t) => {
  const f = await fixture(t);
  await f.tick();
  await f.repository.transact(USER, async (s) => {
    for (const [i, sleeve] of s.portfolios[0].sleeves.entries()) {
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
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.pairedWindows, 0);
  assert.equal((await f.read()).loss_latched, true);
  assert.ok(f.adapter.fences > 0 && f.adapter.cancelledRisk > 0);
  assert.equal(f.adapter.submitted.length, 3);
  assert.ok(f.adapter.submitted.every((e) => e.target_quantity === "0"));
});

it("the blocker never replaces original unknown-ID reconciliation with new targets", async (t) => {
  const f = await fixture(t);
  await f.tick();
  const frozen = {
    id: "original_unknown",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: 1,
    created_at: now() - 30000,
    expires_at: now() + 30000,
  };
  const e: Execution = {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "uncertain",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  };
  await f.repository.transact(USER, async (s) => {
    s.portfolios[0].executions.push(structuredClone(e));
  });
  await f.tick();
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.pairedWindows, 0);
  assert.equal(f.adapter.reconciled, 1);
  assert.deepEqual((await f.read()).executions, [e]);
  assert.equal(f.adapter.submitted.length, 0);
});

it("an unrelated monitor error is not treated as a persisted target blocker", async (t) => {
  const f = await fixture(t);
  f.adapter.changed = false;
  await f.tick();
  await f.repository.transact(USER, async (s) => {
    s.portfolios[0].last_error = {
      code: "RISK_LIMIT",
      message: "prior transient fixture",
      at: now(),
      retryable: false,
    };
  });
  await f.tick();
  assert.equal(f.adapter.windows, 1);
  assert.equal(f.adapter.prepares, 1);
  assert.equal(f.adapter.submitted.length, 1);
});

it("a blocker appearing after cached routing releases an already-ready window before ordinary auditing", async (t) => {
  const f = await fixture(t);
  await f.tick();
  const blocker = (await f.read()).target_blocker;
  assert.ok(blocker);
  f.adapter.changed = false;
  await f.tick();
  await f.repository.transact(USER, async (s) => {
    s.portfolios[0].target_blocker = blocker;
  });
  f.adapter.changed = true;
  f.adapter.events.length = 0;
  await f.tick();
  assert.equal(f.adapter.readonlyWindows, 1);
  assert.equal(f.adapter.pairedWindows, 1);
  assert.equal(f.adapter.prepares, 0);
  assert.equal(f.adapter.events[0], "window:release");
  assert.ok(
    f.adapter.events.includes("account") && f.adapter.events.includes("source"),
  );
  assert.equal((await f.read()).executions.length, 0);
});

for (const cleanupFails of [false, true])
  it(`a newly rejected basket cancels only its old pending preparation after audit commit (${cleanupFails})`, async (t) => {
    const f = await fixture(t);
    f.adapter.changed = false;
    await f.tick();
    f.adapter.pending = true;
    f.adapter.changed = true;
    f.adapter.cleanupFails = cleanupFails;
    await f.tick();
    assert.equal(f.adapter.windows, 1);
    assert.equal(f.adapter.cancelled.length, 1);
    assert.equal((await f.read()).target_blocker?.code, "ASSET_CONCENTRATION");
    assert.equal(f.adapter.cancelled[0].id, (await f.read()).id);
    const sourceReadsBefore = f.adapter.sources;
    const blockerBefore = (await f.read()).target_blocker;
    await f.tick();
    assert.equal(
      f.adapter.pairedWindows,
      1,
      "blocked routing cannot poll/rebook2W",
    );
    assert.equal(
      f.adapter.readonlyWindows,
      cleanupFails ? 0 : 1,
      "a new readonly purpose never replaces an uncancelled old pending capability",
    );
    assert.equal(f.adapter.cancelled.length, cleanupFails ? 2 : 1);
    assert.equal(f.adapter.accounts, 3);
    assert.equal(f.adapter.sources, cleanupFails ? 9 : 6);
    assert.equal(f.adapter.sources - sourceReadsBefore, cleanupFails ? 3 : 0);
    if (!cleanupFails)
      assert.deepEqual((await f.read()).target_blocker, blockerBefore);
    assert.equal((await f.read()).executions.length, 0);
  });
