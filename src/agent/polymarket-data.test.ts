import assert from "node:assert/strict";
import { it } from "node:test";
import { readPredictionPositionsV2 } from "./polymarket-data.js";
import { PredictionVenue } from "./prediction.js";

const wallet = "0x" + "a".repeat(40),
  condition = "0x" + "b".repeat(64);
const row = (patch = {}) => ({
  proxy_wallet: wallet,
  token_id: "123",
  condition_id: condition,
  status: "OPEN",
  current_size: 10,
  current_price: 0.3,
  current_value: 3,
  avg_price: 0.2,
  ...patch,
});
const page = (data: unknown[], next: string | null = null) =>
  Response.json({
    data,
    pagination: { has_more: next !== null, next_cursor: next },
  });

it("walks short and empty cursor pages with identical wallet/cohort filters and retains held losers", async () => {
  const calls: URL[] = [];
  const request = (async (url: URL, init: RequestInit) => {
    calls.push(url);
    assert.equal(url.pathname, "/v2/positions");
    assert.equal(url.searchParams.get("user"), wallet);
    assert.equal(url.searchParams.get("filter_amount"), "0");
    assert.equal(url.searchParams.get("include_archived"), "true");
    assert(!url.searchParams.has("offset"));
    assert.equal(new Headers(init.headers).get("authorization"), null);
    if (url.searchParams.get("status") === "REDEEMABLE_LOST")
      return page([
        row({
          token_id: "124",
          status: "REDEEMABLE",
          current_price: 0,
          current_value: 0,
        }),
      ]);
    return url.searchParams.get("cursor") === "next"
      ? page([row()])
      : page([], "next");
  }) as typeof fetch;
  const value = await readPredictionPositionsV2(wallet, { request });
  assert.equal(calls.length, 3);
  assert.equal(value.rows.length, 2);
  assert.equal(value.rows[0].asset, "123");
  assert.equal(value.rows[0].size, 10);
  assert.equal(value.rows[1].currentValue, 0);
  assert.equal(value.coverage_complete, false);
  assert.equal(value.coverage_scope, "servable_markets_only");
});

for (const [name, response] of [
  ["missing pagination", () => Response.json({ data: [] })],
  [
    "inconsistent cursor",
    () =>
      Response.json({
        data: [],
        pagination: { has_more: true, next_cursor: null },
      }),
  ],
  [
    "foreign wallet",
    () => page([row({ proxy_wallet: "0x" + "c".repeat(40) })]),
  ],
  ["malformed token", () => page([row({ token_id: "not-a-token" })])],
  ["overflow token", () => page([row({ token_id: (1n << 256n).toString() })])],
  ["closed row in open inventory", () => page([row({ status: "CLOSED" })])],
  ["null valuation", () => page([row({ current_value: null })])],
  ["conflicting aliases", () => page([row({ asset: "999" })])],
  ["changed duplicate", () => page([row(), row({ current_size: 1 })])],
] as const) {
  it(`fails ${name} closed instead of returning flat or zero-value positions`, async () => {
    await assert.rejects(
      readPredictionPositionsV2(wallet, {
        request: (async () => response()) as typeof fetch,
      }),
      { code: "PREDICTION_DATA_INCOMPLETE" },
    );
  });
}

it("rejects repeated cursors and page caps without publishing a truncated snapshot", async () => {
  for (const maxPages of [1, 3]) {
    await assert.rejects(
      readPredictionPositionsV2(wallet, {
        maxPages,
        request: (async () => page([], "same")) as typeof fetch,
      }),
      { code: "PREDICTION_DATA_INCOMPLETE" },
    );
  }
});

it("keeps an empty terminal servable response explicitly incomplete", async () => {
  const value = await readPredictionPositionsV2(wallet, {
    request: (async () => page([])) as typeof fetch,
  });
  assert.deepEqual(value.rows, []);
  assert.equal(value.coverage_complete, false);
});

it("never binds or claims a Prediction wallet based on empty servable inventory", async (t) => {
  t.mock.method(globalThis, "fetch", async () => page([]));
  const calls: string[] = [];
  const venue = new PredictionVenue(
    { query: async () => assert.fail("No metadata write") } as any,
    async (operation) => {
      calls.push(operation);
      assert.equal(operation, "prediction_wallet");
      return { wallet };
    },
    "fixture-salt",
  );
  await assert.rejects(
    venue.account(
      "owner",
      { id: "portfolio", revision: 1, sleeves: [] } as any,
      true,
    ),
    (error: any) =>
      error.code === "ACCOUNT_NOT_READY" &&
      error.details.reason_code === "PREDICTION_SERVABLE_ONLY",
  );
  assert.deepEqual(calls, ["prediction_wallet"]);
  (venue as any).resolve = async () => ({ address: wallet });
  await assert.rejects(venue.source("saved-trader"), {
    code: "SOURCE_SCOPE_UNAVAILABLE",
  });
});

it("retains independently verified owned balances and receipts without claiming full Prediction coverage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => page([]));
  const portfolio = {
    id: "saved",
    revision: 1,
    sleeves: [],
    executions: [],
  } as any;
  const venue = new PredictionVenue(
    { query: async () => assert.fail("No metadata write") } as any,
    async (operation) => {
      assert.equal(operation, "prediction_wallet");
      return {
        wallet,
        conditional_tokens: "0x" + "d".repeat(40),
        eligible: true,
        ownership: { portfolio_id: "saved" },
      };
    },
    "fixture-salt",
  );
  (venue as any).provider = () => ({ getBlockNumber: async () => 100 });
  (venue as any).cashBalance = async () => "7";
  (venue as any).settlement = async () => ({
    fills: [],
    orders: [],
    flows: [],
    complete: true,
  });
  const account = await venue.account("owner", portfolio);
  assert.equal(account.available_usdc, "7");
  assert.equal(account.dedicated, true);
  assert.equal(account.coverage_complete, false);
  assert.deepEqual(account.fills, []);
});
