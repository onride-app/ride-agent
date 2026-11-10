import { AgentError, errorDetails } from "./contracts.js";
import { isPlanReadEvidence, type PlanReadEvidence } from "./read-evidence.js";
import { monitorOperation } from "./monitor-diagnostics.js";
import { sourceRequiresRwa } from "./source-identities.js";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  preparedProposalInput,
  preparedProposalBinding,
  privateExecutionHistory,
  type PreparedPortfolioInput,
  type PreparedReadPurpose,
} from "./prepared-portfolio.js";
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
  // Actual Perps clearinghouse scopes observed by this snapshot; "" is native.
  perps_dexes?: string[];
  // Internal proof of the minimum scope actually collected, not permission.
  observation_scope_requires_rwa?: boolean;
}
export interface ActivationCheck {
  eligible: boolean;
  blockers: string[];
  idempotent_existing: boolean;
}
export interface PreparedPortfolioWindow {
  mode: "cold" | "warm";
  purpose?: "audit_source";
  execution_eligible?: false;
  assertLive?(): void;
  expires_at: number;
  /** End read credit before digest/history/notification work. */
  release?(): Promise<void>;
}
export type PreparedPortfolioResult<T> =
  | { state: "unsupported" }
  | { state: "pending"; retry_after_ms: number }
  | { state: "complete"; value: T };
export type ExecutionProposal = Pick<
  Execution,
  "key" | "target_quantity" | "allocations" | "revision" | "reserve_usdc"
>;
export interface ExecutionPreparation {
  expires_at: number;
  bind(execution: Execution): void;
  cancel(): Promise<void>;
}
type ReadWindowContext = {
  user: string;
  portfolio: PreparedPortfolioInput;
  handle: string;
  mode: "cold" | "warm";
  purpose: PreparedReadPurpose;
  expiresAt: number;
  monotonicUntil: number;
  active: boolean;
  financialReleased: boolean;
  bound?: { id: string; fingerprint: string };
  proposal?: string;
  finish?: Promise<void>;
};
export interface VenueAdapter {
  /** Private operational credit only; no completed financial evidence is reused. */
  withPreparedPortfolio?<T>(
    user: string,
    portfolio: PreparedPortfolioInput,
    work: (window: PreparedPortfolioWindow) => Promise<T>,
  ): Promise<PreparedPortfolioResult<T>>;
  prepareExecution?(
    user: string,
    portfolio: Portfolio,
    proposal: ExecutionProposal,
  ): Promise<ExecutionPreparation | null>;
  cancelPreparedPortfolio?(
    user: string,
    previous: PreparedPortfolioInput,
  ): Promise<void>;
  readPlanEvidence?(traders: Candidate[]): Promise<PlanReadEvidence>;
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
    retirement?: import("./execution-retirement.js").PerpsRetirementReceipt;
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
    signal?: AbortSignal,
    deadlineMs?: number,
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
    Object.entries(input.portfolio).filter(
      ([key]) => key !== "decisions" && key !== "__decision_history_version",
    ),
  );
  const withoutDiagnostic = (value: unknown) => {
    if (!record(value) || !Object.hasOwn(value, "first_submission_failure"))
      return value;
    const { first_submission_failure: _diagnostic, ...execution } = value;
    return execution;
  };
  if (Array.isArray(portfolio.executions))
    portfolio.executions = privateExecutionHistory(
      input.portfolio as unknown as Portfolio,
      typeof input.user_id === "string" ? input.user_id : undefined,
      record(input.execution) && typeof input.execution.id === "string"
        ? input.execution.id
        : undefined,
    ).map(withoutDiagnostic);
  return {
    ...input,
    portfolio,
    ...(record(input.execution)
      ? { execution: withoutDiagnostic(input.execution) }
      : {}),
  };
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

function readOnlyExecutionRejected(): AgentError {
  return new AgentError(
    "EXECUTION_REJECTED",
    "Read-only observation cannot prepare or submit an execution.",
    false,
    409,
  );
}

