import { AgentError } from "./contracts.js";
import {
  D,
  maximumUserLeverage,
  minimumAllocation,
  recommendedLeverage,
  type Plan,
} from "./domain.js";
import { validateCopySettings } from "./conversational.js";

// Reselect traders, not capital or approved controls. Retained traders stay in
// their original slots; new traders inherit vacated slots in original order.
export function inheritReselectedSlots(previous: Plan, next: Plan): void {
  if (next.allocations.length !== previous.allocations.length)
    throw new AgentError(
      "RESELECT_SETTINGS_CONFLICT",
      "The original trader count cannot be preserved.",
    );
  const selected = new Map(next.allocations.map((a) => [a.trader.id, a]));
  const previousIds = new Set(previous.allocations.map((a) => a.trader.id));
  const incoming = next.allocations.filter(
    (a) => !previousIds.has(a.trader.id),
  );
  const total = previous.allocations.reduce(
    (n, a) => n.plus(a.amount_usdc),
    D(0),
  );
  if (total.gt(next.preferences.budget_usdc))
    throw new AgentError(
      "RESELECT_SETTINGS_CONFLICT",
      "The original allocation exceeds the requested budget.",
    );
  next.allocations = previous.allocations.map((slot) => {
    const choice = selected.get(slot.trader.id) ?? incoming.shift();
    if (!choice || choice.trader.market !== slot.trader.market)
      throw new AgentError(
        "RESELECT_SETTINGS_CONFLICT",
        "A new trader cannot inherit the original market slot.",
      );
    const mode = slot.leverage_mode ?? "cap";
    const cap =
      mode === "custom_cap"
        ? maximumUserLeverage(choice.trader)
        : recommendedLeverage(next.preferences, choice.trader, mode);
    if (
      cap == null ||
      (slot.leverage_cap == null
        ? mode !== "follow_source"
        : slot.leverage_cap > cap) ||
      (choice.trader.market === "prediction" && slot.leverage_cap !== 1) ||
      D(slot.amount_usdc).lt(
        minimumAllocation(next.preferences, choice.trader),
      ) ||
      (next.allocations.length > 1 &&
        D(slot.amount_usdc).gt(total.times("0.55")))
    )
      throw new AgentError(
        "RESELECT_SETTINGS_CONFLICT",
        "A new trader cannot use the original amount or leverage settings. The original plan was preserved.",
      );
    const allocation = {
      ...structuredClone(slot),
      copy_id: choice.copy_id,
      trader: structuredClone(choice.trader),
      leverage_cap_source: "inherited" as const,
      leverage_cap_inherited_from_plan_id: previous.id,
    };
    validateCopySettings(allocation);
    return allocation;
  });
  if (next.risk_selection) {
    const byId = new Map(
      next.risk_selection.selected.map((row) => [row.trader_id, row]),
    );
    next.risk_selection.selected = next.allocations.map((a) =>
      byId.get(a.trader.id)!,
    );
  }
  next.previous_plan_id = previous.id;
}
