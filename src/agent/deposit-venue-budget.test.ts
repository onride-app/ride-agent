import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { DepositReads, type Deposit } from "./deposits.js";
import {
  VenueReadBudget,
  sharedVenueReadBudget,
  type BudgetTimers,
} from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import { AgentError } from "./contracts.js";

class FakeTime {
  at = 0;
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
    const flush = async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve();
    };
    const end = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, event]) => event.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
}

const master = `0x${"1".repeat(40)}`;
const deposit: Deposit = {
  id: "deposit_fixture",
  market: "perps",
  asset: "USDC",
  network: "Arbitrum",
  address: master,
  provider: "wallet",
  created_at: 1,
  baseline_wallet_usdc: "0",
};
const evidence = (type: string) =>
  type === "userAbstraction"
    ? "disabled"
    : {
        withdrawable: "10",
        marginSummary: { accountValue: "10" },
        assetPositions: [],
      };

function fixture(t: TestContext, network: "mainnet" | "testnet" = "mainnet") {
  const time = new FakeTime();
  const budget = new VenueReadBudget({
    limit: 1000,
    clock: time.clock,
    timers: time.timers,
  });
  const attempts: {
    path: "budgeted" | "ungated";
    url: string;
    type: string;
  }[] = [];
  let rateLimited = false;
  const request =
    (path: "budgeted" | "ungated"): typeof fetch =>
    async (url, init) => {
      const body = JSON.parse(String(init?.body));
      attempts.push({ path, url: String(url), type: body.type });
      return rateLimited
        ? new Response("{}", { status: 429, headers: { "Retry-After": "30" } })
        : Response.json(evidence(body.type));
    };
  t.mock.method(globalThis, "fetch", request("ungated"));
  t.mock.method(
    DepositReads.prototype as any,
    "walletBalance",
    async () => "0",
  );
  const bridge = new CoreBridge(
    "https://core.fixture",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    network,
  );
  (bridge as any).core = async (operation: string) => {
    assert.equal(
      operation,
      "perps_wallet",
      "status must not perform funding writes",
    );
    return { master, status: 4 };
  };
  const reads = new VenueReads(request("budgeted"), time.clock, 2, {
    budget,
    timers: time.timers,
    deadlineMs: 10,
  });
  (bridge as any).venueReads = reads;
  t.after(() => bridge.close());
  return {
    time,
    budget,
    reads,
    attempts,
    status: () =>
      bridge.operation("deposit_status", { user_id: "fixture", deposit }),
    limitProvider: () => {
      rateLimited = true;
    },
  };
}

it("deposit status cannot dispatch Hyperliquid reads when the bridge budget is full", async (t) => {
  const f = fixture(t);
  const ticket = await f.budget.acquire(
    "account",
    1000,
    "prior",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(1000);
  ticket.release();
  const status = f.status().catch((error) => error);
  await f.time.advance(11);
  const error = await status;
  assert.ok(error instanceof AgentError);
  assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
  assert.deepEqual(f.attempts, []);
  assert.equal(f.budget.snapshot().used, 1000);
});

for (const network of ["mainnet", "testnet"] as const)
  it(`deposit status shares the bridge reader and rechecks account mode on ${network}`, async (t) => {
    const f = fixture(t, network);
    const status = (await f.status()) as any;
    assert.equal(status.trading_observation, "verified");
    assert.equal(status.trading_balance_usdc, "10.000000");
    assert.deepEqual(
      f.attempts.map((attempt) => attempt.path),
      ["budgeted", "budgeted", "budgeted"],
    );
    assert.deepEqual(
      f.attempts.map((attempt) => attempt.type),
      ["userAbstraction", "clearinghouseState", "userAbstraction"],
    );
    assert.ok(
      f.attempts.every(
        (attempt) =>
          attempt.url ===
          (network === "mainnet"
            ? "https://api.hyperliquid.xyz/info"
            : "https://api.hyperliquid-testnet.xyz/info"),
      ),
    );
    assert.equal(f.budget.snapshot().used, 42);
  });

it("a funding-status 429 cools the same bridge budget before other source reads", async (t) => {
  const f = fixture(t);
  f.limitProvider();
  await assert.rejects(f.status(), { code: "VENUE_RATE_LIMITED" });
  assert.ok(f.budget.cooldownRemaining() >= 30_000);
  await assert.rejects(
    f.reads.read(
      "https://api.hyperliquid.xyz/info",
      { type: "clearinghouseState", user: master },
      0,
      "source",
    ),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(f.attempts.length, 1);
  assert.equal(f.attempts[0].path, "budgeted");
});

it("standalone deposit reads also charge the process-wide venue budget", async (t) => {
  t.mock.method(
    DepositReads.prototype as any,
    "walletBalance",
    async () => "0",
  );
  const attempts: string[] = [];
  const before = sharedVenueReadBudget.snapshot().used;
  const reads = new DepositReads(
    async () => ({ master, status: 4 }),
    "mainnet",
    async (_url, init) => {
      const type = JSON.parse(String(init?.body)).type;
      attempts.push(type);
      return Response.json(evidence(type));
    },
  );
  await reads.status(deposit, "fixture");
  assert.equal(sharedVenueReadBudget.snapshot().used - before, 42);
  assert.deepEqual(attempts, [
    "userAbstraction",
    "clearinghouseState",
    "userAbstraction",
  ]);
});
