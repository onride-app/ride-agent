import { readAccountBalances } from "./account_balances.js";
import { D } from "./agent/domain.js";
import { z } from "zod";
import { AgentError, result, type Result } from "./agent/contracts.js";

export const accountCopiesInput = z
  .object({
    limit: z.number().int().min(1).max(100).default(100),
    offset: z.number().int().min(0).default(0),
    status: z
      .enum([
        "pending",
        "open",
        "closing",
        "closed",
        "failed",
        "official_missing",
        "claimed",
      ])
      .optional(),
    traderAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/)
      .optional(),
  })
  .strict();

const predictionFields = `id configId traderAddress marketTitle side status shares entryPrice
  currentPnl currentPnlPercent displayCurrentValue displayCurrentPnl displayCurrentPnlPercent claimable openedAt closedAt`;
const perpsFields = `id configId traderAddress coin side size entryPx markPx positionValue marginUsed
  unrealizedPnl realizedPnl tradingFees fundingPnl netPnl status openedAt closedAt`;
const perpsQuery = `query RideAppPerps {
  myPerpsAutoRideConfigs(network: MAINNET, enabledOnly: false) {
    id traderAddress allocatedFund effectiveAllocatedFund mode maxLeverage isEnabled lifecycleState
  }
  myPerpsAutoRidePositions(network: MAINNET, includeRetainedHistory: true) { ${perpsFields} }
}`;

