import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./agent/contracts.js";
import type { VenueReads } from "./agent/venue-reads.js";
import { VenueReadBudget } from "./agent/venue-read-budget.js";
import {
  readAccountBalances,
  type AccountBalanceReadDiagnostic,
} from "./account_balances.js";
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
    mode?: unknown;
    secondaryMode?: unknown;
    spotBalances?: { coin: string; total: string; hold: string }[];
    embeddedSpot?: boolean;
    price?: string;
    perpsOverride?: Record<string, unknown>;
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
              rawResponseJson: JSON.stringify({
                time: Date.now(),
                ...(options.embeddedSpot
                  ? {
                      spotClearinghouseState: {
                        balances: options.spotBalances,
                      },
                    }
                  : {}),
              }),
              ...(Object.hasOwn(options, "mode")
                ? { accountAbstraction: options.mode }
                : {}),
              ...(embedded && Object.hasOwn(options, "secondaryMode")
                ? { accountAbstraction: options.secondaryMode }
                : {}),
              ...options.perpsOverride,
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
          balances: options.spotBalances ?? [
            { coin: "USDC", total: "3", hold: "0" },
            ...(options.unpriced
              ? [{ coin: "UNKNOWN", total: "1", hold: "0" }]
              : []),
          ],
        });
      }
      if (body.type === "spotMetaAndAssetCtxs")
        return Response.json(
          options.price === undefined
            ? [{ tokens: [], universe: [] }, []]
            : [
                {
                  tokens: [
                    { index: 0, name: "USDC" },
                    { index: 1, name: "HYPE" },
                  ],
                  universe: [{ tokens: [1, 0] }],
                },
                [{ midPx: options.price }],
              ],
        );
    }
    if (u.hostname === "data-api.polymarket.com") {
      assert(
        [proxy, "0x" + "3".repeat(40)].includes(u.searchParams.get("user")!),
      );
      assert.equal(u.pathname, "/v2/positions");
      assert(!u.searchParams.has("offset"));
      const row = {
        proxy_wallet: options.foreignPosition
          ? owner
          : u.searchParams.get("user"),
        token_id: "123",
        condition_id: "0x" + "a".repeat(64),
        status: "OPEN",
        current_size: 10,
        current_price: 0.3,
        current_value: 3,
        avg_price: 0.2,
      };
      return Response.json({
        data: u.searchParams.get("status") === "OPEN" ? [row, row] : [],
        pagination: { has_more: false, next_cursor: null },
      });
    }
    throw Error("Unexpected source");
  }) as typeof fetch;
  return { request, calls: () => publicCalls };
}
it("routes only Hyperliquid balances through the injected physical-bank client with a fresh caller deadline per balance read", async () => {
  const f = fixture({ sameWallet: true });
  const signals: AbortSignal[] = [];
  let originalCalls = 0;
  const original = (async (url: any, init: RequestInit) => {
    assert.notEqual(new URL(String(url)).hostname, "api.hyperliquid.xyz");
    originalCalls++;
    return f.request(url, init);
  }) as typeof fetch;
  const options = {
    hyperliquidRetention: true as const,
    hyperliquidBudget: new VenueReadBudget(),
    hyperliquidFetcher: async (url: string, init: RequestInit, context?: { deadline_ms: number }) => {
      assert.equal(new URL(url).hostname, "api.hyperliquid.xyz");
      assert.equal(new Headers(init.headers).get("authorization"), null);
      assert.ok(context && context.deadline_ms <= Date.now() + 10000 && context.deadline_ms > Date.now());
      assert.ok(init.signal && !init.signal.aborted);
      signals.push(init.signal);
      return f.request(url, init);
    },
  };
  const first = await readAccountBalances("https://core.test/graphql", "fixture", original, undefined, options);
  const firstCount = signals.length;
  assert.ok(firstCount > 0);
  const second = await readAccountBalances("https://core.test/graphql", "fixture", original, undefined, options);
  assert.ok(signals.length > firstCount && originalCalls > 0);
  assert.notEqual(signals[0], signals[firstCount]);
  assert.equal(first.markets.perps.account_value_usd, "43.000000");
  assert.equal(second.markets.perps.account_value_usd, "43.000000");
});
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
  assert.equal(out.markets.prediction.known_positions_value_usd, "3.000000");
  assert.equal(out.markets.prediction.account_value_usd, null);
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
    assert.equal(out.markets.prediction.account_value_usd, null);
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
  assert.equal(out.markets.prediction.known_subtotal_usd, "18.000000");
  assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
  assert.equal(out.markets.prediction.retained_wallet_cash_usdc, "5.000000");
  assert.equal(
    out.markets.prediction.known_app_display_subtotal_usd,
    "13.000000",
  );
  assert.equal(out.markets.prediction.position_wallet_count, 2);
});

