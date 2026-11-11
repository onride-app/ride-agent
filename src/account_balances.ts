import { D, cash, fingerprint } from "./agent/domain.js";
import { AgentError } from "./agent/contracts.js";
import { VenueReads } from "./agent/venue-reads.js";
import { readPredictionPositionsV2 } from "./agent/polymarket-data.js";
import { coreAuthenticationError } from "./core_auth.js";
import { randomUUID } from "node:crypto";
import type { VenueReadFetcher } from "./agent/venue-read-transport.js";
import type { VenueReadBudget } from "./agent/venue-read-budget.js";

type PerpsReadMode =
  "standard" | "dex_abstraction" | "unified" | "portfolio_margin";
// Read accounting is broader than execution support. Never infer a balance
// basis from an arbitrary nonempty value (the UI label "Classic" is ambiguous).
function perpsReadMode(value: unknown): PerpsReadMode | undefined {
  if (typeof value !== "string") return;
  switch (value.toLowerCase()) {
    case "default":
    case "disabled":
    case "standard":
      return "standard";
    case "dexabstraction":
    case "dex_abstraction":
      return "dex_abstraction";
    case "unifiedaccount":
    case "unified_account":
    case "unified":
    case "u":
      return "unified";
    case "portfoliomargin":
    case "portfolio_margin":
    case "portfolio":
      return "portfolio_margin";
  }
}

type ReadStage =
  | "core_query"
  | "ownership"
  | "snapshot"
  | "wallet"
  | "account_mode"
  | "spot_snapshot"
  | "spot_valuation"
  | "economics";
type ReadReason =
  | "CORE_HTTP_FAILURE"
  | "CORE_RATE_LIMITED"
  | "CORE_INVALID_RESPONSE"
  | "CORE_GRAPHQL_ERROR"
  | "CORE_TIMEOUT"
  | "CORE_TRANSPORT_FAILURE"
  | "OWNERSHIP_UNVERIFIED"
  | "ACCOUNT_SNAPSHOT_UNAVAILABLE"
  | "ACCOUNT_SNAPSHOT_STALE"
  | "WALLET_UNAVAILABLE"
  | "ACCOUNT_MODE_UNSUPPORTED"
  | "SPOT_SNAPSHOT_UNAVAILABLE"
  | "SPOT_VALUATION_UNAVAILABLE"
  | "VENUE_RATE_LIMITED"
  | "INVALID_ECONOMICS";
class BalanceReadFailure extends Error {
  constructor(
    readonly stage: ReadStage,
    readonly reasonCode: ReadReason,
    readonly upstreamStatus?: number,
  ) {
    super(reasonCode);
  }
}
export type AccountBalanceReadDiagnostic = {
  event: "account_balance_read_failure";
  module: "perps";
  request_id: string;
  wallet_selector: "default" | "embedded-v1";
  stage: ReadStage;
  reason_code: ReadReason;
  upstream_http_status?: number;
};
const stageReason: Record<ReadStage, ReadReason> = {
  core_query: "CORE_GRAPHQL_ERROR",
  ownership: "OWNERSHIP_UNVERIFIED",
  snapshot: "ACCOUNT_SNAPSHOT_UNAVAILABLE",
  wallet: "WALLET_UNAVAILABLE",
  account_mode: "ACCOUNT_MODE_UNSUPPORTED",
  spot_snapshot: "SPOT_SNAPSHOT_UNAVAILABLE",
  spot_valuation: "SPOT_VALUATION_UNAVAILABLE",
  economics: "INVALID_ECONOMICS",
};

const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[a-fA-F0-9]{40}$/.test(v);
const number = (v: unknown) => {
  if (
    (typeof v !== "string" && typeof v !== "number") ||
    v === "" ||
    !D(v).isFinite()
  )
    throw Error("Missing or invalid monetary value");
  return D(v);
};
const unavailable = (name: string, reason: string) => ({
  module: name,
  status: "unavailable",
  account_value_usd: null,
  available_trading_usdc: null,
  occupied_or_reserved_usdc: null,
  positions_value_usd: null,
  observed_at: null,
  fetched_at: new Date().toISOString(),
  reason,
});
const perpsQuery = `query RideOwnedPerpsBalance { hyperliquidAccountState(network: MAINNET) {
 userId accountValue withdrawable totalMarginUsed totalNtlPos accountAbstraction isStale rawResponseJson
 wallet { masterWalletAddress walletGeneration status } positions { coin positionValue }
} }`;

