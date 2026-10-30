import { createHash } from "node:crypto";
import type pg from "pg";
import { AgentError } from "./contracts.js";
import type { Candidate } from "./domain.js";

export function sourceRequiresRwa(trader: Candidate): boolean {
  return (
    trader.market === "perps" &&
    (trader.asset_category === "rwa" ||
      trader.assets.some((asset) => asset.includes(":")) ||
      Object.values(trader.asset_categories ?? {}).some(
        (kind) => kind === "rwa",
      ))
  );
}

export type PerpsSourceIdentity = { address: string; requires_rwa: boolean };
type HistoricalIdentity = { address: string; requires_rwa: boolean | null };
type IdentityPage = {
  identities: HistoricalIdentity[];
  next_cursor: string | null;
  complete: boolean;
};
type ReadPage = (
  input: { limit: number; cursor?: string },
  signal: AbortSignal,
) => Promise<unknown>;

const addressPattern = /^0x[0-9a-f]{40}$/;
const idPattern = /^trader_[0-9a-f]{32}$/;

function unavailable(code = "SOURCE_IDENTITY_UNAVAILABLE") {
  return new AgentError(
    code,
    "Original source identity or observation scope is unavailable. Fresh source evidence remains required.",
    true,
    503,
  );
}

/** Identity evidence only. No scores, eligibility, balances, or source frames. */
export class PerpsSourceIdentities {
  private readonly known = new Map<string, PerpsSourceIdentity>();
  private scanCache?: {
    until: number;
    identities: Map<string, HistoricalIdentity>;
  };
  private scanFlight?: Promise<Map<string, HistoricalIdentity>>;
  private scanFailure?: { until: number; error: unknown };

  constructor(
    private readonly pool: Pick<pg.Pool, "query">,
    private readonly salt: string,
    private readonly readPage: ReadPage,
    private readonly clock: () => number = Date.now,
  ) {}

  id(address: string): string {
    return (
      "trader_" +
      createHash("sha256")
        .update(`${this.salt}:perps:${address.toLowerCase()}`)
        .digest("hex")
        .slice(0, 32)
    );
  }

