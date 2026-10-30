import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { SourceFeed } from "./source-feed.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";

const initialTime = 1_700_000_000_000;
const sourceAddress = "0x" + "a".repeat(40);
type Payload = { type: string; dex?: string; user?: string };
type Trace = { payload: Payload; at: number; completedAt?: number };

function fakeTime() {
  let at = initialTime;
  const tasks = new Map<object, { at: number; callback: () => void }>();
  const timers: BudgetTimers = {
    setTimeout(callback, ms) {
      const handle = {};
      tasks.set(handle, { at: at + ms, callback });
      return handle;
    },
    clearTimeout(handle) {
      tasks.delete(handle as object);
    },
  };
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  const next = () => [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
  const fire = async (entry: ReturnType<typeof next>) => {
    at = Math.max(at, entry[1].at);
    tasks.delete(entry[0]);
    entry[1].callback();
    await flush();
  };
  return {
    clock: () => at,
    timers,
    flush,
    advance: async (ms: number) => {
      const until = at + ms;
      await flush();
      while (next() && next()[1].at <= until) await fire(next());
      at = until;
      await flush();
    },
    finish: async <T>(work: Promise<T>): Promise<T> => {
      let finished = false;
      void work.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      for (let i = 0; i < 100 && !finished; i++) {
        await flush();
        if (!finished) {
          assert.ok(next(), "pending read must have a bounded timer");
          await fire(next());
        }
      }
      assert.ok(finished, "source read must settle");
      return work;
    },
  };
}

function fixture(
  context: TestContext,
  options: { rwa?: boolean; delay?: (payload: Payload) => number } = {},
) {
  const time = fakeTime();
  context.mock.method(Date, "now", time.clock);
  const beforeRwa = process.env.RIDE_AGENT_RWA_ENABLED;
  const beforePrediction = process.env.RIDE_AGENT_PREDICTION_ENABLED;
  process.env.RIDE_AGENT_RWA_ENABLED = String(options.rwa ?? true);
  delete process.env.RIDE_AGENT_PREDICTION_ENABLED;
  context.after(() => {
    if (beforeRwa === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = beforeRwa;
    if (beforePrediction === undefined)
      delete process.env.RIDE_AGENT_PREDICTION_ENABLED;
    else process.env.RIDE_AGENT_PREDICTION_ENABLED = beforePrediction;
  });
  const trace: Trace[] = [];
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.hyperliquid.xyz/info");
    const payload = JSON.parse(String(init?.body)) as Payload;
    const request: Trace = { payload, at: time.clock() };
    trace.push(request);
    const value =
      payload.type === "clearinghouseState"
        ? {
            marginSummary: { accountValue: payload.dex ? "50" : "100" },
            assetPositions: [
              {
                position: {
                  coin: payload.dex ? "CL" : "BTC",
                  szi: payload.dex ? "2" : "1",
                  positionValue: payload.dex ? "400" : "100",
                  entryPx: "100",
                  leverage: { value: 1 },
                },
              },
            ],
          }
        : payload.type === "userAbstraction"
          ? "standard"
          : payload.type === "userDexAbstraction"
            ? false
            : payload.type === "meta"
              ? { collateralToken: 0 }
              : assert.fail("Unexpected venue read " + payload.type);
    return await new Promise<Response>((resolve) => {
      time.timers.setTimeout(
        () => {
          request.completedAt = time.clock();
          resolve({
            ok: true,
            status: 200,
            json: async () => value,
          } as Response);
        },
        options.delay?.(payload) ?? 0,
      );
    });
  };
  const reads = new VenueReads(fetcher, time.clock, 2, {
    budget,
    timers: time.timers,
    report: () => {},
  });
  // Exercise the real source methods without constructing a database pool.
  const bridge = Object.create(CoreBridge.prototype) as CoreBridge;
  const stub = bridge as any;
  stub.network = "testnet";
  stub.venueReads = reads;
  stub.resolve = async () => ({
    address: sourceAddress,
    tags: ["category:stocks_rwa"],
  });
  stub.taxonomy = async () => new Map([["xyz:CL", "commodities"]]);
  const feed = new SourceFeed((id) => stub.readSource(id), {
    clock: time.clock,
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  stub.sourceFeed = feed;
  context.after(() => feed.close());
  return { bridge, reads, budget, time, trace };
}

it("rejects a native source wire response older than five seconds instead of stamping completion time", async (context) => {
  const f = fixture(context, { rwa: false, delay: () => 6001 });
  await assert.rejects(f.time.finish(f.bridge.source("source")), {
    code: "SOURCE_STALE",
  });
  assert.equal(f.trace.length, 1);
  assert.equal(f.trace[0].completedAt! - f.trace[0].at, 6001);
});

for (const wireMs of [5000, 5001])
  it(`uses the real five-second source boundary for a ${wireMs}ms wire response`, async (context) => {
    const f = fixture(context, { rwa: false, delay: () => wireMs });
    const pending = f.time.finish(f.bridge.source("source"));
    if (wireMs > 5000) await assert.rejects(pending, { code: "SOURCE_STALE" });
    else {
      const snapshot = await pending;
      assert.equal(snapshot.observed_at, initialTime);
      assert.equal(snapshot.positions[0].observed_at, initialTime);
      assert.equal(snapshot.complete, true);
    }
  });

it("rejects a complete RWA sweep whose native evidence expired during a later DEX read", async (context) => {
  const f = fixture(context, {
    delay: (payload) =>
      payload.type === "clearinghouseState" && payload.dex ? 6001 : 0,
  });
  await assert.rejects(f.time.finish(f.bridge.source("source")), {
    code: "SOURCE_STALE",
  });
  assert.ok(
    f.trace.some(
      ({ payload }) =>
        payload.dex === "xyz" && payload.type === "clearinghouseState",
    ),
  );
  assert.ok(
    f.trace.some(
      ({ payload }) => payload.dex === "xyz" && payload.type === "meta",
    ),
  );
});

it("rejects a slow RWA metadata tail without relabeling the earlier state responses", async (context) => {
  const f = fixture(context, {
    delay: (payload) => (payload.type === "meta" ? 6001 : 0),
  });
  await assert.rejects(f.time.finish(f.bridge.source("source")), {
    code: "SOURCE_STALE",
  });
  const foreignState = f.trace.find(
    ({ payload }) =>
      payload.dex === "xyz" && payload.type === "clearinghouseState",
  )!;
  assert.ok(f.time.clock() - foreignState.at >= 6001);
});

it("keeps every fast RWA scope and each position's own real dispatch time", async (context) => {
  const f = fixture(context, {
    delay: (payload) =>
      payload.type === "meta"
        ? 300
        : payload.type === "clearinghouseState"
          ? 100
          : 0,
  });
  const snapshot = await f.time.finish(f.bridge.source("source"));
  const native = f.trace.find(
    ({ payload }) => payload.type === "clearinghouseState" && !payload.dex,
  )!;
  const foreign = f.trace.find(
    ({ payload }) =>
      payload.type === "clearinghouseState" && payload.dex === "xyz",
  )!;
  assert.deepEqual(snapshot.perps_dexes, ["", "xyz"]);
  assert.equal(snapshot.account_value_usdc, "150");
  assert.equal(snapshot.complete, true);
  assert.equal(snapshot.observed_at, native.at);
  assert.deepEqual(
    snapshot.positions.map((position) => [
      position.asset,
      position.observed_at,
    ]),
    [
      ["BTC", native.at],
      ["xyz:CL", foreign.at],
    ],
  );
  assert.ok(foreign.at > native.at);
  assert.ok(f.time.clock() > foreign.completedAt!);
});

it("does not age fresh native evidence by the budget queue wait before dispatch", async (context) => {
  const f = fixture(context, { rwa: false, delay: () => 100 });
  const blocker = await f.budget.acquire(
    "source",
    2,
    sourceAddress,
    new AbortController().signal,
  );
  blocker.sent();
  const pending = f.bridge.source("source");
  await f.time.flush();
  assert.equal(f.trace.length, 0);
  await f.time.advance(6001);
  blocker.settle(2);
  blocker.release();
  const snapshot = await f.time.finish(pending);
  assert.equal(snapshot.observed_at, f.trace[0].at);
  assert.ok(snapshot.observed_at >= initialTime + 6001);
  assert.equal(f.time.clock() - snapshot.observed_at, 100);
});

it("SourceFeed caches the original scope evidence times and refreshes when the earliest scope expires", async (context) => {
  const f = fixture(context, {
    delay: (payload) => (payload.type === "clearinghouseState" ? 100 : 0),
  });
  const first = await f.time.finish(f.bridge.source("source"));
  const count = f.trace.length;
  await f.time.advance(1000);
  const cached = await f.time.finish(f.bridge.source("source"));
  assert.equal(f.trace.length, count);
  assert.deepEqual(cached, first);
  assert.equal(cached.observed_at, f.trace[0].at);
  const untilExpired = first.observed_at + 5001 - f.time.clock();
  await f.time.advance(untilExpired);
  const refreshed = await f.time.finish(f.bridge.source("source"));
  assert.ok(f.trace.length > count);
  assert.ok(refreshed.observed_at > first.observed_at);
  assert.equal(refreshed.observed_at, f.trace[count].at);
});
