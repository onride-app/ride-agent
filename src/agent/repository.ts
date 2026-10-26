import pg from "pg";
import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import type { Plan, Portfolio } from "./domain.js";
import { AgentError, type Preferences } from "./contracts.js";

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
  transact<T>(user: string, fn: (state: State) => Promise<T>): Promise<T>;
  users(): Promise<string[]>;
  close(): Promise<void>;
}
export class PgRepository implements Repository {
  readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
  }
  async migrate(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ride_agent_state (user_id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    );
  }
  async transact<T>(
    user: string,
    fn: (state: State) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      await c.query("SET LOCAL idle_in_transaction_session_timeout = '90s'");
      await c.query(
        "INSERT INTO ride_agent_state(user_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [user, emptyState()],
      );
      const r = await c.query(
        "SELECT state FROM ride_agent_state WHERE user_id=$1 FOR UPDATE",
        [user],
      );
      const s = r.rows[0].state as State;
      const out = await fn(s);
      await c.query(
        "UPDATE ride_agent_state SET state=$2, updated_at=now() WHERE user_id=$1",
        [user, s],
      );
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async users(): Promise<string[]> {
    return (
      await this.pool.query(
        "SELECT user_id FROM ride_agent_state WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(state->'portfolios') p WHERE p->>'state' <> 'closed') OR EXISTS (SELECT 1 FROM jsonb_array_elements(state->'updates') u WHERE u->>'notification' = 'pending') OR state->'notification_preferences'->>'daily_digest' = 'true'",
      )
    ).rows.map((x) => x.user_id);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
// Test-only adapter; production startup requires PostgreSQL.
export class MemoryRepository implements Repository {
  private states = new Map<string, State>();
  private tails = new Map<string, Promise<unknown>>();
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
