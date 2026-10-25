import assert from "node:assert/strict";
import { it } from "node:test";
import {
  accountCopiesInput,
  invokeAccountRead,
  readAccountCopies,
} from "./account_reads.js";
import { publicResult, result } from "./agent/contracts.js";

const address = "0x" + "a".repeat(40);
function fixtureFetch(failEmbedded = false): typeof fetch {
  return (async (_url, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer fixture-session");
    const body = JSON.parse(String(init?.body));
    assert(!body.query.includes("mutation"));
    assert(!("user_id" in body.variables));
    if (body.query.includes("RideAppCopies"))
      return Response.json({
        data: {
          me: { id: "account-alice", username: "Alice" },
          myCopyTradeConfigs: [
            {
              id: "prediction-config",
              traderAddress: address,
              isEnabled: true,
            },
          ],
          copyTradeSummary: {
            totalConfigs: 1,
            enabledConfigs: 1,
            totalOpenPositions: 1,
          },
          openInventory: { totalCount: 1 },
          closingInventory: { totalCount: 0 },
          positions0: { positions: [], hasNextPage: false },
          positions1: {
            positions: [
              {
                id: "prediction-position",
                status: "OPEN",
                traderAddress: address,
              },
            ],
            hasNextPage: false,
          },
          positions2: { positions: [], hasNextPage: false },
          positions3: { positions: [], hasNextPage: false },
        },
      });
    const embedded = headers.get("x-hyperliquid-wallet-mode") === "embedded-v1";
    if (embedded && failEmbedded)
      return Response.json(
        { errors: [{ message: "Unavailable" }] },
        { status: 503 },
      );
    return Response.json({
      data: {
        myPerpsAutoRideConfigs: [
          {
            id: embedded ? "embedded-config" : "legacy-config",
            traderAddress: address,
          },
        ],
        myPerpsAutoRidePositions: [
          {
            id: "retained-position",
            traderAddress: address,
            status: "open",
            coin: "BTC",
            size: "0.1",
          },
          {
            id: "closed-position",
            traderAddress: address,
            status: "closed",
            coin: "ETH",
            size: "0",
          },
        ],
      },
    });
  }) as typeof fetch;
}

it("reads both App wallet generations, deduplicates retained positions and confirms account identity", async () => {
  const value = publicResult(
    await readAccountCopies(
      "https://core.test/graphql",
      "fixture-session",
      {},
      fixtureFetch(),
    ),
  );
  assert.equal(value.status, "ok");
  assert.deepEqual(value.data.account, {
    authenticated: true,
    user_id: "account-alice",
    display_name: "Alice",
  });
  const perps = value.data.perps as any;
  assert.equal(perps.configs.length, 2);
  assert.equal(perps.positions.length, 1);
  assert.equal(perps.positions[0].coin, "BTC");
  assert(!JSON.stringify(value).includes(address));
  assert.equal(value.data.coverage_complete, true);
});

it("reports unavailable wallet reads as partial coverage instead of an empty account", async () => {
  const value = await readAccountCopies(
    "https://core.test/graphql",
    "fixture-session",
    {},
    fixtureFetch(true),
  );
  assert.equal(value.status, "stale");
  assert.equal(value.data.coverage_complete, false);
  assert.equal((value.data.account as any).authenticated, true);
  assert.equal((value.data.perps as any).configs.length, 1);
});

it("counts stopped Prediction inventory across all pages and presents one valuation pair", async () => {
  const base = fixtureFetch();
  const fetcher = (async (url, init) => {
    const response = await base(url, init);
    if (!JSON.parse(String(init?.body)).query.includes("RideAppCopies"))
      return response;
    const body = (await response.json()) as any;
    body.data.myCopyTradeConfigs[0].isEnabled = false;
    body.data.copyTradeSummary.totalOpenPositions = 0;
    body.data.openInventory.totalCount = 3;
    body.data.closingInventory.totalCount = 2;
    body.data.positions1.hasNextPage = true;
    Object.assign(body.data.positions1.positions[0], {
      currentPnl: "-2",
      currentPnlPercent: "-40",
      displayCurrentValue: "6",
      displayCurrentPnl: "1",
      displayCurrentPnlPercent: "999",
    });
    return Response.json(body);
  }) as typeof fetch;
  const value = await readAccountCopies(
    "https://core.test/graphql",
    "fixture-session",
    { limit: 1, offset: 10 },
    fetcher,
  );
  const prediction = value.data.prediction as any;
  assert.equal(prediction.summary.totalOpenPositions, 5);
  assert.equal(prediction.summary.openPositionCount, 3);
  assert.equal(prediction.summary.closingPositionCount, 2);
  assert.equal(prediction.summary.includes_disabled_configs, true);
  assert.equal(prediction.positions.length, 1);
  const p = prediction.positions[0];
  assert.equal(p.currentPnl, "1");
  assert.equal(p.displayCurrentPnl, p.currentPnl);
  assert.equal(p.currentPnlPercent, "20.000000");
  assert.equal(p.displayCurrentPnlPercent, p.currentPnlPercent);
  assert.equal(p.valuation.source, "copy_wallet_display_metrics");
  assert.equal(p.valuation.source_observed_at, null);
  assert.equal(value.status, "stale");
});

