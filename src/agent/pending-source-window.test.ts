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
import {
  Cursor,
  MemoryRepository,
  type MonitorCallback,
  type State,
} from "./repository.js";
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

async function blocked(t: TestContext, fixed = false) {
  const f = await fixture(t);
  if (fixed) {
    await f.repository.transact(USER, async (s) => {
      const x = s.portfolios[0].sleeves[0];
      x.copy_mode = "fixed";
      x.fixed_margin_usdc = "2";
      x.fixed_last_fill_at = now() - 1000;
      x.source_quantities = { "perps:BTC": "5" };
      x.fixed_targets = { "perps:BTC": "0.1" };
    });
  }
  let fillReads = 0;
  f.adapter.sourceFills = async () => {
    fillReads++;
    return { fills: [], complete: true };
  };
  await f.tick();
  assert.equal((await f.read()).target_blocker?.code, "ASSET_CONCENTRATION");
  return { ...f, fillReads: () => fillReads };
}
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
function unknownExecution(): Execution {
  const frozen = {
    id: "fixture_original_unknown",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: 1,
    created_at: now() - 30000,
    expires_at: now() + 30000,
  };
  return {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "uncertain",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  };
}
it("verified readonly pending ACK keeps complete account audits but starts no ordinary source interest or fill history", async (t) => {
  const f = await blocked(t, true);
  f.adapter.pending = true;
  const before = await f.read(),
    accounts = f.adapter.accounts,
    sources = f.adapter.sources,
    fills = f.fillReads();
  for (let i = 0; i < 3; i++) await f.tick();
  const p = await f.read();
  assert.equal(f.adapter.accounts - accounts, 3);
  assert.equal(
    f.fillReads(),
    fills,
    "pending cannot refresh Fixed history/cursor outside H",
  );
  assert.equal(
    f.adapter.sources,
    sources,
    "pending cannot start ordinary source prefetch/planning",
  );
  assert.deepEqual(p.target_blocker, before.target_blocker);
  assert.deepEqual(p.sleeves, before.sleeves);
  assert.equal(p.state, before.state);
  assert.equal(p.executions.length, 0);
  assert.equal(f.adapter.prepares, 0);
});
it("pending source deferral preserves prior operational errors and a fresh blocker until a real ready plan", async (t) => {
  const f = await blocked(t);
  await f.repository.transact(USER, async (s) => {
    const old = {
      at: now() - 60000,
      code: "VENUE_READ_BUDGET_EXHAUSTED",
      message: "fixture prior unsent source read",
      retryable: true,
      read_scope: "source" as const,
      details: {
        reason_code: "READ_LOCAL_BUDGET_UNSENT",
        retry_after_ms: 1000,
      },
    };
    s.portfolios[0].source_read_error = structuredClone(old);
    s.portfolios[0].last_error = structuredClone(old);
  });
  const before = await f.read();
  f.adapter.pending = true;
  f.adapter.changed = false;
  await f.tick();
  const after = await f.read();
  assert.deepEqual(after.source_read_error, before.source_read_error);
  assert.deepEqual(after.last_error, before.last_error);
  assert.deepEqual(after.target_blocker, before.target_blocker);
  assert.equal(after.state, before.state);
  assert.equal(after.executions.length, 0);
  f.adapter.pending = false;
  await f.tick();
  assert.equal((await f.read()).target_blocker, undefined);
  assert.equal((await f.read()).source_read_error, undefined);
  assert.equal(
    (await f.read()).executions.length,
    0,
    "readonly success never upgrades in the same tick",
  );
});
for (const route of ["unsupported", "throw", "paired_pending"] as const) {
  it(`${route} does not masquerade as a verified readonly pending ACK`, async (t) => {
    const f = route === "paired_pending" ? await fixture(t) : await blocked(t);
    f.adapter.changed = false;
    if (route === "paired_pending") {
      await f.tick();
      f.adapter.pending = true;
    } else if (route === "unsupported") f.adapter.unsupportedReadonly = true;
    else
      t.mock.method(f.adapter, "withPreparedPortfolio", async () => {
        throw new AgentError(
          "EXECUTOR_UNAVAILABLE",
          "fixture unknown readiness",
          true,
          503,
        );
      });
    const sources = f.adapter.sources,
      accounts = f.adapter.accounts;
    await f.tick();
    assert.equal(f.adapter.sources - sources, 3);
    assert.equal(f.adapter.accounts - accounts, 1);
    assert.equal((await f.read()).target_blocker, undefined);
  });
}
it("a new global unknown invalidates the pending selection without skipping its original-ID reconciliation", async (t) => {
  const f = await blocked(t);
  f.adapter.pending = true;
  const e = unknownExecution();
  await f.repository.transact(USER, async (s) => {
    const closed = structuredClone(s.portfolios[0]);
    closed.id = "fixture_closed_portfolio";
    closed.state = "closed";
    closed.executions = [structuredClone(e)];
    s.portfolios.push(closed);
  });
  const sources = f.adapter.sources;
  await f.tick();
  assert.equal(
    f.adapter.sources - sources,
    3,
    "no current candidate cannot become an indefinite deferral",
  );
  assert.equal(f.adapter.reconciled, 1);
  assert.deepEqual((await f.repository.read(USER)).portfolios[1].executions, [
    e,
  ]);
  assert.equal(f.adapter.submitted.length, 0);
});
it("pending source deferral preserves attention while a fresh owned-only reduction uses exact cancellation and ordinary fresh preflight", async (t) => {
  const f = await blocked(t);
  await owned(f);
  f.adapter.pending = true;
  await f.repository.transact(USER, async (state) => {
    state.portfolios[0].state = "attention";
  });
  const p = await f.read(),
    sources = f.adapter.sources,
    accounts = f.adapter.accounts;
  await f.tick();
  assert.equal(f.adapter.sources, sources);
  assert.equal(f.adapter.submitted.length, 1);
  assert.equal(f.adapter.submitted[0].target_quantity, "0.1");
  assert.equal(
    f.adapter.accounts - accounts,
    2,
    "audit plus a separate fresh financial account preflight",
  );
  assert.ok(f.adapter.cancelled.some((x) => x.purpose === "audit_source"));
  assert.equal((await f.read()).state, p.state);
  assert.deepEqual((await f.read()).target_blocker, p.target_blocker);
});
it("pending deferral does not suppress loss fences, cancellation, owned exits or the durable notification phase", async (t) => {
  const f = await blocked(t);
  await owned(f);
  f.adapter.pending = true;
  f.adapter.snap.account_value_usdc = "470";
  await f.repository.transact(USER, async (s) => {
    for (const sleeve of s.portfolios[0].sleeves)
      for (const lot of Object.values(sleeve.lots)) {
        lot.quantity = "0.2";
        lot.cost = "30";
        f.adapter.snap.positions[lot.key] = "0.2";
      }
    s.notification_preferences = {
      daily_digest: true,
      enabled_at: now() - 86400000,
      timezone: "UTC",
      local_time: "00:00",
    };
  });
  const sources = f.adapter.sources;
  await f.tick();
  const p = await f.read();
  assert.equal(f.adapter.sources, sources);
  assert.equal(p.loss_latched, true);
  assert.ok(f.adapter.fences > 0 && f.adapter.cancelledRisk > 0);
  assert.equal(f.adapter.submitted.length, 3);
  assert.ok(f.adapter.submitted.every((e) => e.target_quantity === "0"));
  assert.ok(
    (await f.repository.read(USER)).updates.some(
      (x) => x.kind === "daily_digest",
    ),
  );
});