const readFixture = (
  f: ReturnType<typeof fixture>,
  diagnostics: AccountBalanceReadDiagnostic[] = [],
) =>
  readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
    undefined,
    {
      reportReadFailure: (value) => diagnostics.push(value),
    },
  );

it("requires an explicit supported read accounting mode, even for an empty spot wallet", async () => {
  for (const mode of [
    undefined,
    null,
    "",
    "unknown",
    "futureMode",
    "classic",
    1,
    {},
    [],
  ]) {
    const diagnostics: AccountBalanceReadDiagnostic[] = [];
    const out = await readFixture(
      fixture({ mode, spotBalances: [] }),
      diagnostics,
    );
    assert.equal(out.markets.perps.status, "unavailable");
    assert.equal(out.markets.perps.account_value_usd, null);
    assert.equal(out.markets.perps.available_trading_usdc, null);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].stage, "account_mode");
    assert.equal(diagnostics[0].reason_code, "ACCOUNT_MODE_UNSUPPORTED");
    assert.equal(out.summary.account_value_usd, null);
    assert.equal(out.summary.copy_ready_usdc, null);
  }
});

it("never treats unknown or future nonempty modes as Classic and adds overlapping USDC", async () => {
  for (const mode of ["unknown", "futureMode"]) {
    const out = await readFixture(fixture({ mode }));
    assert.equal(out.markets.perps.status, "unavailable");
    assert.equal(out.markets.perps.known_subtotal_usd, undefined);
    assert.equal(out.markets.perps.available_trading_usdc, null);
    assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
  }
});

it("reads Standard and Dex abstraction with separate Perps and spot USDC bases", async () => {
  for (const mode of [
    "default",
    "disabled",
    "standard",
    "dexAbstraction",
    "dex_abstraction",
  ]) {
    const out = await readFixture(
      fixture({
        mode,
        spotBalances: [
          { coin: "USDC", total: "3", hold: "1" },
          { coin: "HYPE", total: "2", hold: "0" },
        ],
        price: "3",
      }),
    );
    assert.equal(out.markets.perps.status, "ok");
    assert.equal(out.markets.perps.account_value_usd, "49.000000");
    assert.equal(out.markets.perps.available_trading_usdc, "39.000000");
    assert.equal(out.markets.perps.occupied_or_reserved_usdc, "4.000000");
  }
});

it("reads Unified and Portfolio Margin without double-counting USDC or omitting other priced spot assets", async () => {
  for (const mode of [
    "unifiedAccount",
    "unified_account",
    "unified",
    "u",
    "portfolioMargin",
    "portfolio_margin",
    "portfolio",
  ]) {
    const f = fixture({
      mode,
      unified: true,
      sameWallet: true,
      embeddedSpot: true,
      spotBalances: [
        { coin: "USDC", total: "43", hold: "3" },
        { coin: "HYPE", total: "2", hold: "0" },
      ],
      price: "3",
    });
    let externalSpotReads = 0;
    const original = f.request;
    f.request = (async (url: any, init: any) => {
      if (
        String(url).includes("api.hyperliquid.xyz") &&
        JSON.parse(init.body).type === "spotClearinghouseState"
      )
        externalSpotReads++;
      return original(url, init);
    }) as typeof fetch;
    const out = await readFixture(f);
    assert.equal(out.markets.perps.status, "ok");
    assert.equal(out.markets.perps.account_value_usd, "49.000000");
    assert.equal(out.markets.perps.available_trading_usdc, "40.000000");
    assert.equal(out.markets.perps.occupied_or_reserved_usdc, "3.000000");
    assert.equal(out.markets.perps.wallets.length, 1);
    assert.equal(
      externalSpotReads,
      0,
      "reuse Core spot evidence in Unified/PM",
    );
  }
});

it("validates each wallet selector's mode before deduplication and keeps partial availability explicit", async () => {
  for (const modes of [
    { mode: "disabled", secondaryMode: "futureMode" },
    { mode: "unknown", secondaryMode: "disabled" },
  ]) {
    const out = await readFixture(fixture({ sameWallet: true, ...modes }));
    assert.equal(out.markets.perps.status, "partial");
    assert.equal(out.markets.perps.account_value_usd, null);
    assert.equal(out.markets.perps.available_trading_usdc, null);
    assert.equal(out.markets.perps.known_subtotal_usd, "43.000000");
    assert.equal(out.markets.perps.known_available_trading_usdc, "40.000000");
    assert.equal(out.markets.perps.wallets.length, 1);
    assert.equal(out.summary.copy_ready_usdc, null);
  }
});

