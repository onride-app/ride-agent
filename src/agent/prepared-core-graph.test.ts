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
import { EventEmitter } from "node:events";
import { submitObservationCancellation } from "./submit-observation-cancellation.js";
import { issueNativeSourcePlan } from "./native-source-plan.js";
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
import { AccountObservationPlans } from "./account-observation-plans.js";
import { PerpsSourceIdentities } from "./source-identities.js";
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

// Real loopback HTTP keeps its real20s cancellation. A timer yield may take
// more than1ms on a loaded host; keep the fixture's elapsed clock on that same
// timeline instead of counting yields as milliseconds.
function elapsedIoClock(time: Time, clock = () => performance.now()) {
  const started = clock(),
    initial = time.at;
  return () =>
    time.advance(
      Math.max(0, Math.floor(clock() - started) - (time.at - initial)),
    );
}

async function driveIo<T>(time: Time, work: Promise<T>) {
  const sync = elapsedIoClock(time);
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
    await sync();
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(
    done,
    true,
    "real I/O must settle within the original bounded window",
  );
  if (error) throw error;
  return value;
}

it("4ms I/O wakes preserve the original5s backoff before real20s HTTP cancellation without counting wakes as milliseconds", async () => {
  for (const aligned of [false, true]) {
    const time = new Time();
    let realElapsed = 0,
      fresh = false,
      cancelled = false;
    const sync = elapsedIoClock(time, () => realElapsed);
    time.timers.setTimeout(() => {
      fresh = true;
    }, 5000);
    // Deterministic scheduler model: Linux may deliver a requested1ms yield
    // every4ms. The unchanged real HTTP timer wins at20s if backoff is not due.
    while (!fresh) {
      realElapsed += 4;
      if (realElapsed >= 20000) {
        cancelled = true;
        break;
      }
      await (aligned ? sync() : time.advance(1));
    }
    assert.equal(cancelled, !aligned);
    assert.equal(fresh, aligned);
    assert.equal(time.at - 1793200000000, aligned ? 5000 : 4999);
    assert.equal(realElapsed, aligned ? 5000 : 20000);
  }
});
async function fixture(
  t: TestContext,
  options: {
    cold?: boolean;
    failedCas?: boolean;
    unified?: boolean;
    threeSources?: boolean;
    existingSourceBackoff?: boolean;
    concentratedSources?: boolean;
    nativeSources?: boolean;
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
      asset:
        options.concentratedSources && i < 2 ? "BTC" : sleeve.trader.assets[0],
    })),
    sourceByAddress = new Map(sourceRows.map((row) => [row.address, row])),
    outboxes = new Map<string, any>(),
    reads: any[] = [],
    events: string[] = [],
    begins: any[] = [];
  const nativeIdentities = new Map<
    string,
    { address: string; requires_rwa: boolean }
  >();
  if (options.nativeSources) {
    sourceRows.forEach((row, i) => {
      row.trader = b.sourceIdentities.id(row.address);
      p.sleeves[i].trader.id = row.trader;
      nativeIdentities.set(row.trader, {
        address: row.address,
        requires_rwa: false,
      });
    });
    b.sourceIdentities.resolve = async (id: string) => {
      const row = nativeIdentities.get(id);
      assert.ok(row);
      return { ...row };
    };
  }
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
    sourcePoll: (() => void) | undefined,
    fullSourceHistoryPage = false;
  let sourceHistoryPages: number[] | undefined,
    historySequence = 0;
  let slowSourceHistory = false;
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
        startTime: req.startTime,
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
        case "userDexAbstraction":
          data = false;
          break;
        case "userAbstraction":
          data =
            options.unified && req.user === identity.master
              ? "unifiedAccount"
              : "disabled";
          break;
        case "perpDexs":
          data = [null];
          break;
        case "perpCategories":
          data = [
            ["BTC", "crypto"],
            ["ETH", "crypto"],
            ["SOL", "crypto"],
          ];
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
          if (
            fullSourceHistoryPage &&
            req.type === "userFillsByTime" &&
            sourceByAddress.has(req.user)
          )
            data = Array.from({ length: 2000 }, (_, i) => ({
              tid: i,
              time: req.startTime + i,
            }));
          if (
            sourceHistoryPages &&
            req.type === "userFillsByTime" &&
            sourceByAddress.has(req.user)
          )
            data = Array.from(
              { length: sourceHistoryPages.shift() ?? 0 },
              (_, i) => {
                const sequence = historySequence++;
                return {
                  coin: sourceByAddress.get(req.user)!.asset,
                  side: sequence % 2 === 0 ? "B" : "A",
                  sz: "1",
                  px: "100",
                  tid: sequence + 1000,
                  oid: sequence + 2000,
                  startPosition: sequence % 2 === 0 ? "5" : "6",
                  closedPnl: "0",
                  fee: "0",
                  feeToken: "USDC",
                  time: req.startTime + i,
                };
              },
            );
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
          held >=
            (begins.at(-1).weight === 544
              ? 240
              : begins.at(-1).weight === 304
                ? 0
                : 184),
          "three real sources cannot borrow reserved B or H credit",
        );
        assert.equal(paid + held, 900);
        events.push("three-source-second-scope-protected");
      }
      events.push("wire:" + req.type);
      if (
        slowSourceHistory &&
        req.type === "userFillsByTime" &&
        sourceByAddress.has(req.user)
      )
        await new Promise<void>((resolve) =>
          time.timers.setTimeout(resolve, 6000),
        );
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
      freshSubmitReadIssuer: bridge,
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
      ...(options.nativeSources ? { nativeSourcePlanIssuer: bridge } : {}),
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
    if (options.nativeSources) {
      const row = await b.sourceIdentities.resolve(id);
      return {
        address: row.address,
        tags: row.requires_rwa ? ["category:stocks_rwa"] : [],
      };
    }
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
  async function prepare(purpose?: "audit_source", nativeGraph = false) {
    return (await time.run(
      bridge.operation(
        "prepare_portfolio",
        {
          user_id: graphUser,
          portfolio: preparedPortfolioInput(p, purpose),
        },
        undefined,
        undefined,
        undefined,
        nativeGraph ? "readonly-runner-native-v1" : undefined,
      ),
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
    fullSourceHistoryPage: () => {
      fullSourceHistoryPage = true;
    },
    sourceHistoryPages: (pages: number[]) => {
      sourceHistoryPages = [...pages];
      historySequence = 0;
    },
    slowSourceHistory: (value: boolean) => {
      slowSourceHistory = value;
    },
    diversifySources: () => {
      for (const [i, row] of sourceRows.entries())
        row.asset = p.sleeves[i].trader.assets[0];
    },
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
    sourceRows,
    nativeIdentities,
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
async function primeFixed286(f: Awaited<ReturnType<typeof fixture>>) {
  const owner = "f".repeat(64),
    frameOwner = "e".repeat(64);
  f.budget.refreshObservationPlan(owner, { demand: 184, peaks: [164] }, 600000);
  const sources = [1, 2, 3].map((n) => ({
    id: "trader_" + String(n).repeat(32),
    address: "0x" + String(n).repeat(40),
    requires_rwa: false as const,
  }));
  const token = issueNativeSourcePlan(
    {
      issuer: {},
      reader: {},
      budget: f.budget,
      costOwner: owner,
      frameOwner,
      firstDeadline: f.time.at + 100000,
      operationalBinding: "c".repeat(64),
      purpose: "audit_source",
      network: "mainnet",
    },
    { sources, nonClosedSleeves: 3, fixedSourceIds: [sources[0].id] },
    async () => {},
  );
  const supplements = f.budget.preparedSupplementPlan(
      frameOwner,
      [sources[0].id],
      token,
    ),
    interest = f.budget.beginObservationInterest(owner),
    parent = f.budget.beginObservationBundle(
      owner,
      184,
      1,
      interest,
      false,
      [sources[0].id],
      supplements,
    );
  const pay = async (
    ticket: any,
    reserve: number,
    actual = reserve,
    lane: "account" | "source" = "account",
  ) => {
    const wire = await f.time.run(
      f.budget.acquire(
        lane,
        reserve,
        "fixture-source",
        new AbortController().signal,
        false,
        ticket,
      ),
    );
    wire.sent();
    wire.settle(actual);
    wire.release();
  };
  const a = parent.beginChild();
  for (let i = 0; i < 7; i++) await pay(a, 20);
  for (let i = 0; i < 2; i++) await pay(a, 2);
  a.close(true);
  const s = parent.beginSupplement();
  for (let i = 0; i < 3; i++) await pay(s, 2, 2, "source");
  s.close(true);
  const h = parent.beginHistorySupplement(sources[0].id);
  await pay(h, 120, 100, "source");
  await pay(h, 120, 36, "source");
  h.close(true);
  parent.close(true);
  f.budget.endObservationInterest(interest);
  assert.equal((f.budget as any).recentObservationWeights.at(-1), 286);
}
function freshOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  const frozen = {
    id: "fresh-original-" + randomUUID(),
    key: "perps:BTC",
    target_quantity: "0",
    allocations: { [f.p.sleeves[0].copy_id]: "0" },
    revision: f.p.revision,
    created_at: f.time.at,
    expires_at: f.time.at + 60000,
  };
  const e: Execution = {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "queued",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "0.000000",
    error: null,
  };
  f.p.executions.push(e);
  return e;
}
function graphCaller(f: Awaited<ReturnType<typeof fixture>>, t: TestContext) {
  const req = Object.assign(new EventEmitter(), { aborted: false }),
    res = Object.assign(new EventEmitter(), { writableEnded: false });
  const caller = submitObservationCancellation(
    req as any,
    res as any,
    f.time.clock,
    f.time.timers,
    f.time.clock,
  );
  t.after(() => caller.close());
  return caller;
}

for (const unified of [false, true])
  it(
    "actual fresh CoreBridge submit after Fixed286 reads complete " +
      (unified ? "Unified3UA no-WS" : "Standard2UA") +
      " evidence before any real-PG outbox and keeps original financial wire",
    {
      skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL,
      timeout: 30000,
    },
    async (t) => {
      const f = await fixture(t, { unified });
      f.resetBank(0);
      f.setPlan({ demand: 244, peaks: [224] });
      if (unified)
        f.b.orderSnapshots = {
          readAccount: async () => {
            throw Error("fixture WS unavailable, retain full REST");
          },
          readAbstraction: async () => {
            throw Error("fixture WS abstraction unavailable");
          },
        };
      await primeFixed286(f);
      const url = new URL(process.env.RIDE_AGENT_TEST_DATABASE_URL!);
      assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      const admin = new pg.Pool({ connectionString: url.toString(), max: 2 }),
        schema = "fresh_submit_" + randomUUID().replaceAll("-", "");
      await admin.query("CREATE SCHEMA " + schema);
      url.searchParams.set("options", "-c search_path=" + schema);
      const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
      t.after(async () => {
        await pool.end();
        await admin.query("DROP SCHEMA " + schema + " CASCADE");
        await admin.end();
      });
      await pool.query(
        "CREATE TABLE ride_agent_core_outbox(execution_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,portfolio_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload JSONB NOT NULL,response JSONB)",
      );
      const plans = new AccountObservationPlans(pool);
      await plans.migrate();
      const owner = f.b.perpsCostOwner(
          graphUser,
          f.p,
          false,
          f.identity,
          f.p.account_id,
          [],
        ),
        signal = new AbortController().signal;
      const lease = await plans.begin(owner, signal);
      assert.equal(
        await plans.complete(lease, { demand: 244, peaks: [224] }, signal),
        true,
      );
      f.b.venueReads.observationPlans = plans;
      let selects = 0,
        inserts = 0;
      f.b.pool = {
        query: async (sql: string, args: any[]) => {
          if (sql.startsWith("SELECT fingerprint,payload,response")) selects++;
          if (sql.startsWith("INSERT INTO ride_agent_core_outbox")) {
            inserts++;
            assert.ok(f.reads.some((read) => read.type === "userFillsByTime"));
            assert.ok(f.reads.some((read) => read.type === "userFunding"));
          }
          return pool.query(sql, args);
        },
        end: async () => {},
      };
      const env: Record<string, string> = {
        RIDE_AGENT_EXECUTOR_TOKEN: "e".repeat(48),
        RIDE_AGENT_CORE_URL: "https://core.fixture",
        RIDE_AGENT_CORE_SERVICE_TOKEN: "fixture-token",
        RIDE_AGENT_DATABASE_URL: "postgresql://127.0.0.1:1/unused",
        RIDE_AGENT_TRADER_ID_SALT: "s".repeat(32),
        RIDE_AGENT_NETWORK: "mainnet",
        RIDE_AGENT_INFO_READ_ROUTE: "core",
      };
      for (const [key, value] of Object.entries(env)) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        });
      }
      // Startup dependencies are fixture I/O, but the actual authenticated HTTP
      // route issues the original caller and calls the real operation/submit code.
      t.mock.method(
        CoreBridge.prototype,
        "migrate",
        async function (this: CoreBridge) {
          await (this as any).pool.end();
          Object.assign(this, f.b);
          const previous = f.b.venueReads;
          const reads = new VenueReads(previous.fetcher, f.time.clock, 2, {
            transport: "core_shared_info",
            budget: f.budget,
            timers: f.time.timers,
            monotonicClock: f.time.clock,
            frameCoordinator: previous.frameCoordinator,
            observationPlans: plans,
            requireObservationPlanBinding: true,
            freshSubmitReadIssuer: this,
            report: () => {},
          });
          (this as any).venueReads = reads;
          f.b.venueReads = reads;
        },
      );
      const managed = await startManagedCoreBridge({
        host: "127.0.0.1",
        port: 0,
      });
      t.after(() => managed.close());
      const e = freshOriginal(f),
        frozen = structuredClone(e),
        started = f.time.at;
      let resume!: () => void;
      f.identityBarrier(
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
      );
      const work = fetch(
        "http://127.0.0.1:" +
          (managed.listener.address() as AddressInfo).port +
          "/internal/agent/submit",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + env.RIDE_AGENT_EXECUTOR_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            user_id: graphUser,
            portfolio: f.p,
            execution: e,
          }),
        },
      ).then(async (response) => {
        const value = await response.json();
        assert.equal(response.status, 200, JSON.stringify(value));
        return value;
      });
      // Let the real PG SELECT complete without advancing the synthetic caller.
      for (let n = 0; n < 50 && f.bank().identityCalls === 0; n++)
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(selects, 1);
      assert.equal(inserts, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_core_outbox",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(f.reads.length, 0);
      f.identityBarrier(undefined);
      resume();
      // Real PG I/O is yielded, while elapsed monotonic time consumes the fake
      // scope. This is not the old1ms-per-yield fixture clock.
      let done = false,
        result: any,
        failure: any;
      void work.then(
        (v) => {
          done = true;
          result = v;
        },
        (error) => {
          done = true;
          failure = error;
        },
      );
      let previous = performance.now();
      for (let n = 0; !done && n < 1000; n++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const now = performance.now();
        await f.time.advance(Math.max(1, Math.floor(now - previous)));
        previous = now;
      }
      assert.equal(done, true);
      if (failure) throw failure;
      assert.deepEqual(result, { task_id: "original-fixture-task" });
      assert.deepEqual(e, frozen);
      assert.ok(f.time.at - started < 20000);
      assert.equal(inserts, 1);
      assert.equal(f.bank().posts, 1);
      const row = (await pool.query("SELECT * FROM ride_agent_core_outbox"))
        .rows[0];
      assert.equal(row.execution_id, e.id);
      assert.equal(row.fingerprint, e.fingerprint);
      assert.equal(row.payload.created_at, e.created_at);
      assert.equal(row.payload.expires_at, e.expires_at);
      assert.equal(row.payload.target_quantity, "0");
      assert.equal(row.payload.entry_reference_price, null);
      assert.deepEqual(
        f.reads
          .filter((read) => read.type === "userAbstraction")
          .map((read) => read.user)
          .sort(),
        Array(unified ? 3 : 2).fill(f.identity.master),
      );
      for (const type of [
        "clearinghouseState",
        "frontendOpenOrders",
        "userFillsByTime",
        "userFunding",
        "userNonFundingLedgerUpdates",
      ])
        assert.ok(f.reads.some((read) => read.type === type));
      if (unified)
        for (const type of ["spotClearinghouseState", "perpDexs"])
          assert.ok(f.reads.some((read) => read.type === type));
      for (
        let n = 0;
        n < 50 && !f.b.venueReads.diagnostics().cost_plans.persisted;
        n++
      )
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(f.b.venueReads.diagnostics().cost_plans.persisted, 1);
      assert.ok(f.budget.snapshot().observation_pacing_ms > 0);
      assert.equal(f.begins[0].weight, 244);
      assert.ok(f.begins[0].deadline_ms <= started + 100000);
      // A saved accepted action returns unchanged even after its caller closes.
      const caller = graphCaller(f, t);
      caller.close();
      e.status = "uncertain";
      const before = f.reads.length;
      assert.deepEqual(
        await f.bridge.submit(graphUser, f.p, e, caller),
        result,
      );
      assert.equal(f.reads.length, before);
      assert.equal(inserts, 1);
      assert.equal(f.bank().posts, 1);
    },
  );

