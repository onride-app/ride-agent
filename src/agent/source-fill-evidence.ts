import type { SourceFill, SourceSnapshot } from "./adapter.js";
import { AgentError } from "./contracts.js";
import { D, fingerprint } from "./domain.js";

function missing(message: string): never {
  throw new AgentError("SOURCE_FILL_EVIDENCE_MISSING", message, true);
}

// These identities are defined by Hyperliquid's Info / Asset IDs contracts.
// Bare Perps symbols are not restricted to today's meta or open positions:
// a fully closed or delisted position still needs its historical evidence.
const nativeCoin = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const scopedCoin = /^([a-z][a-z0-9_-]*):([A-Za-z0-9][A-Za-z0-9._-]*)$/;
export function inObservedPerpsScope(
  coin: unknown,
  dexes: readonly string[],
): boolean {
  if (typeof coin !== "string" || !coin.length)
    return missing("Source fill market identity is missing.");
  if (coin === "PURR/USDC" || /^@(0|[1-9][0-9]*)$/.test(coin)) return false;
  if (nativeCoin.test(coin)) return dexes.includes("");
  const scoped = scopedCoin.exec(coin);
  if (scoped) return dexes.includes(scoped[1]);
  return missing("Source fill market identity is unsupported or malformed.");
}

function decimal(value: unknown, label: string) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "string" && !value.length)
  )
    return missing(`Source fill ${label} is missing.`);
  try {
    const number = D(value);
    if (!number.isFinite()) return missing(`Source fill ${label} is invalid.`);
    return number;
  } catch {
    return missing(`Source fill ${label} is invalid.`);
  }
}

export function scopedSourceFills(
  events: any[],
  trader: string,
  dexes: readonly string[],
  start: number,
  end: number,
): SourceFill[] {
  if (
    !dexes.includes("") ||
    new Set(dexes).size !== dexes.length ||
    dexes.some(
      (dex) =>
        typeof dex !== "string" ||
        (dex !== "" && !/^[a-z][a-z0-9_-]*$/.test(dex)),
    )
  )
    return missing("Observed Perps source scopes are unavailable.");
  const fills: SourceFill[] = [];
  for (const event of events) {
    // Validate identity/time before filtering: malformed evidence must never
    // disappear from a response subsequently advertised as complete.
    if (!event || !Number.isSafeInteger(event.time) || event.time < 0)
      return missing("Source fill timestamp is invalid.");
    const included = inObservedPerpsScope(event.coin, dexes);
    if (event.time < start || event.time >= end || !included) continue;
    if (
      !Number.isSafeInteger(event.tid) ||
      event.tid < 0 ||
      !Number.isSafeInteger(event.oid) ||
      event.oid < 0 ||
      !["B", "A"].includes(event.side)
    )
      return missing("Source fill identity or side is invalid.");
    const size = decimal(event.sz, "size"),
      price = decimal(event.px, "price");
    if (!size.isPositive() || !price.isPositive())
      return missing("Source fill size or price is invalid.");
    fills.push({
      id: `source_${fingerprint([trader, event.tid, event.oid]).slice(0, 32)}`,
      key: `perps:${event.coin}`,
      start_quantity: decimal(
        event.startPosition,
        "pre-trade position",
      ).toString(),
      quantity: size.times(event.side === "B" ? 1 : -1).toString(),
      price: price.toString(),
      fee_usdc:
        event.feeToken === "USDC" ? decimal(event.fee, "fee").toString() : null,
      realized_usdc:
        event.closedPnl == null
          ? null
          : decimal(event.closedPnl, "realized PnL").toString(),
      at: event.time,
    });
  }
  return fills;
}

// A millisecond and an opaque fill ID do not establish execution order. Work
// backwards from the complete current position and require one continuous,
// unambiguous start -> end chain in each timestamp bucket. Different assets
// are independent; their deterministic presentation order is not chronology.
export function orderedSourceFills(
  fills: SourceFill[],
  source: SourceSnapshot,
  start: number,
  end: number,
  prior: Record<string, string>,
  seen: readonly string[],
): SourceFill[] {
  const identities = new Map<string, SourceFill>();
  const groups = new Map<string, Map<number, SourceFill[]>>();
  const seenIds = new Set(seen);
  const currentPositions = new Map<string, string>();
  for (const position of source.positions) {
    if (currentPositions.has(position.key))
      return missing("Source position is ambiguous.");
    currentPositions.set(position.key, position.quantity);
  }
  for (const fill of fills) {
    if (
      !fill ||
      typeof fill.id !== "string" ||
      !fill.id.length ||
      typeof fill.key !== "string" ||
      !fill.key.startsWith("perps:") ||
      !Number.isSafeInteger(fill.at) ||
      fill.at < start ||
      fill.at >= end
    )
      return missing("Source fill identity or timestamp is invalid.");
    const coin = fill.key.slice("perps:".length);
    if (!inObservedPerpsScope(coin, ["", coin.split(":")[0]]))
      return missing("Source fill is not an observed Perps identity.");
    decimal(fill.start_quantity, "pre-trade position");
    if (decimal(fill.quantity, "quantity").isZero())
      return missing("Source fill quantity is zero.");
    if (!decimal(fill.price, "price").isPositive())
      return missing("Source fill price is invalid.");
    const duplicate = identities.get(fill.id);
    if (duplicate) {
      if (
        [
          "key",
          "at",
          "start_quantity",
          "quantity",
          "price",
          "fee_usdc",
          "realized_usdc",
        ].some(
          (field) =>
            duplicate[field as keyof SourceFill] !==
            fill[field as keyof SourceFill],
        )
      )
        return missing("Source fill identity has conflicting evidence.");
      continue;
    }
    identities.set(fill.id, fill);
    if (seenIds.has(fill.id)) continue;
    let times = groups.get(fill.key);
    if (!times) groups.set(fill.key, (times = new Map()));
    const bucket = times.get(fill.at) ?? [];
    bucket.push(fill);
    times.set(fill.at, bucket);
  }
  const ordered: SourceFill[] = [];
  for (const [key, times] of groups) {
    let expected = decimal(
      currentPositions.get(key) ?? "0",
      "current position",
    );
    const backwards: SourceFill[] = [];
    for (const at of [...times.keys()].sort((a, b) => b - a)) {
      const bucket = times.get(at)!;
      const endings = new Map<string, SourceFill[]>();
      for (const fill of bucket) {
        const terminal = D(fill.start_quantity!).plus(fill.quantity).toString();
        const matches = endings.get(terminal) ?? [];
        matches.push(fill);
        endings.set(terminal, matches);
      }
      // Revisited quantities in a same-time cycle cannot prove chronology.
      const visited = new Set<string>();
      for (let left = bucket.length; left > 0; left--) {
        const quantity = expected.toString();
        if (visited.has(quantity))
          return missing("Source fill sequence is cyclic.");
        visited.add(quantity);
        const matches = endings.get(quantity);
        if (matches?.length !== 1)
          return missing("Source fill sequence is incomplete or ambiguous.");
        const fill = matches[0];
        endings.delete(quantity);
        backwards.push(fill);
        expected = D(fill.start_quantity!);
      }
      if (visited.has(expected.toString()))
        return missing("Source fill sequence is cyclic.");
    }
    if (
      Object.hasOwn(prior, key) &&
      !expected.eq(decimal(prior[key], "prior position"))
    )
      return missing(
        "Source fills do not connect to the verified prior position.",
      );
    for (const fill of backwards.reverse()) ordered.push(fill);
  }
  // Stable sort preserves the proven within-key order at equal timestamps.
  return ordered.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}