it("leaves missing counts and wallet cost basis unavailable instead of reusing stale metrics", async () => {
  const base = fixtureFetch();
  const fetcher = (async (url, init) => {
    const response = await base(url, init);
    if (!JSON.parse(String(init?.body)).query.includes("RideAppCopies"))
      return response;
    const body = (await response.json()) as any;
    delete body.data.openInventory;
    Object.assign(body.data.positions1.positions[0], {
      currentPnl: "-2",
      currentPnlPercent: "-40",
      displayCurrentPnl: "1",
    });
    return Response.json(body);
  }) as typeof fetch;
  const value = await readAccountCopies(
    "https://core.test/graphql",
    "fixture-session",
    {},
    fetcher,
  );
  const prediction = value.data.prediction as any;
  assert.equal(prediction.summary.totalOpenPositions, null);
  assert.equal(prediction.positions[0].currentPnlPercent, null);
  assert.equal(value.data.coverage_complete, false);
  assert.equal(value.status, "stale");
});

it("never accepts a caller-supplied account identity or turns an account failure into logged-out state", async () => {
  assert.throws(() => accountCopiesInput.parse({ user_id: "other-account" }));
  const failed = (async () =>
    Response.json({ errors: [{}] }, { status: 503 })) as typeof fetch;
  await assert.rejects(
    readAccountCopies(
      "https://core.test/graphql",
      "fixture-session",
      {},
      failed,
    ),
    /could not be verified/,
  );
  const value = await invokeAccountRead(
    "get_portfolio",
    {},
    "fixture-session",
    "https://core.test/graphql",
    async () => result({ portfolio: null }, "empty"),
    failed,
  );
  assert.equal(value.status, "stale");
  assert.deepEqual(value.data.account, { authenticated: true });
  assert.equal(value.data.agent_portfolio_status, "empty");
});

it("shows existing App holdings even when the Agent has only an empty portfolio", async () => {
  const value = await invokeAccountRead(
    "get_portfolio",
    {},
    "fixture-session",
    "https://core.test/graphql",
    async () => result({ portfolio: null }, "empty"),
    fixtureFetch(),
  );
  assert.equal(value.status, "stale"); // Copy inventory is complete; balance APIs are absent from this fixture.
  assert.equal(value.data.portfolio, null);
  assert.equal(value.data.agent_portfolio_status, "empty");
  assert.equal((value.data.account as any).authenticated, true);
  assert.equal((value.data.app_copies as any).perps.positions.length, 1);
});

it("separates a ready preview from incomplete balance coverage", async () => {
  const value = await invokeAccountRead(
    "get_portfolio",
    {},
    "fixture-session",
    "https://core.test/graphql",
    async () => result({ portfolio: null, plan_status: "ready" }, "empty"),
    fixtureFetch(),
  );
  assert.equal(value.status, "stale");
  assert.equal((value.data.status_breakdown as any).plan, "ready");
  assert.equal(
    (value.data.status_breakdown as any).authentication,
    "authenticated",
  );
  assert.equal(
    (value.data.status_breakdown as any).account_coverage,
    "partial",
  );
});
it("keeps authoritative execution states even when account balance coverage is partial", async () => {
  for (const status of [
    "uncertain",
    "partially_filled",
    "executing",
    "settling",
  ] as const) {
    const value = await invokeAccountRead(
      "get_portfolio",
      {},
      "fixture-session",
      "https://core.test/graphql",
      async () => result({ portfolio: { id: "owned" } }, status),
      fixtureFetch(),
    );
    assert.equal(value.status, status);
    assert.equal(value.data.agent_portfolio_status, status);
    assert.equal(value.data.account_coverage_status, "partial");
    assert.equal(
      (value.data.account_balances as any).summary.account_value_usd,
      null,
    );
  }
});