for (const kind of [
  "unknown",
  "task",
  "first-failure",
  "different-frozen-record",
  "unregistered",
] as const)
  it(`actual CoreBridge ${kind} caller retains old pacing and cannot mint the new purpose`, async (t) => {
    const f = await fixture(t, { unified: true });
    f.resetBank(0);
    await primeFixed286(f);
    const e = freshOriginal(f),
      caller = graphCaller(f, t);
    if (kind === "unknown") e.status = "uncertain";
    if (kind === "task") e.task_id = "old-task";
    if (kind === "first-failure")
      e.first_submission_failure = { producer: "old" } as any;
    if (kind === "different-frozen-record") {
      const prior = structuredClone(e);
      prior.target_quantity = "1";
      f.p.executions[0] = prior;
    }
    let issued = 0;
    const issue = f.b.venueReads.freshSubmitReadPurpose.bind(f.b.venueReads);
    f.b.venueReads.freshSubmitReadPurpose = (...args: any[]) => {
      issued++;
      return issue(...args);
    };
    await assert.rejects(
      f.time.run(
        f.bridge.submit(
          graphUser,
          f.p,
          e,
          kind === "unregistered" ? { ...caller } : caller,
        ),
      ),
      (error: any) => error.details?.reason_code === "READ_LOCAL_PACING",
    );
    assert.equal(issued, kind === "unregistered" ? 1 : 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.outboxes.size, 0);
    assert.equal(f.bank().posts, 0);
  });
