import QRCode from "qrcode";
import { Contract, JsonRpcProvider, FetchRequest, id as eventId } from "ethers";
import { AgentError } from "./contracts.js";
import { cash, D, uid, now } from "./domain.js";
import { perpsAccountMode, unifiedUsdc } from "./perps_account.js";
import { VenueReads } from "./venue-reads.js";

export interface Deposit {
  id: string;
  market: "perps" | "prediction";
  asset: "USDC" | "USDT";
  network: string;
  address: string;
  provider: "wallet" | "polymarket_bridge";
  created_at: number;
  baseline_wallet_usdc?: string;
  amount_usdc?: string;
  asset_contracts?: string[];
  funding?: Funding;
}
export interface Funding {
  id: string;
  amount_usdc: string;
  created_at: number;
  expires_at: number;
  preview_hash: string;
  status:
    | "requires_confirmation"
    | "submitting"
    | "submitted"
    | "uncertain"
    | "failed"
    | "credited";
  quote: any;
  transaction_hash?: string;
  receipt_status?: string;
  activation?: {
    quote: any;
    preview_hash: string;
    expires_at: number;
    status: string;
  };
}
const chains: Record<string, string> = {
  Ethereum: "1",
  Arbitrum: "42161",
  Base: "8453",
  Polygon: "137",
};
const bridgeUrl = "https://bridge.polymarket.com";
const validAddress = (value: unknown): value is string =>
  typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value);
