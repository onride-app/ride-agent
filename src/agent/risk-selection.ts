import type { Preferences } from "./contracts.js";
import type { Candidate } from "./domain.js";

// A versioned product preference rule, not fitted weights, an investment return
// estimate, or a claim that a resulting portfolio has lower measured risk.
export const RISK_SELECTION_POLICY_VERSION = "perps_model_priorities_v1";
export const RISK_SELECTION_SCORE_VERSION = "strict_perp_v2_5_daily_live_v1";
export const RISK_SELECTION_METRICS = [
  "stability",
  "pathSmoothness",
  "drawdownRecovery",
  "positionLeverageStability",
  "profitQuality",
  "copyability",
] as const;

type RiskMetric = (typeof RISK_SELECTION_METRICS)[number];
type RiskProfile = NonNullable<Preferences["risk_tolerance"]>;
export type SelectionSource = "system" | "explicit" | "legacy_unknown";
export interface RecommendationOptions {
  selection_source?: SelectionSource;
  risk_selection?: "apply" | "preserve";
}
export interface RiskSelectionSummary {
  policy_version: string;
  profile: RiskProfile | null;
  status:
    | "applied"
    | "insufficient_evidence"
    | "unsupported"
    | "not_requested"
    | "preserved_selection";
  scoring_version: string | null;
  priorities: string[];
  candidate_count: number;
  evidence_count: number;
  unavailable_trader_ids: string[];
  missing_metrics_by_trader: Record<string, string[]>;
  selected: Array<{
    trader_id: string;
    metrics: Record<string, number>;
    reasons: string[];
  }>;
  explanation: string;
}

const metricLabels: Record<RiskMetric, string> = {
  stability: "稳定性",
  pathSmoothness: "路径平滑度",
  drawdownRecovery: "回撤恢复",
  positionLeverageStability: "仓位杠杆稳定性",
  profitQuality: "盈利质量",
  copyability: "可复制性",
};
const priorities: Record<RiskProfile, string[]> = {
  low: ["stability_floor", "opportunity_floor", "copy_score"],
  medium: ["balanced_floor", "copy_score"],
  high: ["opportunity_floor", "stability_floor", "copy_score"],
};
const finiteScore = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 100;

function evidence(candidate: Candidate) {
  const missing: string[] = [];
  const metrics: Record<string, number> = {};
  if (candidate.market !== "perps") missing.push("unsupported_market");
  if (!finiteScore(candidate.score)) missing.push("copy_score");
  if (candidate.score_version !== RISK_SELECTION_SCORE_VERSION)
    missing.push("unsupported_score_version");
  for (const key of RISK_SELECTION_METRICS) {
    const value = candidate.components?.[key];
    if (finiteScore(value)) metrics[key] = value;
    else missing.push(key);
  }
  if (!missing.length) {
    // Bottlenecks avoid one high subscore hiding a weak dimension. Different
    // profiles change the priority order, not the underlying Copy Score.
    metrics.stability_floor = Math.min(
      metrics.stability,
      metrics.pathSmoothness,
      metrics.drawdownRecovery,
      metrics.positionLeverageStability,
    );
    metrics.opportunity_floor = Math.min(
      metrics.profitQuality,
      metrics.copyability,
    );
    metrics.balanced_floor = Math.min(
      metrics.stability_floor,
      metrics.opportunity_floor,
    );
  }
  return { missing, metrics };
}

