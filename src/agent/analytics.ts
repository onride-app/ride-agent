import {
  D,
  cash,
  now,
  pnl,
  fresh,
  fingerprint,
  type Portfolio,
  type Fill,
  type Sleeve,
} from "./domain.js";
import type { State } from "./repository.js";

export interface PerformancePoint {
  portfolio_id: string;
  at: number;
  revision: number;
  state: string;
  account_value_usdc: string;
  external_flows_usdc: string;
  net_profit_usdc: string | null;
  reconciliation: string;
  ledger_version: string;
  sleeves: {
    copy_id: string;
    trader_id: string;
    handle: string;
    net_profit_usdc: string | null;
    state: string;
  }[];
}
export interface Receipt {
  copy_id: string;
  fill: Fill;
  quantity: string;
  fee_usdc: string;
  realized_usdc: string;
  config: ReturnType<typeof configAt> | null;
}
export interface Decision {
  at: number;
  copy_id: string;
  key: string;
  source_revision: string;
  reason: string;
  config: ReturnType<typeof configAt>;
  source_quantity: string;
  target_quantity: string | null;
  source_entry_price: string | null;
  follower_mark: string;
  observation_episode?: { first_at: number; last_at: number; count: number };
}
export const configAt = (s: Sleeve) => ({
  trader_id: s.trader.id,
  amount_usdc: s.amount_usdc,
  leverage_cap: s.leverage_cap,
  ...(s.leverage_mode ? { leverage_mode: s.leverage_mode } : {}),
  stop_loss_pct: s.stop_loss_pct,
  copy_mode: s.copy_mode ?? "ride_recommends",
  fixed_margin_usdc: s.fixed_margin_usdc ?? null,
  proportional_multiplier: s.proportional_multiplier ?? 1,
  loss_policy: s.loss_policy ?? "exit",
  emergency_exit_pct: s.emergency_exit_pct ?? null,
});
export function recordConfigurations(p: Portfolio): void {
  const history = (p.configurations ??= []);
  for (const s of p.sleeves)
    history.push({ at: now(), copy_id: s.copy_id, config: configAt(s) });
}
export function recordPerformance(state: State, p: Portfolio): void {
  if (!p.snapshot || p.initial_equity == null) return;
  const stats = pnl(p);
  const points = (state.performance ??= []);
  const last = [...points].reverse().find((x) => x.portfolio_id === p.id);
  const at = p.snapshot.observed_at;
  // Store event changes as well as hourly marks; never recalculate past points.
  const point: PerformancePoint = {
    portfolio_id: p.id,
    at,
    revision: p.revision,
    state: p.state,
    account_value_usdc: p.snapshot.account_value_usdc,
    external_flows_usdc: stats.external_flows_usdc,
    net_profit_usdc: stats.net_usdc,
    reconciliation: p.reconciliation,
    ledger_version: fingerprint([
      p.seen_fills.length,
      p.seen_funding.length,
      p.seen_flows.length,
    ]),
    sleeves: p.sleeves.map((s) => ({
      copy_id: s.copy_id,
      trader_id: s.trader.id,
      handle: s.trader.handle,
      state: s.state,
      net_profit_usdc:
        stats.sleeves.find((x) => x.copy_id === s.copy_id)?.net_usdc ?? null,
    })),
  };
  if (
    !last ||
    (at >= last.at &&
      (at - last.at >= 3600_000 ||
        fingerprint([
          point.revision,
          point.state,
          point.reconciliation,
          point.ledger_version,
          point.sleeves.map((s) => s.state),
        ]) !==
          fingerprint([
            last.revision,
            last.state,
            last.reconciliation,
            last.ledger_version,
            last.sleeves.map((s) => s.state),
          ])))
  )
    points.push(point);
}
export function performanceView(state: State, p: Portfolio, period: string) {
  const end = p.snapshot?.observed_at ?? now();
  const start =
    period === "inception"
      ? (p.ledger_started_at ?? p.created_at)
      : end - (period === "daily" ? 1 : 7) * 86400_000;
  const all = (state.performance ?? [])
    .filter((x) => x.portfolio_id === p.id)
    .sort((a, b) => a.at - b.at);
  const baseline = [...all].reverse().find((x) => x.at <= start);
  const points = all.filter((x) => x.at >= start && x.at <= end);
  const last = [...all].reverse().find((x) => x.at <= end);
  const continuous =
    baseline &&
    last &&
    last.at - end >= -3600_000 &&
    baseline.at >= start - 3600_000 &&
    [baseline, ...points].every(
      (x, i, a) =>
        x.net_profit_usdc != null &&
        (i === 0 || x.at - a[i - 1].at <= 2 * 3600_000),
    );
  const covered = !!continuous && !!p.snapshot && fresh(p.snapshot.observed_at);
  return {
    portfolio_id: p.id,
    period,
    requested_window: { start_at: start, end_at: end },
    observed_window:
      baseline && last ? { start_at: baseline.at, end_at: last.at } : null,
    coverage: covered ? "complete" : "incomplete",
    net_profit_usdc: covered
      ? cash(D(last!.net_profit_usdc!).minus(baseline!.net_profit_usdc!))
      : null,
    inception_net_profit_usdc: pnl(p).net_usdc,
    recent_fills: (p.receipts ?? [])
      .filter((r) => r.fill.at >= start && r.fill.at < end)
      .slice(-40)
      .map((r) => ({
        copy_id: r.copy_id,
        trader:
          p.sleeves.find((s) => s.copy_id === r.copy_id)?.trader.handle ?? null,
        at: r.fill.at,
        asset: r.fill.key,
        quantity: r.quantity,
        price: r.fill.price,
        fee_usdc: r.fee_usdc,
        realized_usdc: r.realized_usdc,
      })),
    points: [
      ...new Map(
        points.map((x) => [new Date(x.at).toISOString().slice(0, 10), x]),
      ).values(),
    ].slice(-366),
    series_interval: "daily_UTC",
    full_snapshot_count: points.length,
    series_truncated:
      new Set(points.map((x) => new Date(x.at).toISOString().slice(0, 10)))
        .size > 366,
    missing_reason: covered
      ? null
      : "Verified accounting snapshots do not cover the entire requested window.",
  };
}
export function recordReceipt(
  p: Portfolio,
  fill: Fill,
  before: Sleeve[],
): void {
  const receipts = (p.receipts ??= []);
  for (const s of p.sleeves) {
    const old = before.find((x) => x.copy_id === s.copy_id)!;
    const quantity = D(s.lots[fill.key]?.quantity ?? 0).minus(
      old.lots[fill.key]?.quantity ?? 0,
    );
    if (quantity.isZero()) continue;
    receipts.push({
      copy_id: s.copy_id,
      fill: structuredClone(fill),
      quantity: quantity.toString(),
      fee_usdc: D(s.lots[fill.key].fees)
        .minus(old.lots[fill.key]?.fees ?? 0)
        .toString(),
      realized_usdc: D(s.lots[fill.key].realized)
        .minus(old.lots[fill.key]?.realized ?? 0)
        .toString(),
      config:
        [...(p.configurations ?? [])]
          .reverse()
          .find((c) => c.copy_id === s.copy_id && c.at <= fill.at)?.config ??
        null,
    });
  }
}
export function recordDecision(
  p: Portfolio,
  s: Sleeve,
  x: {
    key: string;
    quantity: string;
    source_revision: string;
    source_entry_price: string | null;
    raw_source_quantity?: string;
  },
  mark: string,
  target: string | null,
  reason: string,
): void {
  const decisions = (p.decisions ??= []);
  const value: Decision = {
    at: now(),
    copy_id: s.copy_id,
    key: x.key,
    source_revision: x.source_revision,
    source_quantity: x.raw_source_quantity ?? x.quantity,
    target_quantity: target,
    source_entry_price: x.source_entry_price,
    follower_mark: mark,
    reason,
    config: configAt(s),
  };
  let previous: Decision | undefined;
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (
      d.copy_id === value.copy_id &&
      d.key === value.key &&
      d.reason !== "__cold_history_guard"
    ) {
      previous = d;
      break;
    }
  }
  if (previous) {
    const {
      at: _oldAt,
      observation_episode: _episode,
      ...oldBusiness
    } = previous;
    const { at: _newAt, ...newBusiness } = value;
    if (fingerprint(oldBusiness) === fingerprint(newBusiness)) {
      previous.observation_episode = {
        first_at: previous.observation_episode?.first_at ?? previous.at,
        last_at: value.at,
        count: (previous.observation_episode?.count ?? 1) + 1,
      };
      return;
    }
  }
  decisions.push(value);
}
export function localDay(
  at: number,
  timezone: string,
): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    day: `${v.year}-${v.month}-${v.day}`,
    time: `${v.hour}:${v.minute}`,
  };
}
