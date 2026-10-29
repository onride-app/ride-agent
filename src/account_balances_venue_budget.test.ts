import assert from "node:assert/strict";
import { it } from "node:test";
import { readAccountBalances } from "./account_balances.js";
import { VenueReads } from "./agent/venue-reads.js";
import {
  VenueReadBudget,
  sharedVenueReadBudget,
} from "./agent/venue-read-budget.js";

const owner = `0x${"1".repeat(40)}`;
const proxy = `0x${"2".repeat(40)}`;
function fixture(rateLimited = false) {
  const venueCalls: string[] = [];
  let predictionCalls = 0;
  const request: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const headers = new Headers(init?.headers);
    if (u.hostname === "core.fixture") {
      assert.equal(headers.get("authorization"), "Bearer private-fixture");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.variables, {});
      assert.ok(!body.query.includes("mutation"));
      if (body.query.includes("RideBalanceIdentity"))
        return Response.json({
          data: { me: { id: "alice", proxyWalletAddress: proxy } },
        });
      if (body.query.includes("RidePredictionBalance"))
        return Response.json({
          errors: [{ message: "fixture cash unavailable" }],
        });
      assert.ok(body.query.includes("RideOwnedPerpsBalance"));
      const absent = headers.has("x-hyperliquid-wallet-mode");
      return Response.json({
        data: {
          hyperliquidAccountState: {
            userId: "alice",
            accountValue: absent ? "0" : "10",
            withdrawable: absent ? "0" : "10",
            totalMarginUsed: "0",
            totalNtlPos: "0",
            accountAbstraction: "disabled",
            isStale: false,
            wallet: {
              masterWalletAddress: absent ? null : owner,
              status: absent ? "NOT_CREATED" : "ACTIVE",
              walletGeneration: 1,
            },
            rawResponseJson: JSON.stringify({ time: Date.now() }),
          },
        },
      });
    }
    assert.equal(
      headers.get("authorization"),
      null,
      "private Core credentials must never reach public venues",
    );
    if (u.hostname === "api.hyperliquid.xyz") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.type, "spotClearinghouseState");
      assert.equal(body.user, owner);
      venueCalls.push(body.type);
      return rateLimited
        ? new Response("{}", { status: 429, headers: { "Retry-After": "30" } })
        : Response.json({ balances: [] });
    }
    assert.equal(u.hostname, "data-api.polymarket.com");
    assert.equal(u.searchParams.get("user"), proxy);
    predictionCalls++;
    return Response.json([]);
  };
  return { request, venueCalls, predictionCalls: () => predictionCalls };
}

it("a full gateway venue budget makes Perps unavailable without public Hyperliquid dispatch", async () => {
  const f = fixture();
  const budget = new VenueReadBudget({ limit: 20 });
  const ticket = await budget.acquire(
    "account",
    20,
    "prior",
    new AbortController().signal,
  );
  ticket.sent();
  ticket.settle(20);
  ticket.release();
  const reads = new VenueReads(f.request, Date.now, 2, {
    budget,
    deadlineMs: 1,
  });
  const output = await readAccountBalances(
    "https://core.fixture/graphql",
    "private-fixture",
    f.request,
    reads,
  );
  assert.deepEqual(f.venueCalls, []);
  assert.equal(output.markets.perps.status, "unavailable");
  assert.equal(output.markets.perps.account_value_usd, null);
  assert.equal(output.markets.perps.available_trading_usdc, null);
  assert.equal(output.markets.perps.positions_value_usd, null);
  assert.equal(budget.snapshot().used, 20);
  assert.equal(
    f.predictionCalls(),
    1,
    "independent Prediction reads keep their original path",
  );
});

it("a gateway balance 429 cools the same reader and cannot turn missing balances into zero", async () => {
  const f = fixture(true);
  const budget = new VenueReadBudget();
  const reads = new VenueReads(f.request, Date.now, 2, { budget });
  const output = await readAccountBalances(
    "https://core.fixture/graphql",
    "private-fixture",
    f.request,
    reads,
  );
  assert.equal(output.markets.perps.status, "unavailable");
  assert.equal(output.markets.perps.account_value_usd, null);
  assert.equal(output.markets.perps.available_trading_usdc, null);
  assert.ok(budget.cooldownRemaining() >= 29_000);
  await assert.rejects(
    reads.read("https://api.hyperliquid.xyz/info", {
      type: "spotClearinghouseState",
      user: owner,
    }),
    { code: "VENUE_RATE_LIMITED" },
  );
  assert.equal(f.venueCalls.length, 1);
});

it("default gateway balance readers share the process budget without caching completed balances", async () => {
  const f = fixture();
  const before = sharedVenueReadBudget.snapshot().used;
  for (let i = 0; i < 2; i++) {
    const output = await readAccountBalances(
      "https://core.fixture/graphql",
      "private-fixture",
      f.request,
    );
    assert.equal(output.markets.perps.account_value_usd, "10.000000");
    assert.equal(output.markets.perps.available_trading_usdc, "10.000000");
  }
  assert.equal(f.venueCalls.length, 2);
  assert.equal(sharedVenueReadBudget.snapshot().used - before, 4);
});

it("the gateway's existing overall deadline cancels queued default-reader work before dispatch", async (t) => {
  const f = fixture();
  const overall = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) =>
    milliseconds === 22000
      ? overall.signal
      : originalTimeout.call(AbortSignal, milliseconds),
  );
  const remaining =
    sharedVenueReadBudget.limit - sharedVenueReadBudget.snapshot().used;
  if (remaining > 0) {
    const held = await sharedVenueReadBudget.acquire(
      "account",
      remaining,
      owner,
      new AbortController().signal,
    );
    held.sent();
    held.settle(remaining);
    held.release();
  }
  const pending = readAccountBalances(
    "https://core.fixture/graphql",
    "private-fixture",
    f.request,
  );
  for (let i = 0; i < 100; i++) await Promise.resolve();
  assert.equal(sharedVenueReadBudget.snapshot().account_queued, 1);
  assert.deepEqual(f.venueCalls, []);
  overall.abort(new Error("fixture overall deadline expired"));
  const output = await pending;
  assert.equal(output.markets.perps.status, "unavailable");
  assert.equal(output.markets.perps.account_value_usd, null);
  assert.deepEqual(f.venueCalls, []);
  assert.equal(sharedVenueReadBudget.snapshot().account_queued, 0);
});
