import { createHash } from "node:crypto";
import { costPlanUnavailable } from "./account-observation-plans.js";
import { VenueReadBudget, type SourceCapacityReservation, type SourceReadReservation } from "./venue-read-budget.js";

export type SourceReservationPlan = Readonly<{ sourceWeight: number; historyWeights: Readonly<Record<string, number>> }>;

/** Source/history capacity on the REAL gateway bank, never an A child/plan. */
export class SourceReservation {
  private capacity: SourceCapacityReservation;
  private history = new Map<string, string>();
  readonly weight: number;
  readonly plan: SourceReservationPlan;
  constructor(
    readonly budget: VenueReadBudget,
    sourcePlan: SourceReservationPlan,
    leaseRemainingMs: number,
    recordNeed: (source: string | undefined, weight: number) => void,
  ) {
    const plan = this.plan = Object.freeze({ sourceWeight: sourcePlan.sourceWeight, historyWeights: Object.freeze({ ...sourcePlan.historyWeights }) });
    const pools: Record<string, number> = {};
    if (plan.sourceWeight > 0) pools.s = plan.sourceWeight;
    for (const [source, weight] of Object.entries(plan.historyWeights)) {
      const key = "h:" + createHash("sha256").update(source).digest("hex");
      this.history.set(source, key);
      pools[key] = weight;
    }
    this.weight = Object.values(pools).reduce((sum, weight) => sum + weight, 0);
    this.capacity = budget.beginSourceCapacity(pools, leaseRemainingMs, (key, weight) => {
      if (key === "s") recordNeed(undefined, weight);
      else {
        const source = [...this.history].find(([, pool]) => pool === key)?.[0];
        if (source === undefined) throw costPlanUnavailable();
        recordNeed(source, weight);
      }
    });
  }
  source(): SourceReadReservation { return this.capacity.open("s"); }
  fills(source: string): SourceReadReservation {
    const pool = this.history.get(source);
    if (!pool) throw costPlanUnavailable();
    return this.capacity.open(pool);
  }
  close(complete = false): void { this.capacity.close(complete); }
}
