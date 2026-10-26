import assert from "node:assert/strict";
import { it } from "node:test";
import { browse, saveDiscovery, traderRow } from "./discovery.js";
import {
  filterCandidates,
  metricPeriodsComparable,
  normalizeCandidateQuery,
  type CandidateFilters,
} from "./candidate-filters.js";
import { candidate } from "./fixtures.js";
import { emptyState, Cursor } from "./repository.js";
import { recommend, type Candidate, type Plan } from "./domain.js";
import { preferences } from "./contracts.js";

const pref = preferences.parse({
  budget_usdc: "30",
  loss_trigger_pct: 10,
  market: "perps",
  portfolio_kind: "basket",
  basket_size: 4,
});
const window = { start_at: 1_700_000_000_000, end_at: 1_702_592_000_000 };
const cursor = new Cursor("candidate-filter-test-secret-32-characters");
const ids = (rows: Candidate[]) => rows.map((c) => c.id);

function fixture() {
  const state = emptyState();
  const pool = Array.from({ length: 12 }, (_, i) => ({
    ...candidate(i + 1),
    score: 95 - i,
    source_drawdown_pct: i < 7 ? 15 : i - 7,
    source_roi_pct: i - 6,
  }));
  state.preferences = pref;
  const plan = recommend(pref, pool);
  state.plans = [plan];
  state.selected_trader_ids = plan.allocations.map((a) => a.trader.id);
  saveDiscovery(state, pref, pool);
  return { state, pool, plan };
}
const withPeriod = (c: Candidate, bounds = window): Candidate => ({
  ...c,
  metric_periods: {
    roi: { period: "verified", ...bounds, basis: "verified test NAV" },
    drawdown: { period: "verified", ...bounds, basis: "verified test NAV" },
  },
});

it("filters the complete snapshot before pagination, including matches beyond the original first page", () => {
  const { state, pool } = fixture();
  const before = structuredClone(state);
  const args = { filters: { max_drawdown_pct: 4 }, limit: 2 };
  const first = browse(state, pref, args, "alice", cursor);
  const second = browse(
    state,
    pref,
    { ...args, cursor: first.candidates_meta.next_cursor! },
    "alice",
    cursor,
  );
  const third = browse(
    state,
    pref,
    { ...args, cursor: second.candidates_meta.next_cursor! },
    "alice",
    cursor,
  );
  assert.deepEqual(
    [
      ...ids(first.candidates),
      ...ids(second.candidates),
      ...ids(third.candidates),
    ],
    ids(pool.slice(7)),
  );
  assert.equal(first.candidates_meta.total, 5);
  assert.equal(first.filter_counts.threshold_excluded_count, 7);
  assert.equal(first.filter_counts.before_filters_count, 12);
  assert.equal(first.filter_counts.matching_count, 5);
  assert.equal(third.candidates_meta.next_cursor, null);
  assert.deepEqual(state, before);
});

it("keeps exclusions, preference eligibility, counts and original plan intact", () => {
  const { state, plan } = fixture();
  const chosen = new Set(plan.allocations.map((a) => a.trader.id));
  state.discovery!.candidates[11].eligibility = "REJECT";
  const before = structuredClone(state);
  const result = browse(
    state,
    pref,
    {
      plan_id: plan.id,
      exclude_selected: true,
      filters: { min_score: 0 },
      limit: 20,
    },
    "alice",
    cursor,
  );
  assert(result.candidates.every((c) => !chosen.has(c.id)));
  assert.equal(result.filter_counts.source_count, 12);
  assert.equal(result.filter_counts.eligible_count, 11);
  assert.equal(result.filter_counts.selected_excluded_count, 4);
  assert.equal(result.filter_counts.matching_count, 7);
  assert.equal(result.plan_unchanged, true);
  assert.equal(result.preferences_unchanged, true);
  assert.deepEqual(state, before);
});

