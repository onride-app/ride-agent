import { AgentError, errorDetails } from "./contracts.js";
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function bridgeInput(input: unknown): unknown {
  if (!record(input) || !record(input.portfolio)) return input;
  // Decisions are the backend's full audit history. Neither private venue
  // implementation reads it, and its growth must not block account refreshes
  // or execution. Omit it on the wire without touching the persisted object.
  const portfolio = Object.fromEntries(
    Object.entries(input.portfolio).filter(([key]) => key !== "decisions"),
  );
  return { ...input, portfolio };
}

function invalidBridgeResponse(response: Response): AgentError {
  if (response.status === 413)
    return new AgentError(
      "EXECUTOR_REQUEST_TOO_LARGE",
      "Execution boundary rejected an oversized request. Existing pending work remains unresolved.",
      false,
      413,
    );
  if (!response.ok && response.status >= 500)
    return new AgentError(
      "EXECUTOR_UNAVAILABLE",
      "Execution boundary is unavailable. Existing pending work remains unresolved.",
      true,
      response.status,
    );
  return new AgentError(
    "EXECUTOR_RESPONSE_INVALID",
    "Execution boundary returned an invalid response. Existing pending work remains unresolved.",
    true,
    502,
  );
}

function validBridgeResponse(operation: string, data: unknown): boolean {
  if (operation === "candidates") return Array.isArray(data);
  if (!record(data)) return false;
  if (!["account", "preflight", "bind"].includes(operation)) return true;
  return (
    typeof data.account_id === "string" &&
    data.account_id.length > 0 &&
    typeof data.observed_at === "number" &&
    Number.isFinite(data.observed_at) &&
    typeof data.account_value_usdc === "string" &&
    typeof data.available_usdc === "string" &&
    typeof data.eligible === "boolean" &&
    typeof data.dedicated === "boolean" &&
    typeof data.coverage_complete === "boolean" &&
    ["positions", "prices", "max_leverages", "min_notionals"].every((key) =>
      record(data[key]),
    ) &&
    ["orders", "fills", "funding", "flows"].every((key) =>
      Array.isArray(data[key]),
    )
  );
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
          body: JSON.stringify(bridgeInput(input)),
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
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw invalidBridgeResponse(response);
    }
    if (record(data) && "error" in data) {
      const error = data.error;
      if (
        !record(error) ||
        typeof error.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ||
        typeof error.message !== "string"
      )
        throw invalidBridgeResponse(response);
      const details = errorDetails.safeParse(error.details);
      throw new AgentError(
        error.code,
        error.message,
        typeof error.retryable === "boolean"
          ? error.retryable
          : response.status >= 500,
        response.ok ? 502 : response.status,
        details.success ? details.data : undefined,
      );
    }
    if (!response.ok || !validBridgeResponse(operation, data))
      throw invalidBridgeResponse(response);
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
