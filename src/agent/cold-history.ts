import type pg from "pg";
import type { State, Update } from "./repository.js";
import type { Decision } from "./analytics.js";

// Only deduplication history is capped. Exact notification ACK IDs and durable
// due delivery claims are selected independently and can never be displaced.
export const MAX_RECENT_MONITOR_UPDATES = 256;

// Used only once for legacy/imported rows. Steady-state discovery reads the
// native boolean, not any of the potentially compressed JSON histories.
export const legacyEligibilitySql = `EXISTS (
  SELECT 1 FROM jsonb_array_elements(s.state->'portfolios') p WHERE p->>'state'<>'closed')
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.state->'updates') u WHERE u->>'notification'='pending')
  OR EXISTS (SELECT 1 FROM ride_agent_updates u WHERE u.user_id=s.user_id AND u.active AND u.notification='pending')
  OR s.state->'notification_preferences'->>'daily_digest'='true'`;

// Payloads are preserved alongside the mutable delivery/episode view. Financial
// state and history always commit under the same ride_agent_state owner row lock.
export async function migrateHistorySchema(pool: pg.Pool): Promise<void> {
  const c = await pool.connect();
  let committed = false;
  const ready = async () => {
    const table = await c.query(
      "SELECT to_regclass('ride_agent_history_schema') IS NOT NULL AS ready",
    );
    if (!table.rows[0].ready) return false;
    const version = await c.query(
      "SELECT version FROM ride_agent_history_schema WHERE version=1",
    );
    return version.rowCount === 1;
  };
  try {
    // A new reader/pool must never take DDL locks against a running financial
    // callback. This committed marker is visible only with the entire schema.
    if (await ready()) {
      committed = true;
      return;
    }
    await c.query("BEGIN");
    // CREATE IF NOT EXISTS alone does not serialize concurrent catalog writes.
    await c.query("SELECT pg_advisory_xact_lock(724193, 101)");
    if (await ready()) {
      await c.query("COMMIT");
      committed = true;
      return;
    }
    await c.query(`CREATE TABLE IF NOT EXISTS ride_agent_state (
      user_id TEXT PRIMARY KEY, state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    // Match the state -> history lock order used by every business transaction.
    await c.query("LOCK TABLE ride_agent_state IN ACCESS EXCLUSIVE MODE");
    await c.query(`
    CREATE TABLE IF NOT EXISTS ride_agent_history_migrations (
      user_id TEXT PRIMARY KEY REFERENCES ride_agent_state(user_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS ride_agent_history_heads (
      user_id TEXT NOT NULL REFERENCES ride_agent_state(user_id) ON DELETE CASCADE,
      portfolio_id TEXT NOT NULL, version BIGINT NOT NULL DEFAULT 0,
      next_ordinal BIGINT NOT NULL DEFAULT 0, has_decisions BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY(user_id,portfolio_id));
    CREATE TABLE IF NOT EXISTS ride_agent_updates (
      user_id TEXT NOT NULL REFERENCES ride_agent_state(user_id) ON DELETE CASCADE,
      id TEXT NOT NULL, ordinal BIGINT NOT NULL, at_ms BIGINT NOT NULL,
      kind TEXT NOT NULL, portfolio_id TEXT, notification TEXT NOT NULL,
      next_at BIGINT, claim_until BIGINT NOT NULL DEFAULT 0,
      payload JSONB NOT NULL, original JSONB NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
      monitor_visible BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY(user_id,id));
    CREATE INDEX IF NOT EXISTS ride_agent_updates_time ON ride_agent_updates(user_id,at_ms DESC,id DESC) WHERE active AND monitor_visible;
    CREATE INDEX IF NOT EXISTS ride_agent_updates_due ON ride_agent_updates(user_id,next_at,at_ms,id)
      WHERE active AND notification='pending';
    CREATE INDEX IF NOT EXISTS ride_agent_updates_order ON ride_agent_updates(user_id,ordinal);
    CREATE TABLE IF NOT EXISTS ride_agent_decisions (
      user_id TEXT NOT NULL REFERENCES ride_agent_state(user_id) ON DELETE CASCADE,
      portfolio_id TEXT NOT NULL, ordinal BIGINT NOT NULL, copy_id TEXT NOT NULL,
      market_key TEXT NOT NULL, target_present BOOLEAN NOT NULL,
      payload JSONB NOT NULL, original JSONB NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY(user_id,portfolio_id,ordinal));
    CREATE INDEX IF NOT EXISTS ride_agent_decisions_latest ON ride_agent_decisions
      (user_id,portfolio_id,copy_id,market_key,ordinal DESC) WHERE active;
    CREATE TABLE IF NOT EXISTS ride_agent_decision_evidence (
      user_id TEXT NOT NULL REFERENCES ride_agent_state(user_id) ON DELETE CASCADE,
      portfolio_id TEXT NOT NULL, copy_id TEXT NOT NULL, market_key TEXT NOT NULL,
      target_seen BOOLEAN NOT NULL, latest_ordinal BIGINT NOT NULL,
      PRIMARY KEY(user_id,portfolio_id,copy_id,market_key));
    ALTER TABLE ride_agent_state ADD COLUMN IF NOT EXISTS monitor_eligible BOOLEAN;
    CREATE INDEX IF NOT EXISTS ride_agent_monitor_users ON ride_agent_state(user_id) WHERE monitor_eligible;
    UPDATE ride_agent_state s SET monitor_eligible=COALESCE((${legacyEligibilitySql}),false)
      WHERE monitor_eligible IS NULL;
    CREATE TABLE IF NOT EXISTS ride_agent_history_schema (version INTEGER PRIMARY KEY CHECK(version=1));
    INSERT INTO ride_agent_history_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
  `);
    await c.query("COMMIT");
    committed = true;
  } finally {
    c.release(!committed);
  }
}

/** Caller must already hold the user's state row FOR UPDATE. */
export async function migrateInlineHistory(
  c: pg.PoolClient,
  user: string,
): Promise<void> {
  const done = await c.query(
    "SELECT 1 FROM ride_agent_history_migrations WHERE user_id=$1",
    [user],
  );
  if (done.rowCount) return;
  await c.query(
    `INSERT INTO ride_agent_updates
      (user_id,id,ordinal,at_ms,kind,portfolio_id,notification,next_at,claim_until,payload,original)
    SELECT $1,e->>'id',n,(e->>'at')::bigint,e->>'kind',e->>'portfolio_id',e->>'notification',
      (e->>'next_notification_at')::bigint,
      COALESCE((e->'notification_claim'->>'expires_at')::bigint,0),e,e
    FROM ride_agent_state s CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.state->'updates','[]'::jsonb))
      WITH ORDINALITY x(e,n) WHERE s.user_id=$1`,
    [user],
  );
  await c.query(
    `INSERT INTO ride_agent_decisions
      (user_id,portfolio_id,ordinal,copy_id,market_key,target_present,payload,original)
    SELECT $1,p->>'id',n,d->>'copy_id',d->>'key',
      d->'target_quantity' IS NOT NULL AND d->'target_quantity'<>'null'::jsonb,d,d
    FROM ride_agent_state s CROSS JOIN LATERAL jsonb_array_elements(s.state->'portfolios') p
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p->'decisions','[]'::jsonb)) WITH ORDINALITY x(d,n)
    WHERE s.user_id=$1`,
    [user],
  );
  // Retire redundant *delivery attempts* for historical read-budget messages,
  // never their original audit rows. Claimed/unknown sends and every financial,
  // execution or risk event are excluded. Identity retains the entire message
  // and data except the volatile countdown hint.
  await c.query(
    `WITH candidates AS (
      SELECT id,at_ms,kind,portfolio_id,payload->>'message' AS message,
        CASE WHEN jsonb_typeof(payload->'data'->'diagnostics')='object'
          THEN (payload->'data') #- '{diagnostics,retry_after_ms}' ELSE payload->'data' END AS identity_data,
        COALESCE((payload->'observation_episode'->>'first_at')::bigint,at_ms) AS first_at,
        COALESCE((payload->'observation_episode'->>'last_at')::bigint,at_ms) AS last_at,
        COALESCE((payload->'observation_episode'->>'count')::bigint,1) AS observations
      FROM ride_agent_updates WHERE user_id=$1 AND active AND notification='pending'
        AND kind IN ('VENUE_READ_BUDGET_EXHAUSTED','VENUE_RATE_LIMITED')
        AND NOT (payload ? 'notification_claim')
    ), episodes AS (
      SELECT id,first_value(id) OVER (w ORDER BY last_at DESC,id DESC) AS representative,
        min(first_at) OVER w AS first_at,max(last_at) OVER w AS last_at,
        sum(observations) OVER w AS observations,count(*) OVER w AS rows
      FROM candidates WINDOW w AS (PARTITION BY kind,portfolio_id,message,identity_data)
    ) UPDATE ride_agent_updates u SET
      notification=CASE WHEN u.id=e.representative THEN 'pending' ELSE 'cancelled' END,
      monitor_visible=(u.id=e.representative),
      payload=CASE WHEN u.id=e.representative THEN u.payload || jsonb_build_object(
          'observation_episode',jsonb_build_object('first_at',e.first_at,'last_at',e.last_at,
            'count',e.observations,'latest_data',COALESCE(u.payload->'observation_episode'->'latest_data',u.payload->'data')))
        ELSE u.payload || jsonb_build_object('notification','cancelled',
          'notification_superseded_by',e.representative) END
      FROM episodes e WHERE u.user_id=$1 AND u.id=e.id AND e.rows>1`,
    [user],
  );
  await c.query(
    `INSERT INTO ride_agent_history_heads(user_id,portfolio_id,next_ordinal,has_decisions)
    SELECT $1,p->>'id',jsonb_array_length(COALESCE(p->'decisions','[]'::jsonb)),p ? 'decisions'
    FROM ride_agent_state s CROSS JOIN LATERAL jsonb_array_elements(s.state->'portfolios') p WHERE s.user_id=$1`,
    [user],
  );
  await c.query(
    `INSERT INTO ride_agent_decision_evidence(user_id,portfolio_id,copy_id,market_key,target_seen,latest_ordinal)
    SELECT user_id,portfolio_id,copy_id,market_key,bool_or(target_present),max(ordinal) FROM ride_agent_decisions
    WHERE user_id=$1 AND active GROUP BY user_id,portfolio_id,copy_id,market_key ON CONFLICT DO NOTHING`,
    [user],
  );
  await c.query(
    `UPDATE ride_agent_state SET state=jsonb_set(
      jsonb_set(state,'{updates}','[]'::jsonb),'{portfolios}',
      COALESCE((SELECT jsonb_agg(p-'decisions' ORDER BY n)
        FROM jsonb_array_elements(state->'portfolios') WITH ORDINALITY x(p,n)),'[]'::jsonb))
    WHERE user_id=$1`,
    [user],
  );
  await c.query(
    "INSERT INTO ride_agent_history_migrations(user_id) VALUES($1)",
    [user],
  );
}

type DecisionEntry = {
  ordinal: number | null;
  value: Decision;
  before: string;
};
export interface HistoryFrame {
  monitor: boolean;
  updates: Map<string, string>;
  decisions: Map<string, DecisionEntry[]>;
  originalHot: string;
}

const HISTORY_VERSION = "__decision_history_version";
const GUARD = "__cold_history_guard";

export async function hydrateHistory(
  c: pg.PoolClient,
  user: string,
  state: State,
  monitor = false,
  ackIds: string[] = [],
): Promise<HistoryFrame> {
  const frame: HistoryFrame = {
    monitor,
    updates: new Map(),
    decisions: new Map(),
    originalHot: JSON.stringify(state),
  };
  const events = monitor
    ? await c.query(
        `WITH selected AS (
        (SELECT id FROM ride_agent_updates WHERE user_id=$1 AND active AND monitor_visible AND at_ms>$2
          ORDER BY at_ms DESC,id DESC LIMIT ${MAX_RECENT_MONITOR_UPDATES})
        UNION SELECT id FROM ride_agent_updates WHERE user_id=$1 AND active AND id=ANY($3::text[])
        UNION SELECT id FROM ride_agent_updates WHERE user_id=$1 AND active AND notification='pending' AND kind='daily_digest'
        UNION (SELECT id FROM ride_agent_updates WHERE user_id=$1 AND active AND notification='pending'
          AND COALESCE(next_at,0)<=$4 AND claim_until<=$4
          ORDER BY COALESCE(next_at,at_ms),at_ms,id LIMIT 4))
      SELECT payload FROM ride_agent_updates WHERE user_id=$1 AND active AND id IN (SELECT id FROM selected)
      ORDER BY ordinal`,
        [user, Date.now() - 3600000, ackIds, Date.now()],
      )
    : await c.query(
        "SELECT payload FROM ride_agent_updates WHERE user_id=$1 AND active ORDER BY ordinal",
        [user],
      );
  state.updates = events.rows.map((r) => r.payload as Update);
  for (const update of state.updates)
    frame.updates.set(update.id, JSON.stringify(update));
  const heads = await c.query(
    "SELECT portfolio_id,version,has_decisions FROM ride_agent_history_heads WHERE user_id=$1",
    [user],
  );
  const versions = new Map(
    heads.rows.map((r) => [r.portfolio_id, Number(r.version)]),
  );
  const decisions = monitor
    ? await c.query(
        `SELECT k.portfolio_id,d.ordinal,d.payload FROM ride_agent_decision_evidence k
          JOIN ride_agent_decisions d ON d.user_id=k.user_id AND d.portfolio_id=k.portfolio_id AND d.ordinal=k.latest_ordinal
          WHERE k.user_id=$1 AND d.active ORDER BY k.portfolio_id,k.copy_id,k.market_key`,
        [user],
      )
    : await c.query(
        "SELECT portfolio_id,ordinal,payload FROM ride_agent_decisions WHERE user_id=$1 AND active ORDER BY portfolio_id,ordinal",
        [user],
      );
  const evidence = monitor
    ? await c.query(
        "SELECT portfolio_id,copy_id,market_key FROM ride_agent_decision_evidence WHERE user_id=$1 AND target_seen ORDER BY portfolio_id,copy_id,market_key",
        [user],
      )
    : { rows: [] };
  for (const p of state.portfolios) {
    const entries: DecisionEntry[] = [];
    if (monitor) {
      for (const row of evidence.rows.filter((r) => r.portfolio_id === p.id)) {
        const value = {
          copy_id: row.copy_id,
          key: row.market_key,
          target_quantity: "0",
          reason: GUARD,
        } as Decision;
        entries.push({ ordinal: null, value, before: JSON.stringify(value) });
      }
      (p as unknown as Record<string, unknown>)[HISTORY_VERSION] =
        versions.get(p.id) ?? 0;
    }
    for (const row of decisions.rows.filter((r) => r.portfolio_id === p.id))
      entries.push({
        ordinal: Number(row.ordinal),
        value: row.payload,
        before: JSON.stringify(row.payload),
      });
    if (
      monitor ||
      heads.rows.some((r) => r.portfolio_id === p.id && r.has_decisions) ||
      entries.length
    )
      p.decisions = entries.map((e) => e.value);
    else delete p.decisions;
    frame.decisions.set(p.id, entries);
  }
  return frame;
}

export function isColdDecisionGuard(value: Decision): boolean {
  return value.reason === GUARD;
}

async function saveUpdate(
  c: pg.PoolClient,
  user: string,
  e: Update,
): Promise<void> {
  await c.query(
    `INSERT INTO ride_agent_updates(user_id,id,ordinal,at_ms,kind,portfolio_id,notification,next_at,claim_until,payload,original)
    VALUES($1,$2,COALESCE((SELECT max(ordinal)+1 FROM ride_agent_updates WHERE user_id=$1),1),$3,$4,$5,$6,$7,$8,$9,$9)
    ON CONFLICT(user_id,id) DO UPDATE SET payload=EXCLUDED.payload,at_ms=EXCLUDED.at_ms,
      kind=EXCLUDED.kind,portfolio_id=EXCLUDED.portfolio_id,notification=EXCLUDED.notification,
      next_at=EXCLUDED.next_at,claim_until=EXCLUDED.claim_until,active=true`,
    [
      user,
      e.id,
      e.at,
      e.kind,
      e.portfolio_id,
      e.notification,
      e.next_notification_at ?? null,
      e.notification_claim?.expires_at ?? 0,
      e,
    ],
  );
}

async function saveDecision(
  c: pg.PoolClient,
  user: string,
  pid: string,
  value: Decision,
  ordinal: number | null,
): Promise<void> {
  await c.query(
    "INSERT INTO ride_agent_history_heads(user_id,portfolio_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [user, pid],
  );
  if (ordinal === null) {
    const head = await c.query(
      "UPDATE ride_agent_history_heads SET next_ordinal=next_ordinal+1,version=version+1,has_decisions=true WHERE user_id=$1 AND portfolio_id=$2 RETURNING next_ordinal",
      [user, pid],
    );
    ordinal = Number(head.rows[0].next_ordinal);
  } else
    await c.query(
      "UPDATE ride_agent_history_heads SET version=version+1 WHERE user_id=$1 AND portfolio_id=$2",
      [user, pid],
    );
  await c.query(
    `INSERT INTO ride_agent_decisions(user_id,portfolio_id,ordinal,copy_id,market_key,target_present,payload,original)
    VALUES($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT(user_id,portfolio_id,ordinal) DO UPDATE SET payload=EXCLUDED.payload,active=true`,
    [
      user,
      pid,
      ordinal,
      value.copy_id,
      value.key,
      value.target_quantity != null,
      value,
    ],
  );
  await c.query(
    `INSERT INTO ride_agent_decision_evidence(user_id,portfolio_id,copy_id,market_key,target_seen,latest_ordinal)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,portfolio_id,copy_id,market_key) DO UPDATE
    SET target_seen=ride_agent_decision_evidence.target_seen OR EXCLUDED.target_seen,
      latest_ordinal=GREATEST(ride_agent_decision_evidence.latest_ordinal,EXCLUDED.latest_ordinal)
    WHERE (EXCLUDED.target_seen AND NOT ride_agent_decision_evidence.target_seen)
      OR EXCLUDED.latest_ordinal>ride_agent_decision_evidence.latest_ordinal`,
    [
      user,
      pid,
      value.copy_id,
      value.key,
      value.target_quantity != null,
      ordinal,
    ],
  );
}

/** Save only changed projected records; never overwrite histories not loaded. */
export async function saveHistory(
  c: pg.PoolClient,
  user: string,
  state: State,
  frame: HistoryFrame,
): Promise<State> {
  const ids = new Set(state.updates.map((e) => e.id));
  for (const [id] of frame.updates)
    if (!ids.has(id))
      await c.query(
        "UPDATE ride_agent_updates SET active=false WHERE user_id=$1 AND id=$2",
        [user, id],
      );
  for (const e of state.updates)
    if (frame.updates.get(e.id) !== JSON.stringify(e))
      await saveUpdate(c, user, e);
  const portfolios = new Set(state.portfolios.map((p) => p.id));
  for (const [pid] of frame.decisions)
    if (!portfolios.has(pid)) {
      await c.query(
        "UPDATE ride_agent_decisions SET active=false WHERE user_id=$1 AND portfolio_id=$2 AND active",
        [user, pid],
      );
      await c.query(
        "DELETE FROM ride_agent_decision_evidence WHERE user_id=$1 AND portfolio_id=$2",
        [user, pid],
      );
      await c.query(
        "UPDATE ride_agent_history_heads SET has_decisions=false,version=version+1 WHERE user_id=$1 AND portfolio_id=$2",
        [user, pid],
      );
    }
  for (const p of state.portfolios) {
    const prior = frame.decisions.get(p.id) ?? [];
    const values = p.decisions ?? [];
    if (!frame.monitor) {
      await c.query(
        `INSERT INTO ride_agent_history_heads(user_id,portfolio_id,has_decisions) VALUES($1,$2,$3)
        ON CONFLICT(user_id,portfolio_id) DO UPDATE SET has_decisions=EXCLUDED.has_decisions
        WHERE ride_agent_history_heads.has_decisions IS DISTINCT FROM EXCLUDED.has_decisions`,
        [user, p.id, p.decisions !== undefined],
      );
    }
    const prefixPreserved =
      prior.length <= values.length &&
      prior.every((entry, i) => {
        if (entry.ordinal === null)
          return JSON.stringify(values[i]) === entry.before;
        // A monitor can summarize another identical observation, but must never
        // reorder, remove or change any of the immutable decision business fields.
        const { observation_episode: _before, ...before } = JSON.parse(
          entry.before,
        ) as Decision;
        const { observation_episode: _after, ...after } = values[i];
        return JSON.stringify(before) === JSON.stringify(after);
      });
    if (frame.monitor && !prefixPreserved)
      throw new Error("Monitor history projection changed its guarded prefix");
    // Complete Repository callbacks remain compatible, including replacement.
    if (
      !frame.monitor &&
      (values.length < prior.length ||
        prior.some((e, i) => JSON.stringify(values[i]) !== e.before))
    ) {
      await c.query(
        "UPDATE ride_agent_decisions SET active=false WHERE user_id=$1 AND portfolio_id=$2",
        [user, p.id],
      );
      await c.query(
        "DELETE FROM ride_agent_decision_evidence WHERE user_id=$1 AND portfolio_id=$2",
        [user, p.id],
      );
      for (const value of values)
        await saveDecision(c, user, p.id, value, null);
    } else {
      for (let i = 0; i < values.length; i++) {
        const entry = prior[i];
        if (entry?.ordinal === null) continue;
        if (!entry || JSON.stringify(values[i]) !== entry.before)
          await saveDecision(c, user, p.id, values[i], entry?.ordinal ?? null);
      }
    }
  }
  // Copy only the small structural shell; no clone/stringify of cold arrays.
  return {
    ...state,
    updates: [],
    portfolios: state.portfolios.map((p) => {
      const {
        decisions: _history,
        [HISTORY_VERSION]: _version,
        ...hot
      } = p as typeof p & Record<string, unknown>;
      return hot as typeof p;
    }),
  };
}

// One ordinary MVCC snapshot, without row locks or account creation. Readers
// cannot combine a new hot state with old history while a monitor commits.
export const fullStateSql = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM ride_agent_history_migrations m WHERE m.user_id=s.user_id)
  THEN jsonb_set(jsonb_set(s.state,'{updates}',COALESCE((SELECT jsonb_agg(u.payload ORDER BY u.ordinal)
    FROM ride_agent_updates u WHERE u.user_id=s.user_id AND u.active),'[]'::jsonb)),
    '{portfolios}',COALESCE((SELECT jsonb_agg(CASE WHEN h.has_decisions THEN p || jsonb_build_object('decisions',
      COALESCE((SELECT jsonb_agg(d.payload ORDER BY d.ordinal) FROM ride_agent_decisions d
        WHERE d.user_id=s.user_id AND d.portfolio_id=p->>'id' AND d.active),'[]'::jsonb)) ELSE p END ORDER BY n)
      FROM jsonb_array_elements(s.state->'portfolios') WITH ORDINALITY x(p,n)
      LEFT JOIN ride_agent_history_heads h ON h.user_id=s.user_id AND h.portfolio_id=p->>'id'),'[]'::jsonb))
  ELSE s.state END AS state FROM ride_agent_state s WHERE s.user_id=$1`;