it("treats zero thresholds as real filters and excludes missing/non-finite values instead of coercing them to zero", () => {
  const rows = [
    { ...candidate(1), source_drawdown_pct: 0, source_roi_pct: 0 },
    { ...candidate(2), source_drawdown_pct: null, source_roi_pct: null },
    {
      ...candidate(3),
      source_drawdown_pct: Number.NaN,
      source_roi_pct: Number.POSITIVE_INFINITY,
    },
    { ...candidate(4), source_drawdown_pct: -1, source_roi_pct: -2 },
    { ...candidate(5), source_drawdown_pct: 1, source_roi_pct: 1 },
  ];
  const filtered = filterCandidates(rows, {
    max_drawdown_pct: 0,
    min_roi_pct: 0,
    max_roi_pct: 0,
  });
  assert.deepEqual(ids(filtered.rows), [rows[0].id]);
  assert.equal(filtered.counts.missing_metric_count, 3);
  assert.equal(filtered.counts.threshold_excluded_count, 1);
  assert.equal(filtered.metric_basis.kind, "source_reported_values");
  assert.equal(filtered.metric_basis.unknown_period_count, rows.length);
  assert.deepEqual(filtered.applied_filters, {
    max_drawdown_pct: 0,
    min_roi_pct: 0,
    max_roi_pct: 0,
  });
});

it("supports negative ROI and inclusive boundary ranges without changing percentage units", () => {
  const rows = [-10, -5, 0, 5].map((roi, i) => ({
    ...candidate(i + 1),
    source_roi_pct: roi,
  }));
  assert.deepEqual(
    ids(filterCandidates(rows, { min_roi_pct: -5, max_roi_pct: 0 }).rows),
    ids(rows.slice(1, 3)),
  );
  assert.deepEqual(normalizeCandidateQuery({ min_roi_pct: -0 }).filters, {
    min_roi_pct: 0,
  });
  assert.deepEqual(
    normalizeCandidateQuery().filters,
    normalizeCandidateQuery({}).filters,
  );
});

it("rejects invalid filters and invalid windows even when called outside the public schema", () => {
  const invalid: unknown[] = [
    { min_score: -1 },
    { min_score: 101 },
    { min_score: Number.NaN },
    { max_drawdown_pct: -1 },
    { min_roi_pct: Number.POSITIVE_INFINITY },
    { min_roi_pct: 5, max_roi_pct: -5 },
    { unsupported: 1 },
    [],
    { min_score: null },
    null,
  ];
  for (const filters of invalid)
    assert.throws(
      () => normalizeCandidateQuery(filters as CandidateFilters),
      /filter|score|drawdown|ROI/i,
    );
  for (const bounds of [
    { start_at: 0, end_at: 1 },
    { start_at: 5, end_at: 5 },
    { start_at: 5, end_at: 4 },
    { start_at: 1.5, end_at: 3 },
  ])
    assert.throws(() => normalizeCandidateQuery({}, bounds), /window/i);
});

it("only accepts verified exact per-metric windows and reports unavailable vs different window counts", () => {
  const rows: Candidate[] = [
    withPeriod(candidate(1)),
    candidate(2),
    withPeriod(candidate(3), {
      start_at: window.start_at + 1,
      end_at: window.end_at,
    }),
    { ...withPeriod(candidate(4)), source_drawdown_pct: null },
  ];
  const filtered = filterCandidates(rows, { max_drawdown_pct: 10 }, window);
  assert.deepEqual(ids(filtered.rows), [rows[0].id]);
  assert.equal(filtered.counts.unavailable_window_count, 1);
  assert.equal(filtered.counts.mismatched_window_count, 1);
  assert.equal(filtered.counts.missing_metric_count, 1);
  assert.equal(filtered.metric_basis.kind, "verified_window");
  assert.deepEqual(filtered.metric_basis.applied_to_metrics, ["drawdown"]);
  assert.deepEqual(filtered.metric_basis.requested_window, window);
});

it("uses a common historical window only with non-estimated provenance and never overrides an explicit unknown metric period", () => {
  const provenance = {
    source: "verified NAV",
    sampling: "daily" as const,
    estimated: false,
    cashflow_adjusted: true,
    flow_timing: "block",
    reconciliation_difference_pct: 0,
  };
  const common = {
    ...candidate(1),
    metric_window: { ...window, basis: "verified test NAV" },
    metric_provenance: provenance,
  };
  const rows: Candidate[] = [
    common,
    {
      ...candidate(2),
      metric_window: { ...window, basis: "verified test NAV" },
    },
    {
      ...candidate(3),
      metric_window: { ...window, basis: "verified test NAV" },
      metric_provenance: { ...provenance, estimated: true },
    },
    {
      ...common,
      id: candidate(4).id,
      metric_periods: {
        roi: {
          period: "unavailable",
          start_at: null,
          end_at: null,
          basis: "unverified",
        },
        drawdown: {
          period: "unavailable",
          start_at: null,
          end_at: null,
          basis: "unverified",
        },
      },
    },
  ];
  const filtered = filterCandidates(rows, { min_roi_pct: 0 }, window);
  assert.deepEqual(ids(filtered.rows), [common.id]);
  assert.equal(filtered.counts.unavailable_window_count, 3);
});