export class DepositReads {
  constructor(
    private core: (operation: string, input: unknown) => Promise<any>,
    private network: "mainnet" | "testnet",
    private request = fetch,
    private venueReads = new VenueReads(request),
  ) {}
  private async bridge(path: string, body?: unknown): Promise<any> {
    const response = await this.request(`${bridgeUrl}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12000),
      redirect: "error",
    });
    if (!response.ok)
      throw new AgentError(
        "DEPOSIT_PROVIDER_UNAVAILABLE",
        "Deposit provider did not return verified funding details.",
        true,
        503,
      );
    return response.json();
  }
  async options() {
    const routes: any[] =
      this.network === "mainnet"
        ? [
            {
              market: "perps",
              asset: "USDC",
              network: "Arbitrum",
              destination: "Ride funding wallet",
              activation_required: true,
            },
          ]
        : [];
    const supported = await this.bridge("supported-assets");
    for (const item of supported.supportedAssets ??
      supported.supported_assets ??
      []) {
      const symbol = item.token?.symbol ?? item.symbol,
        chain = String(item.chainId ?? item.chain_id);
      const network = Object.keys(chains).find((n) => chains[n] === chain);
      if (
        network &&
        ["USDC", "USDT"].includes(symbol) &&
        validAddress(item.token?.address)
      )
        routes.push({
          market: "prediction",
          asset: symbol,
          network,
          min_deposit_usd: item.minCheckoutUsd ?? item.min_deposit_usd ?? null,
          destination: "Prediction account",
          activation_required: false,
        });
    }
    return {
      routes,
      notes: [
        "Only verified provider routes are offered. Sending to a funding wallet does not fund Hyperliquid until the existing Ride deposit step is completed.",
      ],
    };
  }
  private async walletBalance(address: string): Promise<string> {
    const request = new FetchRequest(
      process.env.RIDE_AGENT_ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    );
    request.timeout = 12000;
    const rpc = new JsonRpcProvider(request, 42161, { staticNetwork: true });
    try {
      if (Number(await rpc.send("eth_chainId", [])) !== 42161)
        throw new AgentError(
          "DEPOSIT_NETWORK_MISMATCH",
          "Funding RPC returned a different chain; no deposit address is shown.",
          true,
          503,
        );
      const token = new Contract(
        "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        ["function balanceOf(address) view returns (uint256)"],
        rpc,
      );
      const balance = await token.balanceOf(address);
      return cash(D(balance.toString()).div(1e6));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        "FUNDING_WALLET_READ_UNAVAILABLE",
        "Arbitrum funding-wallet balance could not be verified. Retry the status read; do not repeat a transfer.",
        true,
        503,
      );
    } finally {
      rpc.destroy();
    }
  }
  private async tradingInfo(type: string, user: string): Promise<any> {
    try {
      return await this.venueReads.read(
        this.network === "mainnet"
          ? "https://api.hyperliquid.xyz/info"
          : "https://api.hyperliquid-testnet.xyz/info",
        { type, user },
      );
    } catch (error) {
      // Keep the funding balance error contract for failed/invalid transport,
      // but preserve shared admission and cooldown hints for callers.
      if (
        error instanceof AgentError &&
        !["VENUE_UNAVAILABLE", "VENUE_RESPONSE_INVALID"].includes(error.code)
      )
        throw error;
      throw new AgentError(
        "TRADING_BALANCE_UNAVAILABLE",
        "Trading balance could not be verified. Retry the status read; do not repeat a transfer.",
        true,
        503,
      );
    }
  }
  async address(
    user: string,
    input: any,
    portfolioId?: string,
  ): Promise<Deposit> {
    if (input.market === "perps") {
      if (
        this.network !== "mainnet" ||
        input.asset !== "USDC" ||
        input.network !== "Arbitrum"
      )
        throw new AgentError(
          "UNSUPPORTED_DEPOSIT_ROUTE",
          "Perps funding currently accepts native USDC on Arbitrum into the Ride funding wallet; complete the venue deposit in Ride.",
          false,
          400,
        );
      let owned;
      try {
        owned = await this.core("perps_wallet", { user_id: user });
      } catch {
        owned = await this.core("perps_funding_prepare", { user_id: user });
      }
      if (!validAddress(owned.master))
        throw new AgentError(
          "ACCOUNT_NOT_READY",
          "Prepare your existing Ride trading account before requesting an address.",
        );
      return {
        id: uid("deposit"),
        market: "perps",
        asset: "USDC",
        network: "Arbitrum",
        address: owned.master,
        provider: "wallet",
        created_at: now(),
        baseline_wallet_usdc: await this.walletBalance(owned.master),
        ...(input.amount_usdc ? { amount_usdc: cash(input.amount_usdc) } : {}),
      };
    }
    const supported = await this.bridge("supported-assets");
    const assetContracts = (supported.supportedAssets ?? [])
      .filter(
        (item: any) =>
          String(item.chainId) === chains[input.network] &&
          item.token?.symbol === input.asset &&
          validAddress(item.token?.address),
      )
      .map((item: any) => item.token.address.toLowerCase());
    const route = (await this.options()).routes.find(
      (r) =>
        r.market === input.market &&
        r.asset === input.asset &&
        r.network === input.network,
    );
    if (!route)
      throw new AgentError(
        "UNSUPPORTED_DEPOSIT_ROUTE",
        "This asset/network route is not currently supported by the provider.",
        false,
        400,
      );
    if (
      input.amount_usdc &&
      route.min_deposit_usd &&
      D(input.amount_usdc).lt(route.min_deposit_usd)
    )
      throw new AgentError(
        "DEPOSIT_BELOW_MINIMUM",
        "The amount is below the provider's current deposit minimum.",
        false,
        400,
      );
    const owned = await this.core("prediction_wallet", {
      user_id: user,
      portfolio_id: portfolioId ?? null,
    });
    if (!validAddress(owned.wallet))
      throw new AgentError(
        "ACCOUNT_NOT_READY",
        "Prepare your existing prediction account in Ride first.",
      );
    const response = await this.bridge("deposit", { address: owned.wallet });
    const address = response.address?.evm ?? response.addresses?.evm;
    if (!validAddress(address))
      throw new AgentError(
        "DEPOSIT_PROVIDER_UNAVAILABLE",
        "The provider returned an invalid deposit address.",
        true,
        503,
      );
    return {
      id: uid("deposit"),
      market: "prediction",
      asset: input.asset,
      network: input.network,
      address,
      provider: "polymarket_bridge",
      asset_contracts: assetContracts,
      created_at: now(),
      ...(input.amount_usdc ? { amount_usdc: cash(input.amount_usdc) } : {}),
    };
  }
  async status(deposit: Deposit, user?: string) {
    if (deposit.provider === "wallet") {
      const balance = await this.walletBalance(deposit.address),
        received = D(balance).minus(deposit.baseline_wallet_usdc ?? balance);
      let trading: any = {
        trading_balance_usdc: null,
        available_to_copy: false,
        trading_observation: "unavailable",
      };
      if (user) {
        const owned = await this.core("perps_wallet", { user_id: user });
        if (
          !validAddress(owned.master) ||
          owned.master.toLowerCase() !== deposit.address.toLowerCase()
        )
          throw new AgentError(
            "FUNDING_WALLET_CHANGED",
            "This receiving account is no longer the active trading account. Review a new request.",
          );
        const mode = perpsAccountMode(
          await this.tradingInfo("userAbstraction", owned.master),
        );
        if (mode === "unsupported")
          throw new AgentError(
            "TRADING_ACCOUNT_MODE_UNAVAILABLE",
            "Trading account mode could not be verified.",
            true,
            503,
          );
        let available: string;
        if (mode === "unified") {
          const spot = await this.tradingInfo(
            "spotClearinghouseState",
            owned.master,
          );
          available = unifiedUsdc(spot).available;
        } else {
          const state = await this.tradingInfo(
            "clearinghouseState",
            owned.master,
          );
          try {
            if (
              typeof state.withdrawable !== "string" ||
              !state.marginSummary ||
              !Array.isArray(state.assetPositions) ||
              !D(state.withdrawable).isFinite() ||
              D(state.withdrawable).lt(0)
            )
              throw Error();
            available = cash(state.withdrawable);
          } catch {
            throw new AgentError(
              "TRADING_BALANCE_UNAVAILABLE",
              "Trading balance evidence is incomplete.",
              true,
              503,
            );
          }
        }
        if (
          perpsAccountMode(
            await this.tradingInfo("userAbstraction", owned.master),
          ) !== mode
        )
          throw new AgentError(
            "TRADING_BALANCE_UNAVAILABLE",
            "Trading account mode changed during the balance read. Retry the status read.",
            true,
            503,
          );
        const active = owned.status === 4 || owned.status === "active";
        const supported =
          mode === "standard" ||
          process.env.RIDE_AGENT_UNIFIED_ENABLED === "true";
        trading = {
          trading_balance_usdc: available,
          trading_observed_at: now(),
          trading_account_mode: mode,
          trading_balance_basis:
            mode === "unified"
              ? "spot_usdc_total_minus_hold"
              : "perps_withdrawable",
          account_mode_supported: supported,
          available_to_copy: active && supported && D(available).gt(0),
          sufficient_for_amount: D(available).gte(
            deposit.funding?.amount_usdc ?? deposit.amount_usdc ?? "5",
          ),
          activation_required: !active,
          trading_observation: "verified",
        };
      }
      let fundingReceipt = "unavailable",
        verifiedCredit = false;
      const f = deposit.funding;
      if (f?.transaction_hash) {
        const response = await this.request(
          process.env.RIDE_AGENT_ARBITRUM_RPC_URL ??
            "https://arb1.arbitrum.io/rpc",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "eth_getTransactionReceipt",
              params: [f.transaction_hash],
            }),
            signal: AbortSignal.timeout(12000),
            redirect: "error",
          },
        );
        if (!response.ok)
          throw new AgentError(
            "FUNDING_RECEIPT_UNAVAILABLE",
            "Funding receipt is not available; do not resubmit.",
            true,
            503,
          );
        const receipt = ((await response.json()) as any).result;
        if (!receipt) fundingReceipt = "pending";
        else if (receipt.status === "0x0") fundingReceipt = "reverted";
        else if (
          receipt.status === "0x1" &&
          receipt.transactionHash?.toLowerCase() ===
            f.transaction_hash.toLowerCase() &&
          receipt.to?.toLowerCase() ===
            "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7"
        ) {
          const amountRaw = BigInt(D(f.amount_usdc).times(1e6).toFixed(0));
          const transferred = (receipt.logs ?? []).some(
            (log: any) =>
              log.address?.toLowerCase() ===
                "0xaf88d065e77c8cc2239327c5edb3a432268e5831" &&
              log.topics?.[0] ===
                eventId("Transfer(address,address,uint256)") &&
              log.topics?.[1]?.slice(-40).toLowerCase() ===
                deposit.address.slice(2).toLowerCase() &&
              log.topics?.[2]?.slice(-40).toLowerCase() ===
                "2df1c51e09aecf9cacb7bc98cb1742757f163df7" &&
              /^0x[a-fA-F0-9]{64}$/.test(log.data) &&
              BigInt(log.data) === amountRaw,
          );
          if (transferred) {
            fundingReceipt = "confirmed";
            verifiedCredit =
              trading.trading_observation === "verified" &&
              (f.quote.baseline_trading_account_mode ===
                trading.trading_account_mode ||
                (f.quote.baseline_trading_account_mode == null &&
                  trading.trading_account_mode === "standard")) &&
              D(trading.trading_balance_usdc).gte(
                D(f.quote.baseline_trading_available_usdc ?? "0").plus(
                  f.amount_usdc,
                ),
              );
          }
        }
      }
      return {
        deposit_id: deposit.id,
        status: trading.available_to_copy
          ? "trading_ready"
          : trading.account_mode_supported === false
            ? "account_mode_unsupported"
            : D(trading.trading_balance_usdc ?? "0").gt(0)
              ? "activation_required"
              : received.gt(0)
                ? "wallet_balance_increased"
                : "awaiting_deposit",
        wallet_balance_usdc: balance,
        received_usdc: received.gt(0) ? cash(received) : null,
        ...trading,
        funding_status: deposit.funding?.status ?? null,
        funding_receipt: fundingReceipt,
        funding_credit_verified: verifiedCredit,
        transaction_hash: deposit.funding?.transaction_hash ?? null,
        next_action: trading.available_to_copy
          ? "Trading balance is verified. Refresh the saved plan before confirming copying."
          : trading.account_mode_supported === false
            ? "Trading balance is verified, but this account mode is not enabled for Agent execution. Review account compatibility; do not repeat funding or switch account mode automatically."
            : trading.activation_required &&
                D(trading.trading_balance_usdc ?? "0").gt(0)
              ? "Use the inline Ride funding card to review and confirm trading-account activation."
              : "Use prepare_deposit with the exact amount to show the inline Ride funding confirmation card. Wallet receipt alone is not trading credit. Do not repeat an unresolved submission.",
      };
    }
    const response = await this.bridge(`status/${deposit.address}`);
    const transactions = (response.transactions ?? [])
      .filter(
        (t: any) =>
          Number(t.createdTimeMs) >= deposit.created_at &&
          String(t.fromChainId) === chains[deposit.network] &&
          !!deposit.asset_contracts?.includes(
            String(t.fromTokenAddress).toLowerCase(),
          ),
      )
      .map((t: any) => ({
        status: String(t.status),
        at: Number(t.createdTimeMs),
        transaction_hash: /^0x[a-fA-F0-9]{64}$/.test(t.txHash)
          ? t.txHash
          : null,
      }));
    return {
      deposit_id: deposit.id,
      status: transactions.some((t: any) => t.status === "COMPLETED")
        ? "provider_completed"
        : transactions.some((t: any) => t.status === "FAILED")
          ? "failed"
          : transactions.length
            ? "processing"
            : "awaiting_deposit",
      transactions,
      available_to_copy: null,
      next_action:
        "Refresh the saved plan; only verified available account collateral can authorize copying.",
    };
  }
}
export async function depositView(deposit: Deposit) {
  return {
    ...deposit,
    baseline_wallet_usdc: undefined,
    asset_contracts: undefined,
    funding: undefined,
    qr_data_url: await QRCode.toDataURL(deposit.address, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 240,
    }),
    activation_required: deposit.provider === "wallet",
    destination:
      deposit.provider === "wallet"
        ? "Ride funding wallet"
        : "Prediction bridge",
    instructions:
      deposit.provider === "wallet"
        ? "Send only native USDC on Arbitrum to this owned funding wallet. Then use the inline Ride funding card to confirm the chosen amount, activate the trading account if needed, and verify trading balance."
        : "Use only the selected supported asset and network. Check provider status before refreshing available collateral.",
  };
}