function mutateBeforeDurable(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
  mutate: (state: State) => void,
) {
  const transact = f.repository.transact.bind(f.repository);
  let ordinal = 0;
  t.mock.method(
    f.repository,
    "transact",
    async <T>(user: string, work: MonitorCallback<T>) =>
      transact(user, async (state) => {
        if (++ordinal === 3) mutate(state);
        return work(state);
      }),
  );
}
for (const change of [
  "revision",
  "control",
  "account",
  "ownership",
  "preferences",
  "loss",
  "reconciliation",
  "last_error",
  "source_error",
  "blocker",
  "frozen_target",
  "fingerprint",
  "task",
  "observed_quantity",
  "unfilled_allocations",
  "retirement",
  "first_packet",
  "submitted_status",
  "partial_status",
  "duplicate_id",
  "new_unknown",
  "old_queued",
  "expiry",
] as const) {
  it(`pending reduction attention exception refuses a changed ${change} before the financial boundary`, async (t) => {
    const f = await blocked(t);
    await owned(f);
    f.adapter.pending = true;
    await f.repository.transact(USER, async (state) => {
      state.portfolios[0].state = "attention";
    });
    let original: Execution | undefined;
    mutateBeforeDurable(t, f, (state) => {
      const p = state.portfolios[0],
        e = p.executions[0];
      assert.ok(e);
      original = structuredClone(e);
      switch (change) {
        case "revision":
          p.revision++;
          break;
        case "control":
          p.control_id = "fixture_changed_control";
          break;
        case "account":
          p.account_id = "fixture_changed_account";
          p.venue_accounts = { perps: p.account_id };
          break;
        case "ownership":
          p.sleeves[0].lots[e.key].quantity = "0.19";
          break;
        case "preferences":
          p.preferences.budget_usdc = "90";
          break;
        case "loss":
          p.loss_latched = true;
          break;
        case "reconciliation":
          p.reconciliation = "incomplete";
          break;
        case "last_error":
          p.last_error = {
            at: now(),
            code: "SOURCE_STALE",
            message: "fixture later source failure",
            retryable: true,
          };
          break;
        case "source_error":
          p.source_read_error = {
            at: now(),
            code: "SOURCE_STALE",
            message: "fixture later source failure",
            retryable: true,
            read_scope: "source",
          };
          break;
        case "blocker":
          p.target_blocker = {
            ...p.target_blocker!,
            evaluated_revision: p.revision + 1,
          };
          break;
        case "frozen_target":
          e.target_quantity = "0.09";
          break;
        case "fingerprint":
          e.fingerprint = "fixture_forged_fingerprint";
          break;
        case "task":
          e.task_id = "fixture_original_task";
          break;
        case "observed_quantity":
          e.observed_quantity = "0.15";
          break;
        case "unfilled_allocations":
          e.unfilled_allocations = { [p.sleeves[0].copy_id]: "-0.05" };
          break;
        case "retirement":
          e.retirement = {} as NonNullable<Execution["retirement"]>;
          break;
        case "first_packet":
          e.first_submission_failure = {
            code: "EXECUTOR_UNAVAILABLE",
            reason_code: "OTHER",
            retryable: true,
            at: now(),
            elapsed_ms: 1,
          };
          break;
        case "submitted_status":
          e.status = "submitted";
          e.task_id = "fixture_original_task";
          break;
        case "partial_status":
          e.status = "partially_filled";
          e.task_id = "fixture_original_task";
          e.observed_quantity = "0.15";
          break;
        case "duplicate_id":
          p.executions.push(structuredClone(e));
          break;
        case "new_unknown": {
          const closed = structuredClone(p);
          closed.id = "fixture_late_closed";
          closed.state = "closed";
          closed.executions = [unknownExecution()];
          state.portfolios.push(closed);
          break;
        }
        case "old_queued": {
          const old = unknownExecution();
          old.id = "fixture_older_queued";
          old.key = "perps:ETH";
          old.status = "queued";
          p.executions.push(old);
          break;
        }
        case "expiry":
          f.advance(60001);
          break;
      }
    });
    await f.tick();
    assert.ok(original);
    assert.equal(f.adapter.submitted.length, 0);
    assert.equal(
      f.adapter.accounts,
      2,
      "no fresh submit preflight is entered after the changed authority",
    );
    const e = (await f.read()).executions.find((e) => e.id === original!.id)!;
    assert.equal(e.id, original.id);
    assert.equal(e.created_at, original.created_at);
    assert.equal(e.expires_at, original.expires_at);
    if (change === "task") {
      assert.equal(e.status, "queued");
      assert.equal(e.task_id, "fixture_original_task");
    } else if (change === "submitted_status")
      assert.equal(e.status, "submitted");
    else if (change === "partial_status") {
      assert.equal(e.status, "partially_filled");
      assert.equal(e.observed_quantity, "0.15");
    } else if (change === "retirement")
      assert.equal(e.status, "uncertain", "bad stored receipt remains unknown");
    else assert.equal(e.status, "superseded");
    if (change === "new_unknown") {
      const closed = (await f.repository.read(USER)).portfolios[1];
      assert.equal(closed.executions[0].status, "uncertain");
      assert.equal(f.adapter.reconciled, 1);
    }
  });
}
it("the pending reduction attention exception is not reconstructed from a queued execution on a later callback", async (t) => {
  const f = await blocked(t);
  await owned(f);
  f.adapter.pending = true;
  await f.repository.transact(USER, async (state) => {
    state.portfolios[0].state = "attention";
  });
  const transact = f.repository.transact.bind(f.repository);
  let ordinal = 0;
  const mocked = t.mock.method(
    f.repository,
    "transact",
    async <T>(user: string, work: MonitorCallback<T>) => {
      if (++ordinal === 3) throw new Error("fixture after-plan abort");
      return transact(user, work);
    },
  );
  await assert.rejects(f.tick(), /fixture after-plan abort/);
  mocked.mock.restore();
  const before = (await f.read()).executions[0];
  assert.equal(before.status, "queued");
  t.mock.method(f.adapter, "source", async () => {
    throw new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "fixture no fresh source",
      true,
      503,
      { reason_code: "READ_LOCAL_BUDGET_UNSENT", retry_after_ms: 1000 },
    );
  });
  await f.tick();
  const after = (await f.read()).executions[0];
  assert.equal(f.adapter.submitted.length, 0);
  assert.equal(after.id, before.id);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.expires_at, before.expires_at);
  assert.equal(after.status, "superseded");
});

