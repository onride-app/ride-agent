import { AgentError } from "./contracts.js";
import {
  D,
  cash,
  fingerprint,
  manualHandoff,
  manualQuantity,
  type Portfolio,
  type Lot,
  type Fill,
  type Funding,
  type ManualFill,
  type ManualOwnershipTransfer,
} from "./domain.js";

function trade(l: Lot, q: string, px: string): void {
  const old = D(l.quantity),
    delta = D(q),
    price = D(px);
  if (delta.isZero()) return;
  const closes = !old.isZero() && old.isPositive() !== delta.isPositive();
  const closed = closes ? D.min(old.abs(), delta.abs()) : D(0);
  const avg = old.isZero() ? D(0) : D(l.cost).div(old);
  l.realized = D(l.realized)
    .plus(closed.times(price.minus(avg)).times(old.isPositive() ? 1 : -1))
    .toString();
  const next = old.plus(delta);
  l.cost = (
    closes
      ? next.isZero()
        ? D(0)
        : next.isPositive() === old.isPositive()
          ? next.times(avg)
          : next.times(price)
      : D(l.cost).plus(delta.times(price))
  ).toString();
  l.quantity = next.toString();
}
export const MANUAL_LEDGER_OWNER = "manual";

/** Transfer virtual ownership at Core's immutable observed mark, without a venue fill. */
export function applyManualHandoffs(p: Portfolio): ManualOwnershipTransfer[] {
  const markers = p.snapshot?.manual_markets ?? [];
  if (
    p.manual_ledger?.transfers.some(
      (transfer) =>
        !markers.some(
          (marker) => fingerprint(marker) === fingerprint(transfer.handoff),
        ),
    )
  )
    throw new AgentError(
      "HANDOFF_CHANGED",
      "A recorded manual ownership handoff is missing or changed.",
    );
  const pending = markers.filter(
    (marker) =>
      !p.manual_ledger?.transfers.some(
        (transfer) => transfer.handoff.handoff_id === marker.handoff_id,
      ),
  );
  if (!pending.length) return [];
  if (!p.snapshot?.coverage_complete)
    throw new AgentError(
      "HANDOFF_PENDING",
      "Complete account history is required before ownership transfer.",
      true,
    );
  // Validate every handoff before mutating any lot. Unknown submissions keep
  // their stable IDs and must be recovered through the read-only Core lookup.
  for (const marker of pending) {
    const key = `perps:${marker.coin}`;
    if (
      p.executions.some(
        (e) =>
          e.key === key &&
          !["completed", "failed", "superseded"].includes(e.status),
      )
    )
      throw new AgentError(
        "HANDOFF_PENDING",
        "An owned execution still requires reconciliation before handoff.",
        true,
      );
    const owned = p.sleeves.reduce(
      (n, s) => n.plus(s.lots[key]?.quantity ?? 0),
      D(0),
    );
    if (
      !owned.eq(marker.signed_size) ||
      p.snapshot.fills.some(
        (fill) => fill.key === key && fill.at >= marker.at_ms,
      ) ||
      p.snapshot.funding.some(
        (event) => event.key === key && event.at === marker.at_ms,
      )
    )
      throw new AgentError(
        "HANDOFF_MISMATCH",
        "The immutable handoff boundary does not match verified owned history.",
      );
  }
  const ledger = (p.manual_ledger ??= {
    lots: {},
    seen_fills: [],
    transfers: [],
  });
  const transfers: ManualOwnershipTransfer[] = [];
  for (const marker of pending.sort(
    (a, b) => a.at_ms - b.at_ms || a.handoff_id.localeCompare(b.handoff_id),
  )) {
    const key = `perps:${marker.coin}`;
    const transfer: ManualOwnershipTransfer = {
      handoff: structuredClone(marker),
      quantities: {},
      realized_usdc: {},
    };
    for (const sleeve of p.sleeves) {
      const owned = sleeve.lots[key];
      if (owned) {
        transfer.quantities[sleeve.copy_id] = owned.quantity;
        const before = D(owned.realized);
        trade(owned, D(owned.quantity).neg().toString(), marker.mark_px);
        transfer.realized_usdc[sleeve.copy_id] = D(owned.realized)
          .minus(before)
          .toString();
      }
      if (sleeve.intents[key]) sleeve.intents[key].quantity = "0";
      if (sleeve.fixed_targets?.[key] != null) sleeve.fixed_targets[key] = "0";
    }
    ledger.lots[key] = {
      key,
      asset: marker.coin,
      market: "perps",
      quantity: marker.signed_size,
      cost: D(marker.signed_size).times(marker.mark_px).toString(),
      realized: "0",
      fees: "0",
      funding: "0",
    };
    ledger.transfers.push(transfer);
    transfers.push(transfer);
  }
  return transfers;
}

