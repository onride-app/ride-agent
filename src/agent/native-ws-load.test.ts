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
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import { VenueReads } from "./venue-reads.js";

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

async function snapshotLoad(t: TestContext, wireMs: number) {
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
  const budget = new VenueReadBudget({
      clock: time.clock,
      timers: time.timers,
    }),
    trace: Attempt[] = [],
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
      }));
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
    return new Promise<Response>((resolve) =>
      time.timers.setTimeout(() => resolve(Response.json(data)), wireMs),
    );
  }) as typeof fetch;
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any;
  stub.venueReads = new VenueReads(fetcher, () => base + time.at, 2, {
    budget,
    timers: time.timers,
    report: () => {},
  });
  stub.core = async (operation: string, input: any) => {
    assert.equal(
      operation,
      "perps_account",
      "sustained observation must not perform financial writes",
    );
    return { master: input.account_id, status: 4 };
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
  stub.sourceFeed.close();
  stub.sourceFeed = new SourceFeed((id: string) => stub.readSource(id), {
    clock: () => base + time.at,
    timers: {
      setInterval(run, ms) {
        const handle = { stopped: false, id: undefined as unknown, unref() {} };
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
  const accountLoops = accounts.map(async (address, owner) => {
    const portfolio = {
      account_id: address,
      venue_accounts: { perps: address },
      sleeves: [],
      executions: [],
      ledger_started_at: base - 1000,
    } as unknown as Portfolio;
    let round = 0;
    while (time.at < horizon) {
      const started = time.at,
        frame = { owner, round: ++round };
      let retry = 5000;
      try {
        const snapshot = await context.run(frame, () =>
          bridge.perpsAccount(`user${owner}`, portfolio),
        );
        assert.equal(snapshot.coverage_complete, true);
        assert.equal(snapshot.account_value_usdc, "100.000000");
        assert.equal(snapshot.available_usdc, "100.000000");
        assert.ok(
          time.at - started <= 20000,
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
        assert.ok(live[0].at >= started);
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
          observed >= started - 1000,
          "only the existing 1s public-price TTL can predate this frame",
        );
        assert.ok(
          observed <= earliest,
          "snapshot time cannot be relabeled to the end of its complete frame",
        );
        observations[owner].push({
          started,
          completed: time.at,
          observed,
          weight: requests.reduce((sum, request) => sum + request.weight, 0),
        });
      } catch (error) {
        assert.ok(error instanceof AgentError, String(error));
        assert.ok(
          ["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_READ_DEADLINE"].includes(
            error.code,
          ),
          error.code,
        );
        retry = Math.max(1, Number(error.details?.retry_after_ms ?? 5000));
        failures.push({
          at: time.at,
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
      }
      await time.sleep(retry);
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
  try {
    await time.advance(horizon + 120000);
    await Promise.all([...accountLoops, sourceLoop, fixedHistoryLoop]);
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
    const report = {
      wireMs,
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