// Account reads use the authenticated Core session and fixed queries only.
// They never import App copies into the Agent execution or accounting ledger.
export async function readAccountCopies(
  graphqlUrl: string,
  token: string,
  input: unknown,
  fetcher: typeof fetch = fetch,
): Promise<Result> {
  const args = accountCopiesInput.parse(input);
  const query = async (
    document: string,
    variables: unknown,
    embedded = false,
  ) => {
    const response = await fetcher(graphqlUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(embedded ? { "x-hyperliquid-wallet-mode": "embedded-v1" } : {}),
      },
      body: JSON.stringify({ query: document, variables }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
    const body = (await response.json()) as {
      data?: Record<string, any>;
      errors?: unknown[];
    };
    if (!response.ok || body.errors?.length || !body.data)
      throw new AgentError(
        "ACCOUNT_READ_UNAVAILABLE",
        "Ride App account data could not be read.",
        true,
        503,
      );
    return body.data;
  };
  const connection = (
    alias: string,
    status: string,
  ) => `${alias}: copyTradePositions(
    traderAddress: $traderAddress, status: ${status}, limit: $limit, offset: $offset
  ) { positions { ${predictionFields} } totalCount hasNextPage }`;
  const statuses = args.status
    ? [args.status.toUpperCase()]
    : ["PENDING", "OPEN", "CLOSING", "OFFICIAL_MISSING"];
  const predictionQuery = `query RideAppCopies($traderAddress: String, $limit: Int!, $offset: Int!) {
    me { id username }
    copyTradeSummary { totalConfigs enabledConfigs totalOpenPositions totalRealizedPnl totalAllocation totalAvailableFund }
    myCopyTradeConfigs { id traderAddress allocatedFund availableFund isEnabled currentPositions }
    openInventory: copyTradePositions(status: OPEN, limit: 1, offset: 0) { totalCount }
    closingInventory: copyTradePositions(status: CLOSING, limit: 1, offset: 0) { totalCount }
    ${statuses.map((s, i) => connection(`positions${i}`, s)).join("\n")}
  }`;
  const reads = await Promise.allSettled([
    query(predictionQuery, {
      limit: args.limit,
      offset: args.offset,
      traderAddress: args.traderAddress,
    }),
    query(perpsQuery, {}, false),
    query(perpsQuery, {}, true),
  ]);
  const prediction = reads[0];
  if (prediction.status !== "fulfilled" || !prediction.value.me?.id)
    throw new AgentError(
      "ACCOUNT_READ_UNAVAILABLE",
      "Account identity and App copies could not be verified. Retry the account read; another login is only needed after an authentication error.",
      true,
      503,
    );
  const perps = reads.slice(1);
  const unique = (rows: any[]) => [
    ...new Map(rows.map((row) => [row.id, row])).values(),
  ];
  const configs = unique(
    perps.flatMap((r) =>
      r.status === "fulfilled" ? (r.value.myPerpsAutoRideConfigs ?? []) : [],
    ),
  );
  let positions = unique(
    perps.flatMap((r) =>
      r.status === "fulfilled" ? (r.value.myPerpsAutoRidePositions ?? []) : [],
    ),
  );
  positions = positions.filter(
    (p) =>
      (!args.traderAddress ||
        p.traderAddress?.toLowerCase() === args.traderAddress.toLowerCase()) &&
      (args.status
        ? p.status?.toLowerCase() === args.status
        : ["pending", "open", "closing", "official_missing"].includes(
            p.status?.toLowerCase(),
          )),
  );
  const pages = statuses.map((_, i) => prediction.value[`positions${i}`]);
  const fetchedAt = new Date().toISOString();
  const predictionPositions = unique(
    pages.flatMap((p) => p?.positions ?? []),
  ).map((p) => {
    // Wallet display metrics supersede the older market-price estimate as a pair.
    const wallet = p.displayCurrentPnl != null;
    const pnl = wallet ? p.displayCurrentPnl : (p.currentPnl ?? null);
    let percent = wallet ? null : (p.currentPnlPercent ?? null);
    if (wallet && p.displayCurrentValue != null) {
      try {
        const cost = D(p.displayCurrentValue).minus(pnl);
        if (cost.isFinite() && cost.gt(0))
          percent = D(pnl).div(cost).times(100).toFixed(6);
      } catch {
        /* An unknown cost basis leaves percentage unavailable. */
      }
    }
    return {
      ...p,
      currentPnl: pnl,
      displayCurrentPnl: pnl,
      displayCurrentValue: wallet ? (p.displayCurrentValue ?? null) : null,
      currentPnlPercent: percent,
      displayCurrentPnlPercent: percent,
      valuation: {
        source: wallet
          ? "copy_wallet_display_metrics"
          : pnl != null
            ? "market_price_estimate"
            : "unavailable",
        fetched_at: fetchedAt,
        source_observed_at: null,
        note: "PnL fields use one valuation; fetch time is not the source price timestamp.",
      },
    };
  });
  const openCount = prediction.value.openInventory?.totalCount;
  const closingCount = prediction.value.closingInventory?.totalCount;
  const summaryComplete = [openCount, closingCount].every(
    (n) => Number.isSafeInteger(n) && n >= 0,
  );
  const complete =
    perps.every((r) => r.status === "fulfilled") &&
    pages.every((p) => p && !p.hasNextPage);
  const data = maskAddresses({
    account: {
      authenticated: true,
      user_id: prediction.value.me.id,
      display_name: prediction.value.me.username ?? "Ride user",
    },
    query_scope: "ride_app_copies",
    management: "ride_app",
    coverage_complete: complete && summaryComplete,
    prediction: {
      configs: prediction.value.myCopyTradeConfigs,
      summary: {
        ...prediction.value.copyTradeSummary,
        totalOpenPositions: summaryComplete ? openCount + closingCount : null,
        openPositionCount: openCount ?? null,
        closingPositionCount: closingCount ?? null,
        position_count_source: "account_position_status_counts",
        includes_disabled_configs: true,
        scope: "all_account_positions_open_or_closing",
        fetched_at: fetchedAt,
      },
      positions: predictionPositions,
      has_more: pages.some((p) => p?.hasNextPage),
    },
    perps: {
      configs,
      positions,
      coverage_complete: perps.every((r) => r.status === "fulfilled"),
    },
  }) as Record<string, unknown>;
  return result(
    data,
    complete && summaryComplete ? "ok" : "stale",
    complete && summaryComplete
      ? []
      : [
          "Some App account reads, position counts or pages are unavailable. Missing positions must not be treated as zero.",
        ],
  );
}

export async function invokeAccountRead(
  name: "get_portfolio" | "get_my_copies",
  args: unknown,
  token: string,
  graphqlUrl: string,
  invokePortfolio: () => Promise<Result>,
  fetcher: typeof fetch = fetch,
): Promise<Result> {
  if (name === "get_my_copies")
    return readAccountCopies(graphqlUrl, token, args, fetcher);
  const reads = await Promise.allSettled([
    invokePortfolio(),
    readAccountCopies(graphqlUrl, token, {}, fetcher),
    readAccountBalances(graphqlUrl, token, fetcher),
  ]);
  const portfolio =
    reads[0].status === "fulfilled"
      ? reads[0].value
      : result({ portfolio: null }, "stale", [
          "Agent portfolio read is unavailable; App accounts are read separately.",
        ]);
  const app = reads[1].status === "fulfilled" ? reads[1].value : null;
  const balances = reads[2].status === "fulfilled" ? reads[2].value : null;
  const hasAppCopies = app
    ? [app.data.perps, app.data.prediction].some(
        (m: any) => (m?.configs?.length ?? 0) + (m?.positions?.length ?? 0) > 0,
      )
    : false;
  const partial =
    !app ||
    app.status === "stale" ||
    !balances ||
    !balances.summary.coverage_complete;
  return result(
    {
      ...portfolio.data,
      account: balances?.account ??
        app?.data.account ?? { authenticated: true },
      query_scope: "agent_portfolio_and_ride_app",
      agent_portfolio_status: portfolio.status,
      account_coverage_status: partial ? "partial" : "complete",
      app_copies: app?.data ?? {
        coverage_complete: false,
        status: "unavailable",
      },
      account_balances: balances ?? {
        summary: {
          coverage_complete: false,
          account_value_usd: null,
          known_subtotal_usd: null,
        },
        markets: Object.fromEntries(
          ["perps", "prediction", "meme"].map((m) => [
            m,
            {
              status: "unavailable",
              account_value_usd: null,
              available_trading_usdc: null,
              reason:
                "Authenticated balance source unavailable; retry without treating it as zero.",
            },
          ]),
        ),
      },
    },
    !["ok", "empty", "stale"].includes(portfolio.status)
      ? portfolio.status
      : partial
        ? "stale"
        : portfolio.status === "empty" &&
            (hasAppCopies || D(balances?.summary.known_subtotal_usd ?? 0).gt(0))
          ? "ok"
          : portfolio.status,
    [
      ...portfolio.warnings,
      ...(app?.warnings ?? [
        "Signed in. Ride App copies could not be read; retry the query without repeating login.",
      ]),
      ...(balances
        ? [
            "Overall account total is unavailable until every module is covered. Meme valuation is unavailable through this API; copy allocation remaining is not account balance.",
          ]
        : ["Account balances are unavailable; no missing source is zero."]),
    ],
  );
}

function maskAddresses(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(
      /0x[a-fA-F0-9]{40}\b/g,
      (address) => `${address.slice(0, 6)}...${address.slice(-4)}`,
    );
  if (Array.isArray(value)) return value.map(maskAddresses);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskAddresses(v)]),
    );
  return value;
}