for (const kind of [
  "control",
  "revision",
  "account",
  "state",
  "loss",
  "reconciliation",
  "asset-filter",
  "preferences",
  "sleeve",
  "intent",
  "frozen",
] as const)
  it(`fresh CoreBridge capability rejects changed ${kind} across its identity await before any venue wire`, async (t) => {
    const f = await fixture(t, { unified: true });
    f.resetBank(0);
    await primeFixed286(f);
    const e = freshOriginal(f),
      caller = graphCaller(f, t);
    let resume!: () => void;
    f.identityBarrier(
      new Promise<void>((resolve) => {
        resume = resolve;
      }),
    );
    const work = f.bridge.submit(graphUser, f.p, e, caller),
      failed = assert.rejects(work, { code: "VENUE_COST_PLAN_UNAVAILABLE" });
    await flush();
    assert.equal(f.bank().identityCalls, 1);
    switch (kind) {
      case "control":
        f.p.control_id = "changed";
        break;
      case "revision":
        f.p.revision++;
        break;
      case "account":
        f.p.venue_accounts!.perps = "foreign";
        break;
      case "state":
        f.p.state = "closing";
        break;
      case "loss":
        f.p.loss_latched = true;
        break;
      case "reconciliation":
        f.p.reconciliation = "incomplete";
        break;
      case "asset-filter":
        f.p.asset_filter_version = undefined;
        break;
      case "preferences":
        f.p.preferences.loss_trigger_pct++;
        break;
      case "sleeve":
        f.p.sleeves[0].stop_loss_pct++;
        break;
      case "intent":
        f.p.sleeves[0].intents[e.key] = { key: e.key, price: "100" } as any;
        break;
      case "frozen":
        e.target_quantity = "1";
        break;
    }
    f.identityBarrier(undefined);
    resume();
    await failed;
    assert.equal(f.reads.length, 0);
    assert.equal(f.outboxes.size, 0);
    assert.equal(f.bank().posts, 0);
  });
it("fresh scheduling never hashes unrelated historical JSON or treats it as current financial evidence", async (t) => {
  const f = await fixture(t, { unified: true });
  f.resetBank(0);
  await primeFixed286(f);
  const e = freshOriginal(f),
    caller = graphCaller(f, t);
  for (const field of ["decisions", "receipts", "snapshot", "seen_fills"])
    Object.defineProperty(f.p, field, {
      configurable: true,
      get() {
        assert.fail("irrelevant history getter: " + field);
      },
    });
  for (let n = 0; n < 1500; n++)
    f.p.executions.push({
      id: "old-" + n,
      status: "failed",
      toJSON() {
        assert.fail(
          "historical payload must not be serialized by live capability checks",
        );
      },
    } as any);
  assert.deepEqual(
    await f.time.run(f.bridge.submit(graphUser, f.p, e, caller)),
    { task_id: "original-fixture-task" },
  );
  assert.equal(f.outboxes.size, 1);
  assert.ok(f.reads.length > 0);
});
for (const changedAt of [2, 3])
  it(`trusted fresh Unified preflight retains mode guard${changedAt} and never writes an outbox after a real enum change`, async (t) => {
    const f = await fixture(t, { unified: true });
    f.resetBank(0);
    await primeFixed286(f);
    f.setPlan({ demand: 244, peaks: [224] });
    f.b.orderSnapshots = {
      readAccount: async () => {
        throw Error("unavailable");
      },
      readAbstraction: async () => {
        throw Error("unavailable");
      },
    };
    const read = f.b.venueReads.fetcher;
    let uas = 0;
    f.b.venueReads.fetcher = async (...args: any[]) => {
      const response = await read(...args);
      if (
        JSON.parse(String(args[1].body)).type === "userAbstraction" &&
        ++uas === changedAt
      ) {
        const changed = Response.json("disabled");
        recordCoordinatedEvidence(changed, f.time.at);
        return changed;
      }
      return response;
    };
    const e = freshOriginal(f);
    await assert.rejects(
      f.time.run(f.bridge.submit(graphUser, f.p, e, graphCaller(f, t))),
      { code: "ACCOUNT_STALE" },
    );
    assert.equal(uas, changedAt);
    assert.equal(f.outboxes.size, 0);
    assert.equal(f.bank().posts, 0);
    assert.ok(f.budget.snapshot().used > 286);
  });
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