it("checks both displayed historical windows for a window-only score query", () => {
  const good = withPeriod(candidate(1));
  const bad = {
    ...withPeriod(candidate(2)),
    metric_periods: {
      ...withPeriod(candidate(2)).metric_periods!,
      roi: {
        period: "source_month",
        start_at: null,
        end_at: null,
        basis: "unknown dates",
      },
    },
  };
  const filtered = filterCandidates([good, bad], {}, window);
  assert.deepEqual(ids(filtered.rows), [good.id]);
  assert.deepEqual(filtered.metric_basis.applied_to_metrics, [
    "roi",
    "drawdown",
  ]);
  assert.equal(filtered.counts.unavailable_window_count, 1);
});

it("binds cursors to canonical filters, metric windows, snapshot and account", () => {
  const { state } = fixture();
  state.discovery!.candidates = state.discovery!.candidates.map((c) =>
    withPeriod(c),
  );
  const args = {
    filters: { min_score: 0, max_roi_pct: 100 },
    metric_window: window,
    limit: 2,
  };
  const first = browse(state, pref, args, "alice", cursor);
  const token = first.candidates_meta.next_cursor!;
  assert(
    browse(
      state,
      pref,
      { ...args, filters: { max_roi_pct: 100, min_score: -0 }, cursor: token },
      "alice",
      cursor,
    ).candidates.length,
  );
  assert.throws(
    () =>
      browse(
        state,
        pref,
        { ...args, filters: { min_score: 80 }, cursor: token },
        "alice",
        cursor,
      ),
    /cursor/i,
  );
  assert.throws(
    () =>
      browse(
        state,
        pref,
        {
          ...args,
          metric_window: { ...window, start_at: window.start_at + 1 },
          cursor: token,
        },
        "alice",
        cursor,
      ),
    /cursor/i,
  );
  assert.throws(
    () => browse(state, pref, { ...args, cursor: token }, "bob", cursor),
    /cursor/i,
  );
  state.discovery!.id = "discovery_changed";
  assert.throws(
    () => browse(state, pref, { ...args, cursor: token }, "alice", cursor),
    /cursor/i,
  );
  state.discovery!.expires_at = Date.now() - 1;
  assert.throws(
    () => browse(state, pref, { ...args, cursor: token }, "alice", cursor),
    /expired/i,
  );
});

it("does not silently filter an explicit comparison list, including an empty filters object", () => {
  const { state, pool } = fixture();
  for (const extra of [
    { filters: {} },
    { metric_window: window },
    { filters: { min_score: 0 } },
  ])
    assert.throws(
      () =>
        browse(
          state,
          pref,
          { compare_ids: [pool[0].id], ...extra },
          "alice",
          cursor,
        ),
      /comparison/i,
    );
  const comparison = browse(
    state,
    pref,
    { compare_ids: [pool[0].id] },
    "alice",
    cursor,
  );
  assert.deepEqual(ids(comparison.candidates), [pool[0].id]);
});

it("keeps filtered-empty distinct from source-empty and sorts missing values last with deterministic ties", () => {
  const { state, pool } = fixture();
  const empty = browse(
    state,
    pref,
    { filters: { min_score: 100 } },
    "alice",
    cursor,
  );
  assert.equal(empty.candidate_availability.status, "no_matching_candidates");
  assert.equal(empty.filter_counts.threshold_excluded_count, pool.length);
  assert.equal(empty.candidates_meta.total, 0);
  state.discovery!.candidates = [
    { ...candidate(3), source_roi_pct: Number.NaN },
    { ...candidate(2), source_roi_pct: 0 },
    { ...candidate(1), source_roi_pct: 0 },
  ];
  assert.deepEqual(
    ids(browse(state, pref, { sort_by: "roi" }, "alice", cursor).candidates),
    [candidate(1).id, candidate(2).id, candidate(3).id],
  );
  state.discovery!.candidates = [];
  const sourceEmpty = browse(
    state,
    pref,
    { filters: { min_score: 100 } },
    "alice",
    cursor,
  );
  assert.equal(sourceEmpty.candidate_availability.status, "source_empty");
  assert.equal(sourceEmpty.candidate_availability.source_count, null);
});

