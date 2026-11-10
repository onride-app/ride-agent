import type pg from "pg";
import { AgentError } from "./contracts.js";

// Bump when the request graph, cost contracts, margin or plan algorithm changes.
// Account/network/route/scope identity is additionally part of the opaque owner.
export const ACCOUNT_OBSERVATION_COST_CONTRACT = "perps-cost-plan-v2";
export const ACCOUNT_OBSERVATION_PLAN_TTL_MS = 600000;

export type ObservationCostPlan = { demand: number; peaks: number[] };
export type ObservationPlanHint = {
  owner: string;
  generation: string | null;
  plan: ObservationCostPlan | null;
  remainingTtlMs: number;
};
export type ObservationPlanLease = Omit<ObservationPlanHint, "generation"> & {
  generation: string;
};
export interface ObservationPlanStore {
  read(owner: string, signal: AbortSignal): Promise<ObservationPlanHint>;
  begin(
    owner: string,
    signal: AbortSignal,
    expected?: ObservationPlanHint,
    maximumLeaseMs?: number,
  ): Promise<ObservationPlanLease>;
  complete(
    lease: ObservationPlanLease,
    plan: ObservationCostPlan,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Internal owned-lease cleanup only; never a completeness publication. */
  returnUnsent?(
    lease: ObservationPlanLease,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export function validObservationCostPlan(
  value: unknown,
  limit = 1000,
): ObservationCostPlan | null {
  const plan = value as ObservationCostPlan;
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1200 ||
    !Number.isSafeInteger(plan.demand) ||
    plan.demand < Math.min(120, limit) ||
    plan.demand > limit ||
    !Array.isArray(plan.peaks) ||
    plan.peaks.length < 1 ||
    plan.peaks.length > 3 ||
    plan.peaks.some(
      (peak) =>
        !Number.isSafeInteger(peak) ||
        peak < 1 ||
        peak > limit ||
        plan.demand < Math.min(limit, peak + 20),
    )
  )
    return null;
  return { demand: plan.demand, peaks: [...plan.peaks] };
}

export function costPlanUnavailable() {
  return new AgentError(
    "VENUE_COST_PLAN_UNAVAILABLE",
    "Account read-cost admission metadata is unavailable. Fresh complete evidence remains required.",
    true,
    503,
  );
}

/** Operational admission metadata only. Never financial evidence or fee credit. */
export class AccountObservationPlans implements ObservationPlanStore {
  private readonly unsentLeases = new WeakMap<
    ObservationPlanLease,
    {
      owner: string;
      generation: string;
      plan: ObservationCostPlan;
      remainingTtlMs: number;
      learnedStamp: string;
      leaseStamp: string;
      monotonicUntil: number;
      used: boolean;
    }
  >();
  constructor(private readonly pool: Pick<pg.Pool, "connect">) {}

  private async transaction<T>(
    signal: AbortSignal,
    work: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
    if (bounded.aborted) throw costPlanUnavailable();
    let client: pg.PoolClient | undefined,
      released = false,
      complete = false;
    let connectionError = false;
    const onError = () => {
      connectionError = true;
    };
    let cancel!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => {
        if (client && !released) {
          released = true;
          client.release(true);
        }
        reject(costPlanUnavailable());
      };
    });
    bounded.addEventListener("abort", cancel, { once: true });
    const connecting = this.pool.connect().then((connected) => {
      if (bounded.aborted) {
        connected.release(true);
        throw costPlanUnavailable();
      }
      client = connected;
      client.on("error", onError);
      return connected;
    });
    try {
      const connected = await Promise.race([connecting, aborted]);
      const result = await Promise.race([
        (async () => {
          await connected.query(
            "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout = '20s'",
          );
          const value = await work(connected);
          if (bounded.aborted || connectionError) throw costPlanUnavailable();
          await connected.query("COMMIT");
          if (bounded.aborted || connectionError) throw costPlanUnavailable();
          return value;
        })(),
        aborted,
      ]);
      complete = true;
      return result;
    } catch {
      throw costPlanUnavailable();
    } finally {
      bounded.removeEventListener("abort", cancel);
      if (client) {
        if (!released) client.release(!complete || connectionError);
        client.removeListener("error", onError);
      }
    }
  }

