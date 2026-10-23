import { AgentError, result } from "./contracts.js";
import { D, cash, fingerprint, now, uid } from "./domain.js";
import type { Deposit, Funding } from "./deposits.js";
import type { Repository, State } from "./repository.js";
import type { VenueAdapter } from "./adapter.js";

function owned(s: State, depositId: string) {
  const d = s.deposits?.find((d) => d.id === depositId);
  if (!d)
    throw new AgentError(
      "NOT_FOUND",
      "Funding request not found for this account.",
      false,
      404,
    );
  if (d.provider !== "wallet")
    throw new AgentError(
      "UNSUPPORTED_ACTIVATION",
      "Prediction bridge funds are credited by the provider; check verified trading balance.",
    );
  return d;
}
const pending = (f?: Funding) =>
  f && ["submitting", "submitted", "uncertain"].includes(f.status);

// Signing challenges stay on the authenticated human surface, never in MCP.
export class FundingService {
  constructor(
    private repository: Repository,
    private adapter: VenueAdapter,
    private base: string,
  ) {}
  private async call(
    operation: "quote" | "submit" | "activate_quote" | "activate_submit",
    user: string,
    input: any,
  ) {
    if (!this.adapter.fundingOperation)
      throw new AgentError(
        "FUNDING_UNAVAILABLE",
        "Funding activation is unavailable on this deployment.",
        true,
        503,
      );
    return this.adapter.fundingOperation(operation, user, input);
  }
  private view(d: Deposit, human = false) {
    const f = d.funding!;
    return result(
      {
        funding: {
          id: f.id,
          deposit_id: d.id,
          amount_usdc: f.amount_usdc,
          status: f.status,
          expires_at: f.expires_at,
          preview_hash: f.preview_hash,
          account_suffix: d.address.slice(-6),
          network: "Arbitrum",
          asset: "USDC",
          destination: "Your Hyperliquid trading account",
          confirmation_url: new URL(`/agent/fund/${d.id}`, this.base).href,
          transaction_hash: f.transaction_hash ?? null,
          receipt_status: f.receipt_status ?? null,
          ...(human
            ? {
                requires_signature: !!f.quote.requires_signature,
                signing_wallet: f.quote.wallet.master,
                signing_challenge: f.quote.typed_data,
                activation: f.activation
                  ? {
                      ...f.activation,
                      quote: undefined,
                      requires_signature:
                        !!f.activation.quote.requires_signature,
                      signing_challenge: f.activation.quote.typed_data,
                    }
                  : null,
              }
            : {}),
        },
      },
      f.status === "requires_confirmation"
        ? "requires_confirmation"
        : f.status === "credited"
          ? "completed"
          : f.status === "uncertain"
            ? "uncertain"
            : "queued",
    );
  }
  async prepare(user: string, depositId: string, amount: string) {
    return this.repository.transact(user, async (s) => {
      const d = owned(s, depositId);
      const blocking = s.deposits?.find((x) => pending(x.funding));
      if (blocking) {
        if (blocking.id === depositId) return this.view(blocking);
        throw new AgentError(
          "FUNDING_PENDING",
          "An earlier funding submission is unresolved. Check its status before preparing another.",
        );
      }
      if (
        d.funding?.status === "requires_confirmation" &&
        d.funding.expires_at > now() &&
        D(d.funding.amount_usdc).eq(amount)
      )
        return this.view(d);
      const observed = await this.adapter.depositStatus?.(d, user);
      if (observed?.trading_balance_usdc == null)
        throw new AgentError(
          "TRADING_BALANCE_UNAVAILABLE",
          "Verify current trading balance before preparing funding.",
          true,
        );
      if (observed.wallet_balance_usdc == null)
        throw new AgentError(
          "FUNDING_WALLET_READ_UNAVAILABLE",
          "Verify the Arbitrum funding-wallet balance before preparing funding.",
          true,
        );
      for (const key of ["wallet_balance_usdc", "trading_balance_usdc"]) {
        try {
          if (!D(observed[key]).isFinite() || D(observed[key]).lt(0))
            throw Error();
        } catch {
          throw new AgentError(
            "FUNDING_BALANCE_UNAVAILABLE",
            "Funding balances could not be verified. Retry the status read before preparing funding.",
            true,
          );
        }
      }
      if (D(observed.wallet_balance_usdc).lt(amount))
        throw new AgentError(
          "FUNDING_WALLET_INSUFFICIENT",
          `Preparing ${cash(amount)} USDC requires that amount in the Arbitrum funding wallet, which currently holds ${cash(observed.wallet_balance_usdc)} USDC. The trading account separately has ${cash(observed.trading_balance_usdc)} USDC available. No new funding was prepared; check existing trading funds before sending more.`,
        );
      const quote = await this.call("quote", user, {
        amount_usdc: cash(amount),
        expected_master: d.address,
      });
      if (
        !quote.wallet?.master ||
        quote.wallet.master.toLowerCase() !== d.address.toLowerCase() ||
        !D(quote.amount_usdc).eq(amount)
      )
        throw new AgentError(
          "FUNDING_QUOTE_CHANGED",
          "Funding quote does not match the owned receiving account and selected amount.",
        );
      const expires = Math.min(
        now() + 5 * 60_000,
        quote.permit_deadline ? quote.permit_deadline * 1000 : Infinity,
      );
      if (expires <= now())
        throw new AgentError(
          "FUNDING_QUOTE_EXPIRED",
          "Review a fresh funding quote.",
        );
      quote.baseline_trading_available_usdc = cash(
        observed.trading_balance_usdc,
      );
      if (observed.trading_account_mode != null)
        quote.baseline_trading_account_mode = observed.trading_account_mode;
      d.funding = {
        id: uid("funding"),
        amount_usdc: cash(amount),
        created_at: now(),
        expires_at: expires,
        status: "requires_confirmation",
        quote,
        preview_hash: fingerprint({
          deposit_id: d.id,
          amount: cash(amount),
          quote,
          expires,
        }),
      };
      return this.view(d);
    });
  }
  async read(user: string, depositId: string) {
    return this.repository.transact(user, async (s) => {
      const d = owned(s, depositId);
      if (!d.funding)
        throw new AgentError(
          "FUNDING_NOT_PREPARED",
          "Choose the exact amount with prepare_deposit first.",
        );
      return this.view(d, true);
    });
  }
  async confirm(
    user: string,
    depositId: string,
    hash: string,
    signature?: string,
  ) {
    // Persist consumption before network I/O. A timeout or process restart
    // cannot roll it back and make the same money action executable again.
    const selected = await this.repository.transact(user, async (s) => {
      const d = owned(s, depositId),
        f = d.funding;
      if (!f) throw new AgentError("NOT_FOUND", "Funding quote unavailable.");
      if (f.preview_hash !== hash)
        throw new AgentError(
          "FUNDING_CHANGED",
          "Displayed funding parameters changed.",
        );
      if (f.status !== "requires_confirmation")
        return { done: this.view(d, true) };
      if (f.expires_at <= now())
        throw new AgentError(
          "FUNDING_QUOTE_EXPIRED",
          "Review a fresh funding quote.",
        );
      if (f.quote.requires_signature && !signature)
        throw new AgentError(
          "SIGNATURE_REQUIRED",
          "Confirm the wallet signature in Ride.",
        );
      f.status = "submitting";
      return { funding: structuredClone(f), address: d.address };
    });
    if (selected.done) return selected.done;
    const f = selected.funding!;
    let response: any;
    try {
      response = await this.call("submit", user, {
        amount_usdc: f.amount_usdc,
        expected_master: selected.address,
        request_id: f.id,
        user_confirmed: true,
        signature,
        permit_nonce: f.quote.permit_nonce,
        permit_deadline: f.quote.permit_deadline,
      });
    } catch {
      // No automatic retry, including a 4xx after a possible broadcast.
      response = null;
    }
    return this.repository.transact(user, async (s) => {
      const d = owned(s, depositId);
      if (d.funding?.id !== f.id)
        throw new AgentError("FUNDING_CHANGED", "Funding identity changed.");
      if (
        response?.submitted &&
        /^0x[a-fA-F0-9]{64}$/.test(response.transaction_hash)
      ) {
        d.funding.status =
          response.receipt_status === "0x0" ? "failed" : "submitted";
        d.funding.transaction_hash = response.transaction_hash;
        d.funding.receipt_status = response.receipt_status;
      } else d.funding.status = "uncertain";
      return this.view(d, true);
    });
  }
  async activationQuote(user: string, depositId: string) {
    return this.repository.transact(user, async (s) => {
      const d = owned(s, depositId);
      if (
        !d.funding ||
        !["submitted", "credited", "uncertain"].includes(d.funding.status)
      )
        throw new AgentError(
          "FUNDING_NOT_SUBMITTED",
          "Fund this account before activating it.",
        );
      const status = await this.adapter.depositStatus?.(d, user);
      if (!status || !D(status.trading_balance_usdc ?? "0").gt(0))
        throw new AgentError(
          "TRADING_CREDIT_PENDING",
          "Wait for verified trading account credit before activation.",
          true,
        );
      const quote = await this.call("activate_quote", user, {
        expected_master: d.address,
      });
      const expires = now() + 5 * 60_000;
      d.funding.activation = {
        quote,
        expires_at: expires,
        status: "requires_confirmation",
        preview_hash: fingerprint({ deposit_id: d.id, quote, expires }),
      };
      return this.view(d, true);
    });
  }
  async activate(
    user: string,
    depositId: string,
    hash: string,
    signature?: string,
  ) {
    const selected = await this.repository.transact(user, async (s) => {
      const d = owned(s, depositId),
        a = d.funding?.activation;
      if (!a || a.preview_hash !== hash || a.expires_at <= now())
        throw new AgentError(
          "ACTIVATION_CHANGED",
          "Review a fresh activation request.",
        );
      if (a.status !== "requires_confirmation")
        return { done: this.view(d, true) };
      if (a.quote.requires_signature && !signature)
        throw new AgentError(
          "SIGNATURE_REQUIRED",
          "Confirm account activation with your wallet.",
        );
      a.status = "submitting";
      return { quote: structuredClone(a.quote), address: d.address };
    });
    if (selected.done) return selected.done;
    let response: any;
    try {
      response = await this.call("activate_submit", user, {
        expected_master: selected.address,
        user_confirmed: true,
        signature,
        nonce: selected.quote.nonce,
        expected_agent: selected.quote.typed_data?.message?.agentAddress,
      });
    } catch {
      response = null;
    }
    return this.repository.transact(user, async (s) => {
      const d = owned(s, depositId);
      d.funding!.activation!.status =
        response?.wallet?.status === "active" ? "completed" : "uncertain";
      return this.view(d, true);
    });
  }
}
