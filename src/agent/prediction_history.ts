import { unzipSync, strFromU8 } from "fflate";
import { D, now, type Candidate } from "./domain.js";
import {
  Gate,
  type PredictionEquityHistory,
} from "./prediction_equity_history.js";

const DAY = 86_400_000;
const BASIS = "polymarket_economic_nav_1m_daily_cashflow_adjusted_v1";
export type Metrics = Pick<
  Candidate,
  | "source_roi_pct"
  | "source_drawdown_pct"
  | "metric_window"
  | "metric_provenance"
  | "metric_unavailable_reason"
>;
export interface EquityHistoryRecord {
  version: 2;
  computed_at: number;
  refresh_at: number;
  metrics: Metrics;
  evidence: unknown;
}
export interface EquityHistoryOptions {
  loader: Pick<PredictionEquityHistory, "load">;
  key(wallet: string): string;
  read(key: string): Promise<EquityHistoryRecord | null>;
  write(key: string, record: EquityHistoryRecord): Promise<void>;
}
type Flow = {
  timestamp: number;
  type: "DEPOSIT" | "WITHDRAWAL";
  usdc_size: number;
  proxy_wallet: string;
};
const validNumber = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x);
function requireData(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
function sameWallet(a: unknown, b: string) {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

export function accountingEquity(zip: Uint8Array) {
  const files = unzipSync(zip, {
    filter: (f) => {
      if (f.name !== "equity.csv") return false;
      requireData(
        f.originalSize > 0 && f.originalSize <= 4096,
        "invalid_equity_snapshot",
      );
      return true;
    },
  });
  requireData(files["equity.csv"], "invalid_equity_snapshot");
  const lines = strFromU8(files["equity.csv"]).trim().split(/\r?\n/);
  requireData(
    lines.length === 2 &&
      lines[0] === "cashBalance,positionsValue,equity,valuationTime",
    "invalid_equity_snapshot",
  );
  const fields = lines[1].split(",");
  requireData(
    fields.length === 4 &&
      fields.slice(0, 3).every((x) => /^\d+(\.\d+)?$/.test(x)),
    "invalid_equity_snapshot",
  );
  const [cash, positions, equity] = fields.slice(0, 3).map((x) => D(x));
  const at = Date.parse(fields[3]);
  requireData(
    Number.isFinite(at) &&
      equity.gt(0) &&
      cash.plus(positions).minus(equity).abs().lte("0.000002"),
    "invalid_equity_snapshot",
  );
  return { equity, at };
}

// The PnL endpoint currently leaves cumulative funding null. Its separately
// paginated DEPOSIT/WITHDRAWAL ledger supplies the missing capital, from genesis.
// PnL alone (or PnL / current balance) is never treated as an equity return.
export function predictionMetrics(
  wallet: string,
  series: any,
  flows: Flow[],
  snapshot: ReturnType<typeof accountingEquity>,
  at: number,
): Metrics {
  requireData(
    sameWallet(series?.proxy_wallet, wallet) &&
      series.interval === "1m" &&
      series.fidelity === "1d" &&
      series.source_fidelity === "1d",
    "invalid_history_identity",
  );
  const points: any[] = series.points;
  requireData(
    Array.isArray(points) && points.length >= 29 && points.length <= 33,
    "insufficient_history",
  );
  requireData(
    snapshot.at <= at + 60_000 && at - snapshot.at <= 5 * 60_000,
    "stale_equity_snapshot",
  );
  let priorTime = 0,
    priorBlock = 0;
  for (const p of points) {
    requireData(
      Number.isSafeInteger(p.timestamp) &&
        p.timestamp > priorTime &&
        Number.isSafeInteger(p.source_block) &&
        p.source_block > priorBlock &&
        p.source_block > 0,
      "invalid_or_carried_history_observation",
    );
    requireData(
      !priorTime || (p.timestamp - priorTime) * 1000 <= 26 * 3_600_000,
      "history_gap",
    );
    requireData(validNumber(p.economic_pnl), "missing_economic_pnl");
    // Cross-check the source composition; do not substitute zero for an atom.
    requireData(
      validNumber(p.position_pnl) &&
        validNumber(p.wallet_income) &&
        D(p.position_pnl)
          .plus(p.wallet_income)
          .minus(p.economic_pnl)
          .abs()
          .lte("0.000002"),
      "invalid_pnl_composition",
    );
    priorTime = p.timestamp;
    priorBlock = p.source_block;
  }
  const first = points[0],
    last = points.at(-1)!;
  requireData(
    snapshot.at >= last.timestamp * 1000,
    "equity_snapshot_precedes_history",
  );
  requireData(
    last.timestamp * 1000 <= at + 60_000 &&
      at - last.timestamp * 1000 <= 36 * 3_600_000 &&
      (last.timestamp - first.timestamp) * 1000 >= 28 * DAY &&
      at - first.timestamp * 1000 <= 32 * DAY,
    "stale_or_short_history",
  );
  const ordered = [...flows].sort((a, b) => a.timestamp - b.timestamp);
  requireData(
    ordered.length > 0 &&
      ordered.some(
        (f) =>
          f.type === "DEPOSIT" &&
          f.timestamp <= first.timestamp &&
          f.usdc_size > 0,
      ),
    "missing_initial_capital",
  );
  for (const f of ordered) {
    requireData(
      sameWallet(f.proxy_wallet, wallet) &&
        (f.type === "DEPOSIT" || f.type === "WITHDRAWAL") &&
        Number.isSafeInteger(f.timestamp) &&
        f.timestamp > 0 &&
        f.timestamp * 1000 <= at + 60_000 &&
        validNumber(f.usdc_size) &&
        f.usdc_size >= 0,
      "invalid_funding_ledger",
    );
  }
  let index = 0,
    deposits = D(0),
    withdrawals = D(0),
    nav = D(1),
    peak = D(1),
    drawdown = D(0);
  let previous: {
    equity: ReturnType<typeof D>;
    deposits: ReturnType<typeof D>;
    withdrawals: ReturnType<typeof D>;
  } | null = null;
  for (const p of points) {
    while (index < ordered.length && ordered[index].timestamp <= p.timestamp) {
      const f = ordered[index++];
      if (f.type === "DEPOSIT") deposits = deposits.plus(f.usdc_size);
      else withdrawals = withdrawals.plus(f.usdc_size);
    }
    for (const [field, computed] of [
      ["deposits", deposits],
      ["withdrawals", withdrawals],
      ["cashflow_net", deposits.minus(withdrawals)],
    ] as const) {
      requireData(
        p[field] == null ||
          (validNumber(p[field]) &&
            D(p[field]).minus(computed).abs().lte("0.01")),
        "conflicting_funding_sources",
      );
    }
    const equity = deposits.minus(withdrawals).plus(p.economic_pnl);
    requireData(equity.gt(0), "nonpositive_historical_equity");
    if (previous) {
      // Daily source observations cannot place returns around intraday flows.
      // Gross deposits go at the start and withdrawals at the end of the day;
      // retain this timing estimate explicitly in the metric provenance.
      nav = nav
        .times(equity.plus(withdrawals.minus(previous.withdrawals)))
        .div(previous.equity.plus(deposits.minus(previous.deposits)));
      peak = D.max(peak, nav);
      drawdown = D.max(drawdown, D(1).minus(nav.div(peak)));
    }
    previous = { equity, deposits, withdrawals };
  }
  // Independent current equity catches absent/partial ledgers and unaccounted
  // transfers. Daily marks can move since the last PnL point: allow at most 1%
  // reconciliation difference, disclose it, and reject larger discrepancies.
  let expectedCurrent = previous!.equity;
  for (const f of ordered
    .slice(index)
    .filter((f) => f.timestamp * 1000 <= snapshot.at))
    expectedCurrent = expectedCurrent.plus(
      f.type === "DEPOSIT" ? f.usdc_size : -f.usdc_size,
    );
  const difference = expectedCurrent
    .minus(snapshot.equity)
    .abs()
    .div(snapshot.equity)
    .times(100);
  requireData(difference.lte(1), "equity_reconciliation_failed");
  return {
    source_roi_pct: nav.minus(1).times(100).toNumber(),
    source_drawdown_pct: drawdown.times(100).toNumber(),
    metric_window: {
      start_at: first.timestamp * 1000,
      end_at: last.timestamp * 1000,
      basis: BASIS,
    },
    metric_provenance: {
      source: "polymarket_data_v2_and_accounting_snapshot",
      sampling: "daily",
      estimated: true,
      cashflow_adjusted: true,
      flow_timing: "deposits_at_start_withdrawals_at_end",
      reconciliation_difference_pct: difference.toNumber(),
    },
  };
}

export class PredictionHistory {
  private reconstructed = new Map<string, EquityHistoryRecord>();
  private hydrated = new Map<string, Promise<void>>();
  private reconstructing = new Map<string, Promise<void>>();
  private retries = new Map<string, { at: number; reason: string }>();
  private jobs = new Gate(2);
  constructor(private equity?: EquityHistoryOptions) {}
  async metrics(wallet: string): Promise<Metrics> {
    if (!this.equity) return this.nativeMetrics(wallet);
    const key = this.equity.key(wallet);
    let hydration = this.hydrated.get(key);
    if (!hydration) {
      hydration = this.equity
        .read(key)
        .then((record) => {
          if (record && this.validRecord(record))
            this.reconstructed.set(key, record);
        })
        .catch(() => {});
      this.hydrated.set(key, hydration);
    }
    await hydration;
    let record = this.reconstructed.get(key);
    if (record && !this.validRecord(record)) {
      this.reconstructed.delete(key);
      record = undefined;
    }
    if (record && record.refresh_at > now()) return record.metrics;
    const retry = this.retries.get(key);
    if (!this.reconstructing.has(key) && (!retry || retry.at <= now())) {
      const job = this.jobs
        .run(async () => {
          try {
            const result = await this.equity!.loader.load(wallet);
            const record: EquityHistoryRecord = {
              version: 2,
              computed_at: now(),
              refresh_at: now() + 3600_000,
              ...result,
            };
            if (!this.validRecord(record))
              throw new Error("invalid_reconstructed_metrics");
            this.reconstructed.set(key, record);
            await this.equity!.write(key, record);
            this.retries.delete(key);
          } catch (e) {
            this.retries.set(key, {
              at: now() + 5 * 60_000,
              reason:
                e instanceof Error && /^[a-z_]+$/.test(e.message)
                  ? e.message
                  : "equity_reconstruction_unavailable",
            });
          }
        })
        .finally(() => this.reconstructing.delete(key));
      this.reconstructing.set(key, job);
    }
    if (record) return record.metrics;
    // Keep the existing verified path available while bounded reconstruction
    // warms. Missing risk data never becomes zero or a smaller risk threshold.
    const fallback = await this.nativeMetrics(wallet);
    const completed = this.reconstructed.get(key);
    if (completed && this.validRecord(completed)) return completed.metrics;
    if (fallback.metric_window) return fallback;
    return {
      ...fallback,
      metric_unavailable_reason:
        this.retries.get(key)?.reason ??
        "equity_history_reconstruction_pending",
    };
  }
  private validRecord(r: EquityHistoryRecord) {
    const m = r.metrics,
      window = m?.metric_window;
    return (
      r.version === 2 &&
      Number.isFinite(r.computed_at) &&
      r.computed_at <= now() + 60_000 &&
      Number.isFinite(r.refresh_at) &&
      window?.basis === "polygon_inventory_nav_1m_daily_v2" &&
      window.end_at <= now() + 60_000 &&
      now() - window.end_at < 36 * 3600_000 &&
      window.end_at - window.start_at >= 28 * DAY &&
      validNumber(m.source_drawdown_pct) &&
      m.source_drawdown_pct >= 0 &&
      m.source_drawdown_pct <= 100 &&
      validNumber(m.source_roi_pct) &&
      m.source_roi_pct >= -100 &&
      m.metric_provenance?.source ===
        "polygon_transfers_and_polymarket_historical_marks"
    );
  }
  private async nativeMetrics(_wallet: string): Promise<Metrics> {
    // The accounting ZIP route retired with Data API v1. v2 position/PnL
    // responses are not equivalent accounting snapshots. Keep risk unavailable
    // while the existing independent Polygon reconstruction supplies evidence.
    return {
      source_roi_pct: null,
      source_drawdown_pct: null,
      metric_unavailable_reason: "accounting_snapshot_retired",
    };
  }
}
