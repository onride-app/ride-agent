import type pg from "pg";
import type { PerformancePoint } from "./analytics.js";
import type { State } from "./repository.js";

// Ordinals describe the original owner-wide array, including interleaved
// portfolios and multiple points at the same millisecond. Time is not an ID.
export async function migratePerformanceSchema(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  let committed = false;
  const ready = async () => {
    const exists = await c.query(
      "SELECT to_regclass('ride_agent_performance_schema') IS NOT NULL AS ready",
    );
    if (!exists.rows[0].ready) return false;
    return (
      (
        await c.query(
          "SELECT version FROM ride_agent_performance_schema WHERE version=1",
        )
      ).rowCount === 1
    );
  };
  try {
    if (await ready()) {
      committed = true;
      return;
    }
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(724193, 102)");
    if (!(await ready())) {
      // Preserve the state -> cold lock order used by business transactions.
      await c.query("LOCK TABLE ride_agent_state IN ACCESS EXCLUSIVE MODE");
      await c.query(`
        CREATE TABLE IF NOT EXISTS ride_agent_performance_heads (
          user_id TEXT PRIMARY KEY REFERENCES ride_agent_state(user_id) ON DELETE CASCADE,
          next_ordinal BIGINT NOT NULL DEFAULT 0, has_performance BOOLEAN NOT NULL);
        CREATE TABLE IF NOT EXISTS ride_agent_performance (
          user_id TEXT NOT NULL REFERENCES ride_agent_state(user_id) ON DELETE CASCADE,
          ordinal BIGINT NOT NULL, portfolio_id TEXT NOT NULL, at_ms DOUBLE PRECISION NOT NULL,
          payload JSONB NOT NULL, original JSONB NOT NULL,
          active BOOLEAN NOT NULL DEFAULT true, PRIMARY KEY(user_id,ordinal));
        CREATE INDEX IF NOT EXISTS ride_agent_performance_latest ON ride_agent_performance
          (user_id,portfolio_id,ordinal DESC) WHERE active;
        CREATE INDEX IF NOT EXISTS ride_agent_performance_window ON ride_agent_performance
          (user_id,portfolio_id,at_ms,ordinal) WHERE active;
        CREATE TABLE IF NOT EXISTS ride_agent_performance_schema (
          version INTEGER PRIMARY KEY CHECK(version=1));
        INSERT INTO ride_agent_performance_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
      `);
    }
    await c.query("COMMIT");
    committed = true;
  } finally {
    c.release(!committed);
  }
}

/** Caller holds the owner's state row lock; the copy and strip are atomic. */
export async function migrateInlinePerformance(
  c: pg.PoolClient,
  user: string,
): Promise<void> {
  if (
    (
      await c.query(
        "SELECT 1 FROM ride_agent_performance_heads WHERE user_id=$1",
        [user],
      )
    ).rowCount
  )
    return;
  const shape = await c.query(
    `SELECT NOT(state ? 'performance') OR jsonb_typeof(state->'performance')='array' AS valid
     FROM ride_agent_state WHERE user_id=$1`,
    [user],
  );
  if (shape.rows[0]?.valid !== true)
    throw new Error("Performance history must be an array or absent");
  await c.query(
    `INSERT INTO ride_agent_performance(user_id,ordinal,portfolio_id,at_ms,payload,original)
     SELECT $1,n,e->>'portfolio_id',(e->>'at')::double precision,e,e FROM ride_agent_state s
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.state->'performance','[]'::jsonb))
       WITH ORDINALITY x(e,n) WHERE s.user_id=$1`,
    [user],
  );
  await c.query(
    `INSERT INTO ride_agent_performance_heads(user_id,next_ordinal,has_performance)
     SELECT $1,jsonb_array_length(COALESCE(state->'performance','[]'::jsonb)),state ? 'performance'
     FROM ride_agent_state WHERE user_id=$1`,
    [user],
  );
  await c.query(
    "UPDATE ride_agent_state SET state=state-'performance' WHERE user_id=$1 AND state ? 'performance'",
    [user],
  );
}

type Entry = { ordinal: number; value: PerformancePoint; before: string };
export interface PerformanceFrame {
  monitor: boolean;
  hasPerformance: boolean;
  entries: Entry[];
}

