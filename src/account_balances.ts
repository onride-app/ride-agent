import { D, cash, fingerprint } from "./agent/domain.js";
import { AgentError } from "./agent/contracts.js";

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
) {
  // Pagination and wallet reads share one deadline, below the widget tool timeout.
  const deadline = AbortSignal.timeout(22000);
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
    });
    const body = (await response.json()) as any;
    if (!response.ok || body.errors?.length || !body.data)
      throw Error("Account source unavailable");
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
    publicJson("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
    const seen = new Set<string>();
    const wallets: any[] = [];
    let verifiedAbsent = 0;
    let missing = reads.some((r) => r.status === "rejected");
    for (const r of reads) {
      if (r.status !== "fulfilled") continue;
      try {
        const state = r.value.hyperliquidAccountState;
        if (state?.userId !== me.id || state.isStale)
          throw Error("Missing, stale or foreign Perps account");
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
        const key = owner.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const raw =
          typeof state.rawResponseJson === "string"
            ? JSON.parse(state.rawResponseJson)
            : {};
        const spot =
          raw.spotClearinghouseState ??
          (await info({ type: "spotClearinghouseState", user: owner }));
        if (!Array.isArray(spot?.balances))
          throw Error("Spot balances unavailable");
        const abstraction = String(
          state.accountAbstraction ?? "",
        ).toLowerCase();
        // This is the same Classic/Unified distinction used by the App account card.
        const unified = [
          "unifiedaccount",
          "unified_account",
          "unified",
          "u",
          "portfoliomargin",
          "portfolio_margin",
          "portfolio",
        ].includes(abstraction);
        if (
          !abstraction &&
          spot.balances.some(
            (b: any) => b.coin === "USDC" && number(b.total).gt(0),
          )
        )
          throw Error(
            "Account mode is unavailable; spot USDC could overlap with Perps equity",
          );
        let total = number(state.accountValue),
          available = number(state.withdrawable);
        const perpsValue = total;
        const withdrawable = available;
        let spotHold = D(0);
        for (const holding of spot.balances) {
          const quantity = number(holding.total);
          if (quantity.isZero()) continue;
          if (quantity.lt(0)) throw Error("Invalid spot holding");
          const cashToken = String(holding.coin).toUpperCase() === "USDC";
          if (cashToken && unified) continue;
          total = total.plus(
            quantity.times(cashToken ? 1 : await spotPrice(holding.coin)),
          );
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
        wallets.push({
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
          account_mode: abstraction || "unknown",
        });
      } catch {
        missing = true;
      }
    }
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
      return unavailable(
        "perps",
        "Perps equity, account mode or complete owned spot valuation is temporarily unavailable. No missing value is zero.",
      );
    const sum = (key: string) =>
      cash(wallets.reduce((n, w) => n.plus(w[key]), D(0)));
    return {
      module: "perps",
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
    const positions = new Map<string, string>();
    for (let offset = 0; offset <= 10000; offset += 500) {
      deadline.throwIfAborted();
      const url = new URL("https://data-api.polymarket.com/positions");
      for (const [k, v] of Object.entries({
        user: owner,
        sizeThreshold: "0",
        includeArchived: "true",
        limit: "500",
        offset: String(offset),
        sortBy: "TOKENS",
        sortDirection: "DESC",
      }))
        url.searchParams.set(k, v);
      const rows = await publicJson(url.href);
      if (!Array.isArray(rows) || rows.length > 500)
        throw Error("Prediction inventory unavailable");
      const previous = positions.size;
      for (const row of rows) {
        if (
          String(row.proxyWallet).toLowerCase() !== owner.toLowerCase() ||
          typeof row.asset !== "string" ||
          !row.asset
        )
          throw Error("Unverified position owner");
        const value = number(row.currentValue);
        if (value.lt(0)) throw Error("Invalid position value");
        if (positions.has(row.asset) && !D(positions.get(row.asset)!).eq(value))
          throw Error("Inconsistent inventory page");
        positions.set(row.asset, value.toString());
      }
      if (rows.length < 500) return positions;
      if (positions.size === previous)
        throw Error("Prediction inventory pagination did not advance");
    }
    throw Error("Prediction inventory truncated");
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
    const value =
      cashValue && holdings !== null
        ? cash(number(cashValue.allOwnedBalance).plus(holdings))
        : null;
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
      app_display_value_usd:
        cashValue && holdings !== null
          ? cash(D(cashValue.totalBalance).plus(holdings))
          : null,
      app_difference_reason:
        "App displays current trading-wallet cash plus owned positions. MCP equity also includes verified cash in retained Prediction wallets; retained cash is not current trading availability.",
      positions_value_usd: holdings,
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
        reason ??
        "Open-order reserve is unavailable. Native USDC is funding cash and is excluded from trading equity. Retained-wallet cash is included in equity, separately from current-wallet trading availability.",
    };
  };
  const reads = await Promise.allSettled([readPerps(), readPrediction()]);
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