export function applyManualFill(p: Portfolio, fill: ManualFill): void {
  const marker = manualHandoff(p, fill.key),
    ledger = p.manual_ledger;
  if (
    !marker ||
    !ledger ||
    marker.handoff_id !== fill.handoff_id ||
    fill.at <= marker.at_ms
  )
    throw new AgentError(
      "UNOWNED_FILL",
      "A manual fill requires an exact earlier ownership handoff.",
    );
  if (ledger.seen_fills.includes(fill.id)) return;
  if (p.seen_fills.includes(fill.id))
    throw new AgentError(
      "FILL_MISMATCH",
      "A fill cannot have both copy and manual ownership.",
    );
  const l = ledger.lots[fill.key];
  trade(l, fill.quantity, fill.price);
  l.fees = D(l.fees).plus(fill.fee_usdc).toString();
  ledger.seen_fills.push(fill.id);
}
function lot(p: Portfolio, sleeveId: string, key: string): Lot {
  const s = p.sleeves.find((x) => x.copy_id === sleeveId);
  if (!s) throw new AgentError("LEDGER_OWNER", "Unknown sleeve owner.");
  const intent = s.intents[key],
    existing = s.lots[key];
  if (existing) return existing;
  if (!intent)
    throw new AgentError("LEDGER_OWNER", "An owned intent is required.");
  return (s.lots[key] = {
    key,
    asset: intent.asset,
    market: intent.market,
    quantity: "0",
    cost: "0",
    realized: "0",
    fees: "0",
    funding: "0",
  });
}
// Internal crosses settle virtual sleeve transfers at the same observed mark.
// Their quantities sum to zero, and their combined PnL is conserved.
export function internalCross(
  p: Portfolio,
  key: string,
  price: string,
): Record<string, string> {
  const deltas = p.sleeves.map((s) => ({
    id: s.copy_id,
    q: D(s.intents[key]?.quantity ?? 0).minus(s.lots[key]?.quantity ?? 0),
  }));
  const buys = deltas.filter((x) => x.q.gt(0)),
    sells = deltas.filter((x) => x.q.lt(0));
  for (const buy of buys)
    for (const sell of sells) {
      const q = D.min(buy.q, sell.q.neg());
      if (q.isZero()) continue;
      trade(lot(p, buy.id, key), q.toString(), price);
      trade(lot(p, sell.id, key), q.neg().toString(), price);
      buy.q = buy.q.minus(q);
      sell.q = sell.q.plus(q);
    }
  return Object.fromEntries(
    deltas.filter((x) => !x.q.isZero()).map((x) => [x.id, x.q.toString()]),
  );
}
export function applyFill(p: Portfolio, fill: Fill): void {
  if (p.seen_fills.includes(fill.id)) return;
  if (manualHandoff(p, fill.key))
    throw new AgentError(
      "HANDOFF_HISTORY_CHANGED",
      "Previously unseen copy history arrived after a verified manual transfer.",
    );
  const e = p.executions.find(
    (x) => x.task_id === fill.task_id && x.key === fill.key,
  );
  if (!e)
    throw new AgentError(
      "UNOWNED_FILL",
      "Exchange fill has no owned execution.",
    );
  const entries = Object.entries(e.allocations).filter(
      ([, q]) => !D(q).isZero(),
    ),
    total = entries.reduce((n, [, q]) => n.plus(q), D(0));
  const q = D(fill.quantity);
  if (
    total.isZero() ||
    q.isZero() ||
    q.isPositive() !== total.isPositive() ||
    entries.some(
      ([, allocation]) => D(allocation).isPositive() !== q.isPositive(),
    ) ||
    q.abs().gt(total.abs())
  )
    throw new AgentError(
      "FILL_MISMATCH",
      "Fill exceeds the unsettled owned execution.",
    );
  let remaining = q,
    feeRemaining = D(fill.fee_usdc);
  // Keep virtual ownership on the venue's quantity grid. A repeating decimal
  // share otherwise leaves the owned sum unequal to an exact exchange position.
  const decimals = Math.max(
    p.snapshot?.quantity_decimals?.[fill.key] ?? 8,
    q.decimalPlaces(),
    ...entries.map(([, allocation]) => D(allocation).decimalPlaces()),
  );
  for (let i = 0; i < entries.length; i++) {
    const [sid, remainingQ] = entries[i],
      last = i === entries.length - 1;
    const laterCapacity = entries
      .slice(i + 1)
      .reduce((n, [, allocation]) => n.plus(D(allocation).abs()), D(0));
    const proportional = q
      .abs()
      .times(D(remainingQ).abs())
      .div(total.abs())
      .toDecimalPlaces(decimals, 1);
    const minimum = D.max(0, remaining.abs().minus(laterCapacity));
    const part = last
      ? remaining
      : D.min(D(remainingQ).abs(), D.max(proportional, minimum)).times(
          q.isPositive() ? 1 : -1,
        );
    const fee = last ? feeRemaining : D(fill.fee_usdc).times(part.div(q));
    const l = lot(p, sid, fill.key);
    trade(l, part.toString(), fill.price);
    l.fees = D(l.fees).plus(fee).toString();
    e.allocations[sid] = D(remainingQ).minus(part).toString();
    remaining = remaining.minus(part);
    feeRemaining = feeRemaining.minus(fee);
  }
  p.seen_fills.push(fill.id);
}
export function applyFunding(
  p: Portfolio,
  event: Funding,
  holdings: Record<string, string>,
): void {
  if (p.seen_funding.includes(event.id)) return;
  const total = Object.values(holdings).reduce((n, q) => n.plus(q), D(0));
  if (total.isZero() && !D(event.amount_usdc).isZero())
    throw new AgentError(
      "FUNDING_MISMATCH",
      "Funding has no verified historical owned position.",
    );
  const entries = Object.entries(holdings).filter(([, q]) => !D(q).isZero());
  if (total.isZero() && D(event.amount_usdc).isZero()) {
    p.seen_funding.push(event.id);
    return;
  }
  let remaining = D(event.amount_usdc);
  for (let i = 0; i < entries.length; i++) {
    const [sid, q] = entries[i];
    const share =
      i === entries.length - 1
        ? remaining
        : D(event.amount_usdc).times(D(q).div(total));
    const l =
      sid === MANUAL_LEDGER_OWNER
        ? p.manual_ledger?.lots[event.key]
        : lot(p, sid, event.key);
    if (!l)
      throw new AgentError(
        "FUNDING_MISMATCH",
        "Historical manual ownership is unavailable.",
      );
    l.funding = D(l.funding).plus(share).toString();
    remaining = remaining.minus(share);
  }
  p.seen_funding.push(event.id);
}
export function reconcileQuantities(p: Portfolio): boolean {
  if (!p.snapshot?.coverage_complete) return false;
  const keys = new Set([
    ...Object.keys(p.snapshot.positions),
    ...p.sleeves.flatMap((s) => Object.keys(s.lots)),
    ...Object.keys(p.manual_ledger?.lots ?? {}),
  ]);
  for (const key of keys) {
    const actual = p.sleeves.reduce(
      (n, s) => n.plus(s.lots[key]?.quantity ?? 0),
      D(0),
    );
    if (!actual.plus(manualQuantity(p, key)).eq(p.snapshot.positions[key] ?? 0))
      return false;
  }
  return true;
}
