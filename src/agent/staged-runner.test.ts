import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import type {
  ExecutionPreparation,
  ExecutionProposal,
  PreparedPortfolioResult,
  PreparedPortfolioWindow,
  SourceSnapshot,
} from "./adapter.js";
import {
  fingerprint,
  now,
  recommend,
  type Candidate,
  type Execution,
  type Portfolio,
} from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import type { PreparedPortfolioInput } from "./prepared-portfolio.js";
import {
  Cursor,
  MemoryRepository,
  type MonitorCallback,
  type State,
} from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

const USER = "staged_runner_alice",
  BASE = 1793200000000,
  KEY = "perps:BTC";

class RecordedRepository extends MemoryRepository {
  monitorCalls = 0;
  failAt = Infinity;
  committed?: State;
  readonly events: string[] = [];
  async transactMonitor<T>(
    user: string,
    callback: MonitorCallback<T>,
  ): Promise<T> {
    const call = ++this.monitorCalls;
    this.events.push(`tx:start:${call}`);
    let copy: State | undefined;
    const result = await super.transact(user, async (state) => {
      const value = await callback(state);
      if (call === this.failAt) throw new Error("fixture plan commit rejected");
      copy = structuredClone(state);
      return value;
    });
    this.committed = copy;
    this.events.push(`tx:commit:${call}`);
    return result;
  }
}

class StagedAdapter extends FakeAdapter {
  mode: "pending" | "cold" | "warm" | "unsupported" = "warm";
  windows = 0;
  prepares = 0;
  windowActive = false;
  releasesWindow = 0;
  readonly events: string[];
  readonly bound = new Map<string, string>();
  readonly submitted: Execution[] = [];
  readonly issuedSources: SourceSnapshot[] = [];
  beforeWindow?: () => Promise<void>;
  onPrepare?: () => Promise<void>;
  accountRead?: () => ReturnType<FakeAdapter["account"]>;
  repository!: RecordedRepository;
  private accountDone = false;
  private windowExpires = 0;
  constructor(events: string[]) {
    super();
    this.events = events;
  }
  async withPreparedPortfolio<T>(
    _user: string,
    _p: PreparedPortfolioInput,
    work: (window: PreparedPortfolioWindow) => Promise<T>,
  ): Promise<PreparedPortfolioResult<T>> {
    this.windows++;
    this.events.push(`window:${this.mode}`);
    if (this.mode === "pending")
      return { state: "pending", retry_after_ms: 1000 };
    if (this.mode === "unsupported") return { state: "unsupported" };
    await this.beforeWindow?.();
    this.windowActive = true;
    this.accountDone = false;
    this.windowExpires = now() + 20000;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      this.windowActive = false;
      this.releasesWindow++;
      this.events.push("window:release");
      this.bound.clear();
    };
    try {
      return {
        state: "complete",
        value: await work({
          mode: this.mode,
          expires_at: this.windowExpires,
          release,
        }),
      };
    } finally {
      await release();
    }
  }
  async prepareExecution(
    _user: string,
    _p: Portfolio,
    _proposal: ExecutionProposal,
  ): Promise<ExecutionPreparation> {
    assert.equal(
      this.windowActive,
      true,
      "preparation belongs to its live read window",
    );
    this.prepares++;
    this.events.push("execution:prepare");
    const expires = Math.min(this.windowExpires, now() + 10000);
    await this.onPrepare?.();
    return {
      expires_at: expires,
      bind: (execution) => {
        assert.equal(
          this.bound.size,
          0,
          "one ready window binds one original execution",
        );
        this.bound.set(execution.id, execution.fingerprint);
        this.events.push("execution:bind");
      },
      cancel: async () => {
        this.bound.clear();
        this.events.push("execution:cancel");
      },
    };
  }
  async account() {
    this.events.push("account:start");
    const result = this.accountRead
      ? await this.accountRead()
      : await super.account();
    this.accountDone = true;
    this.events.push("account:done");
    return result;
  }
  async source(trader: Candidate) {
    if (this.windowActive)
      assert.equal(
        this.accountDone,
        true,
        "prepared source starts after full audit",
      );
    this.events.push("source");
    const value = {
      observed_at: now(),
      revision: "staged_source_v1",
      account_value_usdc: "1000",
      complete: true,
      positions: trader.assets.map((asset) => ({
        key: `perps:${asset}`,
        asset,
        market: "perps" as const,
        quantity: "5",
        price: "100",
        source_entry_price: "100",
        source_leverage: 5,
        source_leverage_verified: true,
        observed_at: now(),
        source_revision: "staged_source_v1",
      })),
    };
    this.issuedSources.push(value);
    return value;
  }
  async submit(_user?: string, p?: Portfolio, execution?: Execution) {
    assert.ok(p && execution);
    const saved = this.repository.committed?.portfolios
      .find((value) => value.id === p.id)
      ?.executions.find((value) => value.id === execution.id);
    assert.ok(saved, "the original ID must be durably committed before submit");
    assert.equal(saved.fingerprint, execution.fingerprint);
    assert.equal(saved.expires_at, execution.expires_at);
    if (this.windowActive)
      assert.equal(this.bound.get(execution.id), execution.fingerprint);
    this.events.push("submit");
    this.submitted.push(structuredClone(execution));
    return super.submit();
  }
  async fence() {
    this.events.push("fence");
    await super.fence();
  }
  async cancelIncreasing() {
    this.events.push("cancelIncreasing");
  }
  async notify() {
    this.events.push("notify");
    await super.notify();
  }
}