// Fixed, authenticated ownership queries only. No caller-supplied wallet or user ID.
export async function readAccountBalances(
  graphql: string,
  token: string,
  request: typeof fetch = fetch,
  venueReads?: VenueReads,
  options: {
    reportReadFailure?: (diagnostic: AccountBalanceReadDiagnostic) => void;
    hyperliquidFetcher?: VenueReadFetcher;
    hyperliquidBudget?: VenueReadBudget;
    hyperliquidRetention?: true;
  } = {},
) {
  // Pagination and wallet reads share one deadline, below the widget tool timeout.
  const deadline = AbortSignal.timeout(22000);
  const publicVenueReads =
    venueReads ??
    new VenueReads(options.hyperliquidFetcher ?? request, Date.now, 2, {
      deadlineMs: 10000,
      signal: deadline,
      ...(options.hyperliquidFetcher ? { transport: "core_shared_info" as const } : {}),
      ...(options.hyperliquidBudget ? { budget: options.hyperliquidBudget } : {}),
      ...(options.hyperliquidRetention ? { retainRemoteDispatch: true } : {}),
    });
  let authenticationFailure: AgentError | undefined;
  const query = async (document: string, embedded = false) => {
    const response = await request(graphql, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(embedded ? { "x-hyperliquid-wallet-mode": "embedded-v1" } : {}),
      },
      body: JSON.stringify({ query: document, variables: {} }),
      redirect: "error",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(15000)]),
    }).catch((error: unknown) => {
      throw new BalanceReadFailure(
        "core_query",
        error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name)
          ? "CORE_TIMEOUT"
          : "CORE_TRANSPORT_FAILURE",
      );
    });
    const httpAuthentication = coreAuthenticationError(response.status);
    if (httpAuthentication) {
      authenticationFailure = httpAuthentication;
      throw httpAuthentication;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new BalanceReadFailure(
        "core_query",
        response.status === 429 ? "CORE_RATE_LIMITED" : "CORE_HTTP_FAILURE",
        response.status,
      );
    }
    const body = (await response.json().catch((error: unknown) => {
      throw new BalanceReadFailure(
        "core_query",
        error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name)
          ? "CORE_TIMEOUT"
          : "CORE_INVALID_RESPONSE",
        response.status,
      );
    })) as any;
    const authentication = coreAuthenticationError(
      response.status,
      body?.errors,
    );
    if (authentication) {
      authenticationFailure = authentication;
      throw authentication;
    }
    if (body?.errors?.length || !body?.data)
      throw new BalanceReadFailure(
        "core_query",
        Array.isArray(body?.errors) &&
          body.errors.some(
            (e: any) => e?.extensions?.code === "HYPERLIQUID_RATE_LIMITED",
          )
          ? "CORE_RATE_LIMITED"
          : "CORE_GRAPHQL_ERROR",
        response.status,
      );
    return body.data;
  };
  const publicJson = async (url: string, init?: RequestInit) => {
    const response = await request(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw Error("Venue balance source unavailable");
    return response.json() as Promise<any>;
  };
  const info = (body: unknown) =>
    publicVenueReads.read("https://api.hyperliquid.xyz/info", body);
  const me = (
    await query(
      "query RideBalanceIdentity { me { id username proxyWalletAddress legacyProxyWalletAddress } }",
    )
  ).me;
  if (!me?.id)
    throw new AgentError(
      "ACCOUNT_READ_UNAVAILABLE",
      "Ride account ownership could not be verified.",
      true,
      503,
    );
  let catalog: Promise<any> | undefined;
  const spotPrice = async (coin: string) => {
    const payload = await (catalog ??= info({ type: "spotMetaAndAssetCtxs" }));
    if (
      !Array.isArray(payload) ||
      !payload[0]?.tokens ||
      !payload[0]?.universe ||
      !Array.isArray(payload[1])
    )
      throw Error("Spot valuation unavailable");
    const tokens = payload[0].tokens,
      markets = payload[0].universe,
      contexts = payload[1];
    const price = (
      name: string,
      seen = new Set<string>(),
    ): ReturnType<typeof D> => {
      if (name.toUpperCase() === "USDC") return D(1);
      if (seen.has(name)) throw Error("Unpriced spot holding");
      seen.add(name);
      const index = markets.findIndex(
        (m: any) =>
          tokens.find((t: any) => t.index === m.tokens?.[0])?.name === name,
      );
      if (index < 0) throw Error("Unpriced spot holding");
      const quote = tokens.find(
        (t: any) => t.index === markets[index].tokens[1],
      )?.name;
      const p = number(contexts[index]?.midPx ?? contexts[index]?.markPx);
      if (!quote || !p.gt(0)) throw Error("Unpriced spot holding");
      return p.times(price(quote, seen));
    };
    return price(coin);
  };
  const readPerps = async () => {
    const reads = await Promise.allSettled([
      query(perpsQuery),
      query(perpsQuery, true),
    ]);
    const observedModes = new Map<string, PerpsReadMode>();
    const countedWallets = new Map<string, any>();
    const requestId = randomUUID();
    const diagnostics: AccountBalanceReadDiagnostic[] = [];
    const recordFailure = (error: unknown, index: number, stage: ReadStage) => {
      // Only fixed classifications cross the logging/tool boundary. Do not
      // include upstream text, modes, GraphQL, URLs, tokens or account IDs.
      const failure = error instanceof BalanceReadFailure ? error : undefined;
      const diagnostic: AccountBalanceReadDiagnostic = {
        event: "account_balance_read_failure",
        module: "perps",
        request_id: requestId,
        wallet_selector: index === 0 ? "default" : "embedded-v1",
        stage: failure?.stage ?? stage,
        reason_code:
          failure?.reasonCode ??
          (error instanceof AgentError && error.code === "VENUE_RATE_LIMITED"
            ? "VENUE_RATE_LIMITED"
            : stageReason[stage]),
        ...(failure?.upstreamStatus !== undefined
          ? { upstream_http_status: failure.upstreamStatus }
          : {}),
      };
      diagnostics.push(diagnostic);
      try {
        (
          options.reportReadFailure ??
          ((value) => console.warn(JSON.stringify(value)))
        )(diagnostic);
      } catch {
        // Reporting cannot replace the original read result or auth failure.
      }
    };
    let verifiedAbsent = 0;
    let missing = reads.some((r) => r.status === "rejected");
    for (const [index, r] of reads.entries()) {
      if (r.status !== "fulfilled") {
        if (!(
          r.reason instanceof AgentError &&
          ["AUTH_REQUIRED", "UPGRADE_REQUIRED"].includes(r.reason.code)
        ))
          recordFailure(r.reason, index, "core_query");
        continue;
      }
      let stage: ReadStage = "snapshot";
      try {
        const state = r.value.hyperliquidAccountState;
        if (!state) throw Error("Missing Perps account");
        stage = "ownership";
        if (state.userId !== me.id) throw Error("Foreign Perps account");
        if (state.isStale)
          throw new BalanceReadFailure("snapshot", "ACCOUNT_SNAPSHOT_STALE");
        stage = "wallet";
        const owner = state.wallet?.masterWalletAddress;
        if (!address(owner)) {
          if (
            String(state.wallet?.status).replaceAll("_", "").toLowerCase() ===
              "notcreated" &&
            number(state.accountValue).isZero() &&
            number(state.withdrawable).isZero()
          ) {
            verifiedAbsent++;
            continue;
          }
          throw Error("Owned wallet is not available");
        }
        stage = "account_mode";
        const mode = perpsReadMode(state.accountAbstraction);
        if (!mode)
          throw new BalanceReadFailure(
            "account_mode",
            "ACCOUNT_MODE_UNSUPPORTED",
          );
        const key = owner.toLowerCase();
        // Validate each selector before deduplicating the physical wallet.
        // An unknown mode in an alias is still missing accounting evidence.
        const previousMode = observedModes.get(key);
        if (previousMode && previousMode !== mode) {
          // Neither conflicting basis can remain a verified subtotal.
          countedWallets.delete(key);
          throw new BalanceReadFailure(
            "account_mode",
            "ACCOUNT_MODE_UNSUPPORTED",
          );
        }
        observedModes.set(key, mode);
        // A failed selector has not counted this wallet. A later complete
        // alias can still supply a subtotal, without upgrading missing reads.
        if (countedWallets.has(key)) continue;
        stage = "spot_snapshot";
        const raw =
          typeof state.rawResponseJson === "string"
            ? JSON.parse(state.rawResponseJson)
            : {};
        const spot =
          raw.spotClearinghouseState ??
          (await info({ type: "spotClearinghouseState", user: owner }));
        if (!Array.isArray(spot?.balances))
          throw Error("Spot balances unavailable");
        // Core reports spot USDC (not all spot assets) as accountValue and
        // withdrawable in these two modes. Add other priced assets once.
        const unified = mode === "unified" || mode === "portfolio_margin";
        stage = "economics";
        let total = number(state.accountValue),
          available = number(state.withdrawable);
        const perpsValue = total;
        const withdrawable = available;
        let spotHold = D(0);
        for (const holding of spot.balances) {
          stage = "economics";
          const quantity = number(holding.total);
          if (quantity.isZero()) continue;
          if (quantity.lt(0)) throw Error("Invalid spot holding");
          const cashToken = String(holding.coin).toUpperCase() === "USDC";
          if (cashToken && unified) continue;
          stage = "spot_valuation";
          total = total.plus(
            quantity.times(cashToken ? 1 : await spotPrice(holding.coin)),
          );
          stage = "economics";
          if (cashToken) {
            const hold = number(holding.hold);
            if (hold.lt(0) || hold.gt(quantity))
              throw Error("Invalid spot reserve");
            available = available.plus(quantity.minus(hold));
            spotHold = spotHold.plus(hold);
          }
        }
        const gross = number(state.totalNtlPos).abs();
        const sourceTime = raw.time ?? raw.clearinghouseState?.time;
        countedWallets.set(key, {
          wallet_ref: `owned_${fingerprint(key).slice(0, 16)}`,
          generation: state.wallet.walletGeneration,
          account_value_usd: cash(total),
          available_trading_usdc: cash(available),
          occupied_or_reserved_usdc: cash(
            D.max(0, perpsValue.minus(withdrawable)).plus(spotHold),
          ),
          margin_used_usdc: cash(number(state.totalMarginUsed)),
          positions_value_usd: cash(gross),
          positions_value_basis:
            "gross leveraged notional; already represented in account equity, never added to equity",
          observed_at: Number.isFinite(sourceTime)
            ? new Date(sourceTime).toISOString()
            : null,
          fetched_at: new Date().toISOString(),
          source:
            "Ride hyperliquidAccountState + owned Hyperliquid spot balances",
          account_mode: mode,
        });
      } catch (error) {
        missing = true;
        recordFailure(error, index, stage);
      }
    }
    const wallets = [...countedWallets.values()];
    if (!wallets.length && !missing && verifiedAbsent === 2)
      return {
        module: "perps",
        status: "ok",
        account_value_usd: "0.000000",
        available_trading_usdc: "0.000000",
        occupied_or_reserved_usdc: "0.000000",
        positions_value_usd: "0.000000",
        wallets: [],
        observed_at: null,
        fetched_at: new Date().toISOString(),
        reason:
          "Core verified that neither owned Perps wallet generation is created.",
      };
    if (!wallets.length)
      return {
        ...unavailable(
          "perps",
          "Perps equity, account mode or complete owned spot valuation is temporarily unavailable. No missing value is zero.",
        ),
        diagnostic_request_id: requestId,
        read_diagnostics: diagnostics,
      };
    const sum = (key: string) =>
      cash(wallets.reduce((n, w) => n.plus(w[key]), D(0)));
    return {
      module: "perps",
      ...(diagnostics.length
        ? {
            diagnostic_request_id: requestId,
            read_diagnostics: diagnostics,
          }
        : {}),
      status: missing ? "partial" : "ok",
      account_value_usd: missing ? null : sum("account_value_usd"),
      known_subtotal_usd: sum("account_value_usd"),
      known_available_trading_usdc: sum("available_trading_usdc"),
      availability_note: missing
        ? "已核实钱包的可用金额仅为小计；其他钱包数据缺失，市场完整可用金额未知。跟单前还需校验选定账户。"
        : "市场钱包可用金额已核实；这不是已批准的跟单额度。",
      available_trading_usdc: missing ? null : sum("available_trading_usdc"),
      occupied_or_reserved_usdc: missing
        ? null
        : sum("occupied_or_reserved_usdc"),
      positions_value_usd: missing ? null : sum("positions_value_usd"),
      positions_value_basis:
        "gross leveraged notional; not additive to account equity",
      wallets,
      observed_at: wallets.every((w) => w.observed_at)
        ? wallets.map((w) => w.observed_at).sort()[0]
        : null,
      fetched_at: new Date().toISOString(),
      reason: missing
        ? "One wallet generation or valuation could not be read; subtotal excludes unavailable wallets."
        : null,
    };
  };
  const inventory = async (owner: string) => {
    const evidence = await readPredictionPositionsV2(owner, {
      request,
      signal: deadline,
    });
    return new Map(
      evidence.rows.map((row) => [
        row.asset as string,
        number(row.currentValue).toString(),
      ]),
    );
  };
  const readPrediction = async () => {
    const owners = [
      ...new Set(
        [me.proxyWalletAddress, me.legacyProxyWalletAddress]
          .filter(address)
          .map((a) => a.toLowerCase()),
      ),
    ];

    let cashValue: any,
      holdings: string | null = null,
      sourceTime: string | null = null,
      reason: string | null = null;
    try {
      const appCash = (
        await query(
          "query RidePredictionBalance { walletBalance { proxyWalletAddress totalBalance nativeUsdcBalance } }",
        )
      ).walletBalance;
      if (
        !appCash ||
        !address(appCash.proxyWalletAddress) ||
        (appCash.proxyWalletAddress &&
          ![me.proxyWalletAddress, me.legacyProxyWalletAddress].some(
            (a) =>
              address(a) &&
              a.toLowerCase() === appCash.proxyWalletAddress.toLowerCase(),
          ))
      )
        throw Error("Cash owner mismatch");
      // Legacy walletBalance can replace failed RPC reads with zero. Verify
      // both trading tokens at one Polygon block before reporting any cash.
      const rpc = async (calls: { method: string; params: unknown[] }[]) => {
        const rows = await publicJson(
          "https://polygon-bor-rpc.publicnode.com",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c })),
            ),
          },
        );
        if (!Array.isArray(rows) || rows.length !== calls.length)
          throw Error("Incomplete Polygon batch");
        return calls.map((_, i) => {
          const matches = rows.filter((r: any) => r.id === i + 1);
          if (
            matches.length !== 1 ||
            matches[0].error ||
            matches[0].result == null
          )
            throw Error("Polygon read unavailable");
          return matches[0].result;
        });
      };
      const [chain, block] = await rpc([
        { method: "eth_chainId", params: [] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
      ]);
      if (
        chain !== "0x89" ||
        !/^0x[0-9a-f]+$/i.test(block.number) ||
        !/^0x[0-9a-f]+$/i.test(block.timestamp)
      )
        throw Error("Polygon block unavailable");
      const blockAt = Number(BigInt(block.timestamp)) * 1000;
      if (
        !Number.isFinite(blockAt) ||
        Date.now() - blockAt > 120000 ||
        blockAt > Date.now() + 5000
      )
        throw Error("Stale Polygon block");
      const tokens = [
        "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB", // pUSD, Ride Core token registry
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
        "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", // native USDC, funding only
      ];
      const quantities = await rpc(
        owners.flatMap((owner) =>
          tokens.map((to) => ({
            method: "eth_call",
            params: [
              {
                to,
                data:
                  "0x70a08231" + owner.slice(2).toLowerCase().padStart(64, "0"),
              },
              block.number,
            ],
          })),
        ),
      );
      const amounts = quantities.map((q: any) => {
        if (typeof q !== "string" || !/^0x[0-9a-f]{64}$/i.test(q))
          throw Error("Invalid token balance");
        return D(BigInt(q).toString()).div(1000000);
      });
      const primary =
        owners.indexOf(appCash.proxyWalletAddress.toLowerCase()) * 3;
      const allOwned = owners.reduce(
        (n, _, i) => n.plus(amounts[i * 3]).plus(amounts[i * 3 + 1]),
        D(0),
      );
      const primaryCash = amounts[primary].plus(amounts[primary + 1]);
      cashValue = {
        totalBalance: cash(primaryCash),
        allOwnedBalance: cash(allOwned),
        retainedCash: cash(allOwned.minus(primaryCash)),
        nativeUsdcBalance: cash(
          owners.reduce((n, _, i) => n.plus(amounts[i * 3 + 2]), D(0)),
        ),
      };
      sourceTime = new Date(blockAt).toISOString();
    } catch {
      cashValue = null;
      reason = "Trading collateral is temporarily unavailable.";
    }
    try {
      if (!owners.length) throw Error("Owned Prediction wallets unavailable");
      const inventories = await Promise.all(owners.map(inventory));
      holdings = cash(
        inventories.reduce(
          (total, rows) =>
            total.plus([...rows.values()].reduce((n, v) => n.plus(v), D(0))),
          D(0),
        ),
      );
    } catch {
      reason =
        (reason ?? "") +
        " Complete Prediction inventory is temporarily unavailable.";
    }
    // Inactive markets are excluded from every v2 positions cohort. Retain
    // verified cash and servable holdings as subtotals, never a full valuation.
    const value = null;
    return {
      module: "prediction",
      status: value === null ? "partial" : "ok",
      account_value_usd: value,
      known_subtotal_usd:
        cashValue || holdings !== null
          ? cash(D(cashValue?.allOwnedBalance ?? 0).plus(holdings ?? 0))
          : null,
      available_trading_usdc: cashValue
        ? cash(number(cashValue.totalBalance))
        : null,
      occupied_or_reserved_usdc: null,
      retained_wallet_cash_usdc: cashValue?.retainedCash ?? null,
      app_display_value_usd: null,
      known_app_display_subtotal_usd:
        cashValue && holdings !== null
          ? cash(D(cashValue.totalBalance).plus(holdings))
          : null,
      app_difference_reason:
        "App displays current trading-wallet cash plus owned positions. MCP equity also includes verified cash in retained Prediction wallets; retained cash is not current trading availability.",
      positions_value_usd: null,
      known_positions_value_usd: holdings,
      positions_coverage: "servable_markets_only",
      trading_collateral_basis:
        "Owned Ride Prediction wallet: pUSD + USDC.e verified at one Polygon block; pending-order reservations are not supplied by this API",
      non_trading_native_usdc:
        cashValue?.nativeUsdcBalance == null
          ? null
          : cash(number(cashValue.nativeUsdcBalance)),
      non_trading_cash_included_in_total: false,
      position_wallet_count: owners.length,
      cash_observed_at: sourceTime,
      positions_observed_at: null,
      observed_at: null,
      fetched_at: new Date().toISOString(),
      reason:
        (reason ?? "") +
        " Inactive-market holdings and open-order reserves are unavailable. Prediction values are verified subtotals, not complete account equity. Native USDC remains excluded from trading equity.",
    };
  };
  const reads = await Promise.allSettled([readPerps(), readPrediction()]);
  if (authenticationFailure) throw authenticationFailure;
  const markets: any = {
    perps:
      reads[0].status === "fulfilled"
        ? reads[0].value
        : unavailable("perps", "Perps account read failed."),
    prediction:
      reads[1].status === "fulfilled"
        ? reads[1].value
        : unavailable("prediction", "Prediction account read failed."),
    meme: {
      ...unavailable(
        "meme",
        "Meme is a separate App wallet/inventory module. The authenticated MCP account API does not expose its complete owned multi-chain valuation; inspect it in the App.",
      ),
      status: "unsupported",
    },
  };
  const knownValues = (Object.values(markets) as any[])
    .map((m) => m.account_value_usd ?? m.known_subtotal_usd)
    .filter((v) => v != null);
  const known = knownValues.length
    ? cash(knownValues.reduce((n, v) => n.plus(v), D(0)))
    : null;
  const availableValues = (Object.values(markets) as any[])
    .map((m) => m.available_trading_usdc ?? m.known_available_trading_usdc)
    .filter((v) => v != null);
  const knownAvailable = availableValues.length
    ? cash(availableValues.reduce((n, v) => n.plus(v), D(0)))
    : null;
  return {
    account: {
      authenticated: true,
      user_id: me.id,
      display_name: me.username ?? "Ride user",
    },
    summary: {
      account_value_usd: null,
      available_trading_usdc: null,
      known_subtotal_usd: known,
      known_available_trading_usdc: knownAvailable,
      copy_ready_usdc: null,
      availability_note:
        "已核实可用金额是不同市场的钱包小计，不可跨市场直接用于同一跟单。完整账户总额仍未知；方案可用额度需在选定账户上单独校验。预算不等于余额。",
      coverage_complete: false,
      supported_markets_complete:
        markets.perps.status === "ok" && markets.prediction.status === "ok",
      included_modules: ["perps", "prediction"],
      excluded_modules: ["meme"],
      basis:
        "Sum distinct owned trading accounts once. App copy budgets, their remaining allocation and the Agent ledger are subdivisions, never additional assets. Missing modules keep the overall total unavailable.",
    },
    markets,
    fetched_at: new Date().toISOString(),
  };
}
