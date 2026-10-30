import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { it, type TestContext } from "node:test";
import type WebSocket from "ws";
import { AgentError } from "./contracts.js";
import { CoreBridge } from "./core_bridge.js";
import type { Portfolio } from "./domain.js";
import { SourceFeed } from "./source-feed.js";
import {
  OrderSnapshotBudget,
  VenueOrderSnapshots,
} from "./venue-order-snapshots.js";
import {
  VenueReadBudget,
  type BudgetTimers,
  type ReadTicket,
} from "./venue-read-budget.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import { VenueReads } from "./venue-reads.js";
import type {
  ObservationCostPlan,
  ObservationPlanHint,
  ObservationPlanStore,
} from "./account-observation-plans.js";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
} from "./venue-read-transport.js";

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
class FakeTime {
  at = 0;
  private sequence = 0;
  private events = new Map<number, { at: number; run(): void }>();
  clock = () => this.at;
  timers: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    },
    clearTimeout: (id) => this.events.delete(id as number),
  };
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.timers.setTimeout(resolve, ms));
  }
}

// External budget-contract model. Core's Redis ledger preserves admission
// timestamps during reconciliation; it has no Node observation plans or
// unknown-response exclusive hold. Waiting is bounded by the original caller
// signal. This is not a model of every managed-provider scheduling policy.
class ProviderLedger {
  private charges: { at: number; weight: number }[] = [];
  private waiters: {
    cost: number;
    signal: AbortSignal;
    resolve(ticket: ReadTicket): void;
    reject(error: Error): void;
    cancel(): void;
  }[] = [];
  private wake?: unknown;
  constructor(
    private readonly time: FakeTime,
    private readonly atomicReject = false,
  ) {}
  snapshot() {
    this.charges = this.charges.filter(
      (charge) => charge.at > this.time.at - 60000,
    );
    return {
      used: this.charges.reduce((sum, charge) => sum + charge.weight, 0),
    };
  }
  acquire(cost: number, signal: AbortSignal): Promise<ReadTicket> {
    if (this.atomicReject && this.snapshot().used + cost > 1000)
      return Promise.reject(
        new Error("Core atomic admission rejected before upstream"),
      );
    return new Promise((resolve, reject) => {
      const waiter = { cost, signal, resolve, reject, cancel: () => {} };
      waiter.cancel = () => {
        this.waiters = this.waiters.filter((row) => row !== waiter);
        reject(new Error("External admission cancelled before dispatch"));
        this.pump();
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
      if (signal.aborted) waiter.cancel();
      else this.pump();
    });
  }
  private pump() {
    if (this.wake !== undefined) this.time.timers.clearTimeout(this.wake);
    this.wake = undefined;
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      if (this.snapshot().used + waiter.cost > 1000) break;
      this.waiters.shift();
      waiter.signal.removeEventListener("abort", waiter.cancel);
      const charge = { at: this.time.at, weight: waiter.cost };
      this.charges.push(charge);
      waiter.resolve({
        reservation: waiter.cost,
        sent() {},
        uncertain() {},
        release() {},
        settle: (weight) => {
          assert.ok(
            Number.isSafeInteger(weight) &&
              weight >= 0 &&
              weight <= waiter.cost,
          );
          charge.weight = weight; // Never renew Core's original Redis timestamp.
          this.pump();
        },
      });
    }
    if (this.waiters.length) {
      const next = Math.min(...this.charges.map((charge) => charge.at + 60000));
      this.wake = this.time.timers.setTimeout(
        () => this.pump(),
        Math.max(1, next - this.time.at),
      );
    }
  }
}

type Frame = { owner: number; round: number };
type Attempt = {
  at: number;
  type: string;
  user?: string;
  dex?: string;
  weight: number;
  frame?: Frame;
};
type Observation = {
  started: number;
  completed: number;
  observed: number;
  weight: number;
};
type BackendPipeline = {
  label: string;
  readMs: number;
  publicationMs: number;
  planningMs: number;
  durableMs: number;
  skipEmptyPlanning: boolean;
};