async function localPacing(f: Awaited<ReturnType<typeof fixture>>) {
  const frame = f.budget.beginObservation("local-schedule-prior");
  const ticket = await f.budget.acquire(
    "account",
    20,
    "local-schedule-prior",
    new AbortController().signal,
    false,
    frame,
  );
  ticket.sent();
  ticket.settle(20);
  ticket.release();
  frame.close(true);
}

it("a readonly local-only pending entry can be cancelled exactly without ever owning a Core pin or grant", async (t) => {
  const f = await fixture(t);
  await localPacing(f);
  const pending = await f.prepare("audit_source");
  assert.equal(pending.state, "pending");
  assert.equal(pending.purpose, "audit_source");
  const entry = [...f.b.preparedEntries.values()][0] as any;
  assert.equal(entry.pin, undefined);
  assert.equal(entry.window, undefined);
  assert.equal(f.begins.length, 0);
  assert.equal(f.reads.length, 0);
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: preparedPortfolioInput(f.p, "audit_source"),
    }),
    { ok: true, pending_cancelled: true },
  );
  assert.equal(f.b.preparedEntries.size, 0);
  assert.equal(f.events.includes("end"), false);
  assert.equal(f.bank().dirty, false);
});

for (const change of ["control", "graph"] as const)
  it(`a ${change} change rejects a local pending episode without rebooking its FIRST or borrowing a peer`, async (t) => {
    const f = await fixture(t, { nativeSources: true });
    await localPacing(f);
    assert.equal((await f.prepare("audit_source", true)).state, "pending");
    const entry = [...f.b.preparedEntries.values()][0] as any;
    if (change === "control") f.p.control_id = "changed-control";
    await assert.rejects(f.prepare("audit_source", change !== "graph"), {
      code: "VENUE_COST_PLAN_UNAVAILABLE",
    });
    assert.equal(entry.expired, true);
    assert.equal(f.begins.length, 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.p.executions.length, 0);
  });

it("cancellation while the prepared metadata read is awaiting cannot turn a late local brand into a pending ACK", async (t) => {
  const f = await fixture(t);
  await localPacing(f);
  let release!: () => void,
    loaded = false;
  const old = f.b.venueReads.observationPlans.read.bind(
    f.b.venueReads.observationPlans,
  );
  f.b.venueReads.observationPlans.read = async (...args: any[]) => {
    loaded = true;
    await new Promise<void>((r) => {
      release = r;
    });
    return old(...args);
  };
  const work = f.prepare("audit_source");
  await flush();
  assert.equal(loaded, true);
  const cancelled = await f.bridge.operation("cancel_prepared_portfolio", {
    user_id: graphUser,
    portfolio: preparedPortfolioInput(f.p, "audit_source"),
  });
  assert.deepEqual(cancelled, { ok: true, pending_cancelled: false });
  release();
  await assert.rejects(work, { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.b.preparedEntries.size, 0);
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

for (const nativeGraph of [false, true])
  it(
    nativeGraph
      ? "native readonly graph refuses generic plan evidence and cannot be cancelled through the generic graph"
      : "a generic no-header readonly window keeps S120 and its existing plan-evidence graph",
    async (t) => {
      const f = await fixture(t, {
        unified: true,
        threeSources: true,
        nativeSources: true,
      });
      const ready = await f.prepare("audit_source", nativeGraph);
      assert.equal(ready.state, "ready");
      assert.equal(f.begins[0].weight, nativeGraph ? 214 : 304);
      await f.audit(ready);
      const before = f.reads.length;
      const work = () =>
        f.time.run(
          f.bridge.operation(
            "read_plan_evidence",
            {
              traders: f.p.sleeves.slice(0, 1).map((s) => s.trader),
            },
            undefined,
            undefined,
            ready.handle,
          ),
        );
      if (nativeGraph) {
        await assert.rejects(work());
        assert.equal(
          f.reads.length,
          before,
          "the generic graph cannot spend the bounded native pool",
        );
      } else {
        const result = await work();
        assert.ok(result);
        assert.ok(
          f.reads.length > before,
          "the old general-purpose read graph still dispatches normally",
        );
      }
      const compact = preparedPortfolioInput(f.p, "audit_source");
      assert.deepEqual(
        await f.bridge.operation(
          "cancel_prepared_portfolio",
          { user_id: graphUser, portfolio: compact },
          undefined,
          undefined,
          undefined,
          nativeGraph ? undefined : "readonly-runner-native-v1",
        ),
        { ok: true, pending_cancelled: false },
      );
      assert.ok(
        f.bank().held > 0,
        "a mismatched graph cannot release a live peer",
      );
      await f.bridge.operation(
        "finish_portfolio",
        { user_id: graphUser },
        undefined,
        undefined,
        ready.handle,
      );
      assert.equal(f.bank().held, 0);
      assert.equal(f.bank().posts, 0);
    },
  );

it("a pending native episode is cancelled only by its exact graph and never lends its pin to a generic replacement", async (t) => {
  const f = await fixture(t, {
    unified: true,
    threeSources: true,
    nativeSources: true,
  });
  f.pendingFrames(true);
  assert.equal((await f.prepare("audit_source", true)).state, "pending");
  const compact = preparedPortfolioInput(f.p, "audit_source"),
    original = structuredClone(f.begins[0]);
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: compact,
    }),
    { ok: true, pending_cancelled: false },
  );
  assert.equal(f.events.includes("end"), false);
  assert.equal((await f.prepare("audit_source", true)).state, "pending");
  assert.deepEqual(f.begins[1], original);
  assert.deepEqual(
    await f.bridge.operation(
      "cancel_prepared_portfolio",
      { user_id: graphUser, portfolio: compact },
      undefined,
      undefined,
      undefined,
      "readonly-runner-native-v1",
    ),
    { ok: true, pending_cancelled: true },
  );
  assert.equal(f.events.filter((e) => e === "end").length, 1);
  assert.equal(f.reads.length, 0);
});

