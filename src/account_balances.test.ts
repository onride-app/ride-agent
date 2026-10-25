import assert from "node:assert/strict";
import { it } from "node:test";
import { readAccountBalances } from "./account_balances.js";
const owner = "0x" + "1".repeat(40),
  proxy = "0x" + "2".repeat(40);
function fixture(
  options: {
    sameWallet?: boolean;
    legacyWallet?: boolean;
    unified?: boolean;
    missingPerps?: boolean;
    missingPrediction?: boolean;
    rpcFailure?: boolean;
    foreignPosition?: boolean;
    unpriced?: boolean;
  } = {},
) {
  let publicCalls = 0;
  const request = (async (url: any, init: any) => {
    const u = new URL(String(url)),
      headers = new Headers(init?.headers);
    if (u.hostname === "core.test") {
      assert.equal(headers.get("authorization"), "Bearer fixture");
      const body = JSON.parse(init.body);
      assert(!body.query.includes("mutation"));
      assert.deepEqual(body.variables, {});
      if (body.query.includes("RideBalanceIdentity"))
        return Response.json({
          data: {
            me: {
              id: "alice",
              username: "Alice",
              proxyWalletAddress: proxy,
              legacyProxyWalletAddress: options.legacyWallet
                ? "0x" + "3".repeat(40)
                : proxy,
            },
          },
        });
      if (body.query.includes("RidePredictionBalance"))
        return options.missingPrediction
          ? Response.json({ errors: [{}] })
          : Response.json({
              data: {
                walletBalance: {
                  proxyWalletAddress: proxy,
                  totalBalance: 7,
                  nativeUsdcBalance: 4,
                },
              },
            });
      if (body.query.includes("RideOwnedPerpsBalance")) {
        if (options.missingPerps) return Response.json({ errors: [{}] });
        const embedded = headers.has("x-hyperliquid-wallet-mode");
        if (embedded && !options.sameWallet)
          return Response.json({
            data: {
              hyperliquidAccountState: {
                userId: "alice",
                accountValue: "0",
                withdrawable: "0",
                totalMarginUsed: "0",
                totalNtlPos: "0",
                isStale: false,
                wallet: { status: "NOT_CREATED", masterWalletAddress: null },
              },
            },
          });
        return Response.json({
          data: {
            hyperliquidAccountState: {
              userId: "alice",
              accountValue: options.unified ? "43" : "40",
              withdrawable: options.unified ? "40" : "37",
              totalMarginUsed: "3",
              totalNtlPos: "60",
              accountAbstraction: options.unified
                ? "unifiedAccount"
                : "disabled",
              isStale: false,
              wallet: {
                masterWalletAddress: owner,
                walletGeneration: embedded ? 2 : 1,
                status: "ACTIVE",
              },
              positions: [],
              rawResponseJson: JSON.stringify({ time: Date.now() }),
            },
          },
        });
      }
      throw Error("Unknown fixed account query");
    }
    publicCalls++;
    assert.equal(
      headers.get("authorization"),
      null,
      "Ride JWT must never reach an external data API",
    );
    if (String(url).includes("polygon-bor-rpc.publicnode.com")) {
      if (options.rpcFailure)
        return Response.json({ error: "source unavailable" }, { status: 503 });
      const calls = JSON.parse(init.body);
      return Response.json(
        calls.map((c: any, i: number) => ({
          jsonrpc: "2.0",
          id: c.id,
          result:
            c.method === "eth_chainId"
              ? "0x89"
              : c.method === "eth_getBlockByNumber"
                ? {
                    number: "0x123",
                    timestamp:
                      "0x" + Math.floor(Date.now() / 1000).toString(16),
                  }
                : "0x" +
                  (BigInt([7, 0, 4, 5, 0, 2][i]) * 1000000n)
                    .toString(16)
                    .padStart(64, "0"),
        })),
      );
    }
    if (u.hostname === "api.hyperliquid.xyz") {
      const body = JSON.parse(init.body);
      if (body.type === "spotClearinghouseState") {
        assert.equal(body.user, owner);
        return Response.json({
          balances: [
            { coin: "USDC", total: "3", hold: "0" },
            ...(options.unpriced
              ? [{ coin: "UNKNOWN", total: "1", hold: "0" }]
              : []),
          ],
        });
      }
      if (body.type === "spotMetaAndAssetCtxs")
        return Response.json([{ tokens: [], universe: [] }, []]);
    }
    if (u.hostname === "data-api.polymarket.com") {
      assert(
        [proxy, "0x" + "3".repeat(40)].includes(u.searchParams.get("user")!),
      );
      return Response.json([
        {
          proxyWallet: options.foreignPosition
            ? owner
            : u.searchParams.get("user"),
          asset: "token",
          currentValue: 3,
        },
        {
          proxyWallet: u.searchParams.get("user"),
          asset: "token",
          currentValue: 3,
        },
      ]);
    }
    throw Error("Unexpected source");
  }) as typeof fetch;
  return { request, calls: () => publicCalls };
}
it("reads the App's 43 USD Perps separately from 7 USDC Prediction cash and never adds copy budgets or duplicate wallets", async () => {
  const f = fixture({ sameWallet: true }),
    out = await readAccountBalances(
      "https://core.test/graphql",
      "fixture",
      f.request,
    );
  assert.equal(out.markets.perps.account_value_usd, "43.000000");
  assert.equal(out.markets.perps.available_trading_usdc, "40.000000");
  assert.equal(out.markets.perps.wallets.length, 1);
  assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
  assert.equal(out.markets.prediction.positions_value_usd, "3.000000");
  assert.equal(out.markets.prediction.account_value_usd, "10.000000");
  assert.equal(out.summary.known_subtotal_usd, "53.000000");
  assert.equal(out.summary.account_value_usd, null);
  assert.equal(out.markets.meme.account_value_usd, null);
  assert.equal(out.markets.meme.status, "unsupported");
  assert.equal(out.markets.prediction.occupied_or_reserved_usdc, null);
  assert(!JSON.stringify(out).includes(owner));
  assert(!JSON.stringify(out).includes(proxy));
});
it("keeps verified wallet availability in the subtotal while incomplete market totals stay unknown", async () => {
  const f = fixture({ sameWallet: true });
  const partial = (async (url: any, init: any) => {
    if (
      String(url).includes("core.test") &&
      JSON.parse(init.body).query.includes("RideOwnedPerpsBalance") &&
      !new Headers(init.headers).has("x-hyperliquid-wallet-mode")
    )
      return Response.json({ errors: [{}] });
    return f.request(url, init);
  }) as typeof fetch;
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    partial,
  );
  assert.equal(out.markets.perps.status, "partial");
  assert.equal(out.markets.perps.available_trading_usdc, null);
  assert.equal(out.markets.perps.known_available_trading_usdc, "40.000000");
  assert.equal(out.summary.known_available_trading_usdc, "47.000000");
  assert.equal(out.summary.available_trading_usdc, null);
  assert.equal(out.summary.copy_ready_usdc, null);
});
it("Unified account equity already includes Spot USDC and is never counted twice", async () => {
  const f = fixture({ unified: true, sameWallet: true });
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
  );
  assert.equal(out.markets.perps.account_value_usd, "43.000000");
  assert.equal(out.markets.perps.available_trading_usdc, "40.000000");
});
it("reports failed market reads and unpriced holdings as unavailable while retaining independent markets", async () => {
  for (const flags of [{ missingPerps: true }, { unpriced: true }]) {
    const f = fixture(flags),
      out = await readAccountBalances(
        "https://core.test/graphql",
        "fixture",
        f.request,
      );
    assert.equal(out.markets.perps.account_value_usd, null);
    assert.equal(out.markets.prediction.account_value_usd, "10.000000");
    assert.equal(out.summary.supported_markets_complete, false);
  }
});

it("does not turn a failed token RPC into zero collateral even if legacy GraphQL reports a balance", async () => {
  const f = fixture({ rpcFailure: true });
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
  );
  assert.equal(out.markets.prediction.available_trading_usdc, null);
  assert.equal(out.markets.prediction.account_value_usd, null);
  assert.equal(out.markets.prediction.known_subtotal_usd, "3.000000");
  assert.equal(out.markets.perps.account_value_usd, "43.000000");
});
it("rejects inventory belonging to another wallet without losing independently verified cash", async () => {
  const f = fixture({ foreignPosition: true });
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
  );
  assert.equal(out.markets.prediction.positions_value_usd, null);
  assert.equal(out.markets.prediction.account_value_usd, null);
  assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
});

it("includes retained Prediction cash once and explains the difference from App current-wallet availability", async () => {
  const f = fixture({ legacyWallet: true });
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
  );
  assert.equal(out.markets.prediction.account_value_usd, "18.000000");
  assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
  assert.equal(out.markets.prediction.retained_wallet_cash_usdc, "5.000000");
  assert.equal(out.markets.prediction.app_display_value_usd, "13.000000");
  assert.equal(out.markets.prediction.position_wallet_count, 2);
});
