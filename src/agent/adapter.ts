import { AgentError, errorDetails, type ErrorDetails } from "./contracts.js";
import type {
  AccountSnapshot,
  Candidate,
  Portfolio,
  PositionIntent,
  Execution,
} from "./domain.js";

export interface SourceSnapshot {
  observed_at: number;
  revision: string;
  account_value_usdc: string;
  positions: PositionIntent[];
  complete: boolean;
}
export interface ActivationCheck {
  eligible: boolean;
  blockers: string[];
  idempotent_existing: boolean;
}
export interface VenueAdapter {
  activationCheck?(
    user: string,
    portfolio: Portfolio,
  ): Promise<ActivationCheck>;
  depositOptions?(): Promise<{ routes: any[]; notes?: string[] }>;
  depositAddress?(
    user: string,
    input: any,
    portfolioId?: string,
  ): Promise<import("./deposits.js").Deposit>;
  depositStatus?(
    deposit: import("./deposits.js").Deposit,
    user?: string,
  ): Promise<any>;
  fundingOperation?(
    operation: "quote" | "submit" | "activate_quote" | "activate_submit",
    user: string,
    input: any,
  ): Promise<any>;
  sourceFills?(
    trader: Candidate,
    start: number,
    end: number,
  ): Promise<{ fills: SourceFill[]; complete: boolean; reason?: string }>;
  notificationStatus?(
    user: string,
  ): Promise<{ configured: boolean; device_registered: boolean }>;
  candidates(market?: "perps" | "prediction" | "both"): Promise<Candidate[]>;
  profile(id: string): Promise<Candidate>;
  preflight(
    user: string,
    portfolio: Portfolio | null,
  ): Promise<AccountSnapshot>;
  bind(user: string, portfolio: Portfolio): Promise<AccountSnapshot>;
  account(user: string, portfolio: Portfolio): Promise<AccountSnapshot>;
  source(trader: Candidate): Promise<SourceSnapshot>;
  submit(
    user: string,
    portfolio: Portfolio,
    execution: Execution,
  ): Promise<{ task_id: string }>;
  execution(
    user: string,
    portfolio: Portfolio,
    execution: Execution,
  ): Promise<{
    task_id?: string;
    status: Execution["status"];
    observed_quantity: string | null;
    settled: boolean;
  }>;
  fence(user: string, portfolio: Portfolio): Promise<void>;
  cancelIncreasing(user: string, portfolio: Portfolio): Promise<void>;
  release(user: string, portfolio: Portfolio): Promise<void>;
  notify(
    user: string,
    event: {
      id: string;
      kind: string;
      message: string;
      portfolio_id: string | null;
    },
  ): Promise<void>;
}
export interface SourceFill {
  start_quantity?: string;
  id: string;
  key: string;
  quantity: string;
  price: string;
  fee_usdc: string | null;
  realized_usdc: string | null;
  at: number;
}
// Private, authenticated execution boundary. It holds Core S2S identity, never
// signing secrets. Its responses are normalized; machine routes cannot confirm.
export class BridgeAdapter implements VenueAdapter {
  constructor(
    private url: string,
    private token: string,
    privateHttpHost?: string,
  ) {
    const u = new URL(url);
    const privateHttp =
      u.protocol === "http:" &&
      u.hostname === privateHttpHost &&
      /^[a-z0-9-]+\.railway\.internal$/.test(u.hostname);
    if (
      u.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(u.hostname) &&
      !privateHttp
    )
      throw new Error(
        "Executor must use HTTPS, loopback or an explicitly configured private host",
      );
    if (u.username || u.password)
      throw new Error("Executor URL must not contain credentials");
    if (!token) throw new Error("Missing executor service token");
  }
  private async call<T>(operation: string, input: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(
        new URL(`/internal/agent/${operation}`, this.url),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(
            operation.startsWith("funding_") ? 90000 : 20000,
          ),
          redirect: "error",
        },
      );
    } catch {
      throw new AgentError(
        "EXECUTOR_UNAVAILABLE",
        "Execution boundary did not respond; pending submissions remain unresolved.",
        true,
        503,
      );
    }
    const data = (await response.json()) as {
      error?: {
        code: string;
        message: string;
        retryable?: boolean;
        details?: ErrorDetails;
      };
    };
    if (!response.ok)
      throw new AgentError(
        data.error?.code ?? "EXECUTOR_ERROR",
        data.error?.message ?? "Execution boundary rejected the request.",
        data.error?.retryable ?? response.status >= 500,
        response.status,
        errorDetails.safeParse(data.error?.details).success
          ? data.error?.details
          : undefined,
      );
    return data as T;
  }
  depositOptions() {
    return this.call<{ routes: any[]; notes?: string[] }>(
      "deposit_options",
      {},
    );
  }
  activationCheck(user: string, portfolio: Portfolio) {
    return this.call<ActivationCheck>("activation_check", {
      user_id: user,
      portfolio,
    });
  }
  depositAddress(user: string, input: any, portfolioId?: string) {
    return this.call<import("./deposits.js").Deposit>("deposit_address", {
      user_id: user,
      input,
      portfolio_id: portfolioId,
    });
  }
  depositStatus(deposit: import("./deposits.js").Deposit, user?: string) {
    return this.call<any>("deposit_status", { deposit, user_id: user });
  }
  fundingOperation(
    operation: "quote" | "submit" | "activate_quote" | "activate_submit",
    user: string,
    input: any,
  ) {
    return this.call<any>(`funding_${operation}`, { user_id: user, ...input });
  }
  candidates(market?: "perps" | "prediction" | "both") {
    return this.call<Candidate[]>("candidates", market ? { market } : {});
  }
  sourceFills(trader: Candidate, start: number, end: number) {
    return this.call<{
      fills: SourceFill[];
      complete: boolean;
      reason?: string;
    }>("source_fills", {
      trader_id: trader.id,
      market: trader.market,
      start_at: start,
      end_at: end,
    });
  }
  notificationStatus(user: string) {
    return this.call<{ configured: boolean; device_registered: boolean }>(
      "notification_status",
      { user_id: user },
    );
  }
  profile(id: string) {
    return this.call<Candidate>("profile", { trader_id: id });
  }
  preflight(user: string, portfolio: Portfolio | null) {
    return this.call<AccountSnapshot>("preflight", {
      user_id: user,
      portfolio,
    });
  }
  bind(user: string, portfolio: Portfolio) {
    return this.call<AccountSnapshot>("bind", { user_id: user, portfolio });
  }
  account(user: string, portfolio: Portfolio) {
    return this.call<AccountSnapshot>("account", { user_id: user, portfolio });
  }
  source(trader: Candidate) {
    return this.call<SourceSnapshot>("source", { trader_id: trader.id });
  }
  submit(user: string, portfolio: Portfolio, execution: Execution) {
    return this.call<{ task_id: string }>("submit", {
      user_id: user,
      portfolio,
      execution,
    });
  }
  execution(user: string, portfolio: Portfolio, execution: Execution) {
    return this.call<{
      task_id?: string;
      status: Execution["status"];
      observed_quantity: string | null;
      settled: boolean;
    }>("execution", { user_id: user, portfolio, execution });
  }
  async fence(user: string, portfolio: Portfolio) {
    await this.call("fence", { user_id: user, portfolio });
  }
  async release(user: string, portfolio: Portfolio) {
    await this.call("release", { user_id: user, portfolio });
  }
  async cancelIncreasing(user: string, portfolio: Portfolio) {
    await this.call("cancel_increasing", { user_id: user, portfolio });
  }
  async notify(
    user: string,
    event: {
      id: string;
      kind: string;
      message: string;
      portfolio_id: string | null;
    },
  ) {
    await this.call("notify", { user_id: user, event });
  }
}