it("fresh RWA authority cannot mint a discounted source graph from native candidate labels", async (t) => {
  const f = await fixture(t, {
    unified: true,
    threeSources: true,
    nativeSources: true,
  });
  f.nativeIdentities.get(f.p.sleeves[0].trader.id)!.requires_rwa = true;
  const ready = await f.prepare("audit_source", true);
  assert.equal(ready.state, "ready");
  assert.equal(
    f.begins[0].weight,
    304,
    "authoritative broader scope retains the whole original S120",
  );
  const entry = [...f.b.preparedEntries.values()][0] as any;
  assert.equal(entry.nativeSourcePlan, undefined);
  await f.bridge.operation(
    "finish_portfolio",
    { user_id: graphUser },
    undefined,
    undefined,
    ready.handle,
  );
  assert.equal(f.reads.length, 0);
});

it("a prediction-recognized source retains S120 even when its candidate labels and PG identity are native", async (t) => {
  const f = await fixture(t, {
    unified: true,
    threeSources: true,
    nativeSources: true,
  });
  const old = process.env.RIDE_AGENT_PREDICTION_ENABLED;
  process.env.RIDE_AGENT_PREDICTION_ENABLED = "true";
  t.after(() => {
    if (old === undefined) delete process.env.RIDE_AGENT_PREDICTION_ENABLED;
    else process.env.RIDE_AGENT_PREDICTION_ENABLED = old;
  });
  f.b.prediction.recognizes = async () => true;
  const ready = await f.prepare("audit_source", true);
  assert.equal(ready.state, "ready");
  assert.equal(f.begins[0].weight, 304);
  assert.equal(
    ([...f.b.preparedEntries.values()][0] as any).nativeSourcePlan,
    undefined,
  );
  await f.bridge.operation(
    "finish_portfolio",
    { user_id: graphUser },
    undefined,
    undefined,
    ready.handle,
  );
  assert.equal(f.reads.length, 0);
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

it("the actual readonly server graph reserves544 for complete A/S/F, rejects all financial entrypoints and keeps original outboxed recovery", async (t) => {
  const f = await fixture(t, { unified: true, threeSources: true });
  const fixed = f.p.sleeves[2];
  fixed.copy_mode = "fixed";
  fixed.fixed_last_fill_at = f.time.at - 10000;
  f.resetBank(356);
  const ready = await f.prepare("audit_source");
  assert.equal(ready.state, "ready");
  assert.equal(ready.mode, "warm");
  assert.equal(ready.purpose, "audit_source");
  assert.equal(ready.execution_eligible, false);
  assert.equal(f.begins.at(-1).weight, 544);
  await f.audit(ready);
  const sources = new Map<string, any>();
  for (const sleeve of f.p.sleeves)
    sources.set(
      sleeve.trader.id,
      await f.time.run(
        f.bridge.operation(
          "source",
          {
            trader_id: sleeve.trader.id,
          },
          undefined,
          undefined,
          ready.handle,
        ),
      ),
    );
  const source = sources.get(fixed.trader.id);
  const input = {
    trader_id: fixed.trader.id,
    market: "perps",
    start_at: fixed.fixed_last_fill_at,
    end_at: source.observed_at,
  };
  const result = (await f.time.run(
    f.bridge.operation(
      "source_fills",
      input,
      undefined,
      undefined,
      ready.handle,
    ),
  )) as any;
  assert.equal(result.complete, true);
  assert.deepEqual(result.fills, []);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.bank().paid, 356 + 144 + 6 + 20);
  assert.equal(f.bank().held, 374);
  const reads = f.reads.length;
  await assert.rejects(
    f.bridge.operation(
      "source_fills",
      { ...input, start_at: input.start_at! + 1 },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  await assert.rejects(f.proposal(ready));
  await assert.rejects(
    f.bridge.operation("bind", { user_id: graphUser, portfolio: f.p }),
  );
  const frozen = {
    id: "readonly-original-id",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: f.p.revision,
    created_at: f.time.at,
    expires_at: f.time.at + 60000,
  };
  const e: Execution = {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "queued",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "1",
    error: null,
  };
  await assert.rejects(
    f.bridge.operation(
      "submit",
      { user_id: graphUser, portfolio: f.p, execution: e },
      undefined,
      undefined,
      ready.handle,
    ),
  );
  await assert.rejects(
    f.bridge.operation("submit", {
      user_id: graphUser,
      portfolio: f.p,
      execution: e,
    }),
  );
  assert.equal(f.reads.length, reads);
  assert.equal(f.outboxes.size, 0);
  assert.equal(f.bank().posts, 0);
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: preparedPortfolioInput(f.p, "audit_source"),
    }),
    { ok: true, pending_cancelled: false },
  );
  const response = { task_id: "original-outboxed-task" };
  f.outboxes.set(e.id, {
    fingerprint: e.fingerprint,
    payload: { execution_id: e.id },
    response,
  });
  assert.deepEqual(await f.bridge.submit(graphUser, f.p, e), response);
  assert.equal(
    f.bank().posts,
    0,
    "existing frozen response is returned without a new financial call",
  );
  assert.equal(f.b.activeReadonlyControl("another-user", f.p), false);
  assert.equal(
    f.b.activeReadonlyControl(graphUser, {
      ...f.p,
      account_id: "other-account",
      venue_accounts: {},
    }),
    false,
  );
  assert.equal(
    f.b.activeReadonlyControl(graphUser, {
      ...f.p,
      control_id: "other-control",
    }),
    false,
  );
  assert.equal(f.p.executions.length, 0);
  await f.bridge.operation(
    "finish_portfolio",
    { user_id: graphUser },
    undefined,
    undefined,
    ready.handle,
  );
});

it("the real A164 graph can read authoritative RWA S46 and H500 plus its empty tail without borrowing any pool", async (t) => {
  const f = await fixture(t, { unified: true, threeSources: true });
  delete f.p.sleeves[0].copy_mode;
  f.p.sleeves[1].copy_mode = "proportional";
  const fixed = f.p.sleeves[2];
  fixed.copy_mode = "fixed";
  fixed.fixed_last_fill_at = f.time.at - 10000;
  const originalAccount = f.b.account.bind(f.b);
  f.b.account = async (...args: any[]) => {
    const value = await originalAccount(...args);
    await f.b.info({ type: "userDexAbstraction", user: f.identity.master });
    return value;
  };
  const oldRwa = process.env.RIDE_AGENT_RWA_ENABLED;
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  t.after(() => {
    if (oldRwa === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = oldRwa;
  });
  f.resetBank(356);
  const ready = await f.prepare("audit_source");
  await f.audit(ready);
  assert.equal(
    f.reads.reduce((sum, r) => sum + r.actual, 0),
    164,
  );
  assert.equal(f.planDemand(), 184);
  const resolve = f.b.resolve.bind(f.b);
  f.b.resolve = async (id: string) => ({
    ...(await resolve(id)),
    ...(id === fixed.trader.id ? { tags: ["category:stocks_rwa"] } : {}),
  });
  const start = f.reads.length;
  let snapshot: any;
  for (const sleeve of f.p.sleeves) {
    const source = await f.time.run(
      f.bridge.operation(
        "source",
        { trader_id: sleeve.trader.id },
        undefined,
        undefined,
        ready.handle,
      ),
    );
    if (sleeve === fixed) snapshot = source;
  }
  assert.equal(
    f.reads.slice(start).reduce((sum, r) => sum + r.actual, 0),
    46,
  );
  f.sourceHistoryPages([500, 0]);
  const history = (await f.time.run(
    f.bridge.operation(
      "source_fills",
      {
        trader_id: fixed.trader.id,
        market: "perps",
        start_at: fixed.fixed_last_fill_at,
        end_at: snapshot.observed_at,
      },
      undefined,
      undefined,
      ready.handle,
    ),
  )) as any;
  assert.equal(history.complete, true);
  assert.equal(history.fills.length, 500);
  assert.equal(
    f.reads.slice(start).filter((r) => r.type === "userFillsByTime").length,
    2,
  );
  assert.equal(f.bank().paid, 356 + 164 + 46 + 65);
  assert.equal(f.bank().held, 269);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.planDemand(), 184);
  assert.equal(f.p.executions.length, 0);
  assert.equal(f.bank().posts, 0);
});