  async migrate(): Promise<void> {
    await this.transaction(AbortSignal.timeout(20000), async (client) => {
      // Serialize the additive DDL when independent bridge processes start
      // together. Generations are never reset and rows are never auto-deleted.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('ride_agent_account_cost_plans'))",
      );
      await client.query(`CREATE TABLE IF NOT EXISTS ride_agent_account_cost_plans (
        owner_key TEXT PRIMARY KEY CHECK (owner_key ~ '^[0-9a-f]{64}$'),
        contract TEXT NOT NULL,
        generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
        dirty BOOLEAN NOT NULL DEFAULT true,
        demand INTEGER NOT NULL DEFAULT 1000,
        peaks JSONB NOT NULL DEFAULT '[]',
        learned_at TIMESTAMPTZ,
        lease_until TIMESTAMPTZ
      )`);
      await client.query(
        "ALTER TABLE ride_agent_account_cost_plans ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ",
      );
    });
  }

  private async locked(
    client: pg.PoolClient,
    owner: string,
  ): Promise<
    ObservationPlanHint & {
      busy: boolean;
      currentMs: number;
      learnedStamp?: string;
      leaseStamp?: string;
    }
  > {
    const result = await client.query(
      `WITH locked AS MATERIALIZED (SELECT contract,generation::text,dirty,demand,peaks,
      floor(extract(epoch FROM learned_at)*1000)::text AS learned_ms,
      floor(extract(epoch FROM lease_until)*1000)::text AS lease_ms,
      to_char(learned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS learned_stamp,
      to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lease_stamp
      FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE)
      SELECT locked.*,floor(extract(epoch FROM clock_timestamp())*1000)::text AS current_ms FROM locked`,
      [owner],
    );
    // The materialized row must pass FOR UPDATE (including its wait/EPQ)
    // before the outer projection evaluates the wall clock. An empty result
    // has no projection, so retain the independent clock query in that case.
    const timestamp = result.rows.length
      ? result
      : await client.query(
          "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS current_ms",
        );
    const millis = (value: unknown): number =>
      typeof value === "string" &&
      /^[1-9][0-9]*$/.test(value) &&
      Number.isSafeInteger(Number(value))
        ? Number(value)
        : NaN;
    const current = millis(timestamp.rows[0]?.current_ms);
    if (!Number.isSafeInteger(current)) throw costPlanUnavailable();
    if (!result.rows.length)
      return {
        owner,
        generation: null,
        plan: null,
        remainingTtlMs: 0,
        busy: false,
        currentMs: current,
      };
    if (result.rows.length !== 1) throw costPlanUnavailable();
    const row = result.rows[0];
    if (
      typeof row.generation !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/.test(row.generation)
    )
      throw costPlanUnavailable();
    const age = current - millis(row.learned_ms);
    const plan =
      row.contract === ACCOUNT_OBSERVATION_COST_CONTRACT &&
      row.dirty === false &&
      age >= 0 &&
      age < ACCOUNT_OBSERVATION_PLAN_TTL_MS
        ? validObservationCostPlan(row)
        : null;
    return {
      owner,
      generation: row.generation,
      plan,
      remainingTtlMs: plan ? ACCOUNT_OBSERVATION_PLAN_TTL_MS - age : 0,
      busy: row.dirty === true && millis(row.lease_ms) > current,
      currentMs: current,
      learnedStamp: row.learned_stamp,
      leaseStamp: row.lease_stamp,
    };
  }

  async read(owner: string, signal: AbortSignal): Promise<ObservationPlanHint> {
    if (!/^[0-9a-f]{64}$/.test(owner)) throw costPlanUnavailable();
    return this.transaction(signal, async (client) => {
      const {
        busy,
        currentMs: _current,
        learnedStamp: _learned,
        leaseStamp: _lease,
        ...hint
      } = await this.locked(client, owner);
      if (busy) throw costPlanUnavailable();
      return hint;
    });
  }

  async begin(
    owner: string,
    signal: AbortSignal,
    expected?: ObservationPlanHint,
    maximumLeaseMs = 20000,
  ): Promise<ObservationPlanLease> {
    if (
      !/^[0-9a-f]{64}$/.test(owner) ||
      !Number.isSafeInteger(maximumLeaseMs) ||
      maximumLeaseMs <= 0 ||
      maximumLeaseMs > 20000 ||
      (expected && expected.owner !== owner)
    )
      throw costPlanUnavailable();
    const started = performance.now();
    let prior:
      | {
          plan: ObservationCostPlan;
          learnedStamp: string;
          leaseStamp: string;
          monotonicUntil: number;
        }
      | undefined;
    const lease = await this.transaction(signal, async (client) => {
      if (typeof expected?.generation !== "string")
        await client.query(
          `INSERT INTO ride_agent_account_cost_plans (owner_key,contract) VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [owner, ACCOUNT_OBSERVATION_COST_CONTRACT],
        );
      const current = await this.locked(client, owner);
      const expectedGeneration =
        expected?.generation === null ? "0" : expected?.generation;
      if (
        current.busy ||
        (expected &&
          (expectedGeneration !== current.generation ||
            JSON.stringify(expected.plan) !== JSON.stringify(current.plan)))
      )
        throw costPlanUnavailable();
      const leaseMs = Math.floor(
        maximumLeaseMs - Math.max(0, performance.now() - started),
      );
      if (leaseMs <= 0) throw costPlanUnavailable();
      const dirty = await client.query(
        `UPDATE ride_agent_account_cost_plans SET contract=$2,generation=generation+1,dirty=true,
        lease_until=to_timestamp($3::double precision/1000) WHERE owner_key=$1
        RETURNING generation::text,
        to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lease_stamp`,
        [owner, ACCOUNT_OBSERVATION_COST_CONTRACT, current.currentMs + leaseMs],
      );
      const generation = dirty.rows[0]?.generation;
      if (typeof generation !== "string" || !/^[1-9][0-9]*$/.test(generation))
        throw costPlanUnavailable();
      const stamp = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
      if (
        current.plan &&
        typeof current.learnedStamp === "string" &&
        stamp.test(current.learnedStamp) &&
        typeof dirty.rows[0]?.lease_stamp === "string" &&
        stamp.test(dirty.rows[0].lease_stamp)
      )
        prior = {
          plan: structuredClone(current.plan),
          learnedStamp: current.learnedStamp,
          leaseStamp: dirty.rows[0].lease_stamp,
          monotonicUntil:
            started + Math.min(maximumLeaseMs, current.remainingTtlMs),
        };
      return {
        owner,
        generation,
        plan: current.plan,
        remainingTtlMs: current.remainingTtlMs,
      };
    });
    // No capability exists when COMMIT fails or its result is ambiguous.
    if (prior)
      this.unsentLeases.set(lease, {
        owner: lease.owner,
        generation: lease.generation,
        plan: prior.plan,
        remainingTtlMs: lease.remainingTtlMs,
        learnedStamp: prior.learnedStamp,
        leaseStamp: prior.leaseStamp,
        used: false,
        monotonicUntil: prior.monotonicUntil,
      });
    return lease;
  }

  async returnUnsent(
    lease: ObservationPlanLease,
    signal: AbortSignal,
  ): Promise<boolean> {
    const original = this.unsentLeases.get(lease);
    if (!original || original.used) return false;
    original.used = true;
    const remaining = Math.floor(original.monotonicUntil - performance.now());
    if (
      remaining <= 0 ||
      signal.aborted ||
      lease.owner !== original.owner ||
      lease.generation !== original.generation ||
      lease.remainingTtlMs !== original.remainingTtlMs ||
      JSON.stringify(lease.plan) !== JSON.stringify(original.plan)
    )
      return false;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
    return this.transaction(bounded, async (client) => {
      const current = await this.locked(client, original.owner);
      if (
        bounded.aborted ||
        performance.now() >= original.monotonicUntil ||
        !current.busy ||
        current.generation !== original.generation ||
        current.learnedStamp !== original.learnedStamp ||
        current.leaseStamp !== original.leaseStamp
      )
        return false;
      const result = await client.query(
        `UPDATE ride_agent_account_cost_plans
        SET dirty=false,lease_until=NULL
        WHERE owner_key=$1 AND contract=$2 AND generation=$3::bigint AND dirty=true
        AND demand=$4 AND peaks=$5::jsonb
        AND to_char(learned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=$6
        AND to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')=$7
        AND learned_at<=clock_timestamp()
        AND learned_at>clock_timestamp()-INTERVAL '600 seconds'
        AND lease_until>clock_timestamp() RETURNING owner_key`,
        [
          original.owner,
          ACCOUNT_OBSERVATION_COST_CONTRACT,
          original.generation,
          original.plan.demand,
          JSON.stringify(original.plan.peaks),
          original.learnedStamp,
          original.leaseStamp,
        ],
      );
      return result.rows.length === 1;
    });
  }

  async complete(
    lease: ObservationPlanLease,
    value: ObservationCostPlan,
    signal: AbortSignal,
  ): Promise<boolean> {
    const plan = validObservationCostPlan(value);
    if (
      !plan ||
      !/^[0-9a-f]{64}$/.test(lease.owner) ||
      !/^[1-9][0-9]*$/.test(lease.generation)
    )
      throw costPlanUnavailable();
    return this.transaction(signal, async (client) => {
      const current = await this.locked(client, lease.owner);
      if (!current.busy || current.generation !== lease.generation)
        return false;
      const result = await client.query(
        `UPDATE ride_agent_account_cost_plans
        SET demand=$4,peaks=$5::jsonb,learned_at=clock_timestamp(),dirty=false,lease_until=NULL
        WHERE owner_key=$1 AND contract=$2 AND generation=$3::bigint AND dirty=true AND lease_until>clock_timestamp()
        RETURNING owner_key`,
        [
          lease.owner,
          ACCOUNT_OBSERVATION_COST_CONTRACT,
          lease.generation,
          plan.demand,
          JSON.stringify(plan.peaks),
        ],
      );
      return result.rows.length === 1;
    });
  }
}
