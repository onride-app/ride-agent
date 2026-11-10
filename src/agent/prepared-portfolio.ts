import { fingerprint, now, type Portfolio, type Execution } from "./domain.js";
import { perpsRecoveryRequest } from "./execution-core-recovery.js";
import { persistedPerpsRetirement } from "./execution-retirement.js";

/**
 * Private transport projection only. Original durable state, standalone
 * execution arguments and every task/financial receipt remain untouched.
 */
export function privateExecutionHistory(
  p: Pick<Portfolio, "executions" | "account_id" | "venue_accounts">,
  user?: string,
  protectedExecutionId?: string,
): Execution[] {
  if (typeof user !== "string") return p.executions;
  const account = p.venue_accounts?.perps ?? p.account_id;
  let changed = false;
  const kept = p.executions.filter((e) => {
    try {
      if (
        e.id === protectedExecutionId ||
        e.status !== "failed" ||
        e.task_id !== null ||
        e.observed_quantity !== null ||
        !e.key.startsWith("perps:") ||
        e.expires_at !== e.created_at + 60000 ||
        e.fingerprint !==
          fingerprint({
            id: e.id,
            key: e.key,
            target_quantity: e.target_quantity,
            allocations: e.allocations,
            revision: e.revision,
            created_at: e.created_at,
            expires_at: e.expires_at,
          })
      )
        return true;
      const request = perpsRecoveryRequest(user, account, e);
      if (!request || !persistedPerpsRetirement(request, e.retirement, now()))
        return true;
      changed = true;
      return false;
    } catch {
      return true;
    }
  });
  return changed ? kept : p.executions;
}

export type PreparedReadPurpose = "audit_submit" | "audit_source";

/** Private operational metadata only: never an execution or account response. */
export function preparedPortfolioInput(
  p: Portfolio,
  purpose: PreparedReadPurpose = "audit_submit",
) {
  if (purpose !== "audit_submit" && purpose !== "audit_source")
    throw new Error("Invalid prepared read purpose.");
  return {
    ...(purpose === "audit_source" ? { purpose } : {}),
    id: p.id,
    revision: p.revision,
    control_id: p.control_id,
    account_id: p.account_id,
    venue_accounts: p.venue_accounts,
    ledger_started_at: p.ledger_started_at,
    preferences: p.preferences,
    loss_latched: !!p.loss_latched,
    state: p.state,
    sleeves: p.sleeves.map((s) => ({
      copy_id: s.copy_id,
      state: s.state,
      copy_mode: s.copy_mode,
      ...(purpose === "audit_source" && s.copy_mode === "fixed"
        ? { fixed_last_fill_at: s.fixed_last_fill_at }
        : {}),
      trader: {
        id: s.trader.id,
        market: s.trader.market,
        assets: s.trader.assets,
        asset_category: s.trader.asset_category,
        asset_categories: s.trader.asset_categories,
      },
    })),
    handoff_binding: fingerprint(
      p.manual_ledger?.transfers.map((t) => t.handoff) ?? [],
    ),
    has_nonterminal_executions: p.executions.some(
      (e) => !["completed", "failed", "superseded"].includes(e.status),
    ),
  };
}
export type PreparedPortfolioInput = ReturnType<typeof preparedPortfolioInput>;
/** Audit status/timestamps and normal ledger reconciliation may advance. */
export function preparedOperationalBinding(p: PreparedPortfolioInput) {
  const { state: _state, has_nonterminal_executions: _pending, ...stable } = p;
  return fingerprint(stable);
}
/** The entire write-sensitive state is hashed, never copied into metadata RPCs. */
export function preparedWriteBinding(
  p: Portfolio,
  excludeExecutionId?: string,
  user?: string,
) {
  const { decisions: _decisions, executions, ...rest } = p;
  // Operational errors and performance observations are not authority changes.
  const {
    last_error: _last,
    source_read_error: _source,
    target_blocker: _blocker,
    __decision_history_version: _history,
    ...write
  } = rest as typeof rest & { __decision_history_version?: unknown };
  return fingerprint({
    portfolio: {
      ...write,
      sleeves: write.sleeves.map((s) => {
        const { last_source_at: _observationOnly, ...authority } = s;
        return authority;
      }),
    },
    executions: privateExecutionHistory(
      { ...p, executions },
      user,
      excludeExecutionId,
    )
      .filter((e) => e.id !== excludeExecutionId)
      .map((e) => {
        if (!Object.hasOwn(e, "first_submission_failure")) return e;
        const { first_submission_failure: _diagnostic, ...original } = e;
        return original;
      }),
  });
}
export function preparedProposalInput(p: Portfolio, user?: string) {
  return {
    ...preparedPortfolioInput(p),
    audit_snapshot_hash: fingerprint(p.snapshot),
    write_binding: preparedWriteBinding(p, undefined, user),
  };
}
export function preparedProposalBinding(proposal: {
  key: string;
  target_quantity: string;
  allocations: Execution["allocations"];
  revision: number;
  reserve_usdc: string;
}) {
  return fingerprint({
    key: proposal.key,
    target_quantity: proposal.target_quantity,
    allocations: proposal.allocations,
    revision: proposal.revision,
    reserve_usdc: proposal.reserve_usdc,
  });
}