it("allows a complete alias to supply a subtotal after the same wallet's first selector fails valuation", async () => {
  const f = fixture({ sameWallet: true }),
    original = f.request;
  f.request = (async (url: any, init: any) => {
    const response = await original(url, init);
    if (
      String(url).includes("core.test") &&
      JSON.parse(init.body).query.includes("RideOwnedPerpsBalance") &&
      !new Headers(init.headers).has("x-hyperliquid-wallet-mode")
    ) {
      const body = await response.json();
      body.data.hyperliquidAccountState.rawResponseJson =
        "invalid-spot-snapshot";
      return Response.json(body);
    }
    return response;
  }) as typeof fetch;
  const out = await readFixture(f);
  assert.equal(out.markets.perps.status, "partial");
  assert.equal(out.markets.perps.account_value_usd, null);
  assert.equal(out.markets.perps.available_trading_usdc, null);
  assert.equal(out.markets.perps.known_subtotal_usd, "43.000000");
  assert.equal(out.markets.perps.known_available_trading_usdc, "40.000000");
  assert.equal(out.markets.perps.wallets.length, 1);
  assert.equal(
    out.markets.perps.read_diagnostics[0].reason_code,
    "SPOT_SNAPSHOT_UNAVAILABLE",
  );
});

it("removes the wallet's previously counted subtotal when duplicate selectors disagree on a known accounting mode", async () => {
  const out = await readFixture(
    fixture({
      sameWallet: true,
      mode: "disabled",
      secondaryMode: "unifiedAccount",
    }),
  );
  assert.equal(out.markets.perps.status, "unavailable");
  assert.equal(out.markets.perps.account_value_usd, null);
  assert.equal(out.markets.perps.available_trading_usdc, null);
  assert.equal(out.markets.perps.known_subtotal_usd, undefined);
  assert.equal(out.markets.perps.known_available_trading_usdc, undefined);
  assert.equal(
    out.markets.perps.read_diagnostics[0].reason_code,
    "ACCOUNT_MODE_UNSUPPORTED",
  );
  assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
  assert.equal(out.summary.copy_ready_usdc, null);
});

it("keeps a venue rate-limit failure distinct from Core errors and never promotes partial valuation to available cash", async () => {
  const f = fixture();
  const diagnostics: AccountBalanceReadDiagnostic[] = [];
  const reads = {
    read: async () => {
      throw new AgentError(
        "VENUE_RATE_LIMITED",
        "private venue body",
        true,
        429,
      );
    },
  } as unknown as VenueReads;
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
    reads,
    {
      reportReadFailure: (value) => diagnostics.push(value),
    },
  );
  assert.equal(out.markets.perps.status, "unavailable");
  assert.equal(out.markets.perps.account_value_usd, null);
  assert.equal(out.markets.perps.available_trading_usdc, null);
  assert.equal(diagnostics[0].stage, "spot_snapshot");
  assert.equal(diagnostics[0].reason_code, "VENUE_RATE_LIMITED");
  assert(!JSON.stringify(diagnostics).includes("private venue body"));
});

it("retains confirmed zero for supported empty accounts and verified uncreated wallet generations", async () => {
  const zero = await readFixture(
    fixture({
      mode: "default",
      spotBalances: [],
      perpsOverride: { accountValue: "0", withdrawable: "0" },
    }),
  );
  assert.equal(zero.markets.perps.status, "ok");
  assert.equal(zero.markets.perps.account_value_usd, "0.000000");
  const absent = await readFixture(
    fixture({
      mode: undefined,
      perpsOverride: {
        wallet: { status: "NOT_CREATED", masterWalletAddress: null },
        accountValue: "0",
        withdrawable: "0",
      },
    }),
  );
  assert.equal(absent.markets.perps.status, "ok");
  assert.equal(absent.markets.perps.account_value_usd, "0.000000");
  assert.deepEqual(absent.markets.perps.wallets, []);
});