it("readonly history preserves the full-page continuation and refuses its third120 dispatch without changing the original cursor", async (t) => {
  const f = await fixture(t, { unified: true, threeSources: true });
  const fixed = f.p.sleeves[2];
  fixed.copy_mode = "fixed";
  fixed.fixed_last_fill_at = f.time.at - 10000;
  f.resetBank(356);
  f.fullSourceHistoryPage();
  const ready = await f.prepare("audit_source");
  await f.audit(ready);
  const source = (await f.time.run(
    f.bridge.operation(
      "source",
      { trader_id: fixed.trader.id },
      undefined,
      undefined,
      ready.handle,
    ),
  )) as any;
  const before = f.reads.length,
    cursor = fixed.fixed_last_fill_at;
  await assert.rejects(
    f.time.run(
      f.bridge.operation(
        "source_fills",
        {
          trader_id: fixed.trader.id,
          market: "perps",
          start_at: cursor,
          end_at: source.observed_at,
        },
        undefined,
        undefined,
        ready.handle,
      ),
    ),
  );
  const history = f.reads
    .slice(before)
    .filter((r) => r.type === "userFillsByTime");
  assert.equal(history.length, 2);
  assert.ok(history.every((read) => read.actual === 120));
  assert.equal(fixed.fixed_last_fill_at, cursor);
  assert.equal(f.p.executions.length, 0);
  assert.equal(f.outboxes.size, 0);
  assert.equal(f.bank().posts, 0);
  assert.equal(f.bank().dirty, false);
});

it("a new history episode grows H240 to360 and rereads the complete original range instead of reusing paid partial pages", async (t) => {
  const f = await fixture(t, { unified: true, threeSources: true }),
    fixed = f.p.sleeves[2];
  fixed.copy_mode = "fixed";
  fixed.fixed_last_fill_at = f.time.at - 10000;
  f.resetBank(356);
  f.sourceHistoryPages([2000, 2000, 0]);
  let ready = await f.prepare("audit_source");
  await f.audit(ready);
  let source = (await f.time.run(
    f.bridge.operation(
      "source",
      { trader_id: fixed.trader.id },
      undefined,
      undefined,
      ready.handle,
    ),
  )) as any;
  const originalCursor = fixed.fixed_last_fill_at;
  await assert.rejects(
    f.time.run(
      f.bridge.operation(
        "source_fills",
        {
          trader_id: fixed.trader.id,
          market: "perps",
          start_at: originalCursor,
          end_at: source.observed_at,
        },
        undefined,
        undefined,
        ready.handle,
      ),
    ),
    (e) => {
      assert.equal((e as any).details.read_stage, "history");
      return true;
    },
  );
  assert.equal(fixed.fixed_last_fill_at, originalCursor);
  assert.equal(f.bank().paid, 356 + 144 + 2 + 240);
  await f.bridge.operation(
    "finish_portfolio",
    { user_id: graphUser },
    undefined,
    undefined,
    ready.handle,
  );
  await flush();
  await f.time.advance(60001);
  f.resetBank(236);
  f.sourceHistoryPages([2000, 2000, 0]);
  const before = f.reads.length;
  ready = await f.prepare("audit_source");
  assert.equal(f.begins.at(-1).weight, 664);
  await f.audit(ready);
  source = (await f.time.run(
    f.bridge.operation(
      "source",
      { trader_id: fixed.trader.id },
      undefined,
      undefined,
      ready.handle,
    ),
  )) as any;
  const result = (await f.time.run(
    f.bridge.operation(
      "source_fills",
      {
        trader_id: fixed.trader.id,
        market: "perps",
        start_at: originalCursor,
        end_at: source.observed_at,
      },
      undefined,
      undefined,
      ready.handle,
    ),
  )) as any;
  assert.equal(result.complete, true);
  assert.equal(result.fills.length, 4000);
  const pages = f.reads
    .slice(before)
    .filter(
      (r) => r.type === "userFillsByTime" && r.user !== f.identity.master,
    );
  assert.equal(pages.length, 3);
  assert.equal(pages[0].startTime, originalCursor);
  assert.equal(
    fixed.fixed_last_fill_at,
    originalCursor,
    "the server supplies complete evidence; only original Runner strategy can advance state",
  );
  assert.equal(f.planDemand(), 184);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.p.executions.length, 0);
  assert.equal(f.outboxes.size, 0);
});

it("readonly pending cancellation has exact acknowledgement and never claims a ready peer was cancelled", async (t) => {
  const f = await fixture(t, { unified: true });
  f.pendingFrames(true);
  const pending = await f.prepare("audit_source");
  assert.equal(pending.state, "pending");
  assert.equal(pending.purpose, "audit_source");
  assert.equal(pending.execution_eligible, false);
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: preparedPortfolioInput(f.p, "audit_source"),
    }),
    { ok: true, pending_cancelled: true },
  );
  assert.equal(f.b.preparedEntries.size, 0);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.reads.length, 0);
});

it("readonly strict cancellation confirms only the same expired window and leaves a live or foreign ready peer intact", async (t) => {
  const f = await fixture(t, { unified: true });
  const ready = await f.prepare("audit_source"),
    compact = preparedPortfolioInput(f.p, "audit_source");
  assert.equal(ready.state, "ready");
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: compact,
    }),
    { ok: true, pending_cancelled: false },
  );
  assert.equal(f.bank().held, 304);
  await f.time.advance(20001);
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: { ...compact, revision: compact.revision + 1 },
    }),
    { ok: true, pending_cancelled: false },
  );
  assert.deepEqual(
    await f.bridge.operation("cancel_prepared_portfolio", {
      user_id: graphUser,
      portfolio: compact,
    }),
    { ok: true, pending_cancelled: true },
  );
  await flush();
  assert.equal(f.b.preparedEntries.size, 0);
  assert.equal(f.bank().held, 0);
  assert.equal(f.bank().dirty, false);
  assert.equal(f.reads.length, 0);
  assert.equal(f.bank().posts, 0);
});