async function snapshotLoad(
  t: TestContext,
  wireMs: number,
  dbDelayMs = 0,
  restart = false,
  atomicReject = false,
  disableRestoreAfterRestart = false,
  backend?: BackendPipeline,
) {
  const time = new FakeTime(),
    base = 1793200000000,
    horizon = 360000,
    warmup = 120000,
    dexes = Array.from({ length: 10 }, (_, i) => `dex${i}`),
    accounts = ["0x" + "1".repeat(40), "0x" + "2".repeat(40)],
    sources = Array.from(
      { length: 6 },
      (_, i) => "0x" + (i + 10).toString(16).repeat(40),
    ),
    context = new AsyncLocalStorage<Frame>();
  t.mock.method(Date, "now", () => base + time.at);
  const previous = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = previous;
  });
  let budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const providerGate = restart
    ? new ProviderLedger(time, atomicReject)
    : undefined;
  const deniedFrames = new Set<Frame>();
  let noUpstreamDenials = 0,
    invalidCleanAttempts = 0;
  let restarted = false;
  const trace: Attempt[] = [],
    observations: Observation[][] = [[], []],
    failures: { at: number; owner: number; code: string; retry: number }[] = [],
    sourceReads: number[][] = sources.map(() => []),
    sockets: {
      id: number;
      frame?: Frame;
      user?: string;
      dexes: string[];
      states: string[];
      at: number;
    }[] = [];
  let maximumWeight = 0,
    maximumActiveAccounts = 0;
  const fetcher = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    let data: unknown;
    switch (payload.type) {
      case "clearinghouseState":
        data = {
          time: base + time.at,
          marginSummary: {
            accountValue: sources.includes(payload.user) ? "100" : "0",
            totalMarginUsed: "0",
          },
          withdrawable: "0",
          assetPositions: [],
        };
        break;
      case "frontendOpenOrders":
      case "userFillsByTime":
      case "userFunding":
      case "userNonFundingLedgerUpdates":
        data = [];
        break;
      case "allMids":
        data = { BTC: "100" };
        break;
      case "meta":
        data = {
          collateralToken: 0,
          universe: [{ name: "BTC", maxLeverage: 10, szDecimals: 3 }],
        };
        break;
      case "userAbstraction":
        data = "unifiedAccount";
        break;
      case "userDexAbstraction":
        data = false;
        break;
      case "spotClearinghouseState":
        data = {
          balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }],
        };
        break;
      case "perpDexs":
        data = [null, ...dexes.map((name) => ({ name }))];
        break;
      default:
        assert.fail("Unexpected provider method " + payload.type);
    }
    if (payload.type === "userFillsByTime" && sources.includes(payload.user))
      data = Array.from({ length: 380 }, (_, i) => ({
        time: base - 1000 + i,
        tid: i,
        oid: i + 1,
        coin: "BTC",
        side: i % 2 ? "A" : "B",
        px: "100",
        sz: "1",
        startPosition: i % 2 ? "1" : "0",
        closedPnl: "0",
        fee: "0",
        feeToken: "USDC",
        dir: i % 2 ? "Close Long" : "Open Long",
      }));
    let providerTicket: ReadTicket | undefined;
    const coreObserved = time.at;
    if (providerGate) {
      const cost = readCost(payload);
      try {
        // Core's current startTime funding contract reserves 500/20+20=45.
        // Node retains its independently stricter unknown-surcharge protocol.
        providerTicket = await providerGate.acquire(
          payload.type === "userFunding" ? 45 : cost.reserve,
          init?.signal as AbortSignal,
        );
      } catch {
        noUpstreamDenials++;
        const frame = context.getStore();
        if (frame) deniedFrames.add(frame);
        throw new CoordinatedReadError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          false,
          1000,
        );
      }
      if (init?.signal?.aborted) {
        providerTicket.release();
        throw new CoordinatedReadError("VENUE_READ_DEADLINE", false);
      }
      providerTicket.sent();
    }
    const dispatched = time.at;
    trace.push({
      at: time.at,
      type: payload.type,
      user: payload.user,
      dex: payload.dex,
      weight: responseCost(readCost(payload), data),
      frame: context.getStore(),
    });
    const current = budget.snapshot();
    maximumWeight = Math.max(maximumWeight, current.used);
    maximumActiveAccounts = Math.max(
      maximumActiveAccounts,
      current.account_active,
    );
    assert.ok(
      current.used <= 1000,
      "all provisional and settled REST charges share the 1000/min ceiling",
    );
    const response = await new Promise<Response>((resolve) =>
      time.timers.setTimeout(() => resolve(Response.json(data)), wireMs),
    );
    if (providerTicket) {
      if (init?.signal?.aborted) {
        providerTicket.uncertain();
        providerTicket.release();
        throw new CoordinatedReadError("VENUE_READ_DEADLINE", true);
      }
      providerTicket.settle(responseCost(readCost(payload), data));
      providerTicket.release();
      recordCoordinatedEvidence(response, base + coreObserved);
    }
    return response;
  }) as typeof fetch;
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any;
  const rows = new Map<
    string,
    {
      plan: ObservationCostPlan | null;
      generation: number;
      dirty: boolean;
      at: number;
      leaseUntil: number;
    }
  >();
  const planIo = async (signal: AbortSignal) => {
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([time.sleep(dbDelayMs), cancelled]);
      if (signal.aborted) throw signal.reason;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
  const hint = (owner: string): ObservationPlanHint => {
    const row = rows.get(owner),
      age = row ? time.at - row.at : Infinity;
    if (row?.dirty && row.leaseUntil > time.at)
      throw new AgentError(
        "VENUE_COST_PLAN_UNAVAILABLE",
        "Fixture active metering lease",
        true,
        503,
      );
    const plan =
      row && !row.dirty && age >= 0 && age < 600000 ? row.plan : null;
    return {
      owner,
      generation: row ? String(row.generation) : null,
      plan: plan ? structuredClone(plan) : null,
      remainingTtlMs: plan ? 600000 - age : 0,
    };
  };
  const store: ObservationPlanStore = {
    read: async (owner, signal) => {
      await planIo(signal);
      return hint(owner);
    },
    begin: async (owner, signal, expected, maximumLeaseMs = 20000) => {
      await planIo(signal);
      const current = hint(owner);
      assert.equal(current.generation, expected?.generation);
      assert.deepEqual(current.plan, expected?.plan);
      const generation = (rows.get(owner)?.generation ?? 0) + 1;
      rows.set(owner, {
        plan: current.plan,
        generation,
        dirty: true,
        at: rows.get(owner)?.at ?? time.at,
        leaseUntil: time.at + maximumLeaseMs - dbDelayMs,
      });
      return { ...current, generation: String(generation) };
    },
    complete: async (lease, plan, signal) => {
      await planIo(signal);
      if (context.getStore() && deniedFrames.has(context.getStore()!))
        invalidCleanAttempts++;
      const row = rows.get(lease.owner);
      if (
        !row ||
        String(row.generation) !== lease.generation ||
        !row.dirty ||
        row.leaseUntil <= time.at
      )
        return false;
      rows.set(lease.owner, {
        ...row,
        dirty: false,
        plan: structuredClone(plan),
        at: time.at,
        leaseUntil: 0,
      });
      return true;
    },
  };
  const installReader = () => {
    stub.venueReads = new VenueReads(fetcher, () => base + time.at, 2, {
      budget,
      timers: time.timers,
      report: () => {},
      ...(dbDelayMs && !(disableRestoreAfterRestart && restarted)
        ? {
            observationPlans: store,
            requireObservationPlanBinding: true,
            monotonicClock: time.clock,
          }
        : {}),
      ...(providerGate ? { transport: "core_shared_info" as const } : {}),
    });
  };
  installReader();
  stub.core = async (operation: string, input: any) => {
    assert.equal(
      operation,
      "perps_account",
      "sustained observation must not perform financial writes",
    );
    return {
      master: input.account_id,
      status: 4,
      ...(dbDelayMs
        ? {
            account_id: input.account_id,
            agent: "0x" + "3".repeat(40),
            network: 2,
            wallet_generation: 1,
          }
        : {}),
    };
  };
  stub.resolve = async (id: string) => ({ address: id, tags: [] });
  stub.orderSnapshots = new VenueOrderSnapshots("mainnet", {
    clock: () => base + time.at,
    timers: time.timers,
    budget: new OrderSnapshotBudget(time.clock),
    report: () => {},
    connect: (url) => {
      assert.equal(url, "wss://api.hyperliquid.xyz/ws");
      const row = {
        id: sockets.length,
        frame: context.getStore(),
        user: undefined as string | undefined,
        dexes: [] as string[],
        states: [] as string[],
        at: time.at,
      };
      sockets.push(row);
      class Socket extends EventEmitter {
        private stopped = false;
        send(raw: string) {
          const message = JSON.parse(raw);
          assert.equal(message.method, "subscribe");
          const { user, dex, type } = message.subscription;
          assert.ok(
            ["openOrders", "clearinghouseState", "webData3"].includes(type),
          );
          assert.ok(accounts.includes(user));
          if (type === "webData3") {
            row.user = user;
            time.timers.setTimeout(() => {
              if (!this.stopped)
                this.emit(
                  "message",
                  Buffer.from(
                    JSON.stringify({
                      channel: "webData3",
                      data: {
                        userState: {
                          user,
                          serverTime: base + time.at,
                          dexAbstractionEnabled: false,
                        },
                        perpDexStates: [],
                      },
                    }),
                  ),
                  false,
                );
            }, 200);
            return;
          }
          assert.ok(["", ...dexes].includes(dex));
          row.user = user;
          (type === "openOrders" ? row.dexes : row.states).push(dex);
          time.timers.setTimeout(() => {
            if (!this.stopped)
              this.emit(
                "message",
                Buffer.from(
                  JSON.stringify({
                    channel: type,
                    data:
                      type === "openOrders"
                        ? { user, dex, orders: [] }
                        : {
                            user,
                            dex,
                            clearinghouseState: {
                              marginSummary: { accountValue: "0" },
                              withdrawable: "0",
                              assetPositions: [],
                            },
                          },
                  }),
                ),
                false,
              );
          }, 200);
        }
        terminate() {
          this.stopped = true;
        }
      }
      const socket = new Socket();
      time.timers.setTimeout(() => socket.emit("open"), 100);
      return socket as unknown as WebSocket;
    },
  });
  const installSourceFeed = () => {
    stub.sourceFeed.close();
    stub.sourceFeed = new SourceFeed((id: string) => stub.readSource(id), {
      clock: () => base + time.at,
      timers: {
        setInterval(run, ms) {
          const handle = {
            stopped: false,
            id: undefined as unknown,
            unref() {},
          };
          const poll = () => {
            if (handle.stopped) return;
            run();
            handle.id = time.timers.setTimeout(poll, ms);
          };
          handle.id = time.timers.setTimeout(poll, ms);
          return handle;
        },
        clearInterval(handle) {
          const timer = handle as { stopped: boolean; id: unknown };
          timer.stopped = true;
          time.timers.clearTimeout(timer.id);
        },
      },
    });
  };
  installSourceFeed();
  const accountLoops = accounts.map(async (address, owner) => {
    const portfolio = {
      account_id: address,
      venue_accounts: { perps: address },
      sleeves: [],
      executions: [],
      ledger_started_at: base - 1000,
    } as unknown as Portfolio;
    let round = 0;
    let pendingRetryAt: number | undefined;
    const backendDue = (started: number) =>
      pendingRetryAt !== undefined && pendingRetryAt - time.at <= 5000
        ? Math.max(time.at, pendingRetryAt)
        : Math.max(time.at, started + 5000);
    while (time.at < horizon) {
      const started = time.at,
        frame = { owner, round: ++round };
      let retry = 5000;
      let retryAt: number | undefined;
      if (backend) await time.sleep(backend.readMs);
      const observationStarted = time.at;
      if (backend && pendingRetryAt !== undefined && pendingRetryAt > time.at) {
        // The real runner still drains durable work every normal interval
        // while a persisted account hint prevents another bridge observation.
        await time.sleep(
          backend.publicationMs +
            (backend.skipEmptyPlanning ? 0 : backend.planningMs) +
            backend.durableMs,
        );
        await time.sleep(backendDue(started) - time.at);
        continue;
      }
      try {
        const snapshot = await context.run(frame, () =>
          bridge.perpsAccount(`user${owner}`, portfolio),
        );
        assert.equal(snapshot.coverage_complete, true);
        assert.equal(snapshot.account_value_usdc, "100.000000");
        assert.equal(snapshot.available_usdc, "100.000000");
        assert.ok(
          time.at - observationStarted <= 20000,
          "complete account observation retains its original 20-second limit",
        );
        const requests = trace.filter((request) => request.frame === frame);
        for (const method of [
          "spotClearinghouseState",
          "userAbstraction",
          "userFillsByTime",
          "userFunding",
          "userNonFundingLedgerUpdates",
        ])
          assert.ok(
            requests.some((request) => request.type === method && !request.dex),
            `every frame must re-read native ${method}`,
          );
        assert.equal(
          requests.filter((request) => request.type === "userAbstraction")
            .length,
          2,
          "account mode is verified before and after the complete scope sweep",
        );
        assert.equal(
          requests.filter(
            (request) => request.type === "clearinghouseState" && request.dex,
          ).length,
          0,
          "only complete fresh WS states replace foreign REST positions",
        );
        assert.equal(
          requests.filter(
            (request) => request.type === "frontendOpenOrders" && request.dex,
          ).length,
          0,
          "only fresh WS orders replace foreign REST orders",
        );
        const live = sockets.filter((socket) => socket.frame === frame);
        assert.equal(
          live.length,
          2,
          "each complete frame needs its own socket, not a cached observation",
        );
        assert.deepEqual(
          live[0].dexes.filter(Boolean).sort(),
          [...dexes].sort(),
        );
        assert.deepEqual(
          live[0].states.filter(Boolean).sort(),
          [...dexes].sort(),
        );
        assert.ok(live[0].at >= observationStarted);
        const observed = snapshot.observed_at - base,
          earliest = Math.min(
            ...requests
              .filter((request) =>
                [
                  "clearinghouseState",
                  "spotClearinghouseState",
                  "allMids",
                  "frontendOpenOrders",
                ].includes(request.type),
              )
              .map((request) => request.at),
          );
        assert.ok(
          observed >= observationStarted - 1000,
          "only the existing 1s public-price TTL can predate this frame",
        );
        assert.ok(
          observed <= earliest,
          "snapshot time cannot be relabeled to the end of its complete frame",
        );
        // A returned bridge frame is not yet visible in backend state. This
        // independent envelope never changes the financial evidence stamp.
        if (backend) await time.sleep(backend.publicationMs);
        observations[owner].push({
          started,
          completed: time.at,
          observed,
          weight: requests.reduce((sum, request) => sum + request.weight, 0),
        });
        if (backend) {
          pendingRetryAt = undefined;
          await time.sleep(backend.planningMs + backend.durableMs);
          retryAt = backendDue(started);
        }
      } catch (error) {
        assert.ok(error instanceof AgentError, String(error));
        assert.ok(
          [
            "VENUE_READ_BUDGET_EXHAUSTED",
            "VENUE_READ_DEADLINE",
            ...(restart ? ["VENUE_COST_PLAN_UNAVAILABLE"] : []),
          ].includes(error.code),
          error.code,
        );
        retry = Math.max(1, Number(error.details?.retry_after_ms ?? 5000));
        const failedAt = time.at;
        failures.push({
          at: failedAt,
          owner,
          code: error.code,
          retry,
          used: budget.snapshot().used,
          head: [...(budget as any).observationQueue.values()].map(
            (x: any) => x.demand,
          ),
          plans: [...(budget as any).observationPlans.values()].map(
            (x: any) => x.demand,
          ),
        } as any);
        if (backend) {
          // Error hints are absolute. Failed audit commit, unchanged planning
          // (legacy only), and durable reconciliation must drain before retry.
          pendingRetryAt = failedAt + retry;
          await time.sleep(
            backend.publicationMs +
              (backend.skipEmptyPlanning ? 0 : backend.planningMs) +
              backend.durableMs,
          );
          retryAt = backendDue(started);
        }
      }
      await time.sleep(
        retryAt === undefined ? retry : Math.max(0, retryAt - time.at),
      );
    }
  });
  const sourceLoop = (async () => {
    await time.sleep(30000);
    while (time.at < horizon) {
      await Promise.all(
        sources.map(async (source, i) => {
          try {
            const snapshot = await bridge.source(source);
            assert.ok(base + time.at - snapshot.observed_at <= 5000);
            sourceReads[i].push(time.at);
          } catch (error) {
            assert.ok(error instanceof AgentError, String(error));
            assert.ok(
              ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(
                error.code,
              ),
            );
          }
        }),
      );
      await time.sleep(5000);
    }
  })();
  let fixedHistoryCalls = 0;
  const fixedHistoryLoop = (async () => {
    await time.sleep(30000);
    while (time.at < horizon) {
      const next = time.at + 15000;
      try {
        const rows = await stub.venueReads.read(
          "https://fixture.invalid/info",
          {
            type: "userFillsByTime",
            user: sources[2],
            startTime: base - 60000,
            endTime: base + time.at,
            aggregateByTime: false,
          },
          0,
          "source",
        );
        assert.equal(rows.length, 380);
        fixedHistoryCalls++;
      } catch (error) {
        assert.ok(error instanceof AgentError, String(error));
        assert.ok(
          ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(
            error.code,
          ),
        );
      }
      await time.sleep(Math.max(0, next - time.at));
    }
  })();
  let restartEvidence: Record<string, unknown> | undefined;
  const restartLoop = restart
    ? (async () => {
        await time.sleep(180000); // Fixed phase, independent of clean/dirty state.
        restartEvidence = {
          requestedAt: time.at,
          rows: rows.size,
          dirtyAtRequest: [...rows.values()].filter((row) => row.dirty).length,
          providerUsedBeforeDrain: providerGate!.snapshot().used,
          oldTraceCount: trace.length,
        };
        await stub.venueReads.drainAccounts();
        budget = new VenueReadBudget({
          clock: time.clock,
          timers: time.timers,
        });
        restarted = true;
        installReader();
        installSourceFeed();
        Object.assign(restartEvidence, {
          restartedAt: time.at,
          providerUsedAfterRestart: providerGate!.snapshot().used,
          newNodeUsed: budget.snapshot().used,
          sameProviderGate: true,
          sameTrace: true,
          cleanAfterDrain: [...rows.values()].filter((row) => !row.dirty)
            .length,
        });
      })()
    : Promise.resolve();
  try {
    await time.advance(horizon + 120000);
    await Promise.all([
      ...accountLoops,
      sourceLoop,
      fixedHistoryLoop,
      restartLoop,
    ]);
    let maximumProviderWindow = 0;
    for (const attempt of trace) {
      const weight = trace
        .filter((row) => row.at > attempt.at - 60000 && row.at <= attempt.at)
        .reduce((sum, row) => sum + row.weight, 0);
      maximumProviderWindow = Math.max(maximumProviderWindow, weight);
      assert.ok(
        weight <= 1000,
        "actual provider requests must remain within 1000/min, including every source read",
      );
    }
    t.diagnostic(
      JSON.stringify({
        completions: observations.map((x) => x.length),
        failures: failures.slice(0, 10),
      }),
    );
    const maximumAge = observations.map((rows) => {
      let latest: Observation | undefined,
        maximum = 0;
      for (const row of rows) {
        if (row.completed < warmup) {
          latest = row;
          continue;
        }
        assert.ok(
          latest,
          "every owner must have a complete snapshot before the steady-state interval",
        );
        maximum = Math.max(
          maximum,
          Math.min(row.completed, horizon) - latest.observed,
        );
        latest = row;
        if (row.completed > horizon) break;
      }
      assert.ok(latest);
      if (latest.completed <= horizon)
        maximum = Math.max(maximum, horizon - latest.observed);
      return maximum;
    });
    let resumeMetrics:
      | {
          cutoff: number;
          frozenAt: number | null;
          firstTwoNewAfterRestart: number[][];
          allOver30Points: { at: number; ages: (number | null)[] }[];
          allOver30Intervals: {
            owner: number;
            from: number;
            until: number;
            maximumAge: number;
          }[];
          afterCutoffFailures: number;
          afterFreezeFailures: number;
          postCutoffMaximumAge: number[];
        }
      | undefined;
    if (restartEvidence) {
      const restartedAt = Number(restartEvidence.restartedAt),
        cutoff = restartedAt + 90000;
      const points = Array.from(
        { length: Math.floor(horizon / 5000) + 1 },
        (_, index) => {
          const at = index * 5000;
          const ages = observations.map((rows) => {
            const completed = rows.filter((row) => row.completed <= at).at(-1);
            return completed ? at - completed.observed : null;
          });
          return {
            at,
            ages,
            fresh: ages.every((age) => age !== null && age < 30000),
            newCounts: observations.map(
              (rows) =>
                rows.filter(
                  (row) => row.completed > restartedAt && row.completed <= at,
                ).length,
            ),
          };
        },
      );
      const frozenAt =
        points.find(
          (point) =>
            point.at >= restartedAt &&
            point.newCounts.every((count) => count >= 2) &&
            point.fresh,
        )?.at ?? null;
      resumeMetrics = {
        cutoff,
        frozenAt,
        firstTwoNewAfterRestart: observations.map((rows) =>
          rows
            .filter((row) => row.completed > restartedAt)
            .slice(0, 2)
            .map((row) => row.completed - restartedAt),
        ),
        allOver30Points: points
          .filter((point) => !point.fresh)
          .map(({ at, ages }) => ({ at, ages })),
        allOver30Intervals: observations.flatMap((rows, owner) =>
          rows.flatMap((previous, index) => {
            const until = Math.min(
              rows[index + 1]?.completed ?? horizon,
              horizon,
            );
            return until - previous.observed >= 30000
              ? [
                  {
                    owner,
                    from: Math.max(
                      previous.completed,
                      previous.observed + 30000,
                    ),
                    until,
                    maximumAge: until - previous.observed,
                  },
                ]
              : [];
          }),
        ),
        afterCutoffFailures: points.filter(
          (point) => point.at >= cutoff && !point.fresh,
        ).length,
        afterFreezeFailures:
          frozenAt === null
            ? -1
            : points.filter((point) => point.at >= frozenAt && !point.fresh)
                .length,
        postCutoffMaximumAge: observations.map((_, owner) =>
          Math.max(
            ...points
              .filter((point) => point.at >= cutoff)
              .map((point) => point.ages[owner] ?? Infinity),
          ),
        ),
      };
    }
    const report = {
      wireMs,
      dbDelayMs,
      backendPipeline: backend,
      restartEvidence,
      disableRestoreAfterRestart,
      resumeMetrics,
      providerContract: providerGate
        ? {
            cap: 1000,
            reservation: "Core fills120/funding45",
            timestamp: "original_admission",
            admission: atomicReject
              ? "atomic_reject_no_upstream"
              : "declared_bounded_wait_assumption",
          }
        : undefined,
      noUpstreamDenials,
      deniedAccountFrames: deniedFrames.size,
      invalidCleanAttempts,
      dirtyCostRowsAtEnd: [...rows.values()].filter((row) => row.dirty).length,
      fixedHistoryCalls,
      fixedHistoryWindows: Array.from({ length: 4 }, (_, i) => {
        const start = warmup + i * 60000;
        return trace.filter(
          (row) =>
            row.at >= start &&
            row.at < start + 60000 &&
            row.type === "userFillsByTime" &&
            sources.includes(row.user ?? ""),
        ).length;
      }),
      fixedHistoryWeights: [
        ...new Set(
          trace
            .filter(
              (row) =>
                row.type === "userFillsByTime" &&
                sources.includes(row.user ?? ""),
            )
            .map((row) => row.weight),
        ),
      ],
      horizon,
      warmup,
      maximumAge,
      maximumWeight,
      maximumProviderWindow,
      maximumActiveAccounts,
      completions: observations.map((rows) => rows.length),
      frameWeights: observations.map((rows) => [
        ...new Set(rows.map((row) => row.weight)),
      ]),
      completeFrames: observations,
      failureCount: failures.length,
      firstFailures: failures.slice(0, 5),
      lastFailures: failures.slice(-5),
      sourceCompletions: sourceReads.map((rows) => rows.length),
      sourceWeights: trace
        .filter((row) => row.user && sources.includes(row.user))
        .reduce((sum, row) => sum + row.weight, 0),
      socketCount: sockets.length,
    };
    t.diagnostic(JSON.stringify(report));
    if (disableRestoreAfterRestart) return report; // Counterfactual SLOs are reported, never called a performance pass.
    assert.ok(
      observations.every(
        (rows) =>
          rows.filter(
            (row) => row.completed >= warmup && row.completed <= horizon,
          ).length >= 5,
      ),
      "both owners must keep completing entire frames throughout the load interval",
    );
    assert.ok(
      sourceReads.every((rows) => rows.some((at) => at >= warmup)),
      "both source owners must keep progressing during account load",
    );
    return report;
  } finally {
    await bridge.close();
  }
}

