import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import {
  accountingEquity,
  predictionMetrics,
  PredictionHistory,
} from "./prediction_history.js";
import { D } from "./domain.js";

const wallet = "0x0000000000000000000000000000000000000001";
const day = 86400,
  end = Date.UTC(2026, 9, 15) / 1000,
  start = end - 30 * day;
const at = end * 1000 + 60_000;
function history() {
  return {
    proxy_wallet: wallet,
    interval: "1m",
    fidelity: "1d",
    source_fidelity: "1d",
    points: Array.from({ length: 31 }, (_, i) => ({
      timestamp: start + i * day,
      source_block: 90000000 + i * 40000,
      economic_pnl: 0,
      position_pnl: 0,
      wallet_income: 0,
      deposits: null,
      withdrawals: null,
      cashflow_net: null,
    })),
  };
}
const flow = (
  timestamp = start - day,
  type: "DEPOSIT" | "WITHDRAWAL" = "DEPOSIT",
  usdc_size = 1000,
) => ({ proxy_wallet: wallet, timestamp, type, usdc_size });
const snapshot = (equity = 1000) => ({ equity: D(equity), at });
function archive(equity = "1000", valuation = new Date(at).toISOString()) {
  return zipSync({
    "equity.csv": strToU8(
      `cashBalance,positionsValue,equity,valuationTime\n${equity},0,${equity},${valuation}\n`,
    ),
    "positions.csv": strToU8("not used"),
  });
}

