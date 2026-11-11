import { createHash } from "node:crypto";
import { isIPv4 } from "node:net";
import { hash64 } from "./dual-egress-contract.js";
import { sharedVenueReadBudget, VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";

export type PhysicalBankMetadata = Readonly<{
  account_bank_id: string;
  gateway_bank_id: string;
  account_ipv4: readonly string[];
  gateway_ipv4: readonly string[];
}>;

/** Local ledgers only. Runtime/physical authority is checked before use by V3. */
export class PhysicalVenueBudgetRegistry {
  private banks = new Map<string, { ipDigest: string; budget: VenueReadBudget }>();
  private ipOwners = new Map<string, string>();
  constructor(private options: { accountBudget?: VenueReadBudget; clock?: () => number; timers?: BudgetTimers } = {}) {}
  register(metadata: PhysicalBankMetadata): { account: VenueReadBudget; gateway: VenueReadBudget } {
    if (!hash64(metadata.account_bank_id) || !hash64(metadata.gateway_bank_id) || metadata.account_bank_id === metadata.gateway_bank_id ||
      [metadata.account_ipv4, metadata.gateway_ipv4].some((ips) => !ips.length || ips.length > 256 || new Set(ips).size !== ips.length || ips.some((ip) => !isIPv4(ip))) ||
      metadata.gateway_ipv4.some((ip) => metadata.account_ipv4.includes(ip)))
      throw new Error("Physical venue banks are not disjoint");
    const get = (id: string, ips: readonly string[], account: boolean) => {
      if (ips.some((ip) => this.ipOwners.has(ip) && this.ipOwners.get(ip) !== id))
        throw new Error("A retired or live physical IP cannot be reassigned to a fresh bank");
      const ipDigest = createHash("sha256").update(JSON.stringify([...ips].sort())).digest("hex");
      const previous = this.banks.get(id);
      if (previous) {
        // Metadata validates the stable ID; it is NEVER part of the fee key.
        // A changed mapping requires external drain/cold proof and a new
        // process, not an empty in-process ledger under a composite key.
        if (previous.ipDigest !== ipDigest) throw new Error("Physical bank mapping changed without drain");
        return previous.budget;
      }
      if (this.banks.size >= 16) throw new Error("Physical venue bank registry is full");
      const budget = account ? this.options.accountBudget ?? sharedVenueReadBudget : new VenueReadBudget({ limit: 1000, clock: this.options.clock, timers: this.options.timers });
      if (budget.limit !== 1000 || [...this.banks.values()].some((entry) => entry.budget === budget))
        throw new Error("A physical bank cannot alias another local ledger");
      this.banks.set(id, { ipDigest, budget });
      for (const ip of ips) this.ipOwners.set(ip, id);
      return budget;
    };
    return { account: get(metadata.account_bank_id, metadata.account_ipv4, true), gateway: get(metadata.gateway_bank_id, metadata.gateway_ipv4, false) };
  }
}
const physicalVenueBudgets = new PhysicalVenueBudgetRegistry();
export function sharedPhysicalVenueBudgets(metadata: PhysicalBankMetadata) {
  return physicalVenueBudgets.register(metadata);
}
