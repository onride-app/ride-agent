import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge, startManagedCoreBridge } from "./core_bridge.js";
import { BridgeAdapter } from "./adapter.js";
import { AgentRunner } from "./runner.js";
import { perpsRecoveryRequest } from "./execution-core-recovery.js";
import { AgentService } from "./service.js";
import { PgRepository, Cursor } from "./repository.js";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import { SourceFeed } from "./source-feed.js";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
} from "./venue-read-transport.js";
import { recommend, fingerprint, type Execution } from "./domain.js";
import { candidate } from "./fixtures.js";
import { fromPlan } from "./service.js";
import {
  preparedPortfolioInput,
  preparedProposalInput,
  preparedWriteBinding,
} from "./prepared-portfolio.js";
const graphUser = "11111111-1111-4111-8111-111111111111";
async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}
class Time {
  at = 1793200000000;
  sequence = 0;
  events = new Map<number, { at: number; run(): void }>();
  clock = () => this.at;
  timers: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    },
    clearTimeout: (id) => {
      this.events.delete(id as number);
    },
  };
  async advance(ms: number) {
    const end = this.at + ms;
    await flush();
    for (;;) {
      const n = [...this.events]
        .filter(([, e]) => e.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!n) break;
      this.at = n[1].at;
      this.events.delete(n[0]);
      n[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  async run<T>(work: Promise<T>) {
    let done = false,
      value!: T,
      error: unknown;
    void work.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (let n = 0; !done && n < 25000; n++) await this.advance(1);
    assert.equal(done, true, "bounded local graph must settle");
    if (error) throw error;
    return value;
  }
}
async function fixture(
  t: TestContext,
  options: {
    cold?: boolean;
    failedCas?: boolean;
    unified?: boolean;
    threeSources?: boolean;
    existingSourceBackoff?: boolean;
  } = {},
) {
  const time = new Time();
  t.mock.method(Date, "now", time.clock);
  if (options.unified) {
    const prior = process.env.RIDE_AGENT_UNIFIED_ENABLED;
    process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
    t.after(() => {
      if (prior === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
      else process.env.RIDE_AGENT_UNIFIED_ENABLED = prior;
    });
  }
  const bridge = new CoreBridge(
      "https://core.fixture",
      "fixture-token",
      "postgresql://127.0.0.1:1/unused",
      "s".repeat(32),
      "mainnet",
      { infoReadRoute: "core" },
    ),
    b = bridge as any;
  await b.pool.end();
  const p = fromPlan(
    recommend(
      {
        budget_usdc: options.threeSources ? "60" : "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: options.threeSources ? "basket" : "single",
        basket_size: options.threeSources ? 3 : 1,
      },
      options.threeSources
        ? ["BTC", "ETH", "SOL"].map((asset, i) => ({
            ...candidate(i + 1),
            assets: [asset],
          }))
        : [candidate(1)],
    ),
  );
  p.account_id = "22222222-2222-4222-8222-222222222222";
  p.venue_accounts = { perps: p.account_id };
  p.state = "active";
  p.initial_equity = "1000";
  p.ledger_started_at = time.at - 10000;
  p.reconciliation = "complete";
  for (const sleeve of p.sleeves) {
    sleeve.state = "active";
    sleeve.initialized = true;
    sleeve.reviewed_at = time.at;
  }
  const identity = {
    account_id: p.account_id,
    network: 2,
    master: "0x" + "1".repeat(40),
    agent: "0x" + "2".repeat(40),
    wallet_generation: 1,
    status: 4,
    policy_revision: 1,
  };
  const source = "0x" + "3".repeat(40),
    sourceRows = p.sleeves.map((sleeve, i) => ({
      trader: sleeve.trader.id,
      address: "0x" + String(i + 3).repeat(40),
      asset: sleeve.trader.assets[0],
    })),
    sourceByAddress = new Map(sourceRows.map((row) => [row.address, row])),
    outboxes = new Map<string, any>(),
    reads: any[] = [],
    events: string[] = [],
    begins: any[] = [];
  let paid = options.cold ? 120 : options.unified ? 532 : 412,
    held = 0,
    frameId = "",
    frameOwner = "",
    dirty = false,
    generation = 1;
  let plan: any = options.cold
    ? null
    : options.unified
      ? { demand: 184, peaks: [164] }
      : { demand: 244, peaks: [224, 164, 164] };
  let pendingFrames = false,
    frameBarrier: Promise<void> | undefined;
  let identityBarrier: Promise<void> | undefined,
    financialBarrier: Promise<void> | undefined,
    posts = 0,
    identityCalls = 0;
  let denyOrdinarySources = false,
    ordinarySourceDenials = 0,
    sourcePoll: (() => void) | undefined;
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const coordinator = coreFrameCoordinator(
    "https://core.fixture",
    "fixture-token",
    (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("_end")) {
        assert.equal(body.frame_id, frameId);
        held = 0;
        events.push("end");
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      begins.push(body);
      if (frameBarrier) await frameBarrier;
      frameId = body.frame_id;
      frameOwner = body.owner;
      if (pendingFrames)
        return Response.json({
          state: "pending",
          frame_id: body.frame_id,
          expires_at: body.deadline_ms,
          retry_after_ms: 1000,
          reserved_weight: 0,
          capacity: 900,
          guaranteed_complete: false,
        });
      assert.ok(paid + body.weight <= 900);
      held = body.weight;
      return Response.json({
        state: "granted",
        frame_id: body.frame_id,
        expires_at: time.at + 20000,
        retry_after_ms: 0,
        reserved_weight: body.weight,
        capacity: 900,
        guaranteed_complete: false,
      });
    }) as typeof fetch,
    time.clock,
  );
  b.venueReads = new VenueReads(
    async (_url, init, context) => {
      const req = JSON.parse(String(init.body)),
        cost = readCost(req);
      const reserve = req.type === "userFunding" ? 120 : cost.reserve;
      const observedRead: any = {
        type: req.type,
        user: req.user,
        at: time.at,
        context,
      };
      reads.push(observedRead);
      if (
        denyOrdinarySources &&
        !context?.frame_id &&
        req.type === "clearinghouseState" &&
        sourceByAddress.has(req.user)
      ) {
        ordinarySourceDenials++;
        throw new CoordinatedReadError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          false,
          2000,
        );
      }
      if (context?.frame_id) {
        assert.equal(context.frame_id, frameId);
        assert.equal(context.frame_owner, frameOwner);
        assert.ok(
          held >= reserve,
          "Core must retain full conservative wire bound",
        );
        held -= reserve;
        paid += reserve;
      } else {
        if (paid + held + reserve > 900)
          throw new CoordinatedReadError(
            "VENUE_READ_BUDGET_EXHAUSTED",
            false,
            1000,
          );
        paid += reserve;
      }
      let data: any;
      switch (req.type) {
        case "userAbstraction":
          data = options.unified ? "unifiedAccount" : "disabled";
          break;
        case "perpDexs":
          data = [null];
          break;
        case "spotClearinghouseState":
          data = {
            balances: [{ coin: "USDC", token: 0, total: "1000", hold: "0" }],
          };
          break;
        case "clearinghouseState":
          data = {
            marginSummary: { accountValue: "1000" },
            withdrawable: "1000",
            assetPositions: sourceByAddress.has(req.user)
              ? [
                  {
                    position: {
                      coin: sourceByAddress.get(req.user)!.asset,
                      szi: "5",
                      entryPx: "100",
                      positionValue: "500",
                      leverage: { type: "cross", value: 5 },
                    },
                  },
                ]
              : [],
          };
          break;
        case "frontendOpenOrders":
        case "userFillsByTime":
        case "userFunding":
        case "userNonFundingLedgerUpdates":
          data = [];
          break;
        case "allMids":
          data = options.threeSources
            ? { BTC: "100", ETH: "100", SOL: "100" }
            : { BTC: "100" };
          break;
        case "meta":
          data = {
            collateralToken: 0,
            universe: (options.threeSources
              ? ["BTC", "ETH", "SOL"]
              : ["BTC"]
            ).map((name) => ({ name, maxLeverage: 8, szDecimals: 3 })),
          };
          break;
        default:
          assert.fail("unexpected local provider graph method " + req.type);
      }
      const actual = responseCost(cost, data);
      observedRead.actual = actual;
      paid += actual - reserve;
      if (context?.frame_id) held += reserve - actual;
      if (
        options.threeSources &&
        context?.frame_id &&
        req.type === "clearinghouseState" &&
        sourceByAddress.has(req.user) &&
        reads.filter(
          (read) =>
            read.type === "clearinghouseState" &&
            read.context?.frame_id === context.frame_id &&
            sourceByAddress.has(read.user),
        ).length === 3
      ) {
        assert.ok(
          held >= 184,
          "three real sources cannot borrow the second W184 scope",
        );
        assert.equal(paid + held, 900);
        events.push("three-source-second-scope-protected");
      }
      events.push("wire:" + req.type);
      const response = Response.json(data);
      recordCoordinatedEvidence(response, time.at);
      return response;
    },
    time.clock,
    2,
    {
      transport: "core_shared_info",
      budget,
      timers: time.timers,
      monotonicClock: time.clock,
      frameCoordinator: coordinator,
      report: () => {},
      observationPlans: {
        read: async (owner) => {
          if (dirty) throw new Error("fixture dirty lease busy");
          return {
            owner,
            generation: String(generation),
            plan,
            remainingTtlMs: plan ? 600000 : 0,
          };
        },
        begin: async (owner, _signal, expected) => {
          assert.equal(expected!.generation, String(generation));
          assert.equal(dirty, false);
          dirty = true;
          generation++;
          events.push("dirty");
          return {
            owner,
            generation: String(generation),
            plan,
            remainingTtlMs: plan ? 600000 : 0,
          };
        },
        complete: async (lease, value, signal) => {
          if (options.failedCas || signal.aborted) return false;
          assert.equal(lease.generation, String(generation));
          dirty = false;
          plan = structuredClone(value);
          events.push("clean");
          return true;
        },
      },
    },
  );
  b.core = async (op: string) => {
    if (op === "perps_account") {
      identityCalls++;
      if (identityBarrier) await identityBarrier;
      return identity;
    }
    assert.equal(op, "perps_submit");
    posts++;
    events.push("financial-post");
    assert.equal(
      held,
      0,
      "all unused parent credit must end before a financial POST",
    );
    if (financialBarrier) await financialBarrier;
    return { task_id: "original-fixture-task" };
  };
  b.resolve = async (id: string) => {
    if (!options.threeSources) return { address: source, tags: [] };
    const selected = sourceRows.find((row) => row.trader === id);
    assert.ok(
      selected,
      "the real CoreBridge source route must select a known distinct trader",
    );
    return { address: selected.address, tags: [] };
  };
  if (options.existingSourceBackoff) {
    b.sourceFeed.close();
    b.sourceFeed = new SourceFeed((id) => b.readSource(id), {
      clock: time.clock,
      // This integration drives the original interval callback explicitly;
      // source-prepared-backoff.test.ts exercises actual same-tick ordering.
      timers: {
        setInterval: (run) => {
          sourcePoll = run;
          return 1;
        },
        clearInterval: () => {
          sourcePoll = undefined;
        },
      },
    });
  }
  if (options.unified)
    b.orderSnapshots = {
      readAccount: async () => ({
        states: new Map([
          [
            "",
            {
              marginSummary: { accountValue: "1000" },
              withdrawable: "1000",
              assetPositions: [],
            },
          ],
        ]),
        orders: new Map([["", []]]),
        dispatches: {
          states: new Map([["", time.at]]),
          orders: new Map([["", time.at]]),
        },
      }),
      readAbstraction: async () => ({
        user: identity.master,
        dex_abstraction_enabled: false,
        dispatch_at: time.at,
        server_time: time.at,
      }),
    };
  b.pool = {
    query: async (sql: string, args: any[]) => {
      if (sql.startsWith("SELECT fingerprint"))
        return {
          rowCount: outboxes.has(args[0]) ? 1 : 0,
          rows: outboxes.has(args[0]) ? [outboxes.get(args[0])] : [],
        };
      if (sql.startsWith("INSERT INTO ride_agent_core_outbox")) {
        events.push("outbox");
        outboxes.set(args[0], { fingerprint: args[3], payload: args[4] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.startsWith("UPDATE ride_agent_core_outbox")) {
        outboxes.get(args[0]).response = args[1];
        return { rowCount: 1, rows: [] };
      }
      assert.fail("unexpected local SQL");
    },
    end: async () => {},
  };
  t.after(async () => bridge.close());
  async function prepare() {
    return (await time.run(
      bridge.operation("prepare_portfolio", {
        user_id: graphUser,
        portfolio: preparedPortfolioInput(p),
      }),
    )) as any;
  }
  async function audit(ready: any) {
    const snap = (await time.run(
      bridge.operation(
        "account",
        { user_id: graphUser, portfolio: p },
        undefined,
        undefined,
        ready.handle,
      ),
    )) as any;
    p.snapshot = snap;
    return snap;
  }
  async function proposal(ready: any) {
    const snapshot = (await time.run(
      bridge.operation(
        "source",
        { trader_id: p.sleeves[0].trader.id },
        undefined,
        undefined,
        ready.handle,
      ),
    )) as any;
    p.sleeves[0].intents = {
      "perps:BTC": { ...snapshot.positions[0], quantity: "0.1" },
    };
    p.sleeves[0].source_revision = snapshot.revision;
    const target = {
      key: "perps:BTC",
      target_quantity: "0.1",
      allocations: { [p.sleeves[0].copy_id]: "0.1" },
      revision: p.revision,
      reserve_usdc: "2.006000",
    };
    const bound = await bridge.operation(
      "prepare_execution",
      {
        user_id: graphUser,
        portfolio: preparedProposalInput(p),
        proposal: target,
      },
      undefined,
      undefined,
      ready.handle,
    );
    assert.deepEqual(bound, { ready: true });
    const frozen = {
      id: "execution-fixture-original",
      key: target.key,
      target_quantity: target.target_quantity,
      allocations: target.allocations,
      revision: p.revision,
      created_at: time.at,
      expires_at: time.at + 60000,
    };
    const e: Execution = {
      ...frozen,
      fingerprint: fingerprint(frozen),
      status: "queued",
      task_id: null,
      observed_quantity: null,
      reserve_usdc: target.reserve_usdc,
      error: null,
    };
    p.executions.push(e);
    return e;
  }
  return {
    bridge,
    b,
    p,
    time,
    identity,
    reads,
    events,
    begins,
    outboxes,
    prepare,
    audit,
    proposal,
    budget,
    denyOrdinarySources: (value: boolean) => {
      denyOrdinarySources = value;
    },
    ordinarySourceDenials: () => ordinarySourceDenials,
    pollSources: () => sourcePoll?.(),
    bank: () => ({ paid, held, dirty, generation, posts, identityCalls }),
    setPlan: (value: any) => {
      plan = value;
    },
    resetBank: (value: number) => {
      assert.equal(held, 0);
      paid = value;
    },
    planDemand: () => plan?.demand,
    pendingFrames: (value: boolean) => {
      pendingFrames = value;
    },
    frameBarrier: (value: Promise<void> | undefined) => {
      frameBarrier = value;
    },
    identityBarrier: (v: Promise<void> | undefined) => {
      identityBarrier = v;
    },
    financialBarrier: (v: Promise<void> | undefined) => {
      financialBarrier = v;
    },
  };
}
it("actual private account graph completes two fresh histories, binds one proposal and ends credit before one original financial POST", async (t) => {
  const f = await fixture(t),
    ready = await f.prepare();
  assert.equal(ready.mode, "warm");
  assert.equal(f.bank().paid + f.bank().held, 900);
  assert.equal(f.bank().dirty, false);
  await f.audit(ready);
  assert.equal(f.bank().dirty, false);
  const e = await f.proposal(ready);
  const result = await f.time.run(
    f.bridge.operation(
      "submit",
      { user_id: graphUser, portfolio: f.p, execution: e },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  assert.deepEqual(result, { task_id: "original-fixture-task" });
  assert.equal(f.bank().posts, 1);
  assert.equal(f.outboxes.size, 1);
  for (const type of [
    "userFillsByTime",
    "userFunding",
    "userNonFundingLedgerUpdates",
  ])
    assert.equal(f.reads.filter((r) => r.type === type).length, 2);
  assert.ok(f.events.indexOf("end") < f.events.indexOf("outbox"));
  assert.ok(f.events.indexOf("outbox") < f.events.indexOf("financial-post"));
  await assert.rejects(
    f.bridge.operation(
      "submit",
      { user_id: graphUser, portfolio: f.p, execution: e },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  assert.equal(f.bank().posts, 1);
});
it("cold real account graph can learn a clean single scope but cannot bind or create an execution", async (t) => {
  const f = await fixture(t, { cold: true }),
    ready = await f.prepare();
  assert.equal(ready.mode, "cold");
  await f.audit(ready);
  assert.equal(f.bank().dirty, false);
  await assert.rejects(f.proposal(ready));
  assert.equal(f.p.executions.length, 0);
  assert.equal(f.outboxes.size, 0);
  assert.equal(f.bank().posts, 0);
});
it("first-audit clean CAS failure returns no audit success and cannot authorize a proposal", async (t) => {
  const f = await fixture(t, { failedCas: true }),
    ready = await f.prepare();
  await assert.rejects(f.audit(ready));
  assert.equal(f.bank().dirty, true);
  await assert.rejects(
    f.bridge.operation(
      "prepare_execution",
      {
        user_id: graphUser,
        portfolio: preparedProposalInput(f.p),
        proposal: {},
      },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  assert.equal(f.p.executions.length, 0);
  assert.equal(f.bank().posts, 0);
});
it("foreign capabilities, changed control and changed frozen target never reach an outbox", async (t) => {
  const f = await fixture(t),
    ready = await f.prepare();
  await assert.rejects(
    f.bridge.operation(
      "account",
      { user_id: "foreign", portfolio: f.p },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  await f.audit(ready);
  const e = await f.proposal(ready),
    original = e.target_quantity;
  e.target_quantity = "0.2";
  await assert.rejects(
    f.bridge.operation(
      "submit",
      { user_id: graphUser, portfolio: f.p, execution: e },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  e.target_quantity = original;
  f.p.control_id = "changed";
  await assert.rejects(
    f.bridge.operation(
      "submit",
      { user_id: graphUser, portfolio: f.p, execution: e },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  assert.equal(f.outboxes.size, 0);
  assert.equal(f.bank().posts, 0);
});
it("same-key concurrent preparation is gated before the first asynchronous identity lookup", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.identityBarrier(new Promise<void>((r) => (release = r)));
  const first = f.prepare();
  await flush();
  const second = (await f.bridge.operation("prepare_portfolio", {
    user_id: graphUser,
    portfolio: preparedPortfolioInput(f.p),
  })) as any;
  assert.equal(second.state, "pending");
  assert.equal(f.bank().identityCalls, 1);
  release();
  const ready = await first;
  assert.equal(ready.state, "ready");
  assert.equal(f.begins.length, 1);
  assert.equal(f.b.preparedEntries.size, 1);
});
it("an already-outboxed original financial POST is not interrupted by parent expiry or replayed", async (t) => {
  const f = await fixture(t),
    ready = await f.prepare();
  await f.audit(ready);
  const e = await f.proposal(ready);
  let release!: () => void;
  f.financialBarrier(new Promise<void>((r) => (release = r)));
  const submit = f.bridge.operation(
    "submit",
    { user_id: graphUser, portfolio: f.p, execution: e },
    undefined,
    undefined,
    ready.handle,
  );
  for (let i = 0; !f.bank().posts && i < 20000; i++) await f.time.advance(1);
  assert.equal(f.bank().posts, 1);
  assert.equal(f.outboxes.size, 1);
  assert.equal(f.bank().held, 0);
  await f.time.advance(21000);
  release();
  assert.deepEqual(await submit, { task_id: "original-fixture-task" });
  assert.equal(f.bank().posts, 1);
  assert.equal(f.outboxes.get(e.id).response.task_id, "original-fixture-task");
});
it("compact metadata and history fold markers do not alter the bound financial authority or frozen wire", async (t) => {
  const f = await fixture(t);
  const hash = preparedWriteBinding(f.p),
    input = preparedPortfolioInput(f.p);
  (f.p as any).__decision_history_version = 10;
  f.p.decisions = [];
  assert.equal(preparedWriteBinding(f.p), hash);
  const compact = JSON.stringify(input);
  for (const key of [
    "executions",
    "snapshot",
    "fills",
    "decisions",
    "seen_fills",
  ])
    assert.equal(compact.includes('"' + key + '"'), false);
  const changed = structuredClone(f.p);
  changed.preferences.budget_usdc = "21";
  assert.notEqual(preparedWriteBinding(changed), hash);
  changed.preferences.budget_usdc = f.p.preferences.budget_usdc;
  changed.sleeves[0].intents["perps:BTC"] = {} as any;
  assert.notEqual(preparedWriteBinding(changed), hash);
});

it("actual unified WS history-fenced graph completes a production-sized warm184 parent without cached account reuse", async (t) => {
  const f = await fixture(t, { unified: true }),
    ready = await f.prepare();
  assert.equal(f.begins[0].weight, 368);
  assert.equal(f.bank().paid + f.bank().held, 900);
  await f.audit(ready);
  const e = await f.proposal(ready);
  const result = await f.time.run(
    f.bridge.operation(
      "submit",
      { user_id: graphUser, portfolio: f.p, execution: e },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  assert.deepEqual(result, { task_id: "original-fixture-task" });
  for (const type of [
    "userFillsByTime",
    "userFunding",
    "userNonFundingLedgerUpdates",
    "spotClearinghouseState",
  ])
    assert.equal(f.reads.filter((r) => r.type === type).length, 2);
  assert.equal(f.bank().posts, 1);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.bank().held, 0);
});

it("public source observation marker changes do not alter authority, while intent evidence and controls do", async (t) => {
  const f = await fixture(t),
    hash = preparedWriteBinding(f.p);
  f.p.sleeves[0].last_source_at = f.time.at + 1;
  assert.equal(preparedWriteBinding(f.p), hash);
  const sourceIntent = {
    key: "perps:BTC",
    market: "perps" as const,
    asset: "BTC",
    quantity: "0.1",
    price: "100",
    source_entry_price: "100",
    source_leverage: 5,
    source_revision: "same",
    observed_at: f.time.at,
  };
  f.p.sleeves[0].intents[sourceIntent.key] = sourceIntent;
  const withIntent = preparedWriteBinding(f.p);
  for (const [field, value] of [
    ["quantity", "0.2"],
    ["price", "101"],
    ["observed_at", f.time.at + 2],
    ["source_revision", "changed"],
  ] as const) {
    const p = structuredClone(f.p);
    (p.sleeves[0].intents["perps:BTC"] as any)[field] = value;
    assert.notEqual(preparedWriteBinding(p), withIntent);
  }
  const revision = structuredClone(f.p);
  revision.revision++;
  assert.notEqual(preparedWriteBinding(revision), withIntent);
});

for (const demand of [451, 900])
  it(`known single-scope${demand} remains legacy-supported without booking an oversized pair`, async (t) => {
    const f = await fixture(t);
    f.setPlan({ demand, peaks: [demand - 20] });
    const result = await f.prepare();
    assert.deepEqual(result, { state: "unsupported" });
    assert.equal(f.begins.length, 0);
    assert.equal(f.budget.snapshot().observation_active, false);
    assert.equal(f.bank().dirty, false);
    assert.equal(f.p.executions.length, 0);
    assert.equal(f.b.preparedEntries.size, 0);
  });
it("testnet and unmanaged read routes return unsupported without invoking paired credit", async (t) => {
  const f = await fixture(t);
  f.b.network = "testnet";
  assert.deepEqual(await f.prepare(), { state: "unsupported" });
  f.b.network = "mainnet";
  f.b.infoReadRoute = "official";
  assert.deepEqual(await f.prepare(), { state: "unsupported" });
  assert.equal(f.begins.length, 0);
  assert.equal(f.bank().posts, 0);
});

it("successful audit registers a repeated selected trader and identical scope only once", async (t) => {
  const f = await fixture(t);
  f.p.sleeves.push(structuredClone(f.p.sleeves[0]));
  let selectedIds: string[] = [];
  const original = f.b.sourceFeed.registerPreparedSources.bind(f.b.sourceFeed);
  t.mock.method(
    f.b.sourceFeed,
    "registerPreparedSources",
    (selected: any[], limits: any) => {
      selectedIds = selected.map((source) => source.id);
      return original(selected, limits);
    },
  );
  const ready = await f.prepare();
  await f.audit(ready);
  assert.deepEqual(selectedIds, [f.p.sleeves[0].trader.id]);
  assert.equal(f.bank().dirty, false);
  await f.bridge.operation(
    "finish_portfolio",
    { user_id: graphUser },
    undefined,
    undefined,
    ready.handle,
  );
});

for (const { threeSources, existingSourceBackoff } of [
  { threeSources: false, existingSourceBackoff: false },
  { threeSources: true, existingSourceBackoff: false },
  { threeSources: true, existingSourceBackoff: true },
])
  it(
    "actual Runner and real PostgreSQL commits traverse authenticated managed HTTP, both fresh scopes and one original outbox (" +
      (existingSourceBackoff
        ? "three distinct sources after existing UNSENT backoff"
        : threeSources
          ? "three distinct sources"
          : "one source") +
      ")",
    { skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL, timeout: 30000 },
    async (t) => {
      const f = await fixture(t, {
          unified: true,
          threeSources,
          existingSourceBackoff,
        }),
        url = new URL(process.env.RIDE_AGENT_TEST_DATABASE_URL!);
      assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      const admin = new pg.Pool({ connectionString: url.toString(), max: 2 }),
        schema = "prepared_graph_" + randomUUID().replaceAll("-", "");
      await admin.query("CREATE SCHEMA " + schema);
      url.searchParams.set("options", "-c search_path=" + schema);
      let closeRunner = async () => {};
      const repository = new PgRepository(url.toString());
      await repository.migrate();
      t.after(async () => {
        await closeRunner();
        await repository.close();
        await admin.query("DROP SCHEMA " + schema + " CASCADE");
        await admin.end();
      });
      const fixtureEnv: Record<string, string> = {
        RIDE_AGENT_EXECUTOR_TOKEN: "e".repeat(48),
        RIDE_AGENT_CORE_URL: "https://core.fixture",
        RIDE_AGENT_CORE_SERVICE_TOKEN: "fixture-token",
        RIDE_AGENT_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
        RIDE_AGENT_TRADER_ID_SALT: "s".repeat(32),
        RIDE_AGENT_NETWORK: "mainnet",
        RIDE_AGENT_INFO_READ_ROUTE: "core",
      };
      for (const [key, value] of Object.entries(fixtureEnv)) {
        const old = process.env[key];
        process.env[key] = value;
        t.after(() => {
          if (old === undefined) delete process.env[key];
          else process.env[key] = old;
        });
      }
      // Only startup dependencies are fixture transports; the actual authenticated
      // Express route, operation dispatcher and all financial read functions run.
      t.mock.method(
        CoreBridge.prototype,
        "migrate",
        async function (this: CoreBridge) {
          await (this as any).pool.end();
          Object.assign(this, f.b);
        },
      );
      const managed = await startManagedCoreBridge({
        host: "127.0.0.1",
        port: 0,
      });
      t.after(async () => managed.close());
      const adapter = new BridgeAdapter(
        "http://127.0.0.1:" + (managed.listener.address() as AddressInfo).port,
        fixtureEnv.RIDE_AGENT_EXECUTOR_TOKEN,
      );
      adapter.notify = async () => {};
      const originalHistory = Array.from({ length: 5 }, (_, i) => {
        const frozen = {
          id: "paired_old_retired_" + i,
          key: "perps:BTC",
          target_quantity: "0.1",
          allocations: { [f.p.sleeves[0].copy_id]: "0.1" },
          revision: f.p.revision,
          created_at: f.time.at - 180000 - i,
          expires_at: f.time.at - 120000 - i,
        };
        const e: Execution = {
          ...frozen,
          fingerprint: fingerprint(frozen),
          status: "failed",
          task_id: null,
          observed_quantity: null,
          reserve_usdc: "2",
          error: null,
        };
        const request = perpsRecoveryRequest(graphUser, f.p.account_id, e)!;
        assert.ok(request);
        e.retirement = {
          protocol_version: 1,
          retirement: "original_absence_retired",
          reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED",
          proof: {
            ...request,
            network: "mainnet",
            observed_at: f.time.at - 1,
            current_execution_epoch: "33333333-3333-4333-8333-333333333333",
            retirement_epoch: "44444444-4444-4444-8444-444444444444",
            tombstone_id: "55555555-5555-4555-8555-555555555555",
            retired_at: f.time.at - 2,
            serialized_absence_check: true,
            permanent_original_id_fence: true,
            historical_bindings_checked: true,
          },
        };
        return e;
      });
      f.p.executions.push(...originalHistory);
      await repository.transact(graphUser, async (state) => {
        state.portfolios.push(f.p);
      });
      const runner = new AgentRunner(
        new AgentService(
          repository,
          adapter,
          "https://fixture.invalid",
          new Cursor("s".repeat(32)),
        ),
      );
      closeRunner = () => runner.closeNotifications();
      async function drive<T>(work: Promise<T>) {
        let done = false,
          value!: T,
          error: unknown;
        void work.then(
          (v) => {
            done = true;
            value = v;
          },
          (e) => {
            done = true;
            error = e;
          },
        );
        for (let n = 0; !done && n < 25000; n++) {
          await f.time.advance(1);
          await new Promise<void>((r) => setTimeout(r, 1));
        }
        assert.equal(
          done,
          true,
          "real loopback pipeline must settle inside the original window",
        );
        if (error) throw error;
        return value;
      }
      await drive(runner.tick(graphUser));
      let state = await repository.read(graphUser);
      assert.equal(
        state.portfolios[0].executions.length,
        originalHistory.length,
        "discovery cannot materialize a financial identifier",
      );
      assert.equal(f.bank().posts, 0);
      await flush();
      assert.equal(f.bank().held, 0);
      await f.time.advance(60001);
      // The preceding charges have really aged out of the local ledger. This
      // finite external-ledger fixture offers just enough room for the warm pair.
      f.resetBank(900 - 2 * f.planDemand());
      let originalRetryAt = 0;
      const sourceRetryAt = new Map<string, number>();
      if (existingSourceBackoff) {
        f.denyOrdinarySources(true);
        for (const sleeve of f.p.sleeves)
          await assert.rejects(f.time.run(f.bridge.source(sleeve.trader.id)), {
            code: "VENUE_READ_BUDGET_EXHAUSTED",
          });
        assert.equal(f.ordinarySourceDenials(), 3);
        originalRetryAt = Math.max(
          ...f.p.sleeves.map(
            (s) => f.b.sourceFeed.interests.get(s.trader.id).failure.retryAt,
          ),
        );
        for (const s of f.p.sleeves)
          sourceRetryAt.set(
            (await f.b.resolve(s.trader.id)).address,
            f.b.sourceFeed.interests.get(s.trader.id).failure.retryAt,
          );
        f.denyOrdinarySources(false);
        // The existing background callback wins the retryAt turn, including
        // the third selected source not yet consumed by the two workers.
        f.time.timers.setTimeout(
          () => f.pollSources(),
          originalRetryAt - f.time.at,
        );
      }
      const before = f.reads.length;
      await drive(runner.tick(graphUser));
      state = await repository.read(graphUser);
      const executions = state.portfolios[0].executions.filter(
        (e) => !originalHistory.some((old) => old.id === e.id),
      );
      assert.deepEqual(
        state.portfolios[0].executions.filter((e) =>
          originalHistory.some((old) => old.id === e.id),
        ),
        originalHistory,
      );
      assert.equal(
        executions.length,
        1,
        "only one new original target is materialized in the paired window",
      );
      assert.equal(executions[0].status, "submitted");
      assert.equal(executions[0].first_submission_failure, undefined);
      assert.equal(f.outboxes.size, 1);
      assert.equal(f.bank().posts, 1);
      for (const type of [
        "userFillsByTime",
        "userFunding",
        "userNonFundingLedgerUpdates",
        "spotClearinghouseState",
      ])
        assert.equal(
          f.reads.slice(before).filter((r) => r.type === type).length,
          2,
          "each fresh financial scope preserves " + type,
        );
      const captured = f.outboxes.get(executions[0].id);
      assert.equal(captured.fingerprint, executions[0].fingerprint);
      assert.equal(captured.payload.execution_id, executions[0].id);
      assert.equal(captured.response.task_id, executions[0].task_id);
      assert.equal(f.bank().held, 0);
      assert.equal(f.bank().dirty, false);
      if (threeSources) {
        const sourceReads = f.reads
          .slice(before)
          .filter(
            (read) =>
              read.type === "clearinghouseState" &&
              read.user !== f.identity.master,
          );
        assert.equal(sourceReads.length, 3);
        if (existingSourceBackoff) {
          assert.ok(
            sourceReads.every(
              (read) => read.at >= sourceRetryAt.get(read.user)!,
            ),
          );
          assert.ok(sourceReads.every((read) => !!read.context?.frame_id));
          assert.equal(
            f.ordinarySourceDenials(),
            3,
            "the existing failure is not renewed by another unframed background attempt",
          );
          assert.equal(f.b.sourceFeed.preparedRetryCount, 0);
        }
        assert.equal(
          new Set(sourceReads.map((read) => read.user)).size,
          3,
          "distinct provider addresses prevent SourceFeed singleflight from hiding concurrency",
        );
        assert.ok(sourceReads.every((read) => f.time.at - read.at <= 5000));
        assert.equal(
          sourceReads.reduce((sum, read) => sum + read.actual, 0),
          6,
        );
        const firstSource = f.reads.slice(before).indexOf(sourceReads[0]);
        const lastSource = f.reads.slice(before).indexOf(sourceReads.at(-1)!);
        // The full managed graph retains its real metadata charges: A144,
        // three distinct native source reads S6, and a fresh second B102.
        // The real five-second backoff expires allMids too, so that graph
        // performs its normal extra2 read rather than reusing stale metadata.
        // Both children still book W184; S may only spend A's unused credit.
        assert.equal(
          f.reads
            .slice(before, before + firstSource)
            .reduce((sum, read) => sum + read.actual, 0),
          144,
          "the first real account scope includes all A144 metadata costs",
        );
        assert.equal(
          f.reads
            .slice(before + lastSource + 1)
            .reduce((sum, read) => sum + read.actual, 0),
          existingSourceBackoff ? 104 : 102,
          "the second real account scope retains all fresh metadata costs",
        );
        assert.equal(f.begins.at(-1).weight, 2 * 184);
        assert.equal(f.planDemand(), 184);
        assert.ok(f.events.includes("three-source-second-scope-protected"));
        assert.equal(
          f.budget.snapshot().used,
          144 + 6 + (existingSourceBackoff ? 104 : 102),
        );
        assert.equal(
          f.bank().paid,
          900 - 2 * 184 + 144 + 6 + (existingSourceBackoff ? 104 : 102),
        );
      }
      const head = await repository.pool.query(
        "SELECT version::text FROM ride_agent_history_heads WHERE user_id=$1 AND portfolio_id=$2",
        [graphUser, f.p.id],
      );
      assert.ok(
        Number(head.rows[0]?.version) >= 1,
        "the actual decision history crossed a real PG commit",
      );
    },
  );
it("fixed copying preserves its ordinary full source-fill path without booking a paired window", async (t) => {
  const f = await fixture(t);
  f.p.sleeves[0].copy_mode = "fixed";
  assert.deepEqual(await f.prepare(), { state: "unsupported" });
  assert.equal(f.begins.length, 0);
  assert.equal(f.bank().identityCalls, 0);
  assert.equal(f.bank().dirty, false);
});
it("a first audit that learns a larger hint is rejected before a new execution ID can be created", async (t) => {
  const f = await fixture(t, { unified: true });
  f.setPlan({ demand: 164, peaks: [144] });
  const ready = await f.prepare();
  assert.equal(f.begins[0].weight, 328);
  await f.audit(ready);
  assert.equal(f.planDemand(), 184);
  await assert.rejects(f.proposal(ready), {
    code: "VENUE_COST_PLAN_UNAVAILABLE",
  });
  assert.equal(f.p.executions.length, 0);
  assert.equal(f.outboxes.size, 0);
  assert.equal(f.bank().posts, 0);
  assert.equal(f.bank().dirty, false);
});

it("pending cancellation during the first identity await cannot create a later reservation", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.identityBarrier(new Promise<void>((r) => (release = r)));
  const first = f.prepare();
  await flush();
  assert.equal(f.bank().identityCalls, 1);
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: preparedPortfolioInput(f.p),
    }),
    { ok: true },
  );
  release();
  await assert.rejects(first);
  assert.equal(f.begins.length, 0);
  assert.equal(f.b.preparedEntries.size, 0);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.reads.length, 0);
});
for (const late of ["pending", "ready"] as const)
  it(
    "pending cancellation releases only its exact late " +
      late +
      " factory reservation",
    async (t) => {
      const f = await fixture(t);
      f.pendingFrames(late === "pending");
      let release!: () => void;
      f.frameBarrier(new Promise<void>((r) => (release = r)));
      const first = f.prepare();
      await flush();
      assert.equal(f.begins.length, 1);
      await f.bridge.operation("cancel_prepared_portfolio", {
        user_id: graphUser,
        portfolio: preparedPortfolioInput(f.p),
      });
      assert.equal(f.b.preparedEntries.size, 0);
      release();
      await assert.rejects(first);
      assert.equal(f.events.filter((e) => e === "end").length, 1);
      assert.equal(f.bank().held, 0);
      assert.equal(f.bank().dirty, false);
      assert.equal(f.budget.snapshot().observation_active, false);
      assert.equal(f.reads.length, 0);
    },
  );
it("metadata cancellation cannot end an already ready peer", async (t) => {
  const f = await fixture(t),
    ready = await f.prepare();
  await f.bridge.operation("cancel_prepared_portfolio", {
    user_id: graphUser,
    portfolio: preparedPortfolioInput(f.p),
  });
  assert.equal(f.events.filter((e) => e === "end").length, 0);
  assert.equal(f.b.preparedEntries.size, 1);
  await f.audit(ready);
  assert.equal(f.bank().dirty, false);
});

it("foreign or changed stable metadata cannot cancel a pending generation, while its exact owner can", async (t) => {
  const f = await fixture(t);
  f.pendingFrames(true);
  assert.equal((await f.prepare()).state, "pending");
  const old = preparedPortfolioInput(f.p);
  await f.bridge.operation("cancel_prepared_portfolio", {
    user_id: "foreign",
    portfolio: old,
  });
  await f.bridge.operation("cancel_prepared_portfolio", {
    user_id: graphUser,
    portfolio: { ...old, control_id: "other-generation" },
  });
  assert.equal(f.b.preparedEntries.size, 1);
  assert.equal(f.events.filter((e) => e === "end").length, 0);
  await f.bridge.operation("cancel_prepared_portfolio", {
    user_id: graphUser,
    portfolio: old,
  });
  assert.equal(f.b.preparedEntries.size, 0);
  assert.equal(f.events.filter((e) => e === "end").length, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(f.bank().dirty, false);
});
it("changed fixed or control preparation metadata cannot terminate an already ready peer window", async (t) => {
  const f = await fixture(t),
    ready = await f.prepare(),
    old = preparedPortfolioInput(f.p);
  const fixed = structuredClone(old);
  fixed.sleeves[0].copy_mode = "fixed";
  assert.deepEqual(
    await f.bridge.operation("prepare_portfolio", {
      user_id: graphUser,
      portfolio: fixed,
    }),
    { state: "unsupported" },
  );
  assert.equal(
    (
      (await f.bridge.operation("prepare_portfolio", {
        user_id: graphUser,
        portfolio: { ...old, control_id: "changed" },
      })) as any
    ).state,
    "pending",
  );
  assert.equal(f.events.filter((e) => e === "end").length, 0);
  assert.equal(f.b.preparedEntries.size, 1);
  await f.audit(ready);
  assert.equal(f.bank().dirty, false);
});