it("a pending ordinary attention reduction cannot borrow the exception after a peer reduction has submitted", async (t) => {
  const f = await blocked(t);
  await owned(f);
  f.adapter.pending = true;
  await f.repository.transact(USER, async (state) => {
    const p = state.portfolios[0],
      sleeve = p.sleeves[1],
      key = "perps:ETH";
    p.state = "attention";
    sleeve.lots[key].quantity = "0.2";
    sleeve.lots[key].cost = "20";
    f.adapter.snap.positions[key] = "0.2";
  });
  await f.tick();
  const p = await f.read();
  assert.equal(f.adapter.submitted.length, 1);
  assert.equal(p.executions.filter((e) => e.status === "submitted").length, 1);
  assert.equal(p.executions.filter((e) => e.status === "superseded").length, 1);
  assert.equal(p.state, "attention");
  assert.ok(p.target_blocker);
});
it("pending cannot transfer existing sleeve ownership through opposite retained intent deltas", async (t) => {
  const f = await blocked(t);
  await owned(f);
  f.adapter.pending = true;
  await f.repository.transact(USER, async (state) => {
    const p = state.portfolios[0],
      source = p.sleeves[0],
      other = p.sleeves[1],
      key = "perps:BTC";
    other.lots = {
      [key]: {
        ...structuredClone(source.lots[key]),
        quantity: "0.1",
        cost: "10",
      },
    };
    other.intents = {
      [key]: { ...structuredClone(source.intents[key]), quantity: "0.2" },
    };
    f.adapter.snap.positions[key] = "0.3";
    f.adapter.snap.positions["perps:ETH"] = "0";
  });
  const before = await f.read(),
    sources = f.adapter.sources;
  await f.tick();
  const p = await f.read();
  assert.equal(f.adapter.sources, sources);
  assert.equal(f.adapter.submitted.length, 0);
  assert.equal(p.executions.length, 0);
  assert.deepEqual(
    p.sleeves.map((s) => s.lots),
    before.sleeves.map((s) => s.lots),
  );
  assert.deepEqual(
    p.sleeves.map((s) => Object.values(s.lots).map((l) => l.realized)),
    before.sleeves.map((s) => Object.values(s.lots).map((l) => l.realized)),
  );
});
it("pending owned reductions require an acknowledged exact cancellation before any new execution ID", async (t) => {
  const f = await blocked(t);
  await owned(f);
  f.adapter.pending = true;
  f.adapter.cleanupFails = true;
  await f.tick();
  const p = await f.read();
  assert.ok(f.adapter.cancelled.some((p) => p.purpose === "audit_source"));
  assert.equal(p.executions.length, 0);
  assert.equal(f.adapter.submitted.length, 0);
});
