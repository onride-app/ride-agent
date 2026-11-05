import { AgentError } from "./contracts.js";
import { D, cash } from "./domain.js";

// The current userAbstraction enum includes DEX abstraction itself. A missing
// legacy boolean, unknown enum, or successful HTTP status is not disabled proof.
export function perpsAbstractionState(
  value: unknown,
): "standard" | "unified" | "dex_abstraction" | "portfolio_margin" | "unknown" {
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    const states = ["abstraction", "userAbstraction", "mode", "response"]
      .filter((key) => Object.hasOwn(row, key))
      .map((key) => perpsAbstractionState(row[key]));
    return states.length && states.every((state) => state === states[0])
      ? states[0]
      : "unknown";
  }
  const mode = typeof value === "string" ? value.toLowerCase() : "";
  if (["disabled", "default"].includes(mode)) return "standard";
  if (["unifiedaccount", "unified", "u"].includes(mode)) return "unified";
  if (mode === "dexabstraction") return "dex_abstraction";
  if (mode === "portfoliomargin") return "portfolio_margin";
  return "unknown";
}

export function perpsAccountMode(
  value: unknown,
): "standard" | "unified" | "unsupported" {
  const state = perpsAbstractionState(value);
  return state === "standard" || state === "unified" ? state : "unsupported";
}

// Unified accounts report the single USDC balance and all holds in spot state.
// Per-DEX equity must never be added to this balance.
export function unifiedUsdc(state: any): { equity: string; available: string } {
  try {
    if (!Array.isArray(state?.balances)) throw Error();
    const rows = state.balances.filter((row: any) => row.coin === "USDC");
    if (rows.length !== 1 || rows[0].token !== 0) throw Error();
    const { total, hold } = rows[0];
    if (typeof total !== "string" || typeof hold !== "string") throw Error();
    const equity = D(total),
      reserve = D(hold);
    if (
      !equity.isFinite() ||
      !reserve.isFinite() ||
      equity.lt(0) ||
      reserve.lt(0) ||
      reserve.gt(equity)
    )
      throw Error();
    return { equity: cash(equity), available: cash(equity.minus(reserve)) };
  } catch {
    throw new AgentError(
      "ACCOUNT_STALE",
      "Unified account USDC balance or holds could not be verified.",
      true,
    );
  }
}
