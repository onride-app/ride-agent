#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import { VERSION } from "../version.js";
import { firebaseAccount } from "./firebase.js";
import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import {
  createHash,
  createSign,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DepositReads } from "./deposits.js";
import { PredictionVenue } from "./prediction.js";
import { AgentError, failure, errorDetails } from "./contracts.js";
import { VenueReads } from "./venue-reads.js";
import { SourceFeed } from "./source-feed.js";
import { perpsAccountMode, unifiedUsdc } from "./perps_account.js";
import {
  checkPerpsOrder,
  HYPERLIQUID_MIN_OPEN_NOTIONAL_USDC,
} from "./order_rules.js";
import {
  D,
  cash,
  fingerprint,
  now,
  fresh,
  PERPS_COPY_MAX_LEVERAGE,
  type Candidate,
  type AccountSnapshot,
  type Portfolio,
  type Execution,
  type PositionIntent,
} from "./domain.js";

const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
};
export class CoreBridge {
  private venueReads = new VenueReads();
  private sourceFeed = new SourceFeed((id) => this.readSource(id));
  private pool: pg.Pool;
  private prediction: PredictionVenue;
  private taxonomyCache: { at: number; values: Map<string, string> } | null =
    null;
  private candidatesCache: { at: number; rows: any[] } | null = null;
  private discoveryCache: { until: number; rows: Candidate[] } | null = null;
  private discoveryFlight: Promise<Candidate[]> | null = null;
  private discoveryFailure: { until: number; error: AgentError } | null = null;
  private candleReads = new Map<
    string,
    { until: number; read: Promise<any[]> }
  >();
  private tokens: { value: string; expiry: number } | null = null;
  constructor(
    private coreUrl: string,
    private coreToken: string,
    database: string,
    private salt: string,
    private network: "testnet" | "mainnet",
  ) {
    this.pool = new pg.Pool({ connectionString: database, max: 10 });
    this.prediction = new PredictionVenue(
      this.pool,
      (op, input) => this.core(op, input),
      salt,
      process.env.RIDE_AGENT_POLYGON_RPC_URL,
    );
    if (salt.length < 32)
      throw Error("Trader identity salt must contain 32 characters");
  }
  async migrate() {
    await this.prediction.migrate();
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ride_agent_core_outbox (execution_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,portfolio_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload JSONB NOT NULL,response JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    );
  }
  async close() {
    this.sourceFeed.close();
    await this.pool.end();
  }
  private async control(operation: string, payload: any): Promise<any> {
    const id = `control:${payload.request_id}`;
    await this.pool.query(
      "INSERT INTO ride_agent_core_outbox(execution_id,user_id,portfolio_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        id,
        payload.user_id,
        payload.account_id,
        operation,
        { operation, input: payload },
      ],
    );
    const saved = await this.pool.query(
      "SELECT user_id,portfolio_id,fingerprint,payload,response FROM ride_agent_core_outbox WHERE execution_id=$1",
      [id],
    );
    const row = saved.rows[0];
    if (
      row.user_id !== payload.user_id ||
      row.portfolio_id !== payload.account_id ||
      row.fingerprint !== operation
    )
      throw new AgentError(
        "IDEMPOTENCY_MISMATCH",
        "Control identifier belongs to a different account.",
      );
    if (row.response) return row.response;
    const response = await this.core(row.payload.operation, row.payload.input);
    await this.pool.query(
      "UPDATE ride_agent_core_outbox SET response=$2 WHERE execution_id=$1",
      [id, response],
    );
    return response;
  }
  private async core(operation: string, input: unknown): Promise<any> {
    const r = await fetch(
      new URL(`/internal/agent-core/${operation}`, this.coreUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.coreToken}`,
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(
          operation.startsWith("perps_funding_") ? 90000 : 20000,
        ),
        redirect: "error",
      },
    );
    const body = (await r.json()) as any;
    if (!r.ok) {
      const context = errorDetails.safeParse({
        operation: body.error?.operation,
        grpc_code: body.error?.grpc_code ?? undefined,
        reason_code: body.error?.reason_code,
        retry_after_ms: body.error?.retry_after_ms,
      });
      throw new AgentError(
        body.error?.code ?? "CORE_UNAVAILABLE",
        body.error?.message ?? "Core operation failed",
        typeof body.error?.retryable === "boolean"
          ? body.error.retryable
          : r.status >= 500,
        r.status,
        context.success ? context.data : undefined,
      );
    }
    return body;
  }
  private async info(payload: unknown, source = false): Promise<any> {
    const url =
      source || this.network === "mainnet"
        ? "https://api.hyperliquid.xyz/info"
        : "https://api.hyperliquid-testnet.xyz/info";
    const type = (payload as { type?: string })?.type;
    const ttl = ["meta", "perpDexs", "perpCategories"].includes(type ?? "")
      ? 30_000
      : type === "allMids"
        ? 1000
        : 0;
    return this.venueReads.read(
      url,
      payload,
      ttl,
      source ? "source" : "account",
    );
  }
  private traderId(address: string) {
    return `trader_${createHash("sha256").update(`${this.salt}:perps:${address.toLowerCase()}`).digest("hex").slice(0, 32)}`;
  }
  private async rows() {
    if (this.candidatesCache && now() - this.candidatesCache.at < 30_000)
      return this.candidatesCache.rows;
    const rows = await this.core("perps_pool", {});
    if (!Array.isArray(rows)) throw Error("Invalid trader pool");
    this.candidatesCache = { at: now(), rows };
    return rows;
  }
  private async resolve(id: string) {
    const row = (await this.rows()).find(
      (r: any) => this.traderId(r.address) === id,
    );
    if (!row)
      throw new AgentError(
        "NOT_FOUND",
        "Fresh trader identity is unavailable.",
        false,
        404,
      );
    return row;
  }
  private async taxonomy(): Promise<Map<string, string>> {
    if (this.taxonomyCache && fresh(this.taxonomyCache.at, 3600_000))
      return this.taxonomyCache.values;
    const rows = await this.info({ type: "perpCategories" }, true);
    if (
      !Array.isArray(rows) ||
      !rows.length ||
      rows.some(
        (r: any) =>
          !Array.isArray(r) ||
          r.length !== 2 ||
          typeof r[0] !== "string" ||
          typeof r[1] !== "string",
      )
    )
      throw new AgentError(
        "TAXONOMY_UNAVAILABLE",
        "Official asset classification is unavailable.",
        true,
        503,
      );
    const values = new Map<string, string>(
      rows.map((r: any) => [r[0], r[1].toLowerCase()]),
    );
    this.taxonomyCache = { at: now(), values };
    return values;
  }
  private async standardMode(address: string, source = false) {
    const [mode, abstraction] = await Promise.all([
      this.info({ type: "userAbstraction", user: address }, source),
      this.info({ type: "userDexAbstraction", user: address }, source),
    ]);
    if (
      !["standard", "disabled"].includes(mode) ||
      ![false, null].includes(abstraction)
    )
      throw new AgentError(
        "ACCOUNT_MODE_UNSUPPORTED",
        "This dedicated RWA flow requires Standard mode; unified or portfolio-margin balances cannot be counted as separate DEX collateral.",
      );
  }
  async source(id: string) {
    return this.sourceFeed.read(id);
  }
  private async readSource(id: string) {
    if (
      process.env.RIDE_AGENT_PREDICTION_ENABLED === "true" &&
      (await this.prediction.recognizes(id))
    )
      return this.prediction.source(id);
    const row = await this.resolve(id),
      state = await this.info(
        { type: "clearinghouseState", user: row.address },
        true,
      );
    if (
      process.env.RIDE_AGENT_RWA_ENABLED === "true" &&
      row.tags?.includes("category:stocks_rwa")
    ) {
      await this.standardMode(row.address, true);
      const taxonomy = await this.taxonomy(),
        scopes = [
          ...new Set(
            [...taxonomy]
              .filter(([_, c]) =>
                ["stocks", "commodities", "indices", "fx", "preipo"].includes(
                  c,
                ),
              )
              .map(([a]) => a.split(":")[0]),
          ),
        ].filter(
          (s) => s && [...taxonomy.keys()].some((a) => a.startsWith(s + ":")),
        );
      for (let offset = 0; offset < scopes.length; offset += 3) {
        const observations = await Promise.all(
          scopes.slice(offset, offset + 3).map(async (dex) => ({
            dex,
            state: await this.info(
              { type: "clearinghouseState", user: row.address, dex },
              true,
            ),
            meta: await this.info({ type: "meta", dex }, true),
          })),
        );
        for (const observation of observations) {
          if (observation.meta.collateralToken !== 0) {
            if (
              observation.state.assetPositions?.some(
                (x: any) => !D(x.position?.szi ?? 0).isZero(),
              )
            )
              throw new AgentError(
                "UNSUPPORTED_COLLATERAL",
                "Source RWA positions use non-USDC collateral.",
              );
            continue;
          }
          if (
            !Array.isArray(observation.state.assetPositions) ||
            observation.state.marginSummary?.accountValue == null
          )
            throw new AgentError(
              "SOURCE_STALE",
              "Source RWA scope is incomplete.",
              true,
            );
          state.marginSummary.accountValue = D(state.marginSummary.accountValue)
            .plus(observation.state.marginSummary.accountValue)
            .toString();
          state.assetPositions.push(
            ...observation.state.assetPositions.map((item: any) => ({
              ...item,
              position: {
                ...item.position,
                coin: item.position.coin.includes(":")
                  ? item.position.coin
                  : observation.dex + ":" + item.position.coin,
              },
            })),
          );
        }
      }
    }
    if (
      !state.marginSummary?.accountValue ||
      !Array.isArray(state.assetPositions)
    )
      throw new AgentError(
        "SOURCE_STALE",
        "Trader account state is incomplete.",
        true,
      );
    const at = now();
    const positions: PositionIntent[] = state.assetPositions
      .map((item: any) => item.position)
      .filter(
        (x: any) =>
          x &&
          x.coin &&
          (process.env.RIDE_AGENT_RWA_ENABLED === "true" ||
            !x.coin.includes(":")) &&
          !D(x.szi).isZero(),
      )
      .map((x: any) => ({
        key: `perps:${x.coin}`,
        asset: x.coin,
        market: "perps",
        quantity: String(x.szi),
        price: D(x.positionValue).abs().div(D(x.szi).abs()).toString(),
        source_entry_price: x.entryPx ?? null,
        source_leverage: Number(x.leverage?.value ?? 1),
        source_leverage_verified:
          x.leverage?.value != null &&
          Number.isFinite(Number(x.leverage.value)) &&
          Number(x.leverage.value) >= 1,
        observed_at: at,
        source_revision: "",
      }));
    const revision = fingerprint(
      positions.map((p) => [
        p.key,
        p.quantity,
        p.source_leverage,
        p.source_entry_price,
      ]),
    );
    for (const p of positions) p.source_revision = revision;
    return {
      observed_at: at,
      revision,
      account_value_usdc: String(state.marginSummary.accountValue),
      positions,
      complete:
        process.env.RIDE_AGENT_RWA_ENABLED === "true" ||
        !state.assetPositions.some((x: any) => x.position?.coin?.includes(":")),
    };
  }
  private async profileCandles(asset: string): Promise<any[]> {
    const end = Math.floor(now() / 86400_000) * 86400_000;
    const key = `${asset}:${end}`;
    for (const [key, entry] of this.candleReads)
      if (entry.until <= now()) this.candleReads.delete(key);
    let entry = this.candleReads.get(key);
    if (!entry) {
      // These are closed daily candles, shared across traders. Never cache a
      // live source/account read used by execution.
      if (this.candleReads.size >= 128)
        this.candleReads.delete(this.candleReads.keys().next().value!);
      entry = {
        until: now() + 5 * 60_000,
        read: this.info(
          {
            type: "candleSnapshot",
            req: {
              coin: asset,
              interval: "1d",
              startTime: end - 16 * 86400_000,
              endTime: end - 1,
            },
          },
          true,
        ).catch((error) => {
          // A failed optional ATR read must not fan out across every trader.
          entry!.until =
            now() + (error?.code === "VENUE_RATE_LIMITED" ? 60_000 : 2000);
          throw error;
        }),
      };
      this.candleReads.set(key, entry);
    }
    return structuredClone(await entry.read);
  }
  async profile(id: string): Promise<Candidate> {
    if (
      process.env.RIDE_AGENT_PREDICTION_ENABLED === "true" &&
      (await this.prediction.recognizes(id))
    )
      return this.prediction.profile(id);
    const row = await this.resolve(id),
      source = await this.source(id);
    let raw: any = {};
    try {
      raw = JSON.parse(row.raw ?? "{}");
    } catch {}
    const components: Record<string, number | null> = {};
    const scoring = raw.copyScoreV2_5 ?? {};
    const tier =
      typeof scoring.displayTier === "string" ? scoring.displayTier : null;
    const rawQuality =
      typeof scoring.rawQualityScore === "number" &&
      Number.isFinite(scoring.rawQualityScore)
        ? scoring.rawQualityScore
        : null;
    const displayCap =
      row.score_version === "strict_perp_v2_5_daily_live_v1"
        ? tier === "B 观察"
          ? 84.99
          : tier === "C 谨慎"
            ? 69.99
            : null
        : null;
    const sameMetric = (a: unknown, b: unknown) =>
      a != null &&
      b != null &&
      Number.isFinite(Number(a)) &&
      Number(a) === Number(b);
    // The fixed-pool score snapshot stores ROI in percentage points despite
    // Core's legacy `roi_ratio` label. Use the explicitly windowed raw metric
    // instead of applying a second 100x conversion to that ambiguous alias.
    const monthRoi = raw.metrics?.monthRoi;
    const allTimeRoi = raw.metrics?.allTimeRoi;
    const roiPeriod =
      typeof monthRoi === "number" && Number.isFinite(monthRoi)
        ? "source_month"
        : typeof allTimeRoi === "number" && Number.isFinite(allTimeRoi)
          ? "source_all_time"
          : "unavailable";
    const roiPercent =
      roiPeriod === "source_month"
        ? D(monthRoi).times(100).toNumber()
        : roiPeriod === "source_all_time"
          ? D(allTimeRoi).times(100).toNumber()
          : null;
    const drawdownSource =
      raw.metrics?.riskHistorySource ?? raw.metrics?.maxDrawdownSource;
    const drawdownPeriod =
      typeof drawdownSource === "string" &&
      sameMetric(row.drawdown_ratio, raw.metrics?.maxDrawdown)
        ? drawdownSource.includes("AllTime") ||
          drawdownSource.includes("allTime")
          ? "source_all_time"
          : drawdownSource.includes("perpMonth")
            ? "source_month"
            : "unavailable"
        : "unavailable";
    for (const name of [
      "stability",
      "pathSmoothness",
      "drawdownRecovery",
      "profitQuality",
      "profitConcentration",
      "positionLeverageStability",
      "copyability",
      "trackRecord",
    ]) {
      const v = raw.copyScoreV2_5?.components?.[name];
      components[name] =
        typeof v === "number"
          ? v
          : typeof v?.score === "number"
            ? v.score
            : null;
    }
    const assets = [...new Set(source.positions.map((x) => x.asset))];
    const taxonomy = assets.some((a) => a.includes(":"))
      ? await this.taxonomy()
      : new Map<string, string>();
    const classifications = assets.map(
      (a) => taxonomy.get(a) ?? (a.includes(":") ? "unknown" : "crypto"),
    );
    const assetCategory = row.tags?.includes("category:stocks_rwa")
      ? "rwa"
      : classifications.length && classifications.every((c) => c === "crypto")
        ? "crypto"
        : classifications.length &&
            classifications.every((c) =>
              ["stocks", "commodities", "indices", "fx", "preipo"].includes(c),
            )
          ? "rwa"
          : classifications.includes("unknown")
            ? "unknown"
            : "mixed";
    const directions = new Set(
      source.positions.map((x) =>
        D(x.quantity).isPositive() ? "long" : "short",
      ),
    );
    const handle =
      typeof row.handle === "string" && !/0x[a-fA-F0-9]{40}/.test(row.handle)
        ? row.handle
        : `Ride trader ${id.slice(-6)}`;
    let atr: number | null = null;
    try {
      const returns: number[] = [];
      for (const asset of assets.slice(0, 3)) {
        const candles = await this.profileCandles(asset);
        if (candles.length < 15) continue;
        const sorted = candles.sort((a: any, b: any) => a.t - b.t);
        const tr = sorted.slice(-14).map((c: any, i: number) => {
          const previous = sorted[sorted.length - 15 + i];
          return D.max(
            D(c.h).minus(c.l),
            D(c.h).minus(previous.c).abs(),
            D(c.l).minus(previous.c).abs(),
          );
        });
        const last = sorted.at(-1);
        returns.push(
          tr
            .reduce((n: any, v: any) => n.plus(v), D(0))
            .div(14)
            .div(last.c)
            .times(100)
            .toNumber(),
        );
      }
      if (returns.length) atr = Math.max(...returns);
    } catch {
      /* Missing ATR stays unavailable; new Ride recommendations follow source leverage. */
    }
    return {
      id,
      handle,
      market: "perps",
      asset_category: assetCategory as Candidate["asset_category"],
      asset_categories: Object.fromEntries(
        assets.map((a, i) => [
          a,
          classifications[i] === "crypto"
            ? "crypto"
            : ["stocks", "commodities", "indices", "fx", "preipo"].includes(
                  classifications[i],
                )
              ? "rwa"
              : "unknown",
        ]),
      ) as Candidate["asset_categories"],
      execution_supported:
        source.complete &&
        (assetCategory !== "rwa" ||
          process.env.RIDE_AGENT_RWA_ENABLED === "true"),
      score: Number(row.score),
      score_version: row.score_version,
      score_explanation: {
        tier,
        raw_quality_score: rawQuality,
        display_cap: displayCap,
        cap_applied:
          displayCap == null || rawQuality == null
            ? null
            : rawQuality > displayCap && Number(row.score) === displayCap,
        note:
          row.score_version === "strict_perp_v2_5_daily_live_v1"
            ? "B observation scores are capped at 84.99 and C caution scores at 69.99 in this score version. Equal display scores do not imply equal raw quality or returns; public trader ID breaks score ties. Missing tier or raw quality cannot establish why a score tied."
            : "Score tier limits are unavailable for this score version. Equal display scores do not imply equal quality or returns; public trader ID breaks score ties.",
      },
      metric_periods: {
        roi: {
          period: roiPeriod,
          start_at: null,
          end_at: null,
          basis:
            roiPeriod === "unavailable"
              ? "Source did not verify the ROI period"
              : `${roiPeriod === "source_month" ? "metrics.monthRoi" : "metrics.allTimeRoi"}; source ratio converted to percent once; exact historical bounds unavailable`,
        },
        drawdown: {
          period: drawdownPeriod,
          start_at: null,
          end_at: null,
          basis:
            drawdownPeriod === "unavailable"
              ? "Source did not verify the drawdown period"
              : `${drawdownSource}; exact historical bounds unavailable`,
        },
      },
      components,
      scored_at: row.computed_at,
      expires_at: row.expires_at,
      eligibility:
        row.eligibility === "PASS" &&
        row.score_version === "strict_perp_v2_5_daily_live_v1" &&
        Object.values(components).every((v) => v !== null && Number.isFinite(v))
          ? "PASS"
          : "REJECT",
      assets: assets.length ? assets : ["BTC", "ETH"],
      style: row.tags?.[0] ?? "unclassified",
      direction:
        directions.size === 1
          ? ([...directions][0] as "long" | "short")
          : "mixed",
      median_hold_hours:
        row.median_hold_seconds == null ? null : row.median_hold_seconds / 3600,
      source_roi_pct: roiPercent,
      source_drawdown_pct:
        row.drawdown_ratio == null
          ? null
          : D(row.drawdown_ratio).abs().times(100).toNumber(),
      atr_pct: atr,
      // Planning envelope matches the App setting. The execution snapshot
      // separately verifies the current per-asset exchange limit.
      venue_max_leverage: PERPS_COPY_MAX_LEVERAGE,
      min_notional_usdc: HYPERLIQUID_MIN_OPEN_NOTIONAL_USDC,
      last_trade_at: (() => {
        const at =
          raw.tradeMetrics?.status === "available"
            ? raw.tradeMetrics.newestFillTime
            : raw.dailyRescore?.lastTradeAt;
        return Number.isSafeInteger(at) && at > 0 && at <= now() + 1000
          ? at
          : null;
      })(),
    };
  }
  async candidates(
    market: "perps" | "prediction" | "both" = "both",
  ): Promise<Candidate[]> {
    if (market === "prediction")
      return process.env.RIDE_AGENT_PREDICTION_ENABLED === "true"
        ? this.prediction.candidates()
        : [];
    const out = await this.perpsCandidates();
    if (
      market !== "perps" &&
      process.env.RIDE_AGENT_PREDICTION_ENABLED === "true"
    )
      out.push(...(await this.prediction.candidates()));
    return out;
  }
  private async perpsCandidates(): Promise<Candidate[]> {
    if (this.discoveryCache && this.discoveryCache.until > now())
      return structuredClone(this.discoveryCache.rows);
    if (this.discoveryFlight)
      return structuredClone(await this.discoveryFlight);
    if (this.discoveryFailure && this.discoveryFailure.until > now())
      throw this.discoveryFailure.error;
    const read = this.readPerpsCandidates();
    this.discoveryFlight = read;
    try {
      const rows = await read;
      this.discoveryFailure = null;
      return structuredClone(rows);
    } catch (error) {
      const normalized =
        error instanceof AgentError
          ? error
          : new AgentError(
              "CANDIDATE_SOURCE_UNAVAILABLE",
              "The complete candidate snapshot could not be verified. Retry shortly.",
              true,
              503,
            );
      this.discoveryFailure = {
        until:
          now() + (normalized.code === "VENUE_RATE_LIMITED" ? 60_000 : 2000),
        error: normalized,
      };
      throw normalized;
    } finally {
      this.discoveryFlight = null;
    }
  }
  private async readPerpsCandidates(): Promise<Candidate[]> {
    const started = now();
    const sorted = [...(await this.rows())]
      .filter((r) => r.eligibility === "PASS" && r.expires_at > now())
      .sort(
        (a, b) =>
          Number(b.score) - Number(a.score) ||
          this.traderId(a.address).localeCompare(this.traderId(b.address)),
      )
      .slice(0, 30);
    const out: Candidate[] = [];
    for (let offset = 0; offset < sorted.length; offset += 3) {
      const batch = await Promise.allSettled(
        sorted.slice(offset, offset + 3).map(async (r) => {
          const id = this.traderId(r.address);
          try {
            return await this.profile(id);
          } catch (error) {
            // Retry transient transport/5xx failures once. A 429 needs a
            // cooldown, not a second burst of the same expensive reads.
            if (
              error instanceof AgentError &&
              (!error.retryable || error.code === "VENUE_RATE_LIMITED")
            )
              throw error;
            await delay(250);
            return this.profile(id);
          }
        }),
      );
      const failures = batch.flatMap((r, i) =>
        r.status === "rejected"
          ? [{ id: this.traderId(sorted[offset + i].address), error: r.reason }]
          : [],
      );
      if (failures.length) {
        const rateLimited = failures.some(
          (f) => f.error?.code === "VENUE_RATE_LIMITED",
        );
        console.warn(
          JSON.stringify({
            event: "candidate_snapshot_unavailable",
            expected: sorted.length,
            verified:
              out.length + batch.filter((r) => r.status === "fulfilled").length,
            failures: failures.map((f) => ({
              trader_id: f.id,
              code:
                f.error instanceof AgentError ? f.error.code : "READ_FAILED",
            })),
          }),
        );
        throw new AgentError(
          rateLimited ? "VENUE_RATE_LIMITED" : "CANDIDATE_SOURCE_INCOMPLETE",
          "The complete candidate snapshot could not be verified. Retry shortly; the previous snapshot was not replaced.",
          true,
          503,
        );
      }
      for (const r of batch) if (r.status === "fulfilled") out.push(r.value);
    }
    const until = Math.min(started + 60_000, ...out.map((c) => c.expires_at));
    if (until <= now())
      throw new AgentError(
        "CANDIDATE_SOURCE_INCOMPLETE",
        "The candidate snapshot expired during the read. Retry with fresh source data.",
        true,
        503,
      );
    this.discoveryCache = { until, rows: out };
    console.info(
      JSON.stringify({
        event: "candidate_snapshot_refreshed",
        count: out.length,
        expires_at: until,
        elapsed_ms: now() - started,
      }),
    );
    return out;
  }
  private async paged(
    type: string,
    address: string,
    start: number,
    end = now(),
    source = false,
  ): Promise<{ events: any[]; complete: boolean }> {
    let cursor = start;
    const result = new Map<string, any>();
    for (let page = 0; page < 10; page++) {
      const rows = await this.info(
        {
          type,
          user: address,
          startTime: cursor,
          endTime: end,
          aggregateByTime: false,
        },
        source,
      );
      if (!Array.isArray(rows))
        return { events: [...result.values()], complete: false };
      for (const row of rows)
        result.set(
          `${row.tid ?? row.hash ?? fingerprint(row)}:${row.time}`,
          row,
        );
      if (rows.length < 500)
        return { events: [...result.values()], complete: true };
      const next = Math.max(...rows.map((r: any) => r.time));
      if (next <= cursor)
        return { events: [...result.values()], complete: false };
      cursor = next;
    }
    return { events: [...result.values()], complete: false };
  }
  private async activationCheck(user: string, portfolio: Portfolio) {
    if (!portfolio.sleeves.some((s) => s.trader.market === "perps"))
      return { eligible: true, blockers: [], idempotent_existing: false };
    const check = await this.core("perps_registration_check", {
      user_id: user,
      portfolio_id: portfolio.id,
    });
    const allowed = new Set([
      "AGENT_WALLET_INACTIVE",
      "EXECUTION_OWNER_CONFLICT",
      "MANUAL_WRITER_ACTIVE",
      "APP_COPY_ACTIVE",
      "COPY_EVENTS_PROCESSING",
      "APP_POSITIONS_OPEN",
      "BALANCE_TRANSFER_PENDING",
      "WITHDRAWAL_PENDING",
      "DEDICATED_ACCOUNT_REQUIRED",
      "REGISTRATION_IDEMPOTENCY_CONFLICT",
    ]);
    if (
      typeof check?.eligible !== "boolean" ||
      typeof check.idempotent_existing !== "boolean" ||
      !Array.isArray(check.blockers) ||
      check.blockers.some(
        (x: unknown) => typeof x !== "string" || !allowed.has(x),
      ) ||
      check.eligible !== (check.blockers.length === 0)
    )
      throw new AgentError(
        "ACTIVATION_CHECK_UNAVAILABLE",
        "Account registration readiness could not be verified. Existing account ownership and settings are preserved.",
        true,
        503,
      );
    return {
      eligible: check.eligible as boolean,
      blockers: [...new Set(check.blockers as string[])],
      idempotent_existing: check.idempotent_existing as boolean,
    };
  }
  async perpsAccount(
    user: string,
    p: Portfolio | null,
    bind = false,
  ): Promise<AccountSnapshot> {
    let identity: any, accountId: string;
    const binding =
      p?.venue_accounts?.perps ??
      (p?.sleeves.every((s) => s.trader.market === "perps")
        ? p?.account_id
        : null);
    if (binding) {
      identity = await this.core("perps_account", {
        user_id: user,
        account_id: binding,
      });
      accountId = binding;
    } else {
      identity = await this.core("perps_wallet", { user_id: user });
      accountId = `account_${fingerprint([user, this.network]).slice(0, 32)}`;
    }
    const [state, orders, mids, meta, abstraction] = await Promise.all([
      this.info({ type: "clearinghouseState", user: identity.master }),
      this.info({ type: "frontendOpenOrders", user: identity.master }),
      this.info({ type: "allMids" }),
      this.info({ type: "meta" }),
      this.info({ type: "userAbstraction", user: identity.master }),
    ]);
    if (
      !state.marginSummary?.accountValue ||
      !Array.isArray(state.assetPositions) ||
      !Array.isArray(orders) ||
      !Array.isArray(meta.universe)
    )
      throw new AgentError(
        "ACCOUNT_STALE",
        "Account observations are incomplete.",
        true,
      );
    const mode = perpsAccountMode(abstraction);
    if (
      mode === "unsupported" ||
      (mode === "unified" && process.env.RIDE_AGENT_UNIFIED_ENABLED !== "true")
    )
      throw new AgentError(
        "ACCOUNT_NOT_READY",
        "This account mode is not supported by the independent Agent execution service.",
      );
    let accountValue = String(state.marginSummary.accountValue);
    let available = String(state.withdrawable);
    if (mode === "unified") {
      const [spot, dexAbstraction, dexes] = await Promise.all([
        this.info({ type: "spotClearinghouseState", user: identity.master }),
        this.info({ type: "userDexAbstraction", user: identity.master }),
        this.info({ type: "perpDexs" }),
      ]);
      if (![false, null].includes(dexAbstraction))
        throw new AgentError(
          "ACCOUNT_NOT_READY",
          "Agent execution requires disabled DEX abstraction.",
        );
      const balance = unifiedUsdc(spot);
      accountValue = balance.equity;
      available = balance.available;
      // Core-only unified support cannot claim a shared balance while another
      // DEX has exposure or pending orders. The worker repeats these checks.
      if (
        !Array.isArray(dexes) ||
        dexes[0] !== null ||
        dexes
          .slice(1)
          .some((dex: any) => typeof dex?.name !== "string" || !dex.name.trim())
      )
        throw new AgentError(
          "ACCOUNT_STALE",
          "Complete Perps market scopes are unavailable.",
          true,
        );
      await Promise.all(
        dexes.slice(1).map(async (dex: any) => {
          const [other, pending] = await Promise.all([
            this.info({
              type: "clearinghouseState",
              user: identity.master,
              dex: dex.name,
            }),
            this.info({
              type: "frontendOpenOrders",
              user: identity.master,
              dex: dex.name,
            }),
          ]);
          if (!Array.isArray(other?.assetPositions) || !Array.isArray(pending))
            throw new AgentError(
              "ACCOUNT_STALE",
              "Complete dedicated account observations are unavailable.",
              true,
            );
          if (
            pending.length ||
            other.assetPositions.some(
              (row: any) => !D(row.position?.szi).isZero(),
            )
          )
            throw new AgentError(
              "ACCOUNT_NOT_READY",
              "Unified Agent execution requires no exposure or open orders on other Perps DEXs.",
            );
        }),
      );
      if (
        perpsAccountMode(
          await this.info({ type: "userAbstraction", user: identity.master }),
        ) !== mode
      )
        throw new AgentError(
          "ACCOUNT_STALE",
          "Account mode changed during the balance observation.",
          true,
        );
    }
    const scopedAvailable: Record<string, string> = { core: available };
    const scopes = [
      ...new Set(
        (p?.sleeves ?? [])
          .flatMap((s) => s.trader.assets)
          .filter((a) => a.includes(":"))
          .map((a) => a.split(":")[0]),
      ),
    ];
    if (scopes.length) {
      if (process.env.RIDE_AGENT_RWA_ENABLED !== "true")
        throw new AgentError(
          "RWA_EXECUTION_UNAVAILABLE",
          "RWA execution is not enabled on this independent Agent service.",
        );
      await this.standardMode(identity.master);
      for (const dex of scopes) {
        const [extra, extraOrders, extraMids, extraMeta] = await Promise.all([
          this.info({ type: "clearinghouseState", user: identity.master, dex }),
          this.info({ type: "frontendOpenOrders", user: identity.master, dex }),
          this.info({ type: "allMids", dex }),
          this.info({ type: "meta", dex }),
        ]);
        if (extraMeta.collateralToken !== 0)
          throw new AgentError(
            "UNSUPPORTED_COLLATERAL",
            "Only verified USDC-collateral RWA DEXes can join this plan.",
          );
        if (
          !Array.isArray(extra.assetPositions) ||
          !Array.isArray(extraOrders) ||
          !Array.isArray(extraMeta.universe) ||
          extra.marginSummary?.accountValue == null ||
          extra.withdrawable == null
        )
          throw new AgentError(
            "ACCOUNT_STALE",
            "RWA account scope is incomplete.",
            true,
          );
        scopedAvailable[dex] = String(extra.withdrawable);
        state.marginSummary.accountValue = D(state.marginSummary.accountValue)
          .plus(extra.marginSummary.accountValue)
          .toString();
        state.withdrawable = D(state.withdrawable)
          .plus(extra.withdrawable)
          .toString();
        state.assetPositions.push(
          ...extra.assetPositions.map((item: any) => ({
            ...item,
            position: {
              ...item.position,
              coin: item.position.coin.includes(":")
                ? item.position.coin
                : dex + ":" + item.position.coin,
            },
          })),
        );
        orders.push(
          ...extraOrders.map((order: any) => ({
            ...order,
            coin: order.coin.includes(":")
              ? order.coin
              : dex + ":" + order.coin,
          })),
        );
        Object.assign(
          mids,
          Object.fromEntries(
            Object.entries(extraMids).map(([coin, value]) => [
              coin.includes(":") ? coin : dex + ":" + coin,
              value,
            ]),
          ),
        );
        meta.universe.push(
          ...extraMeta.universe.map((x: any) => ({
            ...x,
            name: x.name.includes(":") ? x.name : dex + ":" + x.name,
          })),
        );
      }
    }
    if (bind) {
      if (
        state.assetPositions.some(
          (x: any) => !D(x.position?.szi ?? 0).isZero(),
        ) ||
        orders.length
      )
        throw new AgentError(
          "OWNERSHIP_CONFLICT",
          "Existing positions or orders must remain with their current owner.",
        );
      const b = await this.core("perps_bind", {
        user_id: user,
        portfolio_id: p!.id,
      });
      accountId = b.account_id;
      p!.venue_accounts = { ...p!.venue_accounts, perps: accountId };
      identity = await this.core("perps_account", {
        user_id: user,
        account_id: accountId,
      });
    }
    const positions = Object.fromEntries(
        state.assetPositions.map((x: any) => [
          `perps:${x.position.coin}`,
          String(x.position.szi),
        ]),
      ),
      prices = Object.fromEntries(
        Object.entries(mids).map(([coin, price]) => [
          `perps:${coin}`,
          String(price),
        ]),
      );
    const maxLeverages = Object.fromEntries(
      meta.universe.map((x: any) => [`perps:${x.name}`, x.maxLeverage]),
    );
    let fills: AccountSnapshot["fills"] = [],
      funding: AccountSnapshot["funding"] = [],
      flows: AccountSnapshot["flows"] = [],
      coverage = true;
    if (p?.ledger_started_at) {
      const [fillRows, fundingRows, flowRows] = await Promise.all([
        this.paged("userFillsByTime", identity.master, p.ledger_started_at),
        this.paged("userFunding", identity.master, p.ledger_started_at),
        this.paged(
          "userNonFundingLedgerUpdates",
          identity.master,
          p.ledger_started_at,
        ),
      ]);
      coverage = fillRows.complete && fundingRows.complete && flowRows.complete;
      const oidTasks = new Map<string, string>();
      for (const e of p.executions.filter(
        (e) => e.task_id && e.key.startsWith("perps:"),
      )) {
        const status = await this.core("perps_execution", {
          user_id: user,
          account_id: accountId,
          task_id: e.task_id,
        });
        for (const leg of status.legs ?? [])
          if (leg.oid) oidTasks.set(String(leg.oid), e.task_id!);
      }
      for (const f of fillRows.events) {
        const task = oidTasks.get(String(f.oid));
        if (!task || f.feeToken !== "USDC") {
          coverage = false;
          continue;
        }
        fills.push({
          id: `hl_${f.tid}_${f.oid}`,
          order_id: String(f.oid),
          task_id: task,
          key: `perps:${f.coin}`,
          quantity: D(f.sz)
            .times(f.side === "B" ? 1 : -1)
            .toString(),
          price: String(f.px),
          fee_usdc: String(f.fee),
          at: f.time,
        });
      }
      funding = fundingRows.events.map((f) => ({
        id: `fund_${fingerprint(f).slice(0, 32)}`,
        key: `perps:${f.delta.coin}`,
        amount_usdc: String(f.delta.usdc),
        at: f.time,
      }));
      for (const f of flowRows.events) {
        const d = f.delta;
        let amount: string | null = null;
        if (d?.type === "deposit") amount = String(d.usdc);
        else if (d?.type === "withdraw")
          amount = D(d.usdc)
            .plus(d.fee ?? 0)
            .neg()
            .toString();
        else if (
          [
            "accountClassTransfer",
            "internalTransfer",
            "subAccountTransfer",
          ].includes(d?.type)
        ) {
          if (d.usdc !== undefined && typeof d.toPerp === "boolean")
            amount = D(d.usdc)
              .times(d.toPerp ? 1 : -1)
              .toString();
          else coverage = false;
        } else coverage = false;
        if (amount !== null)
          flows.push({
            id: `flow_${fingerprint(f).slice(0, 32)}`,
            amount_usdc: amount,
            at: f.time,
          });
      }
    }
    if (mode === "standard") {
      accountValue = String(state.marginSummary.accountValue);
      available = String(state.withdrawable);
    }
    const snap: AccountSnapshot = {
      account_id: accountId,
      venue_accounts: { perps: accountId },
      available_by_market: { perps: available },
      available_by_scope: scopedAvailable,
      observed_at: now(),
      account_value_usdc: accountValue,
      available_usdc: available,
      dedicated:
        binding != null ||
        bind ||
        (!orders.length &&
          !Object.values(positions).some((q) => !D(q).isZero())),
      eligible: identity.status === 4 || identity.status === "active",
      positions,
      prices,
      max_leverages: maxLeverages,
      quantity_decimals: Object.fromEntries(
        meta.universe.map((x: any) => [`perps:${x.name}`, x.szDecimals]),
      ),
      min_notionals: Object.fromEntries(
        Object.keys(prices).map((key) => [
          key,
          HYPERLIQUID_MIN_OPEN_NOTIONAL_USDC,
        ]),
      ),
      orders: orders.map((x: any) => ({
        id: String(x.oid),
        key: `perps:${x.coin}`,
        increases_risk: !x.reduceOnly,
      })),
      fills,
      funding,
      flows,
      coverage_complete: coverage,
    };
    if (bind) {
      await this.configure(user, p!, snap);
      return { ...snap, account_id: accountId };
    }
    return snap;
  }
  async account(
    user: string,
    p: Portfolio | null,
    bind = false,
  ): Promise<AccountSnapshot> {
    if (!p) return this.perpsAccount(user, p, bind);
    const venues = new Set(p.sleeves.map((s) => s.trader.market));
    const snapshots: AccountSnapshot[] = [];
    if (venues.has("perps"))
      snapshots.push(await this.perpsAccount(user, p, bind));
    if (venues.has("prediction"))
      snapshots.push(await this.prediction.account(user, p, bind));
    if (snapshots.length === 1) return snapshots[0];
    const merge = (
      field:
        | "positions"
        | "prices"
        | "max_leverages"
        | "min_notionals"
        | "quantity_decimals"
        | "venue_accounts"
        | "available_by_market",
    ) => Object.assign({}, ...snapshots.map((s) => s[field] ?? {}));
    return {
      account_id: `account_${fingerprint([user, p.id, "both"]).slice(0, 32)}`,
      venue_accounts: merge("venue_accounts"),
      chain_block: snapshots.find((s) => s.chain_block != null)?.chain_block,
      observed_at: Math.min(...snapshots.map((s) => s.observed_at)),
      account_value_usdc: cash(
        snapshots.reduce((n, s) => n.plus(s.account_value_usdc), D(0)),
      ),
      available_usdc: cash(
        snapshots.reduce((n, s) => n.plus(s.available_usdc), D(0)),
      ),
      available_by_market: merge("available_by_market"),
      dedicated: snapshots.every((s) => s.dedicated),
      eligible: snapshots.every((s) => s.eligible),
      positions: merge("positions"),
      prices: merge("prices"),
      max_leverages: merge("max_leverages"),
      quantity_decimals: merge("quantity_decimals"),
      min_notionals: merge("min_notionals"),
      fills: snapshots.flatMap((s) => s.fills),
      funding: snapshots.flatMap((s) => s.funding),
      flows: snapshots.flatMap((s) => s.flows),
      orders: snapshots.flatMap((s) => s.orders),
      coverage_complete: snapshots.every((s) => s.coverage_complete),
    };
  }
  private perpsBinding(p: Portfolio) {
    return p.venue_accounts?.perps ?? p.account_id;
  }
  private async configure(
    user: string,
    p: Portfolio,
    snap: AccountSnapshot,
  ): Promise<void> {
    const base = { user_id: user, account_id: this.perpsBinding(p) };
    const perps = p.sleeves.filter(
      (s) => s.trader.market === "perps" && s.state !== "closed",
    );
    if (!perps.length) return;
    const policyLeverage = Math.max(
      ...perps.map((s) => {
        if (s.leverage_cap != null) return s.leverage_cap;
        const limits = s.trader.assets.map(
          (a) => snap.max_leverages[`perps:${a}`],
        );
        if (
          !limits.length ||
          limits.some((limit) => !Number.isInteger(limit) || limit < 1)
        )
          throw new AgentError(
            "VENUE_RULES_UNAVAILABLE",
            "Fresh per-asset leverage limits are required.",
            true,
          );
        return Math.max(...limits);
      }),
    );
    const exposure = D.min(
      // Preserve Core's existing NUMERIC(8,4) columns and prepared statements.
      "9999.9999",
      policyLeverage * 100,
      p.sleeves
        .filter((s) => s.trader.market === "perps" && s.state !== "closed")
        .reduce((n, s) => n.plus(s.amount_usdc), D(0))
        .div(snap.account_value_usdc)
        .times(policyLeverage)
        .times(100),
    );
    const assets = [
      ...new Set(
        p.sleeves
          .filter((s) => s.trader.market === "perps")
          .flatMap((s) => s.trader.assets),
      ),
    ];
    const policy = {
      ...base,
      assets,
      max_total_position_pct: exposure.toFixed(4),
      max_leverage: policyLeverage,
      request_id: `${p.id}:policy:${p.control_id ?? p.revision}`,
      fingerprint: fingerprint([p.id, p.revision, assets, exposure.toFixed(4)]),
    };
    await this.control("perps_policy", policy);
    const state = {
      ...base,
      state: p.loss_latched ? "reduce_only" : "active",
      request_id: `${p.id}:active:${p.control_id ?? p.revision}`,
      fingerprint: fingerprint([p.id, p.revision, p.loss_latched]),
    };
    await this.control("perps_state", state);
  }
  async fence(user: string, p: Portfolio): Promise<void> {
    if (!p.account_id) return;
    if (p.sleeves.some((s) => s.trader.market === "prediction"))
      await this.prediction.fence(user, p);
    if (!p.sleeves.some((s) => s.trader.market === "perps")) return;
    await this.control("perps_state", {
      user_id: user,
      account_id: this.perpsBinding(p),
      state: "paused",
      request_id: `${p.id}:fence:${p.control_id ?? p.revision}`,
      fingerprint: fingerprint([p.id, p.revision, "fence"]),
    });
    await this.configure(user, p, await this.perpsAccount(user, p));
  }
  async release(user: string, p: Portfolio): Promise<void> {
    const snap = await this.account(user, p);
    if (
      !fresh(snap.observed_at) ||
      !snap.coverage_complete ||
      snap.orders.length ||
      Object.values(snap.positions).some((q) => !D(q).isZero())
    )
      throw new AgentError(
        "SETTLEMENT_PENDING",
        "Owned inventory and pending orders must settle before account release.",
        true,
      );
    if (p.sleeves.some((s) => s.trader.market === "prediction"))
      await this.prediction.release(user, p);
    if (p.sleeves.some((s) => s.trader.market === "perps"))
      await this.control("perps_state", {
        user_id: user,
        account_id: this.perpsBinding(p),
        state: "disabled",
        request_id: `${p.id}:release`,
        fingerprint: fingerprint([p.id, "release"]),
      });
  }
  async submit(
    user: string,
    p: Portfolio,
    e: Execution,
  ): Promise<{ task_id: string }> {
    const prediction = e.key.startsWith("prediction:");
    const existing = await this.pool.query(
      "SELECT fingerprint,payload,response FROM ride_agent_core_outbox WHERE execution_id=$1 AND user_id=$2 AND portfolio_id=$3",
      [e.id, user, p.id],
    );
    let payload: any;
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.fingerprint !== e.fingerprint)
        throw new AgentError(
          "IDEMPOTENCY_MISMATCH",
          "Execution parameters changed.",
        );
      if (row.response) return row.response;
      payload = row.payload;
    } else if (prediction) {
      payload = await this.prediction.submitPayload(user, p, e);
      await this.pool.query(
        "INSERT INTO ride_agent_core_outbox(execution_id,user_id,portfolio_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [e.id, user, p.id, e.fingerprint, payload],
      );
      const saved = await this.pool.query(
        "SELECT fingerprint,payload FROM ride_agent_core_outbox WHERE execution_id=$1 AND user_id=$2 AND portfolio_id=$3",
        [e.id, user, p.id],
      );
      if (!saved.rowCount || saved.rows[0].fingerprint !== e.fingerprint)
        throw new AgentError(
          "IDEMPOTENCY_MISMATCH",
          "Execution identifier has other parameters.",
        );
      payload = saved.rows[0].payload;
    } else {
      const snap = await this.perpsAccount(user, p);
      if (
        !fresh(snap.observed_at) ||
        !snap.coverage_complete ||
        !snap.dedicated ||
        !snap.eligible
      )
        throw new AgentError(
          "EXECUTION_REJECTED",
          "Account evidence does not authorize this target.",
        );
      const price = snap.prices[e.key];
      if (!price)
        throw new AgentError("EXECUTION_REJECTED", "Price is unavailable.");
      const current = D(snap.positions[e.key] ?? 0),
        target = D(e.target_quantity);
      if (p.preferences.portfolio_kind) {
        const check = checkPerpsOrder(snap, e.key, e.target_quantity);
        if (!check.ok)
          throw new AgentError(
            "EXECUTION_REJECTED",
            `${check.code}: ${check.message}`,
          );
      }
      if (p.loss_latched && !target.isZero())
        throw new AgentError(
          "EXECUTION_REJECTED",
          "Loss trigger blocks non-flat targets.",
        );
      const increases =
        target.abs().gt(current.abs()) ||
        (!target.isZero() &&
          !current.isZero() &&
          target.isPositive() !== current.isPositive());
      for (const s of p.sleeves.filter((s) => s.intents[e.key])) {
        if (!increases) continue;
        const intent = s.intents[e.key];
        if (
          s.leverage_mode != null &&
          (intent.source_leverage_verified === false ||
            !Number.isInteger(intent.source_leverage) ||
            intent.source_leverage < 1 ||
            !Number.isFinite(snap.max_leverages[e.key]) ||
            intent.source_leverage > snap.max_leverages[e.key])
        )
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Verified leverage rules changed; recalculate the target before increasing exposure.",
          );
        if (
          !fresh(intent.observed_at) ||
          D(price).minus(intent.price).abs().div(intent.price).gt(".002")
        )
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Execution price moved beyond the frozen 0.2% limit.",
          );
        const source = await this.source(s.trader.id);
        if (s.state === "active" && source.revision !== s.source_revision)
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Source position changed before execution.",
          );
      }
      const identity = await this.core("perps_account", {
        user_id: user,
        account_id: this.perpsBinding(p),
      });
      payload = {
        user_id: user,
        account_id: this.perpsBinding(p),
        execution_id: e.id,
        fingerprint: e.fingerprint,
        asset: e.key.slice(6),
        direction: target.isZero()
          ? "flat"
          : target.isPositive()
            ? "long"
            : "short",
        target_quantity: e.target_quantity,
        entry_reference_price: increases ? price : null,
        max_entry_deviation_bps: increases ? 20 : null,
        target_position_pct: target
          .abs()
          .times(price)
          .div(snap.account_value_usdc)
          .times(100)
          .toFixed(4),
        leverage: Math.max(
          1,
          Math.min(
            snap.max_leverages[e.key] ?? 1,
            ...p.sleeves
              .filter((s) => s.intents[e.key])
              .map((s) =>
                Math.min(
                  s.leverage_cap ?? Number.POSITIVE_INFINITY,
                  s.intents[e.key].source_leverage,
                ),
              ),
          ),
        ),
        created_at: e.created_at,
        expires_at: e.expires_at,
        policy_revision: identity.policy_revision,
      };
      await this.pool.query(
        "INSERT INTO ride_agent_core_outbox(execution_id,user_id,portfolio_id,fingerprint,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [e.id, user, p.id, e.fingerprint, payload],
      );
      const saved = await this.pool.query(
        "SELECT fingerprint,payload FROM ride_agent_core_outbox WHERE execution_id=$1",
        [e.id],
      );
      if (saved.rows[0].fingerprint !== e.fingerprint)
        throw new AgentError(
          "IDEMPOTENCY_MISMATCH",
          "Execution identifier already belongs to other parameters.",
        );
      payload = saved.rows[0].payload;
    }
    const response = await this.core(
      prediction ? "prediction_submit" : "perps_submit",
      payload,
    );
    await this.pool.query(
      "UPDATE ride_agent_core_outbox SET response=$2 WHERE execution_id=$1",
      [e.id, response],
    );
    return response;
  }
  async execution(
    user: string,
    p: Portfolio,
    e: Execution,
  ): Promise<{
    task_id?: string;
    status: Execution["status"];
    observed_quantity: string | null;
    settled: boolean;
  }> {
    let task = e.task_id;
    if (!task) {
      const saved = await this.pool.query(
        "SELECT response,payload FROM ride_agent_core_outbox WHERE execution_id=$1 AND user_id=$2 AND portfolio_id=$3",
        [e.id, user, p.id],
      );
      if (!saved.rowCount)
        return { status: "failed", observed_quantity: null, settled: false };
      if (saved.rows[0].response) task = saved.rows[0].response.task_id;
      else {
        const response = await this.core(
          e.key.startsWith("prediction:")
            ? "prediction_submit"
            : "perps_submit",
          saved.rows[0].payload,
        );
        await this.pool.query(
          "UPDATE ride_agent_core_outbox SET response=$2 WHERE execution_id=$1",
          [e.id, response],
        );
        task = response.task_id;
      }
    }
    if (e.key.startsWith("prediction:"))
      return this.prediction.execution(user, p, e, task!);
    const response = await this.core("perps_execution", {
      user_id: user,
      account_id: this.perpsBinding(p),
      task_id: task,
    });
    let snapshot: any = {};
    try {
      snapshot =
        typeof response.snapshot === "string"
          ? JSON.parse(response.snapshot)
          : (response.snapshot ?? {});
    } catch {}
    const snap = await this.account(user, p),
      position = snap.positions[e.key] ?? "0";
    const done =
      response.status === 3 &&
      !snapshot.fill_settlement_pending &&
      !snapshot.settlement_observation_required;
    const failed = [4, 5].includes(response.status);
    return {
      task_id: task!,
      status: done
        ? "completed"
        : failed
          ? "failed"
          : response.legs?.some((l: any) => D(l.quantity ?? 0).gt(0))
            ? "partially_filled"
            : "submitted",
      observed_quantity: position,
      settled: done,
    };
  }
  async notify(
    user: string,
    event: {
      id: string;
      kind: string;
      message: string;
      portfolio_id: string | null;
    },
  ): Promise<void> {
    const tokens = await this.core("push_tokens", { user_id: user });
    if (!tokens.length)
      throw new AgentError(
        "PUSH_NOT_REGISTERED",
        "No Ride App device is registered for push delivery.",
        true,
        409,
      );
    const service = firebaseAccount();
    if (!service)
      throw new AgentError(
        "PUSH_NOT_CONFIGURED",
        "Ride App push is not configured.",
        true,
        503,
      );
    if (!this.tokens || this.tokens.expiry < now() + 60000) {
      const encode = (v: unknown) =>
        Buffer.from(JSON.stringify(v)).toString("base64url");
      const at = Math.floor(now() / 1000),
        claim = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: service.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: at, exp: at + 3600 })}`;
      const signer = createSign("RSA-SHA256");
      signer.update(claim);
      const assertion = `${claim}.${signer.sign(service.private_key).toString("base64url")}`;
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const payload = (await response.json()) as any;
      if (!response.ok || !payload.access_token)
        throw Error("Push authentication failed");
      this.tokens = {
        value: payload.access_token,
        expiry: now() + (payload.expires_in ?? 3600) * 1000,
      };
    }
    for (const token of tokens) {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(service.project_id)}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.tokens.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: "Rider", body: event.message },
              data: {
                type: "ride_agent",
                event_id: event.id,
                event_kind: event.kind,
                ...(event.portfolio_id
                  ? { portfolio_id: event.portfolio_id }
                  : {}),
              },
              android: { priority: "HIGH", collapse_key: event.id },
              apns: { headers: { "apns-collapse-id": event.id } },
            },
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw Error("Push delivery failed");
    }
  }
  async operation(op: string, input: any): Promise<unknown> {
    switch (op) {
      case "deposit_options":
        return new DepositReads(
          (op, input) => this.core(op, input),
          this.network,
        ).options();
      case "deposit_address":
        return new DepositReads(
          (op, input) => this.core(op, input),
          this.network,
        ).address(input.user_id, input.input, input.portfolio_id);
      case "deposit_status": {
        const status = await new DepositReads(
          (op, input) => this.core(op, input),
          this.network,
        ).status(input.deposit, input.user_id);
        if (input.deposit.provider === "polymarket_bridge") {
          const balance = await this.prediction.fundingBalance(input.user_id);
          return {
            ...status,
            ...balance,
            sufficient_for_amount: D(balance.trading_balance_usdc).gte(
              input.deposit.amount_usdc ?? "5",
            ),
            next_action: balance.available_to_copy
              ? "Trading collateral is verified. Refresh the saved plan before confirming copying."
              : "Bridge settlement is separate from trading collateral. Wait for verified credit and account readiness.",
          };
        }
        return status;
      }
      case "funding_quote":
      case "funding_submit":
      case "funding_activate_quote":
      case "funding_activate_submit":
        return this.core(`perps_${op}`, input);
      case "candidates": {
        const market = input?.market ?? "both";
        if (!["perps", "prediction", "both"].includes(market))
          throw new AgentError(
            "INVALID_PREFERENCES",
            "Unknown candidate market.",
            false,
            400,
          );
        return this.candidates(market);
      }
      case "profile":
        return this.profile(input.trader_id);
      case "source":
        return this.source(input.trader_id);
      case "source_fills": {
        if (
          !Number.isSafeInteger(input.start_at) ||
          !Number.isSafeInteger(input.end_at) ||
          input.end_at <= input.start_at ||
          input.end_at - input.start_at > 31 * 86400_000 ||
          input.end_at > now()
        )
          throw new AgentError(
            "INVALID_WINDOW",
            "Invalid source history window.",
            false,
            400,
          );
        if (input.market !== "perps")
          return {
            fills: [],
            complete: false,
            reason:
              "Authenticated prediction source fill history is unavailable.",
          };
        const row = await this.resolve(input.trader_id);
        const history = await this.paged(
          "userFillsByTime",
          row.address,
          input.start_at,
          input.end_at,
          true,
        );
        const valid = history.events.filter(
          (f) => f.time >= input.start_at && f.time < input.end_at,
        );
        return {
          complete: history.complete,
          fills: valid.map((f) => ({
            id: `source_${fingerprint([input.trader_id, f.tid, f.oid]).slice(0, 32)}`,
            key: `perps:${f.coin}`,
            start_quantity:
              f.startPosition == null ? undefined : String(f.startPosition),
            quantity: D(f.sz)
              .times(f.side === "B" ? 1 : -1)
              .toString(),
            price: String(f.px),
            fee_usdc: f.feeToken === "USDC" ? String(f.fee) : null,
            realized_usdc: f.closedPnl == null ? null : String(f.closedPnl),
            at: f.time,
          })),
        };
      }
      case "notification_status": {
        const tokens = await this.core("push_tokens", {
          user_id: input.user_id,
        });
        return {
          configured: firebaseAccount() !== null,
          device_registered: Array.isArray(tokens) && tokens.length > 0,
        };
      }
      case "preflight":
        if (
          input.portfolio &&
          !input.portfolio.account_id &&
          input.portfolio.sleeves.some((s: any) => s.trader.market === "perps")
        ) {
          const check = await this.activationCheck(
            input.user_id,
            input.portfolio,
          );
          if (!check.eligible)
            throw new AgentError(
              "ACTIVATION_BLOCKED",
              "Account activation is blocked by unfinished account activity. Review the reported blockers; do not add funds or clear ownership to bypass them.",
              false,
              409,
              {
                operation: "perps_registration_check",
                blockers: check.blockers,
              },
            );
        }
        return this.account(input.user_id, input.portfolio);
      case "activation_check":
        return this.activationCheck(input.user_id, input.portfolio);
      case "bind":
        return this.account(input.user_id, input.portfolio, true);
      case "account":
        return this.account(input.user_id, input.portfolio);
      case "submit":
        return this.submit(input.user_id, input.portfolio, input.execution);
      case "execution":
        return this.execution(input.user_id, input.portfolio, input.execution);
      case "fence":
        return this.fence(input.user_id, input.portfolio).then(() => ({
          ok: true,
        }));
      case "release":
        return this.release(input.user_id, input.portfolio).then(() => ({
          ok: true,
        }));
      case "cancel_increasing": {
        const snap = await this.account(input.user_id, input.portfolio);
        for (const order of snap.orders.filter(
          (x) => x.increases_risk && x.key.startsWith("prediction:"),
        ))
          await this.core("prediction_cancel", {
            user_id: input.user_id,
            portfolio_id: input.portfolio.id,
            task_id: order.id,
          });
        if (snap.orders.some((x) => x.increases_risk))
          throw new AgentError(
            "UNRESOLVED_OPEN_ORDER",
            "Increasing open orders require Core reconciliation before exit.",
            true,
          );
        return { ok: true };
      }
      case "notify":
        return this.notify(input.user_id, input.event).then(() => ({
          ok: true,
        }));
      default:
        throw new AgentError(
          "NOT_FOUND",
          "Unknown private adapter operation.",
          false,
          404,
        );
    }
  }
}
export async function startCoreBridge() {
  const bridge = new CoreBridge(
    required("RIDE_AGENT_CORE_URL"),
    required("RIDE_AGENT_CORE_SERVICE_TOKEN"),
    required("RIDE_AGENT_DATABASE_URL"),
    required("RIDE_AGENT_TRADER_ID_SALT"),
    process.env.RIDE_AGENT_NETWORK === "mainnet" ? "mainnet" : "testnet",
  );
  await bridge.migrate();
  const token = required("RIDE_AGENT_EXECUTOR_TOKEN");
  if (token.length < 32)
    throw Error("Executor token must contain 32 characters");
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) =>
    res.json({ service: "ride-agent-bridge", version: "3", release: VERSION }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.post("/internal/agent/:operation", async (req, res) => {
    const actual = Buffer.from(
        req.get("authorization")?.replace(/^Bearer /, "") ?? "",
      ),
      expected = Buffer.from(token);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res
        .status(401)
        .json(
          failure(
            new AgentError(
              "AUTH_REQUIRED",
              "Private executor authentication required.",
              false,
              401,
            ),
          ),
        );
      return;
    }
    try {
      res.json(await bridge.operation(req.params.operation, req.body));
    } catch (e) {
      res
        .status(e instanceof AgentError ? e.httpStatus : 503)
        .json({ error: failure(e).error });
    }
  });
  const listener = app.listen(
    Number(process.env.PORT ?? 3355),
    process.env.HOST ?? "127.0.0.1",
  );
  const stop = () => {
    listener.close();
    void bridge.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