it("classifies Core failures using fixed safe diagnostics and a per-read request ID", async () => {
  const secret = "upstream-private-body-token-wallet-graphql";
  const cases: {
    response: () => Response | never;
    reason: string;
    status?: number;
  }[] = [
    {
      response: () => new Response(secret, { status: 503 }),
      reason: "CORE_HTTP_FAILURE",
      status: 503,
    },
    {
      response: () =>
        Response.json(
          { errors: [{ extensions: { code: "HYPERLIQUID_RATE_LIMITED" } }] },
          { status: 503 },
        ),
      reason: "CORE_HTTP_FAILURE",
      status: 503,
    },
    {
      response: () => new Response(secret, { status: 429 }),
      reason: "CORE_RATE_LIMITED",
      status: 429,
    },
    {
      response: () =>
        Response.json({
          errors: [
            {
              message: secret,
              extensions: { code: "HYPERLIQUID_RATE_LIMITED" },
            },
          ],
        }),
      reason: "CORE_RATE_LIMITED",
      status: 200,
    },
    {
      response: () =>
        Response.json({
          errors: [{ message: secret, extensions: { code: secret } }],
        }),
      reason: "CORE_GRAPHQL_ERROR",
      status: 200,
    },
    {
      response: () => new Response(secret),
      reason: "CORE_INVALID_RESPONSE",
      status: 200,
    },
    {
      response: () => {
        throw Error(secret);
      },
      reason: "CORE_TRANSPORT_FAILURE",
    },
    {
      response: () => {
        throw new DOMException(secret, "TimeoutError");
      },
      reason: "CORE_TIMEOUT",
    },
  ];
  for (const c of cases) {
    const f = fixture(),
      original = f.request;
    f.request = (async (url: any, init: any) => {
      if (
        String(url).includes("core.test") &&
        JSON.parse(init.body).query.includes("RideOwnedPerpsBalance")
      )
        return c.response();
      return original(url, init);
    }) as typeof fetch;
    const diagnostics: AccountBalanceReadDiagnostic[] = [];
    const out = await readFixture(f, diagnostics);
    assert.equal(out.markets.perps.status, "unavailable");
    assert.equal(out.markets.prediction.available_trading_usdc, "7.000000");
    assert.equal(diagnostics.length, 2);
    for (const d of diagnostics) {
      assert.equal(d.stage, "core_query");
      assert.equal(d.reason_code, c.reason);
      assert.equal(d.upstream_http_status, c.status);
      assert.match(d.request_id, /^[0-9a-f-]{36}$/);
      assert.equal(d.request_id, out.markets.perps.diagnostic_request_id);
    }
    assert.equal(new Set(diagnostics.map((d) => d.wallet_selector)).size, 2);
    assert.deepEqual(out.markets.perps.read_diagnostics, diagnostics);
    for (const privateValue of [
      secret,
      owner,
      proxy,
      "Bearer fixture",
      "core.test",
    ])
      assert(!JSON.stringify(diagnostics).includes(privateValue));
  }
});

it("distinguishes ownership, stale snapshots, spot valuation and economics failures without leaking source data", async () => {
  const cases = [
    {
      flags: { perpsOverride: { userId: "other-user" } },
      reason: "OWNERSHIP_UNVERIFIED",
      stage: "ownership",
    },
    {
      flags: { perpsOverride: { isStale: true } },
      reason: "ACCOUNT_SNAPSHOT_STALE",
      stage: "snapshot",
    },
    {
      flags: { perpsOverride: { rawResponseJson: "private-invalid-json" } },
      reason: "SPOT_SNAPSHOT_UNAVAILABLE",
      stage: "spot_snapshot",
    },
    {
      flags: { unpriced: true },
      reason: "SPOT_VALUATION_UNAVAILABLE",
      stage: "spot_valuation",
    },
    {
      flags: { spotBalances: [{ coin: "USDC", total: "3", hold: "4" }] },
      reason: "INVALID_ECONOMICS",
      stage: "economics",
    },
  ];
  for (const c of cases) {
    const diagnostics: AccountBalanceReadDiagnostic[] = [];
    const out = await readFixture(fixture(c.flags), diagnostics);
    assert.equal(out.markets.perps.status, "unavailable");
    assert.equal(diagnostics[0].reason_code, c.reason);
    assert.equal(diagnostics[0].stage, c.stage);
    assert(!JSON.stringify(diagnostics).includes("private-invalid-json"));
    assert(!JSON.stringify(diagnostics).includes("other-user"));
  }
});

it("keeps genuine Core authentication failures as AUTH_REQUIRED without balance-failure diagnostics", async () => {
  for (const response of [
    () => new Response("private-invalid-json", { status: 401 }),
    () =>
      Response.json({
        errors: [{ extensions: { code: "ACCESS_TOKEN_EXPIRED" } }],
      }),
  ]) {
    const f = fixture(),
      original = f.request;
    f.request = (async (url: any, init: any) => {
      if (
        String(url).includes("core.test") &&
        JSON.parse(init.body).query.includes("RideOwnedPerpsBalance")
      )
        return response();
      return original(url, init);
    }) as typeof fetch;
    const diagnostics: AccountBalanceReadDiagnostic[] = [];
    await assert.rejects(
      readFixture(f, diagnostics),
      (e: any) => e.code === "AUTH_REQUIRED",
    );
    assert.deepEqual(diagnostics, []);
  }
});

it("does not allow a broken diagnostic sink to turn missing accounting into success", async () => {
  const f = fixture({ mode: "futureMode" });
  const out = await readAccountBalances(
    "https://core.test/graphql",
    "fixture",
    f.request,
    undefined,
    {
      reportReadFailure() {
        throw Error("sink unavailable");
      },
    },
  );
  assert.equal(out.markets.perps.status, "unavailable");
  assert.equal(out.markets.perps.account_value_usd, null);
});