it("reconstructs NAV with full funding history and removes deposits/withdrawals from returns", () => {
  const h = history();
  h.points.slice(6).forEach((p) => {
    p.economic_pnl = -200;
    p.position_pnl = -200;
  });
  const r = predictionMetrics(
    wallet,
    h,
    [flow(), flow(start + 5 * day), flow(start + 7 * day, "WITHDRAWAL")],
    snapshot(800),
    at,
  );
  assert(Math.abs(r.source_drawdown_pct! - 10) < 1e-10);
  assert(Math.abs(r.source_roi_pct! + 10) < 1e-10);
  assert.equal(r.metric_provenance?.estimated, true);
  assert.equal(r.metric_provenance?.cashflow_adjusted, true);
  assert.deepEqual(r.metric_window, {
    start_at: start * 1000,
    end_at: end * 1000,
    basis: "polymarket_economic_nav_1m_daily_cashflow_adjusted_v1",
  });
});
it("retains verified zero drawdown and accounts for funding after the last historical mark", () => {
  const r = predictionMetrics(
    wallet,
    history(),
    [flow(), flow(end + 30, "WITHDRAWAL", 500)],
    snapshot(500),
    at,
  );
  assert.equal(r.source_drawdown_pct, 0);
  assert.equal(r.source_roi_pct, 0);
});
it("rejects missing capital, a wrong wallet, funding disagreements, and failed equity reconciliation", () => {
  for (const [ledger, equity, reason] of [
    [[], 1000, "missing_initial_capital"],
    [
      [{ ...flow(), proxy_wallet: "different" }],
      1000,
      "invalid_funding_ledger",
    ],
    [[flow()], 500, "equity_reconciliation_failed"],
    [[flow(start + day)], 1000, "missing_initial_capital"],
  ] as const)
    assert.throws(
      () =>
        predictionMetrics(wallet, history(), [...ledger], snapshot(equity), at),
      new RegExp(reason),
    );
  const h: any = history();
  h.points[1].deposits = 900;
  assert.throws(
    () => predictionMetrics(wallet, h, [flow()], snapshot(), at),
    /conflicting_funding_sources/,
  );
});
it("rejects null/nonfinite PnL, bad compositions, gaps, stale marks, and short/future histories", () => {
  const variants: Array<(h: any) => void> = [
    (h) => {
      h.points[2].economic_pnl = null;
    },
    (h) => {
      h.points[2].economic_pnl = NaN;
    },
    (h) => {
      h.points[2].wallet_income = null;
    },
    (h) => {
      h.points[2].economic_pnl = 50;
    },
    (h) => {
      h.points.splice(10, 1);
    },
    (h) => {
      h.points[3].timestamp = h.points[2].timestamp;
    },
    (h) => {
      h.points[3].source_block = h.points[2].source_block;
    },
    (h) => {
      h.points.at(-1).timestamp = end + day;
    },
    (h) => {
      h.points.splice(-3);
    },
    (h) => {
      h.proxy_wallet = "different";
    },
    (h) => {
      h.points[3].economic_pnl = -1000;
      h.points[3].position_pnl = -1000;
    },
  ];
  for (const change of variants) {
    const h = history();
    change(h);
    assert.throws(() => predictionMetrics(wallet, h, [flow()], snapshot(), at));
  }
  assert.throws(
    () =>
      predictionMetrics(
        wallet,
        history(),
        [flow()],
        { ...snapshot(), at: at - 3600_000 },
        at,
      ),
    /stale_equity_snapshot/,
  );
  assert.throws(
    () =>
      predictionMetrics(
        wallet,
        history(),
        [flow()],
        { ...snapshot(), at: at + 2 * day * 1000 },
        at + 2 * day * 1000,
      ),
    /stale_or_short_history/,
  );
});
it("bounds and validates the independent accounting snapshot", () => {
  assert.equal(accountingEquity(archive()).equity.toNumber(), 1000);
  assert.throws(() => accountingEquity(archive("NaN")));
  assert.throws(() =>
    accountingEquity(zipSync({ "equity.csv": strToU8("x".repeat(4097)) })),
  );
  assert.throws(() =>
    accountingEquity(zipSync({ "positions.csv": strToU8("only positions") })),
  );
});
it("replays real official daily observations with an anonymized identity", () => {
  const f = JSON.parse(
    readFileSync(
      new URL("./fixtures/prediction-history-20261015.json", import.meta.url),
      "utf8",
    ),
  );
  const s = f.snapshot;
  const r = predictionMetrics(
    f.wallet,
    f.series,
    f.flows,
    { equity: D(s.equity), at: Date.parse(s.valuationTime) },
    Date.parse(f.observed_at),
  );
  assert(Math.abs(r.source_drawdown_pct! - 0.04876968145497429) < 1e-9);
  assert(r.metric_provenance!.reconciliation_difference_pct < 1);
});
it("does not call the retired accounting archive or invent equivalent v2 metrics", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("Retired accounting must not be requested"),
  );
  const reader = new PredictionHistory();
  for (const value of await Promise.all([
    reader.metrics(wallet),
    reader.metrics(wallet),
  ])) {
    assert.equal(value.source_roi_pct, null);
    assert.equal(value.source_drawdown_pct, null);
    assert.equal(
      value.metric_unavailable_reason,
      "accounting_snapshot_retired",
    );
  }
});
it("serves verified reconstructed metrics after background completion and across process restarts", async () => {
  const records = new Map<string, any>();
  let finish!: (value: any) => void,
    loads = 0;
  const result = {
    metrics: {
      source_roi_pct: 2,
      source_drawdown_pct: 1,
      metric_window: {
        start_at: Date.now() - 29 * 86400000,
        end_at: Date.now(),
        basis: "polygon_inventory_nav_1m_daily_v2",
      },
      metric_provenance: {
        source: "polygon_transfers_and_polymarket_historical_marks",
        sampling: "daily",
        estimated: true,
        cashflow_adjusted: true,
        flow_timing: "deposits_at_start_withdrawals_at_end",
        reconciliation_difference_pct: 0,
      },
    },
    evidence: { boundary_balances_verified: true },
  };
  const options = {
    loader: {
      load: async () => {
        loads++;
        return new Promise<any>((r) => {
          finish = r;
        });
      },
    },
    key: () => "public-trader-id",
    read: async (key: string) => records.get(key) ?? null,
    write: async (key: string, record: any) => {
      records.set(key, record);
    },
  };
  const reader = new PredictionHistory(options);
  (reader as any).nativeMetrics = async () => ({
    source_roi_pct: null,
    source_drawdown_pct: null,
  });
  const missing = await reader.metrics(wallet);
  assert.equal(missing.source_drawdown_pct, null);
  assert.equal(
    missing.metric_unavailable_reason,
    "equity_history_reconstruction_pending",
  );
  await reader.metrics(wallet);
  assert.equal(loads, 1);
  finish(result);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await reader.metrics(wallet), result.metrics);
  const restarted = new PredictionHistory(options);
  (restarted as any).nativeMetrics = async () =>
    assert.fail("Fresh reconstructed history must not require legacy PnL");
  assert.deepEqual(await restarted.metrics(wallet), result.metrics);
  assert.equal(loads, 1);
});
