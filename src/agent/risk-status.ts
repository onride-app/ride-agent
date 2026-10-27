import { AgentError } from "./contracts.js";
import { aggregate, D, fresh, now, type Portfolio } from "./domain.js";

export interface TargetBlocker {
  evaluated_revision: number;
  code:
    | "ASSET_CONCENTRATION"
    | "BUDGET_EXCEEDED"
    | "SCOPED_COLLATERAL_REQUIRED"
    | "INVALID_OUTCOME_POSITION";
  message: string;
  message_zh: string;
  asset?: string;
  concentration_pct?: number;
  limit_pct?: number;
  at: number;
}

const explanations: Record<TargetBlocker["code"], [string, string]> = {
  ASSET_CONCENTRATION: [
    "The proposed asset exposure exceeds the existing concentration limit.",
    "拟议资产暴露超过现有集中度上限。",
  ],
  BUDGET_EXCEEDED: [
    "Proposed gross exposure or gross margin exceeds the approved budget limit.",
    "拟议总暴露或总保证金超过已批准的预算上限。",
  ],
  SCOPED_COLLATERAL_REQUIRED: [
    "Fresh available collateral in the selected DEX is insufficient; balances in other DEXs cannot fund this target.",
    "所选 DEX 的最新可用保证金不足；其他 DEX 的余额不能用于本次目标。",
  ],
  INVALID_OUTCOME_POSITION: [
    "The proposed prediction outcome position has negative inventory, which is not permitted.",
    "拟议预测市场结果代币持仓为负，现有规则不允许负库存。",
  ],
};

// Called only after the existing risk check rejects a staged target. This
// metadata describes the rejection and never participates in order decisions.
export function describeRiskBlocker(
  error: unknown,
  proposed: Portfolio,
  prices: Record<string, string>,
): TargetBlocker | undefined {
  if (
    !(error instanceof AgentError) ||
    !Object.hasOwn(explanations, error.code)
  )
    return undefined;
  const code = error.code as TargetBlocker["code"];
  const [message, message_zh] = explanations[code];
  const blocker: TargetBlocker = {
    code,
    message,
    message_zh,
    at: now(),
    evaluated_revision: proposed.revision,
  };
  try {
    if (code === "ASSET_CONCENTRATION") {
      const next = aggregate(proposed, prices);
      const prior = aggregate(proposed, prices, "actual");
      const limit = proposed.preferences.portfolio_kind === "single" ? 100 : 60;
      // Identify the same first non-reducing asset rejected by risk(), without
      // changing its predicate or interpreting concentration as budget usage.
      const rejected = next.find((a) => {
        const old = prior.find((x) => x.key === a.key);
        return (
          D(a.concentration_pct ?? 0).gt(limit) &&
          !(
            D(a.net_notional_usdc)
              .abs()
              .lte(D(old?.net_notional_usdc ?? 0).abs()) &&
            D(a.gross_notional_usdc).lte(old?.gross_notional_usdc ?? 0)
          )
        );
      });
      if (rejected && /^[A-Za-z][A-Za-z0-9:_-]{0,30}$/.test(rejected.asset)) {
        const percentage = D(rejected.concentration_pct!).toNumber();
        Object.assign(blocker, {
          asset: rejected.asset,
          concentration_pct: percentage,
          limit_pct: limit,
          message: `${rejected.asset} accounts for ${percentage}% of proposed gross sleeve exposure; the limit is ${limit}%.`,
          message_zh: `${rejected.asset} 占拟议组合总暴露的 ${percentage}%，超过 ${limit}% 的资产集中度上限。`,
        });
      }
    }
  } catch {
    // A diagnostic must never interrupt reconciliation or existing exits.
  }
  return blocker;
}

export function executionStatus(p: Portfolio, operational: boolean) {
  const blocker = p.target_blocker;
  const current =
    blocker &&
    blocker.evaluated_revision === p.revision &&
    fresh(blocker.at) &&
    p.account_id &&
    p.state === "active" &&
    !p.loss_latched &&
    !p.last_error &&
    p.reconciliation === "complete" &&
    p.snapshot &&
    fresh(p.snapshot.observed_at) &&
    p.snapshot.eligible &&
    p.snapshot.dedicated &&
    p.snapshot.coverage_complete &&
    p.sleeves.every(
      (s) =>
        s.state === "closed" ||
        (s.last_source_at != null && fresh(s.last_source_at)),
    );
  const common = { applies_to: "proposed_target_update" as const };
  if (current)
    return {
      ...common,
      status: "blocked_by_risk" as const,
      summary: "No order placed for this target update: blocked by risk",
      summary_zh: "因风控暂未下单",
      reason: { ...blocker },
      updated_at: blocker.at,
    };
  const pending = p.executions.some(
    (e) => !["completed", "failed", "superseded"].includes(e.status),
  );
  const observed = p.executions.some(
    (e) => e.status === "completed" || e.task_id != null,
  );
  const status = !operational
    ? "not_ready"
    : pending
      ? "orders_pending"
      : observed
        ? "orders_observed"
        : "monitoring";
  return {
    ...common,
    status,
    summary:
      status === "not_ready"
        ? "Monitoring is not ready; review activation and data freshness"
        : status === "orders_pending"
          ? "Existing execution is pending; see execution records"
          : status === "orders_observed"
            ? "Execution observed; see actual order and fill records"
            : "Monitoring ready; no order recorded yet",
    summary_zh:
      status === "not_ready"
        ? "监控尚未就绪，请查看激活状态和数据时效"
        : status === "orders_pending"
          ? "已有执行待核实，请查看执行记录"
          : status === "orders_observed"
            ? "已有执行记录，请查看实际订单与成交"
            : "监控已就绪，尚无订单记录",
    reason: null,
    updated_at: p.snapshot?.observed_at ?? null,
  };
}
