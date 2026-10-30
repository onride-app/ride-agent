import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import type { Portfolio } from "./domain.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
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
    const end = this.at + ms;
    await flush();
    for (;;) {
      const first = [...this.events]
        .filter(([, event]) => event.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.at = first[1].at;
      this.events.delete(first[0]);
      first[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  sleep(ms: number) {
    return new Promise<void>((resolve) => this.timers.setTimeout(resolve, ms));
  }
  async resolve<T>(work: Promise<T>): Promise<T> {
    let done = false,
      result!: T,
      error: unknown;
    void work.then(
      (value) => {
        result = value;
        done = true;
      },
      (value) => {
        error = value;
        done = true;
      },
    );
    for (let elapsed = 0; !done && elapsed <= 20000; elapsed += 100)
      await this.advance(100);
    assert.equal(
      done,
      true,
      "the existing complete observation deadline must remain bounded",
    );
    if (error) throw error;
    return result;
  }
}

function fixture(
  t: TestContext,
  options: { fill?: boolean; incompleteFlows?: boolean } = {},
) {
  const time = new FakeTime(),
    base = 1793200000000,
    master = "0x" + "a".repeat(40),
    reads: { type: string; dex?: string }[] = [],
    lookups: string[] = [];
  t.mock.method(Date, "now", () => base + time.at);
  const previous = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any,
    budget = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  const fill = {
    oid: 778,
    tid: 55,
    coin: "BTC",
    sz: "0.2",
    side: "B",
    px: "100",
    fee: "0.01",
    feeToken: "USDC",
    time: base - 500,
  };
  const fetcher = (async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    reads.push({ type: payload.type, dex: payload.dex });
    let data: unknown;
    switch (payload.type) {
      case "userAbstraction":
        data = "unifiedAccount";
        break;
      case "clearinghouseState":
        data = {
          marginSummary: { accountValue: "0" },
          withdrawable: "0",
          assetPositions: options.fill
            ? [{ position: { coin: "BTC", szi: "0.2" } }]
            : [],
        };
        break;
      case "allMids":
        data = { BTC: "100" };
        break;
      case "spotClearinghouseState":
        data = {
          balances: [{ coin: "USDC", token: 0, total: "100", hold: "0" }],
        };
        break;
      case "frontendOpenOrders":
        data = [];
        break;
      case "meta":
        data = { universe: [{ name: "BTC", maxLeverage: 10, szDecimals: 3 }] };
        break;
      case "userDexAbstraction":
        data = false;
        break;
      case "perpDexs":
        data = [null, { name: "xyz" }];
        break;
      case "userFillsByTime":
        data = options.fill ? [fill] : [];
        break;
      case "userFunding":
        data = [];
        break;
      case "userNonFundingLedgerUpdates":
        data = options.incompleteFlows ? {} : [];
        break;
      default:
        assert.fail("Unexpected read " + payload.type);
    }
    await time.sleep(250);
    return Response.json(data);
  }) as typeof fetch;
  const reader = new VenueReads(fetcher, () => base + time.at, 2, {
    budget,
    timers: time.timers,
    report: () => {},
  });
  stub.venueReads = reader;
  stub.orderSnapshots = {
    readAccount: async (
      address: string,
      dexes: string[],
      signal: AbortSignal,
    ) => {
      assert.equal(address, master);
      assert.deepEqual(dexes, ["", "xyz"]);
      assert.equal(signal.aborted, false);
      const dispatched = base + time.at;
      await time.sleep(300);
      return {
        orders: new Map([
          ["", []],
          ["xyz", []],
        ]),
        states: new Map([
          [
            "",
            {
              marginSummary: { accountValue: "0" },
              withdrawable: "0",
              assetPositions: options.fill
                ? [{ position: { coin: "BTC", szi: "0.2" } }]
                : [],
            },
          ],
          ["xyz", { assetPositions: [] }],
        ]),
        dispatches: {
          orders: new Map(dexes.map((dex) => [dex, dispatched])),
          states: new Map(dexes.map((dex) => [dex, dispatched])),
        },
      };
    },
  };
  stub.core = async (operation: string, input: any) => {
    assert.equal(input.user_id, "alice");
    assert.equal(input.account_id, "owned");
    if (operation === "perps_account") return { master, status: 4 };
    assert.equal(
      operation,
      "perps_execution",
      "the test must never sign, bind, submit, or transfer",
    );
    reader.accountReadTimeout();
    lookups.push(input.task_id);
    await time.sleep(1000);
    reader.accountReadTimeout();
    return { legs: [{ oid: 778 }] };
  };
  const portfolio = {
    account_id: "owned",
    venue_accounts: { perps: "owned" },
    sleeves: [],
    executions: Array.from({ length: options.fill ? 1 : 500 }, (_, i) => ({
      status: "failed",
      task_id: `task_${i}`,
      key: "perps:BTC",
    })),
    ledger_started_at: base - 60000,
  } as unknown as Portfolio;
  t.after(async () => {
    if (previous === undefined) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = previous;
    await bridge.close();
  });
  return { time, base, bridge, portfolio, reads, lookups, fill };
}

it("returns a fresh complete snapshot without looking up 500 failed historical tasks when fills are empty", async (t) => {
  const f = fixture(t),
    snapshot = await f.time.resolve(
      f.bridge.perpsAccount("alice", f.portfolio),
    );
  assert.equal(snapshot.coverage_complete, true);
  assert.equal(snapshot.eligible, true);
  assert.equal(snapshot.dedicated, true);
  assert.equal(snapshot.account_value_usdc, "100.000000");
  assert.equal(snapshot.available_usdc, "100.000000");
  assert.deepEqual(snapshot.positions, {});
  assert.deepEqual(snapshot.fills, []);
  assert.deepEqual(snapshot.funding, []);
  assert.deepEqual(snapshot.flows, []);
  assert.deepEqual(f.lookups, []);
  assert.ok(f.time.at <= 20000);
  assert.ok(
    snapshot.observed_at >= f.base &&
      f.base + f.time.at - snapshot.observed_at <= 20000,
  );
  for (const type of [
    "spotClearinghouseState",
    "userFillsByTime",
    "userFunding",
    "userNonFundingLedgerUpdates",
  ])
    assert.ok(
      f.reads.some((read) => read.type === type && !read.dex),
      "all required native and history evidence remains present",
    );
  assert.equal(
    f.reads.filter((read) => read.type === "userAbstraction").length,
    2,
  );
  assert.ok(
    f.portfolio.executions.every((execution) => execution.status === "failed"),
  );
});

it("retains task lookup and exact attribution for a nonempty owned USDC fill", async (t) => {
  const f = fixture(t, { fill: true }),
    snapshot = await f.time.resolve(
      f.bridge.perpsAccount("alice", f.portfolio),
    );
  assert.equal(snapshot.coverage_complete, true);
  assert.deepEqual(f.lookups, ["task_0"]);
  assert.deepEqual(snapshot.fills, [
    {
      id: "hl_55_778",
      order_id: "778",
      task_id: "task_0",
      key: "perps:BTC",
      quantity: "0.2",
      price: "100",
      fee_usdc: "0.01",
      at: f.fill.time,
    },
  ]);
  assert.equal(
    f.portfolio.executions[0].status,
    "failed",
    "OID attribution must not become a status reconciliation side effect",
  );
});

it("keeps incomplete history coverage false without looking up historical tasks when fills are empty", async (t) => {
  const f = fixture(t, { incompleteFlows: true }),
    snapshot = await f.time.resolve(
      f.bridge.perpsAccount("alice", f.portfolio),
    );
  assert.equal(snapshot.coverage_complete, false);
  assert.deepEqual(snapshot.fills, []);
  assert.deepEqual(snapshot.flows, []);
  assert.deepEqual(f.lookups, []);
  assert.ok(
    f.reads.some((read) => read.type === "userNonFundingLedgerUpdates"),
  );
});