for (const wireMs of [300, 500])
  it(`keeps two complete account frames strictly below 30s with six live sources and repeated 39-weight fixed history at ${wireMs}ms`, async (t) => {
    const report = await snapshotLoad(t, wireMs);
    assert.deepEqual(report.fixedHistoryWeights, [39]);
    assert.ok(
      report.fixedHistoryCalls >= 15,
      "fixed history must remain active throughout the six-minute load",
    );
    assert.equal(report.sourceCompletions.length, 6);
    assert.ok(
      report.maximumAge.every((age) => age < 30000),
      JSON.stringify(report.maximumAge),
    );
  });

for (const wireMs of [300, 500])
  for (const dbDelayMs of [100, 200])
    it(`retains the complete six-source/fixed-history load with ${wireMs}ms venue and ${dbDelayMs}ms per operational-plan I/O`, async (t) => {
      const report = await snapshotLoad(t, wireMs, dbDelayMs);
      assert.deepEqual(report.fixedHistoryWeights, [39]);
      assert.ok(report.fixedHistoryCalls >= 15);
      assert.equal(report.sourceCompletions.length, 6);
      assert.ok(
        report.maximumAge.every((age) => age < 30000),
        JSON.stringify(report.maximumAge),
      );
    });

it("conditionally resumes within the fixed +90s boundary with retained Core cost/admission timestamps and a declared bounded-wait assumption", async (t) => {
  const report = await snapshotLoad(t, 500, 200, true);
  assert.equal(report.restartEvidence?.sameProviderGate, true);
  assert.equal(report.restartEvidence?.sameTrace, true);
  assert.equal(report.restartEvidence?.newNodeUsed, 0);
  assert.ok(
    Number(report.restartEvidence?.providerUsedAfterRestart) > 0,
    "Provider rolling charges survive Node reconstruction",
  );
  assert.ok(Number(report.restartEvidence?.cleanAfterDrain) === 2);
  assert.deepEqual(report.fixedHistoryWeights, [39]);
  assert.ok(report.fixedHistoryCalls >= 15);
  // Keep full-timeline transient failures visible. This new restart case tests
  // the separately predeclared +90s resume boundary, never resets its freeze,
  // and does not relax any original no-restart strict-30s load assertion.
  assert.equal(report.resumeMetrics?.afterCutoffFailures, 0);
  assert.equal(report.resumeMetrics?.afterFreezeFailures, 0);
  assert.ok(
    report.resumeMetrics?.frozenAt !== null &&
      Number(report.resumeMetrics?.frozenAt) <=
        Number(report.resumeMetrics?.cutoff),
  );
  assert.ok(
    report.resumeMetrics?.firstTwoNewAfterRestart.every(
      (times) => times.length === 2 && times.every((at) => at <= 90000),
    ),
  );
});