  async migrate(): Promise<void> {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ride_agent_perps_source_identities (
      trader_id TEXT PRIMARY KEY CHECK (trader_id ~ '^trader_[0-9a-f]{32}$'),
      wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
      requires_rwa BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  }

  private check(identity: unknown): asserts identity is PerpsSourceIdentity {
    const row = identity as PerpsSourceIdentity;
    if (
      !row ||
      typeof row !== "object" ||
      !addressPattern.test(row.address) ||
      typeof row.requires_rwa !== "boolean"
    )
      throw unavailable("SOURCE_SCOPE_UNAVAILABLE");
  }

  async remember(identities: PerpsSourceIdentity[]): Promise<void> {
    const unique = new Map<string, PerpsSourceIdentity>();
    for (const identity of identities) {
      this.check(identity);
      const id = this.id(identity.address);
      const previous = unique.get(id);
      if (previous && previous.address !== identity.address)
        throw unavailable("SOURCE_IDENTITY_CONFLICT");
      unique.set(id, {
        address: identity.address,
        requires_rwa: Boolean(previous?.requires_rwa || identity.requires_rwa),
      });
    }
    if (!unique.size) return;
    const rows = [...unique];
    // Address identity is immutable. Scope may only become more conservative;
    // a later native-only recommendation cannot forget an observed RWA scope.
    const result = await this.pool.query<{
      trader_id: string;
      wallet_address: string;
      requires_rwa: boolean;
    }>(
      `INSERT INTO ride_agent_perps_source_identities (trader_id,wallet_address,requires_rwa)
       SELECT * FROM unnest($1::text[],$2::text[],$3::boolean[])
       ON CONFLICT (trader_id) DO UPDATE SET requires_rwa=ride_agent_perps_source_identities.requires_rwa OR EXCLUDED.requires_rwa
       WHERE ride_agent_perps_source_identities.wallet_address=EXCLUDED.wallet_address
       RETURNING trader_id,wallet_address,requires_rwa`,
      [
        rows.map(([id]) => id),
        rows.map(([, row]) => row.address),
        rows.map(([, row]) => row.requires_rwa),
      ],
    );
    if (result.rows.length !== rows.length)
      throw unavailable("SOURCE_IDENTITY_CONFLICT");
    for (const row of result.rows)
      this.cache(row.trader_id, {
        address: row.wallet_address,
        requires_rwa: row.requires_rwa,
      });
  }

  private cache(id: string, identity: PerpsSourceIdentity): void {
    this.check(identity);
    if (this.id(identity.address) !== id)
      throw unavailable("SOURCE_IDENTITY_CONFLICT");
    const previous = this.known.get(id);
    if (previous && previous.address !== identity.address)
      throw unavailable("SOURCE_IDENTITY_CONFLICT");
    if (this.known.size >= 5000 && !this.known.has(id))
      this.known.delete(this.known.keys().next().value!);
    this.known.set(id, {
      ...identity,
      requires_rwa: Boolean(previous?.requires_rwa || identity.requires_rwa),
    });
  }

  async resolve(
    id: string,
    minimumRequiresRwa = false,
  ): Promise<PerpsSourceIdentity> {
    if (!idPattern.test(id)) throw unavailable("SOURCE_IDENTITY_INVALID");
    const cached = this.known.get(id);
    // A true floor is monotonic. A native floor must observe a concurrent
    // bridge's durable upgrade instead of caching false for this process.
    if (cached?.requires_rwa) return { ...cached };
    const saved = await this.pool.query<{
      wallet_address: string;
      requires_rwa: boolean;
    }>(
      "SELECT wallet_address,requires_rwa FROM ride_agent_perps_source_identities WHERE trader_id=$1",
      [id],
    );
    if (saved.rows.length) {
      if (saved.rows.length !== 1)
        throw unavailable("SOURCE_IDENTITY_CONFLICT");
      const identity = {
        address: saved.rows[0].wallet_address,
        requires_rwa: saved.rows[0].requires_rwa,
      };
      this.cache(id, identity);
      if (minimumRequiresRwa && !identity.requires_rwa)
        await this.remember([
          { address: identity.address, requires_rwa: true },
        ]);
      return { ...this.known.get(id)! };
    }
    const identity = (await this.historicalIdentities()).get(id);
    if (!identity)
      throw new AgentError(
        "NOT_FOUND",
        "Original source identity is unavailable.",
        false,
        404,
      );
    if (identity.requires_rwa === null && !minimumRequiresRwa)
      throw unavailable("SOURCE_SCOPE_UNAVAILABLE");
    await this.remember([
      {
        address: identity.address,
        requires_rwa: minimumRequiresRwa || identity.requires_rwa === true,
      },
    ]);
    return { ...this.known.get(id)! };
  }

  private async historicalIdentities(): Promise<
    Map<string, HistoricalIdentity>
  > {
    if (this.scanCache && this.scanCache.until > this.clock())
      return this.scanCache.identities;
    if (this.scanFlight) return this.scanFlight;
    if (this.scanFailure && this.scanFailure.until > this.clock())
      throw this.scanFailure.error;
    const flight = this.scan();
    this.scanFlight = flight;
    try {
      const identities = await flight;
      this.scanCache = { until: this.clock() + 30_000, identities };
      this.scanFailure = undefined;
      return identities;
    } catch (error) {
      const safe = error instanceof AgentError ? error : unavailable();
      this.scanFailure = { until: this.clock() + 5_000, error: safe };
      throw safe;
    } finally {
      if (this.scanFlight === flight) this.scanFlight = undefined;
    }
  }

  private async scan(): Promise<Map<string, HistoricalIdentity>> {
    const signal = AbortSignal.timeout(12_000);
    const identities = new Map<string, HistoricalIdentity>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      signal.throwIfAborted();
      const page = (await this.readPage(
        { limit: 500, ...(cursor ? { cursor } : {}) },
        signal,
      )) as IdentityPage;
      signal.throwIfAborted();
      if (
        !page ||
        typeof page !== "object" ||
        !Array.isArray(page.identities) ||
        page.identities.length > 500 ||
        typeof page.complete !== "boolean" ||
        (page.next_cursor !== null &&
          (typeof page.next_cursor !== "string" ||
            !addressPattern.test(page.next_cursor))) ||
        page.complete !== (page.next_cursor === null)
      )
        throw unavailable();
      let last = cursor;
      for (const identity of page.identities) {
        if (
          !identity ||
          typeof identity !== "object" ||
          !addressPattern.test(identity.address) ||
          ![true, false, null].includes(identity.requires_rwa)
        )
          throw unavailable("SOURCE_SCOPE_UNAVAILABLE");
        if (last && identity.address <= last)
          throw unavailable("SOURCE_IDENTITY_CONFLICT");
        last = identity.address;
        const id = this.id(identity.address);
        if (identities.has(id)) throw unavailable("SOURCE_IDENTITY_CONFLICT");
        identities.set(id, {
          address: identity.address,
          requires_rwa: identity.requires_rwa,
        });
      }
      if (page.complete) return identities;
      if (!last || last === cursor || page.next_cursor !== last)
        throw unavailable();
      cursor = page.next_cursor!;
    }
    throw unavailable();
  }
}