export async function hydratePerformance(
  c: pg.PoolClient,
  user: string,
  state: State,
  monitor: boolean,
): Promise<PerformanceFrame> {
  const head = await c.query(
    "SELECT has_performance FROM ride_agent_performance_heads WHERE user_id=$1",
    [user],
  );
  const rows = monitor
    ? await c.query(
        `SELECT d.ordinal,d.payload FROM unnest($2::text[]) AS p(portfolio_id)
         CROSS JOIN LATERAL (SELECT ordinal,payload FROM ride_agent_performance
           WHERE user_id=$1 AND portfolio_id=p.portfolio_id AND active
           ORDER BY ordinal DESC LIMIT 1) d ORDER BY d.ordinal`,
        [user, [...new Set(state.portfolios.map((p) => p.id))]],
      )
    : await c.query(
        "SELECT ordinal,payload FROM ride_agent_performance WHERE user_id=$1 AND active ORDER BY ordinal",
        [user],
      );
  const frame: PerformanceFrame = {
    monitor,
    hasPerformance: head.rows[0].has_performance,
    entries: rows.rows.map((r) => ({
      ordinal: Number(r.ordinal),
      value: r.payload as PerformancePoint,
      before: JSON.stringify(r.payload),
    })),
  };
  if (frame.hasPerformance)
    state.performance = frame.entries.map((e) => e.value);
  else delete state.performance;
  return frame;
}

function projectedPoints(state: State, frame: PerformanceFrame) {
  const values = state.performance ?? [];
  if (!Array.isArray(values))
    throw new Error("Performance history must be an array");
  const preserved =
    frame.entries.length <= values.length &&
    frame.entries.every((e, i) => JSON.stringify(values[i]) === e.before);
  if (
    frame.monitor &&
    (!preserved || (frame.hasPerformance && state.performance === undefined))
  )
    throw new Error(
      "Monitor performance projection changed its guarded prefix",
    );
  return { values, preserved };
}

/** Read only the exact analytics window, including its preceding baseline.
 * This is invoked on demand inside the same owner-locked transaction, after
 * the runner knows the actual snapshot end; it never changes the hot projection.
 */
export async function readPerformanceWindow(
  c: pg.PoolClient,
  user: string,
  state: State,
  frame: PerformanceFrame,
  portfolioId: string,
  start: number,
  end: number,
): Promise<PerformancePoint[]> {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    !state.portfolios.some((p) => p.id === portfolioId)
  )
    throw new Error("Invalid performance history window");
  const { values } = projectedPoints(state, frame);
  const rows = await c.query(
    `SELECT ordinal,payload FROM (
       (SELECT ordinal,payload FROM ride_agent_performance
         WHERE user_id=$1 AND portfolio_id=$2 AND active AND at_ms>=$3 AND at_ms<=$4)
       UNION ALL
       (SELECT ordinal,payload FROM ride_agent_performance
         WHERE user_id=$1 AND portfolio_id=$2 AND active AND at_ms<$3
         ORDER BY at_ms DESC,ordinal DESC LIMIT 1)
     ) selected ORDER BY ordinal`,
    [user, portfolioId, start, end],
  );
  // A callback can append before asking for its report. Preserve that local
  // tail as well; the transaction has not saved it to the cold table yet.
  const points = [
    ...rows.rows.map((r) => r.payload as PerformancePoint),
    ...values
      .slice(frame.entries.length)
      .filter((p) => p.portfolio_id === portfolioId),
  ];
  let baseline = -1;
  for (const [i, point] of points.entries())
    if (point.at <= start && (baseline < 0 || point.at >= points[baseline].at))
      baseline = i;
  return points.filter(
    (point, i) => i === baseline || (point.at >= start && point.at <= end),
  );
}

export async function savePerformance(
  c: pg.PoolClient,
  user: string,
  state: State,
  frame: PerformanceFrame,
): Promise<State> {
  const { values, preserved } = projectedPoints(state, frame);
  let added = values.slice(frame.entries.length);
  if (!frame.monitor && !preserved) {
    await c.query(
      "UPDATE ride_agent_performance SET active=false WHERE user_id=$1 AND active",
      [user],
    );
    added = values;
  }
  for (const point of added) {
    await c.query(
      `WITH next AS (UPDATE ride_agent_performance_heads
         SET next_ordinal=next_ordinal+1 WHERE user_id=$1 RETURNING next_ordinal)
       INSERT INTO ride_agent_performance(user_id,ordinal,portfolio_id,at_ms,payload,original)
       SELECT $1,next_ordinal,$2,$3,$4,$4 FROM next`,
      [user, point.portfolio_id, point.at, point],
    );
  }
  await c.query(
    `UPDATE ride_agent_performance_heads SET has_performance=$2
     WHERE user_id=$1 AND has_performance IS DISTINCT FROM $2`,
    [user, state.performance !== undefined],
  );
  const { performance: _history, ...hot } = state;
  return hot;
}

/** Same MVCC statement as the existing complete-history view. */
export function withFullPerformanceStateSql(fullHistorySql: string): string {
  return `SELECT CASE WHEN h.user_id IS NULL THEN complete.state
    WHEN h.has_performance THEN jsonb_set(complete.state,'{performance}',COALESCE((
      SELECT jsonb_agg(p.payload ORDER BY p.ordinal) FROM ride_agent_performance p
      WHERE p.user_id=$1 AND p.active),'[]'::jsonb))
    ELSE complete.state-'performance' END AS state
    FROM (${fullHistorySql}) complete
    LEFT JOIN ride_agent_performance_heads h ON h.user_id=$1`;
}