it("retains the external ledger under atomic Core rejection, learns no denied scope and reports all resume SLO failures", async (t) => {
  const report = await snapshotLoad(t, 500, 200, true, true);
  assert.equal(report.restartEvidence?.sameProviderGate, true);
  assert.equal(report.restartEvidence?.sameTrace, true);
  assert.ok(report.maximumProviderWindow <= 1000);
  assert.ok(report.maximumWeight <= 1000);
  assert.ok(report.noUpstreamDenials > 0);
  assert.ok(report.deniedAccountFrames > 0);
  assert.equal(report.invalidCleanAttempts, 0);
  assert.deepEqual(report.fixedHistoryWeights, [39]);
  assert.ok(report.fixedHistoryCalls >= 15);
});

it("reports the same fixed-phase external-ledger baseline without durable recovery, preserving its cold failures", async (t) => {
  const report = await snapshotLoad(t, 500, 200, true, true, true);
  assert.equal(report.restartEvidence?.sameProviderGate, true);
  assert.equal(report.restartEvidence?.sameTrace, true);
  assert.ok(report.maximumProviderWindow <= 1000);
  assert.ok(report.maximumWeight <= 1000);
  assert.equal(report.invalidCleanAttempts, 0);
});

// Explicit experiments, separate from the original direct-bridge contract.
// Global slow-log read/commit/phase medians are envelope inputs, never owner
// attribution or proof that they caused the hosted account's observed latency.
if (process.env.MCP_NOOP_PIPELINE_EXPERIMENT === "1")
  for (const publicationMs of [675, 2460])
    for (const skipEmptyPlanning of [false, true])
      it(`backend envelope publication ${publicationMs}ms empty planning ${skipEmptyPlanning ? "skipped" : "retained"} keeps the original strict workload`, async (t) => {
        const report = await snapshotLoad(t, 500, 200, false, false, false, {
          label:
            publicationMs === 675
              ? "global-slow-log-envelope-inputs"
              : "synthetic-2460ms-publication-envelope",
          readMs: 529,
          publicationMs,
          planningMs: 1346,
          durableMs: 1252,
          skipEmptyPlanning,
        });
        assert.deepEqual(report.fixedHistoryWeights, [39]);
        assert.ok(report.fixedHistoryCalls >= 15);
        assert.equal(report.sourceCompletions.length, 6);
        assert.ok(report.sourceCompletions.every((count) => count > 0));
        assert.ok(report.maximumWeight <= 1000);
        assert.ok(report.maximumProviderWindow <= 1000);
        assert.ok(
          report.maximumAge.every((age) => age < 30000),
          JSON.stringify(report.maximumAge),
        );
      });