function portfolio(assets = ["BTC"]): Portfolio {
  const trader = { ...candidate(1), assets };
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "single",
        basket_size: 1,
      },
      [trader],
    ),
  );
  p.account_id = snapshot().account_id;
  p.initial_equity = "500";
  p.ledger_started_at = now() - 60000;
  p.state = "active";
  p.reconciliation = "complete";
  const s = p.sleeves[0];
  s.initialized = true;
  s.reviewed_at = now();
  s.source_revision = "staged_source_v1";
  for (const asset of assets)
    s.intents[`perps:${asset}`] = {
      key: `perps:${asset}`,
      asset,
      market: "perps",
      quantity: "0.1",
      price: "100",
      source_entry_price: "100",
      source_leverage: 5,
      observed_at: now() - 45000,
      source_revision: "staged_source_v1",
    };
  return p;
}

async function fixture(t: TestContext, portfolios = [portfolio()]) {
  let clock = BASE;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(console, "info", () => {});
  const repo = new RecordedRepository(),
    adapter = new StagedAdapter(repo.events);
  // Inputs created before the mock are normalized so fixture evidence has one clock.
  for (const p of portfolios) {
    p.ledger_started_at = clock - 60000;
    for (const s of p.sleeves) {
      s.reviewed_at = clock;
      for (const intent of Object.values(s.intents))
        intent.observed_at = clock - 45000;
    }
  }
  adapter.repository = repo;
  adapter.pool = portfolios.flatMap((p) => p.sleeves.map((s) => s.trader));
  for (const key of portfolios.flatMap((p) =>
    p.sleeves.flatMap((s) => s.trader.assets.map((a) => `perps:${a}`)),
  )) {
    adapter.snap.prices[key] = "100";
    adapter.snap.max_leverages[key] = 8;
    adapter.snap.min_notionals[key] = "10";
    (adapter.snap.quantity_decimals ??= {})[key] = 8;
  }
  await repo.transact(USER, async (state) => {
    state.portfolios.push(...structuredClone(portfolios));
  });
  const runner = new AgentRunner(
    new AgentService(
      repo,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  const tick = async () => {
    await runner.tick(USER);
    await runner.notificationsIdle();
  };
  return {
    repo,
    adapter,
    runner,
    tick,
    events: repo.events,
    read: () => repo.read(USER),
    advance: (ms: number) => {
      clock += ms;
    },
    clock: () => clock,
  };
}

it("discovery and pending preparation preserve auditing and create no execution IDs", async (t) => {
  const f = await fixture(t);
  await f.tick();
  assert.equal(f.adapter.windows, 0);
  assert.equal((await f.read()).portfolios[0].executions.length, 0);
  f.adapter.mode = "pending";
  f.events.length = 0;
  await f.tick();
  assert.equal(f.adapter.windows, 1);
  assert.ok(f.events.includes("account:done"));
  assert.ok(f.events.includes("source"));
  assert.equal(f.adapter.prepares, 0);
  assert.equal(f.adapter.submitCount, 0);
  assert.equal((await f.read()).portfolios[0].executions.length, 0);
});

it("a cold complete audit learns without an ID, and the next warm window creates one committed ID", async (t) => {
  const f = await fixture(t, [portfolio(["BTC", "ETH", "SOL"])]);
  await f.tick();
  f.adapter.mode = "cold";
  await f.tick();
  assert.equal(f.adapter.prepares, 0);
  assert.equal((await f.read()).portfolios[0].executions.length, 0);
  f.adapter.mode = "warm";
  f.events.length = 0;
  await f.tick();
  const p = (await f.read()).portfolios[0];
  assert.equal(p.executions.length, 1);
  assert.equal(f.adapter.prepares, 1);
  assert.equal(f.adapter.submitCount, 1);
  assert.equal(p.executions[0].expires_at - p.executions[0].created_at, 60000);
  assert.ok(f.events.indexOf("account:done") < f.events.indexOf("source"));
  assert.ok(f.events.indexOf("execution:bind") < f.events.indexOf("submit"));
  assert.ok(f.events.indexOf("window:release") > f.events.indexOf("submit"));
  assert.ok(f.events.includes("notify"));
  assert.ok(f.events.indexOf("window:release") < f.events.indexOf("notify"));
});

for (const cleanupFails of [false, true])
  it(`cancels only changed pending routing after commit without replacing audits (${cleanupFails})`, async (t) => {
    const f = await fixture(t);
    const cancelled: PreparedPortfolioInput[] = [];
    Object.assign(f.adapter, {
      cancelPreparedPortfolio: async (
        user: string,
        prior: PreparedPortfolioInput,
      ) => {
        assert.equal(user, USER);
        cancelled.push(structuredClone(prior));
        if (cleanupFails)
          throw new Error("fixture metadata cleanup unavailable");
      },
    });
    await f.tick();
    f.adapter.mode = "pending";
    await f.tick();
    assert.equal(
      cancelled.length,
      0,
      "normal pending preserves its first queue episode",
    );
    const previousRevision = (await f.read()).portfolios[0].revision;
    await f.repo.transact(USER, async (state) => {
      state.portfolios[0].revision++;
    });
    f.events.length = 0;
    await f.tick();
    assert.equal(
      cancelled.length,
      1,
      "at most one cleanup attempt per ordinary tick",
    );
    assert.equal(
      cancelled[0].revision,
      previousRevision,
      "cancel is bound to the exact old authority",
    );
    assert.ok(f.events.includes("account:done"));
    assert.ok(f.events.includes("source"));
    assert.equal(f.adapter.submitCount, 0);
    assert.equal((await f.read()).portfolios[0].executions.length, 0);
  });

it("pending read preparation still runs newly triggered loss controls without creating IDs", async (t) => {
  const f = await fixture(t);
  await f.tick();
  f.adapter.mode = "pending";
  await f.repo.transact(USER, async (state) => {
    state.portfolios[0].sleeves[0].lots[KEY] = {
      key: KEY,
      asset: "BTC",
      market: "perps",
      quantity: "0",
      cost: "0",
      realized: "-10",
      fees: "0",
      funding: "0",
    };
  });
  f.adapter.snap.account_value_usdc = "490";
  f.events.length = 0;
  await f.tick();
  const p = (await f.read()).portfolios[0];
  assert.equal(f.adapter.windows, 1);
  assert.equal(p.loss_latched, true);
  assert.ok(f.events.includes("fence"));
  assert.ok(f.events.includes("cancelIncreasing"));
  assert.equal(p.executions.length, 0);
  assert.equal(f.adapter.submitCount, 0);
});

for (const issue of [
  "multiple",
  "mixed",
  "uninitialized",
  "fixed",
  "old unknown",
] as const)
  it(`keeps ${issue} portfolios on the original path without a read bundle`, async (t) => {
    const p = portfolio();
    let old: Execution | undefined;
    const ps = [p];
    if (issue === "multiple")
      ps.push({ ...structuredClone(p), id: `${p.id}_second` });
    if (issue === "mixed")
      p.sleeves.push({
        ...structuredClone(p.sleeves[0]),
        copy_id: "closed_prediction",
        state: "closed",
        trader: { ...candidate(2), market: "prediction" },
        intents: {},
        lots: {},
      });
    if (issue === "uninitialized") p.sleeves[0].initialized = false;
    if (issue === "fixed") p.sleeves[0].copy_mode = "fixed";
    if (issue === "old unknown") {
      const frozen = {
        id: "old_original_uncertain",
        key: KEY,
        target_quantity: "0.1",
        allocations: {},
        revision: p.revision,
        created_at: BASE - 50000,
        expires_at: BASE + 10000,
      };
      old = {
        ...frozen,
        fingerprint: fingerprint(frozen),
        status: "uncertain",
        task_id: null,
        observed_quantity: null,
        reserve_usdc: "2",
        error: null,
      };
      p.executions.push(structuredClone(old));
    }
    const f = await fixture(t, ps);
    let reconciled = 0;
    f.adapter.execution = async () => {
      reconciled++;
      return { status: "uncertain", observed_quantity: null, settled: false };
    };
    await f.tick();
    assert.equal(f.adapter.windows, 0);
    assert.equal(f.adapter.prepares, 0);
    if (old) {
      assert.ok(reconciled > 0);
      assert.deepEqual(
        (await f.read()).portfolios[0].executions.find((e) => e.id === old!.id),
        old,
      );
      assert.equal(
        f.adapter.submitCount,
        0,
        "unknown originals are reconciled, never replayed",
      );
    }
  });

for (const change of ["revision", "account", "handoff"] as const)
  it(`releases a stale prepared ${change} selection before auditing the changed state`, async (t) => {
    const f = await fixture(t);
    await f.tick();
    f.events.length = 0;
    f.adapter.beforeWindow = async () =>
      f.repo.transact(USER, async (state) => {
        const p = state.portfolios[0];
        if (change === "revision") p.revision++;
        if (change === "account")
          p.account_id = f.adapter.snap.account_id = "account_changed000";
        if (change === "handoff") {
          const handoff = {
            handoff_id: "11111111-1111-4111-8111-111111111111",
            binding_id: p.account_id!,
            coin: "BTC",
            at_ms: BASE - 2000,
            mark_px: "100",
            signed_size: "0",
            master: "0x" + "a".repeat(40),
            agent: "0x" + "b".repeat(40),
            network: 2,
            wallet_generation: 1,
          };
          p.manual_ledger = {
            lots: {},
            seen_fills: [],
            transfers: [{ handoff, quantities: {}, realized_usdc: {} }],
          };
          f.adapter.snap.manual_markets = [handoff];
        }
      });
    await f.tick();
    assert.equal(f.adapter.releasesWindow, 1);
    assert.equal(f.events.filter((e) => e === "account:start").length, 1);
    assert.ok(
      f.events.indexOf("window:release") < f.events.indexOf("account:start"),
    );
    assert.equal(f.adapter.prepares, 0);
    assert.equal(f.adapter.submitCount, 0);
    assert.equal((await f.read()).portfolios[0].executions.length, 0);
  });

it("a rejected planning commit releases its window, sends nothing and does not rerun the callback", async (t) => {
  const f = await fixture(t);
  await f.tick();
  const calls = f.repo.monitorCalls;
  f.repo.failAt = calls + 2;
  f.events.length = 0;
  await assert.rejects(f.tick(), /fixture plan commit rejected/);
  assert.equal(f.repo.monitorCalls, calls + 2);
  assert.equal(f.events.filter((e) => e === "account:start").length, 1);
  assert.equal(f.adapter.releasesWindow, 1);
  assert.equal(f.adapter.windowActive, false);
  assert.equal(f.adapter.submitCount, 0);
  assert.equal((await f.read()).portfolios[0].executions.length, 0);
});

it("newly observed loss releases preparation before the original fence, cancel and risk exit", async (t) => {
  const f = await fixture(t);
  await f.tick();
  await f.repo.transact(USER, async (state) => {
    const p = state.portfolios[0];
    p.sleeves[0].lots[KEY] = {
      key: KEY,
      asset: "BTC",
      market: "perps",
      quantity: "1",
      cost: "110",
      realized: "0",
      fees: "0",
      funding: "0",
    };
  });
  f.adapter.snap.positions[KEY] = "1";
  f.adapter.snap.account_value_usdc = "490";
  f.events.length = 0;
  await f.tick();
  const saved = (await f.read()).portfolios[0];
  assert.ok(f.events.indexOf("window:release") >= 0);
  assert.ok(
    f.events.indexOf("window:release") < f.events.indexOf("fence"),
    JSON.stringify(f.events),
  );
  assert.ok(f.events.indexOf("fence") < f.events.indexOf("cancelIncreasing"));
  assert.equal(f.adapter.prepares, 0);
  assert.equal(saved.loss_latched, true);
  assert.equal(
    f.adapter.submitted.length,
    1,
    "the original risk exit is preserved",
  );
  assert.ok(f.adapter.submitted.every((e) => e.target_quantity === "0"));
});

for (const stale of ["source", "position"] as const)
  it(`does not create an ID when ${stale} evidence expires during preparation`, async (t) => {
    const f = await fixture(t);
    await f.tick();
    f.adapter.issuedSources.length = 0;
    f.adapter.onPrepare = async () => {
      if (stale === "source") f.advance(6001);
      else
        for (const s of f.adapter.issuedSources)
          s.positions[0].observed_at -= 6001;
      await Promise.resolve();
    };
    await f.tick();
    const p = (await f.read()).portfolios[0];
    assert.equal(f.adapter.prepares, 1);
    assert.equal(p.executions.length, 0);
    assert.equal(f.adapter.submitCount, 0);
    assert.equal(p.last_error?.code, "SOURCE_STALE");
    assert.equal(
      p.snapshot?.observed_at,
      BASE,
      "a later clock cannot refresh account evidence",
    );
    assert.ok(f.adapter.issuedSources.every((s) => s.observed_at === BASE));
    if (stale === "position")
      assert.ok(
        f.adapter.issuedSources.every(
          (s) => s.positions[0].observed_at === BASE - 6001,
        ),
      );
  });