it("does not claim all historical metrics are comparable from one verified metric", () => {
  const c = withPeriod(candidate(1));
  c.metric_periods!.roi = {
    period: "source_month",
    start_at: null,
    end_at: null,
    basis: "source label only",
  };
  assert.equal(metricPeriodsComparable([c], "drawdown"), true);
  assert.equal(metricPeriodsComparable([c], "roi"), false);
  assert.equal(metricPeriodsComparable([c]), false);
  const { state } = fixture();
  state.discovery!.candidates = [c];
  const result = browse(
    state,
    pref,
    { filters: { max_drawdown_pct: 5 }, metric_window: window },
    "alice",
    cursor,
  );
  assert.equal(result.candidates_meta.period_comparable, false);
  assert.deepEqual(result.candidates_meta.period_comparable_by_metric, {
    roi: false,
    drawdown: true,
  });
});

it("does not promote invalid negative drawdown to the safest sorted result", () => {
  const { state } = fixture();
  state.discovery!.candidates = [
    { ...candidate(1), source_drawdown_pct: -1 },
    { ...candidate(2), source_drawdown_pct: 0 },
  ];
  const result = browse(
    state,
    pref,
    { sort_by: "drawdown", compare_ids: [candidate(1).id, candidate(2).id] },
    "alice",
    cursor,
  );
  assert.deepEqual(ids(result.candidates), [candidate(2).id, candidate(1).id]);
});

it("does not certify contradictory unavailable period labels merely because they have numeric bounds", () => {
  const c = candidate(1);
  const window = { start_at: 1700000000000, end_at: 1702592000000 };
  for (const label of [
    "unavailable",
    "unknown",
    "UNVERIFIED",
    "not_available",
  ]) {
    c.metric_periods = {
      roi: {
        period: "unavailable",
        start_at: null,
        end_at: null,
        basis: "not verified",
      },
      drawdown: { period: label, ...window, basis: "source says unavailable" },
    };
    const d = filterCandidates([c], { max_drawdown_pct: 3 }, window);
    assert.equal(d.rows.length, 0);
    assert.equal(d.counts.unavailable_window_count, 1);
    assert.equal(d.counts.unknown_period_count, 1);
    assert.equal(metricPeriodsComparable([c], "drawdown"), false);
    const row = traderRow(c);
    assert.match(row.metric_period_labels.drawdown, /未核实/);
    assert.doesNotMatch(row.metric_period_labels.drawdown, /2023/);
  }
});

it("uses one safe period rule for raw rows, display and filtering", () => {
  const c = withPeriod(candidate(1));
  const verified = traderRow(c);
  assert.match(verified.metric_period_labels.roi, /2023-11-15.*上海/);
  assert.match(verified.metric_period_labels.drawdown, /2023-11-15.*上海/);
  assert.equal(metricPeriodsComparable([c]), true);
  const { state } = fixture();
  state.discovery!.candidates = [c];
  for (const bounds of [
    { start_at: NaN, end_at: Infinity },
    { start_at: window.end_at, end_at: window.start_at },
    { start_at: window.start_at, end_at: Date.now() + 60_000 },
    { start_at: 0, end_at: window.end_at },
  ]) {
    for (const metric of ["roi", "drawdown"] as const)
      Object.assign(c.metric_periods![metric]!, bounds);
    const row = traderRow(c);
    assert.match(row.metric_period_labels.roi, /未核实/);
    assert.match(row.metric_period_labels.drawdown, /未核实/);
    assert.equal(metricPeriodsComparable([c]), false);
    assert.doesNotThrow(() =>
      browse(state, pref, { sort_by: "drawdown" }, "alice", cursor),
    );
  }
});