function validBridgeResponse(operation: string, data: unknown): boolean {
  if (operation === "candidates") return Array.isArray(data);
  if (operation === "read_plan_evidence") return isPlanReadEvidence(data);
  if (!record(data)) return false;
  if (operation === "notify") return data.ok === true;
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

function transportUnavailable(): AgentError {
  return new AgentError(
    "EXECUTOR_UNAVAILABLE",
    "Execution boundary did not respond; pending submissions remain unresolved.",
    true,
    503,
  );
}

async function withBridgeDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    throw signal.reason;
  }
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

// Private, authenticated execution boundary. It holds Core S2S identity, never
// signing secrets. Its responses are normalized; machine routes cannot confirm.
const readonlyRunnerSourceGraph = "readonly-runner-native-v1" as const;
export class BridgeAdapter implements VenueAdapter {
  private readonly readWindows = new AsyncLocalStorage<ReadWindowContext>();
  constructor(
    private url: string,
    private token: string,
    privateHttpHost?: string,
    private readonly windowMonotonicClock: () => number = () =>
      performance.now(),
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
  private async call<T>(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
    windowHandle?: string,
    sourceReadGraph?: typeof readonlyRunnerSourceGraph,
  ): Promise<T> {
    return monitorOperation(operation, () =>
      this.performCall<T>(
        operation,
        input,
        signal,
        windowHandle,
        sourceReadGraph,
      ),
    );
  }
  private async performCall<T>(
    operation: string,
    input: unknown,
    callerSignal?: AbortSignal,
    explicitWindowHandle?: string,
    sourceReadGraph?: typeof readonlyRunnerSourceGraph,
  ): Promise<T> {
    // The complete account observation is bounded at 20s inside the bridge.
    // Leave transport margin for its typed failure and retry hint to arrive.
    const timeoutSignal = AbortSignal.timeout(
      ["finish_portfolio", "cancel_prepared_portfolio"].includes(operation)
        ? 2000
        : operation.startsWith("funding_")
          ? 90000
          : ["account", "preflight", "bind"].includes(operation)
            ? 25000
            : 20000,
    );
    const signal = callerSignal
      ? AbortSignal.any([timeoutSignal, callerSignal])
      : timeoutSignal;
    const context = this.readWindows.getStore();
    const scopedPortfolio =
      record(input) && record(input.portfolio) ? input.portfolio : undefined;
    const scopedAccounts =
      scopedPortfolio && record(scopedPortfolio.venue_accounts)
        ? scopedPortfolio.venue_accounts
        : undefined;
    const sameReadPortfolio =
      !!context &&
      record(input) &&
      input.user_id === context.user &&
      scopedPortfolio?.id === context.portfolio.id &&
      (scopedAccounts?.perps ?? scopedPortfolio?.account_id) ===
        (context.portfolio.venue_accounts?.perps ??
          context.portfolio.account_id) &&
      scopedPortfolio?.control_id === context.portfolio.control_id;
    if (
      context &&
      context.purpose === "audit_source" &&
      !context.financialReleased &&
      sameReadPortfolio &&
      ["prepare_execution", "bind", "submit"].includes(operation)
    )
      throw readOnlyExecutionRejected();
    let windowHandle = explicitWindowHandle;
    const selectedSources = new Set(
      context?.portfolio.sleeves.map((s) => s.trader.id),
    );
    const sourceMatches =
      operation === "source"
        ? record(input) && selectedSources.has(String(input.trader_id))
        : operation === "source_fills"
          ? record(input) &&
            input.market === "perps" &&
            context?.purpose === "audit_source" &&
            selectedSources.has(String(input.trader_id)) &&
            context.portfolio.sleeves.some(
              (s) =>
                s.state !== "closed" &&
                s.copy_mode === "fixed" &&
                s.trader.id === input.trader_id,
            ) &&
            context.portfolio.sleeves
              .filter(
                (s) =>
                  s.state !== "closed" &&
                  s.copy_mode === "fixed" &&
                  s.trader.id === input.trader_id,
              )
              .every(
                (s) =>
                  Number.isSafeInteger(s.fixed_last_fill_at) &&
                  s.fixed_last_fill_at === input.start_at,
              ) &&
            Number.isSafeInteger(input.end_at) &&
            Number.isSafeInteger(input.start_at) &&
            Number(input.end_at) > Number(input.start_at) &&
            Number(input.end_at) - Number(input.start_at) <= 31 * 86400_000 &&
            Number(input.end_at) <= Date.now()
          : operation === "read_plan_evidence"
            ? record(input) &&
              Array.isArray(input.traders) &&
              input.traders.every(
                (trader) =>
                  record(trader) && selectedSources.has(String(trader.id)),
              )
            : true;
    if (
      context?.active &&
      ((context.purpose === "audit_source" &&
        ["source", "source_fills", "read_plan_evidence"].includes(operation) &&
        !sourceMatches) ||
        (operation === "source_fills" && context.purpose !== "audit_source"))
    )
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "Read-only source history does not match the selected scope.",
        false,
        409,
      );
    if (
      windowHandle === undefined &&
      context?.active &&
      sourceMatches &&
      (["source", "source_fills", "read_plan_evidence"].includes(operation) ||
        sameReadPortfolio) &&
      [
        "account",
        "prepare_execution",
        "submit",
        "source",
        "source_fills",
        "read_plan_evidence",
      ].includes(operation)
    ) {
      if (context.purpose === "audit_source")
        this.assertReadWindowLive(context);
      if (Date.now() >= context.expiresAt)
        throw new AgentError(
          "VENUE_READ_DEADLINE",
          "Prepared read window expired.",
          true,
          503,
        );
      if (operation === "submit") {
        const execution = record(input) ? input.execution : undefined;
        if (
          !record(execution) ||
          !context.bound ||
          execution.id !== context.bound.id ||
          execution.fingerprint !== context.bound.fingerprint
        )
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Prepared execution identity changed.",
          );
      }
      windowHandle = context.handle;
    }
    if (
      sourceReadGraph !== undefined &&
      (sourceReadGraph !== readonlyRunnerSourceGraph ||
        windowHandle !== undefined ||
        !["prepare_portfolio", "cancel_prepared_portfolio"].includes(
          operation,
        ) ||
        scopedPortfolio?.purpose !== "audit_source")
    )
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "Read graph does not match its private preparation scope.",
        false,
        409,
      );
    let response: Response;
    try {
      response = await withBridgeDeadline(
        fetch(new URL(`/internal/agent/${operation}`, this.url), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
            ...(windowHandle ? { "x-ride-read-window": windowHandle } : {}),
            ...(sourceReadGraph
              ? { "x-ride-source-read-graph": sourceReadGraph }
              : {}),
          },
          body: JSON.stringify(bridgeInput(input)),
          signal,
          redirect: "error",
        }),
        signal,
      );
    } catch {
      throw transportUnavailable();
    }
    let data: unknown;
    try {
      data = await withBridgeDeadline(response.json(), signal);
    } catch {
      if (signal.aborted) throw transportUnavailable();
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
  async withPreparedPortfolio<T>(
    user: string,
    portfolio: PreparedPortfolioInput,
    work: (window: PreparedPortfolioWindow) => Promise<T>,
  ): Promise<PreparedPortfolioResult<T>> {
    if (portfolio.purpose !== undefined && portfolio.purpose !== "audit_source")
      throw new AgentError(
        "EXECUTOR_RESPONSE_INVALID",
        "Read purpose is invalid.",
        false,
        502,
      );
    const purpose: PreparedReadPurpose = portfolio.purpose ?? "audit_submit";
    if (this.readWindows.getStore()?.active)
      throw new AgentError(
        "EXECUTOR_RESPONSE_INVALID",
        "Nested read windows are unavailable.",
        true,
        502,
      );
    let ready: any;
    try {
      ready = await this.call<any>(
        "prepare_portfolio",
        {
          user_id: user,
          portfolio,
        },
        undefined,
        undefined,
        purpose === "audit_source" ? readonlyRunnerSourceGraph : undefined,
      );
    } catch (error) {
      // Explicit protocol negotiation with an older authenticated bridge.
      // Operational/provider failures must never claim unsupported readiness.
      if (
        error instanceof AgentError &&
        error.code === "NOT_FOUND" &&
        error.message === "Unknown private adapter operation."
      )
        return { state: "unsupported" };
      throw error;
    }
    if (ready?.state === "unsupported") return { state: "unsupported" };
    if (
      (purpose === "audit_source" &&
        (ready?.purpose !== "audit_source" ||
          ready?.execution_eligible !== false)) ||
      (purpose === "audit_submit" &&
        ready?.purpose !== undefined &&
        ready.purpose !== "audit_submit")
    ) {
      if (
        ready?.state === "ready" &&
        typeof ready.handle === "string" &&
        /^[A-Za-z0-9_-]{32,128}$/.test(ready.handle)
      )
        await this.call(
          "finish_portfolio",
          { user_id: user, portfolio_id: portfolio.id },
          undefined,
          ready.handle,
        ).catch(() => {});
      throw new AgentError(
        "EXECUTOR_RESPONSE_INVALID",
        "Read readiness did not confirm the requested purpose.",
        false,
        502,
      );
    }
    if (ready?.state === "pending") {
      if (
        !Number.isSafeInteger(ready.retry_after_ms) ||
        ready.retry_after_ms < 1 ||
        ready.retry_after_ms > 60000
      )
        throw new AgentError(
          "EXECUTOR_RESPONSE_INVALID",
          "Read readiness response is invalid.",
          true,
          502,
        );
      return { state: "pending", retry_after_ms: ready.retry_after_ms };
    }
    if (
      ready?.state !== "ready" ||
      typeof ready.handle !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(ready.handle) ||
      !["cold", "warm"].includes(ready.mode) ||
      !Number.isSafeInteger(ready.expires_at) ||
      ready.expires_at <= Date.now() ||
      ready.expires_at > Date.now() + 20000
    )
      throw new AgentError(
        "EXECUTOR_RESPONSE_INVALID",
        "Read readiness response is invalid.",
        true,
        502,
      );
    const context: ReadWindowContext = {
      user,
      portfolio: structuredClone(portfolio),
      handle: ready.handle as string,
      mode: ready.mode as "cold" | "warm",
      purpose,
      expiresAt: ready.expires_at as number,
      monotonicUntil:
        this.windowMonotonicClock() +
        Math.max(0, ready.expires_at - Date.now()),
      active: true,
      financialReleased: purpose !== "audit_source",
    };
    const finish = () => {
      context.active = false;
      context.bound = undefined;
      if (!context.finish) {
        const result = this.call<{ ok?: unknown }>(
          "finish_portfolio",
          { user_id: user, portfolio_id: portfolio.id },
          undefined,
          context.handle,
        ).then((value) => {
          if (purpose === "audit_source" && value?.ok !== true)
            throw new AgentError(
              "EXECUTOR_RESPONSE_INVALID",
              "Read-only window release was not acknowledged.",
              true,
              502,
            );
          context.financialReleased = true;
        });
        context.finish =
          purpose === "audit_source" ? result : result.catch(() => undefined);
        void context.finish.catch(() => {});
      }
      return context.finish;
    };
    try {
      const value = await this.readWindows.run(context, () =>
        work({
          mode: context.mode,
          ...(purpose === "audit_source"
            ? {
                purpose,
                execution_eligible: false as const,
                assertLive: () => this.assertReadWindowLive(context),
              }
            : {}),
          expires_at: context.expiresAt,
          release: finish,
        }),
      );
      return { state: "complete", value };
    } finally {
      // An explicit readonly release propagates failure before a risk order
      // can be created. Cleanup cannot replace an earlier business error.
      await finish().catch(() => {});
    }
  }
  private assertReadWindowLive(context: ReadWindowContext): void {
    if (
      !context.active ||
      Date.now() >= context.expiresAt ||
      this.windowMonotonicClock() >= context.monotonicUntil
    )
      throw new AgentError(
        "VENUE_READ_DEADLINE",
        "Read-only observation window expired.",
        true,
        503,
      );
  }
  async prepareExecution(
    user: string,
    portfolio: Portfolio,
    proposal: ExecutionProposal,
  ): Promise<ExecutionPreparation | null> {
    const context = this.readWindows.getStore();
    if (
      context &&
      context.purpose === "audit_source" &&
      !context.financialReleased &&
      context.user === user &&
      context.portfolio.id === portfolio.id
    )
      throw readOnlyExecutionRejected();
    if (!context?.active || context.mode !== "warm") return null;
    if (
      context.user !== user ||
      context.portfolio.id !== portfolio.id ||
      context.proposal !== undefined ||
      Date.now() >= context.expiresAt
    )
      throw new AgentError(
        "EXECUTION_REJECTED",
        "Prepared read authority changed.",
      );
    const proposalBinding = preparedProposalBinding(proposal);
    // Pin before the await so two concurrent callers cannot claim one slot.
    context.proposal = proposalBinding;
    const result = await this.call<{ ready: boolean }>("prepare_execution", {
      user_id: user,
      portfolio: preparedProposalInput(portfolio, user),
      proposal,
    });
    if (
      result?.ready !== true ||
      !context.active ||
      Date.now() >= context.expiresAt
    )
      throw new AgentError(
        "VENUE_READ_DEADLINE",
        "Prepared read window expired.",
        true,
        503,
      );
    return {
      expires_at: context.expiresAt,
      bind: (execution) => {
        if (
          !context.active ||
          context.purpose === "audit_source" ||
          context.bound ||
          Date.now() >= context.expiresAt ||
          preparedProposalBinding(execution) !== proposalBinding
        )
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Prepared execution identity changed.",
          );
        context.bound = {
          id: execution.id,
          fingerprint: execution.fingerprint,
        };
      },
      cancel: async () => {
        context.active = false;
        context.bound = undefined;
        await (context.finish ??= this.call(
          "finish_portfolio",
          {
            user_id: user,
            portfolio_id: portfolio.id,
          },
          undefined,
          context.handle,
        ).then(
          () => undefined,
          () => undefined,
        ));
      },
    };
  }
  async cancelPreparedPortfolio(
    user: string,
    previous: PreparedPortfolioInput,
  ) {
    const value = await this.call<{
      ok?: unknown;
      pending_cancelled?: unknown;
    }>(
      "cancel_prepared_portfolio",
      {
        user_id: user,
        portfolio: previous,
      },
      undefined,
      undefined,
      previous.purpose === "audit_source"
        ? readonlyRunnerSourceGraph
        : undefined,
    );
    if (
      previous.purpose === "audit_source" &&
      (value?.ok !== true || value?.pending_cancelled !== true)
    )
      throw new AgentError(
        "VENUE_COST_PLAN_UNAVAILABLE",
        "Read-only pending cancellation was not confirmed.",
        true,
        503,
      );
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
  async readPlanEvidence(traders: Candidate[]) {
    const result = await this.call<PlanReadEvidence>("read_plan_evidence", {
      traders,
    });
    const expected = new Set(traders.map((trader) => trader.id));
    if (
      result.sources.length !== expected.size ||
      result.sources.some((source) => !expected.has(source.trader_id))
    )
      throw new AgentError(
        "EXECUTOR_RESPONSE_INVALID",
        "Read-only evidence did not match the selected traders.",
        true,
        502,
      );
    return result;
  }
  async sourceFills(trader: Candidate, start: number, end: number) {
    const result = await this.call<{
      fills: SourceFill[];
      complete: boolean;
      reason?: string;
      observation_scope_requires_rwa?: boolean;
    }>("source_fills", {
      trader_id: trader.id,
      market: trader.market,
      start_at: start,
      end_at: end,
      ...(sourceRequiresRwa(trader) ? { minimum_requires_rwa: true } : {}),
    });
    if (
      sourceRequiresRwa(trader) &&
      result.observation_scope_requires_rwa !== true
    )
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "The execution boundary did not verify the original source's required observation scope.",
        true,
        503,
      );
    return result;
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
  async source(trader: Candidate) {
    const result = await this.call<SourceSnapshot>("source", {
      trader_id: trader.id,
      ...(sourceRequiresRwa(trader) ? { minimum_requires_rwa: true } : {}),
    });
    if (
      sourceRequiresRwa(trader) &&
      result.observation_scope_requires_rwa !== true
    )
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "The execution boundary did not verify the original source's required observation scope.",
        true,
        503,
      );
    return result;
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
      retirement?: import("./execution-retirement.js").PerpsRetirementReceipt;
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
    signal?: AbortSignal,
    deadlineMs = Date.now() + 20000,
  ) {
    await this.call(
      "notify",
      { user_id: user, event, deadline_ms: deadlineMs },
      signal,
    );
  }
}