export function createRiskSelectionPolicy(
  preferences: Preferences,
  sourceCandidates: Candidate[],
  options: RecommendationOptions = {},
) {
  const candidates = [...sourceCandidates];
  const profile = preferences.risk_tolerance ?? null;
  const records = new Map(candidates.map((c) => [c.id, evidence(c)]));
  const missingByTrader: Record<string, string[]> = {};
  for (const candidate of candidates) {
    const missing = records.get(candidate.id)!.missing;
    if (missing.length) missingByTrader[candidate.id] = missing;
  }
  const unavailable = Object.keys(missingByTrader).sort();
  const versions = [...new Set(candidates.map((c) => c.score_version))];
  let status: RiskSelectionSummary["status"];
  let explanation: string;
  if (options.risk_selection === "preserve") {
    status = "preserved_selection";
    explanation = "保留现有交易员选择；本次未按风险偏好重新系统选人。";
  } else if (!preferences.portfolio_kind) {
    status = "unsupported";
    explanation = "旧版方案保留原有选择和杠杆规则，未套用新的风险匹配策略。";
  } else if (!profile) {
    status = "not_requested";
    explanation =
      "未提供低、中、高风险偏好；不会从数值退出触发值推断风险标签。";
  } else if (!candidates.length) {
    status = "insufficient_evidence";
    explanation = "没有可验证的候选证据，未完成风险偏好匹配。";
  } else if (candidates.some((c) => c.market !== "perps")) {
    status = "unsupported";
    explanation =
      "当前风险匹配策略仅支持 Perps；未把不同市场的模型分项混作可比较证据。";
  } else if (
    versions.length !== 1 ||
    versions[0] !== RISK_SELECTION_SCORE_VERSION
  ) {
    status = "unsupported";
    explanation = "候选评分版本不一致或不受支持，未宣称已完成风险偏好匹配。";
  } else if (unavailable.length) {
    status = "insufficient_evidence";
    explanation =
      "部分候选缺少完整、有效的模型分项；保留兼容排序，未宣称已完成风险匹配。";
  } else {
    status = "applied";
    const emphasis =
      profile === "low"
        ? "优先稳定性相关分项的短板，再看盈利质量与可复制性"
        : profile === "medium"
          ? "优先稳定性、盈利质量与可复制性之间的共同短板"
          : "优先盈利质量与可复制性的共同短板，再看稳定性";
    explanation = `本版产品规则${emphasis}，并沿用资产、方向、风格重叠扣分和 Copy Score 作为后续排序依据。不是最优权重或收益预测；未使用周期未核实的来源收益、回撤比较，也未改变杠杆或退出设置。`;
  }

  return {
    // Utilities contain the existing qualitative overlap penalty. Apply that
    // same penalty to each priority dimension, rather than ignoring exposure
    // overlap until model subscores happen to tie exactly.
    compare(
      a: Candidate,
      b: Candidate,
      utilityA: number,
      utilityB: number,
    ): number {
      if (status !== "applied" || !profile) return 0;
      const am = records.get(a.id)!.metrics;
      const bm = records.get(b.id)!.metrics;
      const penaltyA = a.score - utilityA;
      const penaltyB = b.score - utilityB;
      for (const key of priorities[profile]) {
        const av = key === "copy_score" ? utilityA : am[key] - penaltyA;
        const bv = key === "copy_score" ? utilityB : bm[key] - penaltyB;
        if (av !== bv) return bv - av;
      }
      return 0;
    },
    summary(selected: Candidate[]): RiskSelectionSummary {
      return {
        policy_version: RISK_SELECTION_POLICY_VERSION,
        profile,
        status,
        scoring_version: versions.length === 1 ? versions[0] : null,
        priorities:
          status === "applied" && profile ? [...priorities[profile]] : [],
        candidate_count: candidates.length,
        evidence_count: candidates.length - unavailable.length,
        unavailable_trader_ids: unavailable,
        missing_metrics_by_trader: missingByTrader,
        selected: selected.map((candidate) => {
          const record = records.get(candidate.id) ?? evidence(candidate);
          const reasons =
            status !== "applied" || !profile
              ? [explanation]
              : [
                  profile === "low"
                    ? `稳定性相关分项短板 ${record.metrics.stability_floor.toFixed(2)}，按稳健偏好优先评估。`
                    : profile === "medium"
                      ? `稳定性与机会质量共同短板 ${record.metrics.balanced_floor.toFixed(2)}，按平衡偏好评估。`
                      : `盈利质量与可复制性共同短板 ${record.metrics.opportunity_floor.toFixed(2)}，按进取偏好优先评估。`,
                  `依据同版模型的${RISK_SELECTION_METRICS.map((key) => `${metricLabels[key]} ${record.metrics[key].toFixed(2)}`).join("、")}。`,
                  "同时考虑已选交易员的资产、方向和风格重叠；不代表实际跟单收益或实测组合风险改善。",
                ];
          return {
            trader_id: candidate.id,
            metrics: { ...record.metrics },
            reasons,
          };
        }),
        explanation,
      };
    },
  };
}