for (const {
  threeSources,
  existingSourceBackoff,
  readonlyFixed,
  incompleteHistory,
  slowHistory,
  nativeSources,
} of [
  {
    threeSources: false,
    existingSourceBackoff: false,
    readonlyFixed: false,
    incompleteHistory: false,
    slowHistory: false,
  },
  {
    threeSources: true,
    existingSourceBackoff: false,
    readonlyFixed: false,
    incompleteHistory: false,
    slowHistory: false,
  },
  {
    threeSources: true,
    existingSourceBackoff: true,
    readonlyFixed: false,
    incompleteHistory: false,
    slowHistory: false,
  },
  {
    threeSources: true,
    existingSourceBackoff: false,
    readonlyFixed: true,
    incompleteHistory: false,
    slowHistory: false,
  },
  {
    threeSources: true,
    existingSourceBackoff: false,
    readonlyFixed: true,
    incompleteHistory: true,
    slowHistory: false,
  },
  {
    threeSources: true,
    existingSourceBackoff: false,
    readonlyFixed: true,
    incompleteHistory: false,
    slowHistory: true,
  },
  {
    threeSources: true,
    existingSourceBackoff: false,
    readonlyFixed: true,
    incompleteHistory: false,
    slowHistory: false,
    nativeSources: true,
  },
])
  it(
    "actual Runner and real PostgreSQL commits traverse authenticated managed HTTP, " +
      (readonlyFixed
        ? "readonly mixedFixed A/S/F with zero financial identifiers ("
        : "both fresh scopes and one original outbox (") +
      (nativeSources
        ? "native graph complete original cursor strategy"
        : slowHistory
          ? "slow complete history cannot advance a stale source cursor"
          : incompleteHistory
            ? "full history page cannot advance its cursor"
            : readonlyFixed
              ? "complete original cursor strategy"
              : existingSourceBackoff
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
          concentratedSources: readonlyFixed,
          nativeSources,
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
      let actualBridge!: CoreBridge;
      t.mock.method(
        CoreBridge.prototype,
        "migrate",
        async function (this: CoreBridge) {
          await (this as any).pool.end();
          Object.assign(this, f.b);
          actualBridge = this;
          if (nativeSources)
            (this as any).venueReads.nativeSourcePlanIssuer = this;
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
      if (nativeSources) {
        const identities = new PerpsSourceIdentities(
          repository.pool,
          "s".repeat(32),
          async () => {
            assert.fail("known source identities must resolve from PG");
          },
        );
        await identities.migrate();
        await identities.remember(
          f.sourceRows.map((row) => ({
            address: row.address,
            requires_rwa: false,
          })),
        );
        f.b.sourceIdentities = identities;
        (actualBridge as any).sourceIdentities = identities;
      }
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
      if (readonlyFixed) {
        const fixed = f.p.sleeves[2];
        fixed.copy_mode = "fixed";
        fixed.fixed_margin_usdc = "0.4";
        fixed.fixed_last_fill_at = f.time.at - 10000;
        fixed.source_quantities = { "perps:SOL": "5" };
        fixed.fixed_targets = { "perps:SOL": "0.1" };
      }
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
        const sync = elapsedIoClock(f.time);
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
          await sync();
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
      if (readonlyFixed) {
        assert.equal(
          state.portfolios[0].target_blocker?.code,
          "ASSET_CONCENTRATION",
          "actual ordinary discovery supplies the readonly routing blocker",
        );
        f.diversifySources();
      }
      await flush();
      assert.equal(f.bank().held, 0);
      await f.time.advance(60001);
      // The preceding charges have really aged out of the local ledger. This
      // finite external-ledger fixture offers just enough room for the warm pair.
      f.resetBank(
        900 -
          (readonlyFixed
            ? f.planDemand() + (nativeSources ? 34 : 120) + 240
            : 2 * f.planDemand()),
      );
      const originalCursor = state.portfolios[0].sleeves[2]?.fixed_last_fill_at;
      if (incompleteHistory) f.fullSourceHistoryPage();
      else if (readonlyFixed) f.sourceHistoryPages([500, 0]);
      f.slowSourceHistory(slowHistory);
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
      if (readonlyFixed) {
        const saved = state.portfolios[0];
        assert.equal(
          executions.length,
          0,
          "a readonly window cannot materialize a new financial identifier",
        );
        assert.equal(f.outboxes.size, 0);
        assert.equal(f.bank().posts, 0);
        assert.equal(f.begins.at(-1).weight, nativeSources ? 458 : 544);
        assert.equal(f.begins.at(-1).mode, "learned");
        const freshReads = f.reads.slice(before),
          sourceReads = freshReads.filter(
            (read) =>
              read.type === "clearinghouseState" &&
              read.user !== f.identity.master &&
              (!slowHistory || !!read.context?.frame_id),
          ),
          historyReads = freshReads.filter(
            (read) =>
              read.type === "userFillsByTime" &&
              read.user !== f.identity.master,
          );
        assert.equal(sourceReads.length, 3);
        assert.equal(new Set(sourceReads.map((read) => read.user)).size, 3);
        assert.ok(sourceReads.every((read) => !!read.context?.frame_id));
        assert.ok(
          slowHistory
            ? sourceReads.some((read) => f.time.at - read.at > 5000)
            : sourceReads.every((read) => f.time.at - read.at <= 5000),
        );
        assert.equal(
          historyReads.length,
          2,
          "each dispatched history page owns its full conservative120",
        );
        assert.ok(historyReads[0].context?.frame_id);
        for (const type of [
          "userFunding",
          "userNonFundingLedgerUpdates",
          "spotClearinghouseState",
        ])
          assert.equal(
            freshReads.filter((read) => read.type === type).length,
            1,
            "readonly has one complete A and physically no B",
          );
        assert.equal(f.bank().dirty, false);
        assert.equal(
          f.planDemand(),
          184,
          "H never enters the single-account scope cost plan",
        );
        if (incompleteHistory || slowHistory) {
          assert.equal(historyReads[0].actual, incompleteHistory ? 120 : 45);
          assert.equal(saved.sleeves[2].fixed_last_fill_at, originalCursor);
          assert.equal(
            saved.last_error?.code,
            incompleteHistory ? "VENUE_READ_BUDGET_EXHAUSTED" : "SOURCE_STALE",
          );
        } else {
          assert.deepEqual(
            historyReads.map((read) => read.actual),
            [45, 20],
          );
          assert.ok(saved.sleeves[2].fixed_last_fill_at! > originalCursor!);
          assert.equal(
            saved.sleeves[2].fixed_last_fill_at,
            saved.sleeves[2].last_source_at,
          );
          assert.equal(saved.target_blocker, undefined);
          assert.equal(saved.last_error, undefined);
          assert.equal(
            f.bank().paid,
            (nativeSources ? 442 : 356) + 144 + 6 + 65,
          );
        }
        assert.equal(f.bank().held, 0);
        return;
      }
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
for (const nativeGraph of [false, true])
  it(
    nativeGraph
      ? "actual native CoreBridge keeps pending458 FIRST across real-PG184 to164 with fresh source identities and local438"
      : "actual CoreBridge keeps a readonly pending544 episode across a fresh real-PG184 to164 generation and audits in local524",
    {
      skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL,
      timeout: 30000,
    },
    async (t) => {
      const f = await fixture(t, {
        unified: true,
        threeSources: true,
        nativeSources: nativeGraph,
      });
      const fixed = f.p.sleeves[2];
      fixed.copy_mode = "fixed";
      fixed.fixed_last_fill_at = f.time.at - 10000;
      f.resetBank(nativeGraph ? 442 : 356);
      const url = new URL(process.env.RIDE_AGENT_TEST_DATABASE_URL!);
      assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
      const admin = new pg.Pool({ connectionString: url.toString(), max: 2 });
      const schema = "monotone_graph_" + randomUUID().replaceAll("-", "");
      await admin.query("CREATE SCHEMA " + schema);
      url.searchParams.set("options", "-c search_path=" + schema);
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      t.after(async () => {
        await pool.end();
        await admin.query("DROP SCHEMA " + schema + " CASCADE");
        await admin.end();
      });
      const plans = new AccountObservationPlans(pool);
      await plans.migrate();
      if (nativeGraph) {
        const identities = new PerpsSourceIdentities(
          pool,
          "s".repeat(32),
          async () => {
            assert.fail("known PG identities must not scan a provider");
          },
        );
        await identities.migrate();
        await identities.remember(
          f.sourceRows.map((row) => ({
            address: row.address,
            requires_rwa: false,
          })),
        );
        f.b.sourceIdentities = identities;
      }
      const compact = preparedPortfolioInput(f.p, "audit_source");
      const owner = await f.b.preparedIdentity(graphUser, compact);
      const signal = new AbortController().signal;
      let lease = await plans.begin(owner, signal);
      assert.equal(
        await plans.complete(lease, { demand: 184, peaks: [164] }, signal),
        true,
      );
      // The fixture keeps its real CoreBridge, VenueReads, Budget and factory;
      // this replaces only its in-memory plan-store transport with actual PG.
      f.b.venueReads.observationPlans = plans;
      const prepare = () =>
        f.bridge.operation(
          "prepare_portfolio",
          {
            user_id: graphUser,
            portfolio: compact,
          },
          undefined,
          undefined,
          undefined,
          nativeGraph ? "readonly-runner-native-v1" : undefined,
        ) as Promise<any>;
      f.pendingFrames(true);
      assert.equal((await prepare()).state, "pending");
      const original = structuredClone(f.begins[0]);
      const entry = [...f.b.preparedEntries.values()][0] as any;
      const originalHandle = entry.handle;
      const before = await plans.read(owner, signal);
      assert.equal(before.plan!.demand, 184);
      assert.equal(f.reads.length, 0);
      lease = await plans.begin(owner, signal, before);
      assert.equal(
        await plans.complete(
          lease,
          { demand: 164, peaks: [144, 144, 144] },
          signal,
        ),
        true,
      );
      const current = await plans.read(owner, signal);
      assert.notEqual(current.generation, before.generation);
      assert.equal(current.plan!.demand, 164);
      await f.time.advance(1000);
      assert.equal((await prepare()).state, "pending");
      assert.equal(f.b.preparedEntries.get(entry.key), entry);
      assert.equal(entry.handle, originalHandle);
      assert.deepEqual(f.begins[1], original);
      assert.equal(f.events.includes("end"), false);
      assert.equal(f.reads.length, 0);
      const pendingRow = await pool.query(
        "SELECT dirty,generation::text,demand FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      assert.equal(pendingRow.rows[0].dirty, false);
      assert.equal(pendingRow.rows[0].generation, current.generation);
      f.pendingFrames(false);
      const ready = await prepare();
      assert.equal(ready.state, "ready");
      assert.equal(ready.handle, originalHandle);
      assert.equal(ready.purpose, "audit_source");
      assert.equal(ready.execution_eligible, false);
      assert.deepEqual(f.begins[2], original);
      assert.equal(
        f.budget.snapshot().observation_reserved,
        nativeGraph ? 438 : 524,
      );
      assert.equal(f.bank().held, nativeGraph ? 458 : 544);
      assert.equal(f.bank().held + f.bank().paid, 900);
      const snapshot = (await f.bridge.operation(
        "account",
        {
          user_id: graphUser,
          portfolio: f.p,
        },
        undefined,
        undefined,
        ready.handle,
      )) as any;
      assert.equal(snapshot.coverage_complete, true);
      assert.equal(snapshot.observed_at, f.time.at);
      assert.equal(
        f.reads.filter((row) =>
          [
            "userFillsByTime",
            "userFunding",
            "userNonFundingLedgerUpdates",
          ].includes(row.type),
        ).length,
        3,
      );
      const after = await pool.query(
        "SELECT dirty,generation::text FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      assert.equal(after.rows[0].dirty, false);
      assert.ok(Number(after.rows[0].generation) > Number(current.generation));
      let fixedSource: any;
      for (const sleeve of f.p.sleeves) {
        const beforeSource = f.time.at;
        const source = (await driveIo(
          f.time,
          f.bridge.operation(
            "source",
            {
              trader_id: sleeve.trader.id,
            },
            undefined,
            undefined,
            ready.handle,
          ),
        )) as any;
        assert.ok(
          source.observed_at >= beforeSource && source.observed_at <= f.time.at,
        );
        assert.ok(f.time.at - source.observed_at <= 5000);
        if (sleeve === fixed) fixedSource = source;
      }
      const history = (await driveIo(
        f.time,
        f.bridge.operation(
          "source_fills",
          {
            trader_id: fixed.trader.id,
            market: "perps",
            start_at: fixed.fixed_last_fill_at,
            end_at: fixedSource.observed_at,
          },
          undefined,
          undefined,
          ready.handle,
        ),
      )) as any;
      assert.equal(history.complete, true);
      assert.deepEqual(history.fills, []);
      assert.equal(
        f.bank().held - f.budget.snapshot().observation_reserved,
        20,
        "the extra original Core20 remains outside every current local pool",
      );
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
      assert.equal(f.outboxes.size, 0);
      assert.equal(f.bank().posts, 0);
      if (nativeGraph) {
        const beforeUpgrade = f.reads.length;
        await f.b.sourceIdentities.remember([
          { address: f.sourceRows[0].address, requires_rwa: true },
        ]);
        await assert.rejects(
          f.bridge.operation(
            "source",
            { trader_id: f.sourceRows[0].trader },
            undefined,
            undefined,
            ready.handle,
          ),
        );
        assert.equal(
          f.reads.length,
          beforeUpgrade,
          "latest PG scope growth blocks even a cached native result before new HTTP",
        );
        assert.equal(entry.expired, true);
        await flush();
      } else
        await f.bridge.operation(
          "finish_portfolio",
          { user_id: graphUser },
          undefined,
          undefined,
          ready.handle,
        );
      assert.equal(f.bank().held, 0);
      assert.equal(f.events.filter((event) => event === "end").length, 1);
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

it("a deferred old finish cannot delete a newly prepared same-key peer", async (t) => {
  const f = await fixture(t),
    oldReady = await f.prepare(),
    old = [...f.b.preparedEntries.values()][0] as any,
    originalClose = old.window.close.bind(old.window);
  let release!: () => void,
    first = true;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Close currently invalidates local admission synchronously. A deferred close
  // completion models the registry ownership invariant without claiming a live
  // network-release race in the present implementation.
  old.window.close = async () => {
    await originalClose();
    if (first) {
      first = false;
      await barrier;
    }
  };
  const finishing = f.bridge.operation(
    "finish_portfolio",
    { user_id: graphUser },
    undefined,
    undefined,
    oldReady.handle,
  );
  await flush();
  assert.equal(old.expired, true);
  assert.equal(f.bank().held, 0);
  await assert.rejects(
    f.prepare(),
    "the expired episode is cleared without same-call rebooking",
  );
  const newReady = await f.prepare();
  assert.equal(newReady.state, "ready");
  assert.notEqual(newReady.handle, oldReady.handle);
  const current = [...f.b.preparedEntries.values()][0] as any;
  release();
  assert.deepEqual(await finishing, { ok: true });
  assert.equal(f.b.preparedEntries.get(current.key), current);
  assert.equal(f.bank().held, 488);
  await f.audit(newReady);
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
