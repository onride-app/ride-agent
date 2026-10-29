import pg from "pg";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import type { Plan, Portfolio } from "./domain.js";
import { AgentError, type Preferences } from "./contracts.js";
import { monitorPhase } from "./monitor-diagnostics.js";

export interface Proposal {
  id: string;
  action: string;
  arguments: Record<string, unknown>;
  portfolio_id: string;
  expected_revision: number;
  committed_revision?: number;
  created_at: number;
  expires_at: number;
  status: "requires_confirmation" | "queued" | "completed" | "rejected";
  snapshot_hash: string;
  amount_usdc: string;
  warnings: string[];
  preview: Record<string, unknown>;
}
export interface Delegation {
  id: string;
  portfolio_id: string;
  total_usdc: string;
  per_action_usdc: string;
  daily_usdc: string;
  expires_at: number;
  markets: ("perps" | "prediction")[];
  assets: string[];
  leverage_cap: number;
  used_usdc: string;
  daily_used_usdc: string;
  day: string;
  revoked: boolean;
}
export interface Update {
  id: string;
  at: number;
  kind: string;
  portfolio_id: string | null;
  message: string;
  data: Record<string, unknown>;
  notification: "pending" | "delivered" | "cancelled";
  notification_attempts?: number;
  next_notification_at?: number;
  notification_error?: string;
}
export interface HoldingCheckpoint {
  at: number;
  key: string;
  quantities: Record<string, string>;
}
export interface State {
  preference_sources?: Partial<
    Record<keyof Preferences, "user" | "default" | "recommended">
  >;
  selected_trader_ids?: string[];
  selection_source?: "system" | "explicit" | "legacy_unknown";
  discovery?: {
    id: string;
    preference_hash: string;
    created_at: number;
    expires_at: number;
    candidates: import("./domain.js").Candidate[];
  };
  preference_asset_filter_version?: 2;
  preferences: Preferences | null;
  preference_draft?: Partial<Preferences>;
  recommendation_batches?: {
    preference_hash: string;
    batches: string[][];
    change_used: boolean;
    active_index: number;
  };
  daily_checkin_days?: Record<string, string>;
  deposits?: import("./deposits.js").Deposit[];
  plans: Plan[];
  portfolios: Portfolio[];
  proposals: Proposal[];
  delegation: Delegation | null;
  updates: Update[];
  checkpoints: HoldingCheckpoint[];
  performance?: import("./analytics.js").PerformancePoint[];
  notification_preferences?: {
    daily_digest: boolean;
    local_time: string;
    timezone: string;
    enabled_at: number;
    last_digest_day?: string;
  };
}
export const emptyState = (): State => ({
  preferences: null,
  plans: [],
  portfolios: [],
  proposals: [],
  delegation: null,
  updates: [],
  checkpoints: [],
});
export interface Repository {
  read(user: string): Promise<State>;
  transact<T>(user: string, fn: (state: State) => Promise<T>): Promise<T>;
  users(): Promise<string[]>;
  close(): Promise<void>;
}
export class PgRepository implements Repository {
  readonly pool: pg.Pool;
  private readonly transactions = new Map<
    pg.PoolClient,
    "reading" | "callback"
  >();
  private closing?: Promise<void>;
  constructor(
    url: string,
    timeouts: { statementTimeoutMs?: number; queryTimeoutMs?: number } = {},
  ) {
    const statementTimeoutMs = timeouts.statementTimeoutMs ?? 20_000;
    const queryTimeoutMs = timeouts.queryTimeoutMs ?? 25_000;
    if (
      !Number.isSafeInteger(statementTimeoutMs) ||
      statementTimeoutMs <= 0 ||
      !Number.isSafeInteger(queryTimeoutMs) ||
      queryTimeoutMs <= statementTimeoutMs
    )
      throw new RangeError(
        "Repository query deadlines must be positive and the transport deadline must follow the database deadline.",
      );
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
      // Bound ordinary SQL execution. PostgreSQL may defer cancellation while
      // flushing ClientWrite; driver timeout and shutdown must close sockets.
      statement_timeout: statementTimeoutMs,
      query_timeout: queryTimeoutMs,
    });
  }
  async migrate(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ride_agent_state (user_id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    );
  }
  async read(user: string): Promise<State> {
    // Inspections neither create an account row nor lock/update saved plans.
    const value = await this.pool.query(
      "SELECT state FROM ride_agent_state WHERE user_id=$1",
      [user],
    );
    return structuredClone(
      (value.rows[0]?.state as State | undefined) ?? emptyState(),
    );
  }
  async transact<T>(
    user: string,
    fn: (state: State) => Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new Error("Repository is closing");
    const c = await this.pool.connect();
    if (this.closing) {
      c.release(true);
      throw new Error("Repository is closing");
    }
    this.transactions.set(c, "reading");
    let failed = true;
    let connectionError: Error | undefined;
    const onError = (error: Error) => {
      connectionError = error;
    };
    // Pool idle listeners are removed at checkout. A socket can also fail
    // between queries while a callback awaits external evidence.
    c.on("error", onError);
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SET LOCAL idle_in_transaction_session_timeout = '90s'");
      await c.query(
        "INSERT INTO ride_agent_state(user_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [user, emptyState()],
      );
      const r = await monitorPhase("db_state_read", () =>
        c.query(
          "SELECT state FROM ride_agent_state WHERE user_id=$1 FOR UPDATE",
          [user],
        ),
      );
      if (this.closing) throw new Error("Repository is closing");
      const s = r.rows[0].state as State;
      this.transactions.set(c, "callback");
      const out = await monitorPhase("db_callback", () => fn(s));
      if (connectionError) throw connectionError;
      await monitorPhase("db_commit", async () => {
        await c.query(
          "UPDATE ride_agent_state SET state=$2, updated_at=now() WHERE user_id=$1",
          [user, s],
        );
        await c.query("COMMIT");
      });
      failed = false;
      return out;
    } finally {
      // A timed-out query may still be reading on the wire. Never queue an
      // unbounded ROLLBACK behind it or return that unknown session to the
      // pool. Closing the connection rolls back its uncommitted transaction.
      this.transactions.delete(c);
      c.release(failed || !!connectionError);
      c.removeListener("error", onError);
    }
  }
  async users(): Promise<string[]> {
    return (
      await this.pool.query(
        "SELECT user_id FROM ride_agent_state WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(state->'portfolios') p WHERE p->>'state' <> 'closed') OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'updates') u WHERE u->>'notification' = 'pending') OR state->'notification_preferences'->>'daily_digest' = 'true'",
      )
    ).rows.map((x) => x.user_id);
  }
  close(): Promise<void> {
    if (!this.closing) {
      // Start on SIGTERM, before waiting for a runner blocked on a state read.
      // Destroying an active query socket releases its database row locks;
      // new transactions are forbidden. Already-entered callbacks may have
      // external effects and must finish through the existing durable path.
      this.closing = Promise.all([
        this.pool.end(),
        ...[...this.transactions]
          .filter(([_, phase]) => phase === "reading")
          .map(([client]) => client.end()),
      ]).then(() => undefined);
    }
    return this.closing;
  }
}
// Test-only adapter; production startup requires PostgreSQL.
export class MemoryRepository implements Repository {
  private states = new Map<string, State>();
  private tails = new Map<string, Promise<unknown>>();
  async read(user: string): Promise<State> {
    await (this.tails.get(user) ?? Promise.resolve()).catch(() => {});
    return structuredClone(this.states.get(user) ?? emptyState());
  }
  async transact<T>(
    user: string,
    fn: (state: State) => Promise<T>,
  ): Promise<T> {
    const prior = this.tails.get(user) ?? Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(async () => {
        const s = structuredClone(this.states.get(user) ?? emptyState());
        const out = await fn(s);
        this.states.set(user, s);
        return out;
      });
    this.tails.set(user, work);
    return work;
  }
  async users(): Promise<string[]> {
    return [...this.states.keys()];
  }
  async close(): Promise<void> {}
}
export class Cursor {
  constructor(private key: string) {
    if (Buffer.byteLength(key) < 32)
      throw new Error("Cursor signing key requires 32 bytes");
  }
  encode(user: string, at: number, id: string): string {
    const data = Buffer.from(
      JSON.stringify({ u: user, a: at, i: id }),
    ).toString("base64url");
    return `${data}.${this.mac(data)}`;
  }
  decode(user: string, token: string): { at: number; id: string } {
    try {
      const [data, sig] = token.split(".");
      const a = Buffer.from(sig ?? ""),
        b = Buffer.from(this.mac(data));
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw 0;
      const v = JSON.parse(Buffer.from(data, "base64url").toString());
      if (v.u !== user || !Number.isSafeInteger(v.a) || typeof v.i !== "string")
        throw 0;
      return { at: v.a, id: v.i };
    } catch {
      throw new AgentError(
        "INVALID_CURSOR",
        "Cursor is invalid for this account.",
        false,
        400,
      );
    }
  }
  private mac(data: string): string {
    return createHmac("sha256", this.key).update(data).digest("base64url");
  }
}
export const nonce = () => randomBytes(32).toString("base64url");
