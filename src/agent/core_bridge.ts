#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import type { Server } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
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
import {
  VenueReads,
  isPreparedBundleUnsupported,
  type AccountObservationLimits,
  type PreparedAccountWindow,
} from "./venue-reads.js";
import { drainBridge } from "./bridge-shutdown.js";
import {
  AccountObservationPlans,
  ACCOUNT_OBSERVATION_COST_CONTRACT,
} from "./account-observation-plans.js";
import { coreInfoFetcher } from "./core-info-reads.js";
import {
  coreFrameCoordinator,
  framePendingContinuation,
} from "./core-frame-coordinator.js";
import {
  preparedPortfolioInput,
  preparedOperationalBinding,
  preparedProposalBinding,
  preparedWriteBinding,
  type PreparedPortfolioInput,
} from "./prepared-portfolio.js";
import { notificationCancellation } from "./notification-cancellation.js";
import { submitObservationCancellation } from "./submit-observation-cancellation.js";
import type { FreshSubmitReadPurpose } from "./fresh-submit-read-purpose.js";
import { NotificationReceipts } from "./notification-receipts.js";
import {
  VenueOrderSnapshots,
  type ForeignAccountRead,
} from "./venue-order-snapshots.js";
import { SourceFeed } from "./source-feed.js";
import type { SourceSnapshot } from "./adapter.js";
import {
  PerpsSourceIdentities,
  sourceRequiresRwa,
} from "./source-identities.js";
import {
  perpsAcceptanceRequest,
  perpsExecutionAcceptance,
} from "./execution-acceptance.js";
import {
  perpsExecutionRecovery,
  perpsRecoveryRequest,
} from "./execution-core-recovery.js";
import {
  perpsExecutionRetirement,
  persistedPerpsRetirement,
  type PerpsRetirementReceipt,
} from "./execution-retirement.js";
import { sourceEvidenceReady } from "./source-observations.js";
import { sourcePositionGuardFailure } from "./source-position-guard.js";
import {
  inObservedPerpsScope,
  scopedSourceFills,
} from "./source-fill-evidence.js";
import {
  perpsAbstractionState,
  perpsAccountMode,
  unifiedUsdc,
} from "./perps_account.js";
import { readSelectedPlanEvidence } from "./read-evidence.js";
import type {
  NativeSourcePlan,
  NativeSourcePlanBinding,
  NativeSourcePlanSource,
} from "./native-source-plan.js";
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
  manualHandoff,
  type Candidate,
  type AccountSnapshot,
  type Portfolio,
  type Execution,
  type PositionIntent,
  type ManualMarketHandoff,
} from "./domain.js";
import { reconcileQuantities } from "./ledger.js";

function manualMarkets(identity: any, binding: string): ManualMarketHandoff[] {
  if (identity.manual_markets === undefined) return [];
  const invalid = () =>
    new AgentError(
      "ACCOUNT_STALE",
      "Immutable manual market ownership evidence is invalid.",
      true,
    );
  if (!Array.isArray(identity.manual_markets)) throw invalid();
  const coins = new Set<string>(),
    ids = new Set<string>();
  return identity.manual_markets.map((row: any) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.handoff_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        row.handoff_id,
      ) ||
      row.binding_id !== binding ||
      typeof row.coin !== "string" ||
      !/^[A-Za-z0-9._-]+(?::[A-Za-z0-9._-]+)?$/.test(row.coin) ||
      !Number.isSafeInteger(row.at_ms) ||
      row.at_ms <= 0 ||
      row.at_ms > now() ||
      ![row.mark_px, row.signed_size].every(
        (value) => typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value),
      ) ||
      !D(row.mark_px).isFinite() ||
      !D(row.mark_px).gt(0) ||
      !D(row.signed_size).isFinite() ||
      ![row.master, row.agent].every(
        (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value),
      ) ||
      row.master.toLowerCase() !== identity.master?.toLowerCase() ||
      row.agent.toLowerCase() !== identity.agent?.toLowerCase() ||
      !Number.isInteger(row.network) ||
      ![1, 2].includes(row.network) ||
      row.network !== identity.network ||
      !Number.isInteger(row.wallet_generation) ||
      row.wallet_generation < 0 ||
      row.wallet_generation !== identity.wallet_generation ||
      coins.has(row.coin) ||
      ids.has(row.handoff_id)
    )
      throw invalid();
    coins.add(row.coin);
    ids.add(row.handoff_id);
    return {
      handoff_id: row.handoff_id,
      binding_id: row.binding_id,
      coin: row.coin,
      at_ms: row.at_ms,
      mark_px: row.mark_px,
      signed_size: row.signed_size,
      master: row.master,
      agent: row.agent,
      network: row.network,
      wallet_generation: row.wallet_generation,
    };
  });
}

const required = (key: string) => {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is required`);
  return v;
};
type PreparedEntry = {
  handle: string;
  key: string;
  user: string;
  portfolio: PreparedPortfolioInput;
  stable: string;
  costOwner: string;
  frameOwner: string;
  graph?: "readonly-runner-native-v1";
  nativeSourcePlan?: NativeSourcePlan;
  nativeSourceContext?: Omit<
    NativeSourcePlanBinding,
    "issuer" | "reader" | "budget"
  >;
  nativeSourceAddresses?: Readonly<Record<string, string>>;
  sourceEvidenceEnds?: Map<string, Set<number>>;
  historyBindings?: Map<
    string,
    { start: number; end: number; requiresRwa: boolean }
  >;
  deadline: number;
  pin?: object;
  window?: PreparedAccountWindow;
  polling: boolean;
  timer: ReturnType<typeof setTimeout>;
  expired: boolean;
  auditHash?: string;
  disposeSourceRetries?: () => void;
  proposal?: string;
  writeBinding?: string;
  attempted?: { id: string; fingerprint: string };
};
export class CoreBridge {
  private readonly preparedEntries = new Map<string, PreparedEntry>();
  private readonly preparedCreating = new Map<
    string,
    { stable: string; cancelled: boolean; graph?: "readonly-runner-native-v1" }
  >();
  private readonly preparedSource = new AsyncLocalStorage<PreparedEntry>();
  private venueReads: VenueReads;
  private observationPlans: AccountObservationPlans;
  private readonly infoReadRoute: "official" | "core";
  private closing?: Promise<void>;
  private orderSnapshots: VenueOrderSnapshots;
  private sourceFeed = new SourceFeed((id) => this.readSource(id));
  private pool: pg.Pool;
  private sourceIdentities: PerpsSourceIdentities;
  private notificationReceipts: NotificationReceipts;
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
    options: { infoReadRoute?: "official" | "core" } = {},
  ) {
    this.infoReadRoute = options.infoReadRoute ?? "official";
    this.orderSnapshots = new VenueOrderSnapshots(this.network);
    this.pool = new pg.Pool({ connectionString: database, max: 10 });
    this.observationPlans = new AccountObservationPlans(this.pool);
    this.venueReads = new VenueReads(
      this.infoReadRoute === "core"
        ? coreInfoFetcher(coreUrl, coreToken)
        : (url, init) => fetch(url, init),
      Date.now,
      2,
      {
        transport:
          this.infoReadRoute === "core" ? "core_shared_info" : "official",
        observationPlans: this.observationPlans,
        requireObservationPlanBinding: true,
        nativeSourcePlanIssuer: this,
        freshSubmitReadIssuer: this,
        frameCoordinator:
          this.infoReadRoute === "core" && this.network === "mainnet"
            ? coreFrameCoordinator(this.coreUrl, this.coreToken)
            : undefined,
      },
    );
    this.sourceIdentities = new PerpsSourceIdentities(
      this.pool,
      salt,
      (input, signal) => this.core("perps_source_identities", input, signal),
    );
    this.notificationReceipts = new NotificationReceipts(this.pool);
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
    await this.observationPlans.migrate();
    await this.sourceIdentities.migrate();
    await this.prediction.migrate();
    await this.notificationReceipts.migrate();
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ride_agent_core_outbox (execution_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,portfolio_id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload JSONB NOT NULL,response JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT now());`,
    );
  }
  drainAccounts(): Promise<void> {
    for (const entry of this.preparedEntries.values()) {
      clearTimeout(entry.timer);
      entry.expired = true;
    }
    return this.venueReads.drainAccounts();
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.sourceFeed.close();
      this.closing = (async () => {
        await this.drainAccounts();
        await this.pool.end();
      })();
    }
    return this.closing;
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
  private async core(
    operation: string,
    input: unknown,
    notificationSignal?: AbortSignal,
  ): Promise<any> {
    const r = await fetch(
      new URL(`/internal/agent-core/${operation}`, this.coreUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.coreToken}`,
        },
        body: JSON.stringify(input),
        signal: notificationSignal
          ? AbortSignal.any([notificationSignal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(
              this.venueReads.accountReadTimeout(
                operation.startsWith("perps_funding_") ? 90000 : 20000,
              ),
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
  private infoRequest(payload: unknown, source: boolean) {
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
    return {
      url,
      ttl,
      lane: source ? ("source" as const) : ("account" as const),
    };
  }
  private async info(payload: unknown, source = false): Promise<any> {
    const { url, ttl, lane } = this.infoRequest(payload, source);
    return this.venueReads.read(url, payload, ttl, lane);
  }
  private infoWithEvidence(payload: unknown, source = false) {
    const { url, ttl, lane } = this.infoRequest(payload, source);
    return this.venueReads.readWithEvidence(url, payload, ttl, lane);
  }
  private traderId(address: string) {
    return `trader_${createHash("sha256").update(`${this.salt}:perps:${address.toLowerCase()}`).digest("hex").slice(0, 32)}`;
  }
  private async rows() {
    if (this.candidatesCache && now() - this.candidatesCache.at < 30_000)
      return this.candidatesCache.rows;
    const rows = await this.core("perps_pool", {});
    if (!Array.isArray(rows)) throw Error("Invalid trader pool");
    await this.sourceIdentities.remember(
      rows.map((row) => {
        if (
          !Array.isArray(row.tags) ||
          row.tags.some((tag: unknown) => typeof tag !== "string")
        )
          throw new AgentError(
            "SOURCE_SCOPE_UNAVAILABLE",
            "Current source observation scope metadata is unavailable.",
            true,
            503,
          );
        return {
          address:
            typeof row.address === "string"
              ? row.address.toLowerCase()
              : row.address,
          requires_rwa: Boolean(row.tags?.includes("category:stocks_rwa")),
        };
      }),
    );
    this.candidatesCache = { at: now(), rows };
    return rows;
  }
  private async resolve(id: string, purpose: "source" | "profile" = "source") {
    if (typeof id !== "string" || !/^trader_[0-9a-f]{32}$/.test(id))
      throw new AgentError(
        "SOURCE_IDENTITY_INVALID",
        "Original source identifier is invalid.",
        false,
        400,
      );
    if (purpose === "profile") {
      const row = (await this.rows()).find(
        (r: any) => this.traderId(r.address) === id,
      );
      if (!row || !Number.isFinite(row.expires_at) || row.expires_at <= now())
        throw new AgentError(
          "SCORE_UNAVAILABLE",
          "A current qualified trader score is unavailable for review. Original source observation remains independent.",
          true,
          503,
        );
      return row;
    }
    const identity = await this.sourceIdentities.resolve(id);
    return {
      address: identity.address,
      tags: identity.requires_rwa ? ["category:stocks_rwa"] : [],
    };
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
    const abstraction = await this.info(
      { type: "userAbstraction", user: address },
      source,
    );
    if (perpsAbstractionState(abstraction) !== "standard")
      throw new AgentError(
        "ACCOUNT_MODE_UNSUPPORTED",
        "This dedicated RWA flow requires Standard mode; unified or portfolio-margin balances cannot be counted as separate DEX collateral.",
      );
  }
  async source(
    id: string,
    minimumRequiresRwa = false,
    observation?: AccountObservationLimits,
  ) {
    const prepared = this.preparedSource?.getStore();
    if (prepared?.nativeSourcePlan)
      await this.validatePreparedNativeSource(prepared, id);
    const validate = () => {
      if (!prepared) return;
      this.checkPreparedSource(prepared, id, minimumRequiresRwa);
      this.assertPrepared(prepared).sourceRetryLimits();
    };
    if (prepared) validate();
    if (minimumRequiresRwa) await this.sourceIdentities.resolve(id, true);
    const snapshot = prepared
      ? await this.assertPrepared(prepared).readSource(
          (limits) =>
            this.preparedSource.exit(() =>
              this.sourceFeed.readPrepared(
                id,
                async (work) => {
                  validate();
                  return this.assertPrepared(prepared).supplement(work, {
                    signal: limits.signal,
                  });
                },
                limits,
                validate,
              ),
            ),
          observation,
        )
      : await this.sourceFeed.read(id);
    if (
      snapshot.observation_scope_requires_rwa !== undefined ||
      minimumRequiresRwa
    ) {
      const minimum = await this.resolve(id);
      if (
        minimum.tags?.includes("category:stocks_rwa") &&
        snapshot.observation_scope_requires_rwa !== true
      )
        throw new AgentError(
          "SOURCE_SCOPE_UNAVAILABLE",
          "The source scope requirement increased; a new complete RWA observation is required.",
          true,
          503,
        );
      const returnedAt = now();
      if (
        [
          snapshot.observed_at,
          ...snapshot.positions.map((position) => position.observed_at),
        ].some(
          (observedAt) =>
            !Number.isFinite(observedAt) ||
            observedAt > returnedAt ||
            returnedAt - observedAt > 5000,
        )
      )
        throw new AgentError(
          "SOURCE_STALE",
          "Source evidence expired while verifying the required observation scope.",
          true,
          503,
        );
    }
    if (prepared) {
      validate();
      if (prepared.nativeSourcePlan)
        await this.validatePreparedNativeSource(prepared, id);
      const values = prepared.sourceEvidenceEnds?.get(id) ?? new Set<number>();
      if (!values.has(snapshot.observed_at) && values.size >= 64)
        throw this.preparedFailure();
      values.add(snapshot.observed_at);
      (prepared.sourceEvidenceEnds ??= new Map()).set(id, values);
    }
    return snapshot;
  }
  private async readSource(id: string) {
    if (
      this.venueReads.nativeSourceReadActive?.() !== true &&
      process.env.RIDE_AGENT_PREDICTION_ENABLED === "true" &&
      (await this.prediction.recognizes(id))
    )
      return this.prediction.source(id);
    const row = await this.resolve(id);
    if (
      row.tags?.includes("category:stocks_rwa") &&
      process.env.RIDE_AGENT_RWA_ENABLED !== "true"
    )
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "The original source requires complete RWA observations, which are not enabled.",
        true,
        503,
      );
    const native = await this.infoWithEvidence(
        { type: "clearinghouseState", user: row.address },
        true,
      ),
      state = native.value,
      scopeTimes = new Map<string, number>([["", native.observed_at]]);
    // Preserve the dispatch time of each position's actual state read. Later
    // scopes or cached metadata must never relabel earlier financial evidence.
    const positionTimes = new Map<unknown, number>();
    if (Array.isArray(state?.assetPositions))
      for (const item of state.assetPositions)
        positionTimes.set(item?.position, native.observed_at);
    const perpsDexes = [""];
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
            evidence: await this.infoWithEvidence(
              { type: "clearinghouseState", user: row.address, dex },
              true,
            ),
            meta: await this.info({ type: "meta", dex }, true),
          })),
        );
        for (const observation of observations) {
          const observedState = observation.evidence.value;
          scopeTimes.set(observation.dex, observation.evidence.observed_at);
          if (observation.meta.collateralToken !== 0) {
            if (
              observedState.assetPositions?.some(
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
            !Array.isArray(observedState.assetPositions) ||
            observedState.marginSummary?.accountValue == null
          )
            throw new AgentError(
              "SOURCE_STALE",
              "Source RWA scope is incomplete.",
              true,
            );
          perpsDexes.push(observation.dex);
          state.marginSummary.accountValue = D(state.marginSummary.accountValue)
            .plus(observedState.marginSummary.accountValue)
            .toString();
          state.assetPositions.push(
            ...observedState.assetPositions.map((item: any) => {
              const position = {
                ...item.position,
                coin: item.position.coin.includes(":")
                  ? item.position.coin
                  : observation.dex + ":" + item.position.coin,
              };
              positionTimes.set(position, observation.evidence.observed_at);
              return { ...item, position };
            }),
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
    const completedAt = now(),
      at = Math.min(...scopeTimes.values());
    if (
      [...scopeTimes.values()].some(
        (observedAt) =>
          !Number.isFinite(observedAt) ||
          observedAt > completedAt ||
          completedAt - observedAt > 5000,
      )
    )
      throw new AgentError(
        "SOURCE_STALE",
        "Complete source scope evidence expired during observation.",
        true,
        503,
      );
    const activePositions = state.assetPositions
      .map((item: any) => item.position)
      .filter((x: any) => x && !D(x.szi).isZero());
    if (
      activePositions.some(
        (x: any) => !inObservedPerpsScope(x.coin, perpsDexes),
      )
    )
      throw new AgentError(
        "SOURCE_STALE",
        "Source positions exceed the observed Perps scopes.",
        true,
      );
    const positions: PositionIntent[] = activePositions.map((x: any) => ({
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
      observed_at: positionTimes.get(x)!,
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
      perps_dexes: perpsDexes,
      observation_scope_requires_rwa: Boolean(
        row.tags?.includes("category:stocks_rwa"),
      ),
      complete: true,
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
    const row = await this.resolve(id, "profile"),
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
          ...(type === "userFillsByTime" ? { aggregateByTime: false } : {}),
        },
        source,
      );
      if (!Array.isArray(rows))
        return { events: [...result.values()], complete: false };
      for (const row of rows) {
        const identity = `${row?.tid ?? row?.hash ?? fingerprint(row)}:${row?.time}`;
        const previous = result.get(identity);
        if (
          source &&
          type === "userFillsByTime" &&
          previous &&
          fingerprint(previous) !== fingerprint(row)
        )
          throw new AgentError(
            "SOURCE_FILL_EVIDENCE_MISSING",
            "Source fill identity has conflicting history.",
            true,
          );
        result.set(identity, row);
      }
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
  private preparedFailure(): AgentError {
    return new AgentError(
      "VENUE_COST_PLAN_UNAVAILABLE",
      "Prepared read window is unavailable; complete fresh evidence remains required.",
      true,
      503,
    );
  }
  private preparedInput(value: any): PreparedPortfolioInput {
    const allowed = new Set([
      "id",
      "revision",
      "control_id",
      "account_id",
      "venue_accounts",
      "ledger_started_at",
      "preferences",
      "loss_latched",
      "state",
      "sleeves",
      "handoff_binding",
      "has_nonterminal_executions",
      "audit_snapshot_hash",
      "write_binding",
      "purpose",
    ]);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (value.purpose !== undefined && value.purpose !== "audit_source") ||
      Object.keys(value).some((k) => !allowed.has(k)) ||
      JSON.stringify(value).length > 32768 ||
      typeof value.id !== "string" ||
      !value.id ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      typeof value.account_id !== "string" ||
      !value.account_id ||
      !Number.isSafeInteger(value.ledger_started_at) ||
      value.ledger_started_at <= 0 ||
      !Array.isArray(value.sleeves) ||
      value.sleeves.length < 1 ||
      value.sleeves.length > 8 ||
      value.sleeves.some(
        (s: any) =>
          !s ||
          typeof s.copy_id !== "string" ||
          (s.fixed_last_fill_at !== undefined &&
            (!Number.isSafeInteger(s.fixed_last_fill_at) ||
              s.fixed_last_fill_at < 0)) ||
          (s.copy_mode !== undefined &&
            !["ride_recommends", "fixed", "proportional"].includes(
              s.copy_mode,
            )) ||
          s.trader?.market !== "perps" ||
          typeof s.trader.id !== "string" ||
          !Array.isArray(s.trader.assets) ||
          s.trader.assets.some((a: any) => typeof a !== "string"),
      ) ||
      value.has_nonterminal_executions !== false ||
      value.state === "closed"
    )
      throw this.preparedFailure();
    const {
      audit_snapshot_hash: _audit,
      write_binding: _write,
      ...compact
    } = value;
    return compact as PreparedPortfolioInput;
  }
  private assertPrepared(entry: PreparedEntry): PreparedAccountWindow {
    if (
      entry.expired ||
      !entry.window ||
      entry.window.expires_at <= now() ||
      this.preparedEntries.get(entry.key) !== entry
    )
      throw this.preparedFailure();
    return entry.window;
  }
  private activeReadonlyControl(user: string, p: Portfolio): boolean {
    const entry = this.preparedEntries.get(fingerprint([user, p.id]));
    return (
      !!entry &&
      entry.portfolio.purpose === "audit_source" &&
      !entry.expired &&
      !!entry.window &&
      entry.window.expires_at > now() &&
      entry.portfolio.revision === p.revision &&
      (entry.portfolio.control_id ?? null) === (p.control_id ?? null) &&
      (entry.portfolio.venue_accounts?.perps ?? entry.portfolio.account_id) ===
        (p.venue_accounts?.perps ?? p.account_id)
    );
  }
  private preparedHandle(
    handle: string,
    user?: string,
    portfolioId?: string,
  ): PreparedEntry {
    if (!/^[0-9a-f]{64}$/.test(handle)) throw this.preparedFailure();
    const entry = [...this.preparedEntries.values()].find(
      (e) => e.handle === handle,
    );
    if (
      !entry ||
      (user !== undefined && entry.user !== user) ||
      (portfolioId !== undefined && entry.portfolio.id !== portfolioId)
    )
      throw this.preparedFailure();
    return entry;
  }
  private async finishPrepared(entry: PreparedEntry): Promise<void> {
    entry.expired = true;
    clearTimeout(entry.timer);
    entry.disposeSourceRetries?.();
    entry.disposeSourceRetries = undefined;
    if (entry.window) await entry.window.close();
    else if (entry.pin) await this.venueReads.cancelPreparedPending(entry.pin);
  }
  private async preparedIdentity(user: string, p: PreparedPortfolioInput) {
    const accountId = p.venue_accounts?.perps ?? p.account_id;
    if (typeof accountId !== "string" || !accountId)
      throw this.preparedFailure();
    const identity = await this.core("perps_account", {
      user_id: user,
      account_id: accountId,
    });
    if (
      identity.account_id !== accountId ||
      identity.network !== (this.network === "mainnet" ? 2 : 1) ||
      typeof identity.master !== "string" ||
      !/^0x[0-9a-f]{40}$/i.test(identity.master) ||
      typeof identity.agent !== "string" ||
      !/^0x[0-9a-f]{40}$/i.test(identity.agent) ||
      !Number.isSafeInteger(identity.wallet_generation) ||
      identity.wallet_generation < 0
    )
      throw this.preparedFailure();
    const handoffs = manualMarkets(identity, accountId);
    return this.perpsCostOwner(
      user,
      p as unknown as Portfolio,
      false,
      identity,
      accountId,
      handoffs,
    );
  }
  private async preparedNativeSourcePlan(entry: PreparedEntry) {
    const selected = entry.portfolio.sleeves.filter(
      (s) => s.state !== "closed",
    );
    if (
      entry.graph !== "readonly-runner-native-v1" ||
      entry.portfolio.purpose !== "audit_source" ||
      this.infoReadRoute !== "core" ||
      this.network !== "mainnet" ||
      !selected.length ||
      selected.length > 8 ||
      selected.some(
        (s) =>
          s.trader.market !== "perps" ||
          sourceRequiresRwa(s.trader as Candidate),
      )
    )
      return;
    try {
      const unique = [...new Set(selected.map((s) => s.trader.id))].sort();
      const sources: NativeSourcePlanSource[] = await Promise.all(
        unique.map(async (id) => {
          if (
            process.env.RIDE_AGENT_PREDICTION_ENABLED === "true" &&
            (await this.prediction.recognizes(id))
          )
            throw this.preparedFailure();
          const identity = await this.sourceIdentities.resolve(id);
          if (
            identity.requires_rwa !== false ||
            !/^0x[0-9a-f]{40}$/.test(identity.address) ||
            this.sourceIdentities.id(identity.address) !== id
          )
            throw this.preparedFailure();
          return {
            id,
            address: identity.address,
            requires_rwa: false as const,
          };
        }),
      );
      if (
        entry.expired ||
        entry.deadline <= now() ||
        this.preparedEntries.get(entry.key) !== entry
      )
        throw this.preparedFailure();
      const context = {
        costOwner: entry.costOwner,
        frameOwner: entry.frameOwner,
        firstDeadline: entry.deadline,
        operationalBinding: fingerprint([entry.stable, entry.graph]),
        purpose: "audit_source" as const,
        network: "mainnet" as const,
      };
      let plan!: NativeSourcePlan;
      plan = this.venueReads.createNativeSourcePlan(
        this,
        context,
        {
          sources,
          nonClosedSleeves: selected.length,
          fixedSourceIds: selected
            .filter((s) => s.copy_mode === "fixed")
            .map((s) => s.trader.id),
        },
        async (source) => {
          try {
            this.assertPrepared(entry);
            if (
              entry.nativeSourcePlan !== plan ||
              fingerprint([entry.stable, entry.graph]) !==
                context.operationalBinding
            )
              throw this.preparedFailure();
            if (
              process.env.RIDE_AGENT_PREDICTION_ENABLED === "true" &&
              (await this.prediction.recognizes(source.id))
            )
              throw this.preparedFailure();
            const current = await this.sourceIdentities.resolve(source.id);
            if (
              current.requires_rwa !== false ||
              current.address !== source.address ||
              this.sourceIdentities.id(current.address) !== source.id
            )
              throw this.preparedFailure();
            this.assertPrepared(entry);
            if (
              entry.nativeSourcePlan !== plan ||
              fingerprint([entry.stable, entry.graph]) !==
                context.operationalBinding
            )
              throw this.preparedFailure();
          } catch (error) {
            // Revoke the entire old graph before a replacement can be booked.
            // This never edits another entry or forgives already paid reads.
            await this.finishPrepared(entry).catch(() => {});
            throw error;
          }
        },
      );
      return {
        plan,
        context,
        addresses: Object.freeze(
          Object.fromEntries(sources.map((s) => [s.id, s.address])),
        ),
      };
    } catch {
      // Unknown/currently broader identities retain the original S contract.
      // They can never mint a discounted capability from candidate labels.
      return;
    }
  }
  private async validatePreparedNativeSource(entry: PreparedEntry, id: string) {
    this.assertPrepared(entry);
    const plan = entry.nativeSourcePlan,
      context = entry.nativeSourceContext,
      address = entry.nativeSourceAddresses?.[id];
    if (!plan || !context || !address) throw this.preparedFailure();
    await this.venueReads.validateNativeSourcePlan(this, plan, context, {
      type: "clearinghouseState",
      user: address,
    });
    this.assertPrepared(entry);
    if (entry.nativeSourcePlan !== plan) throw this.preparedFailure();
  }
  private async preparePortfolio(
    user: string,
    value: any,
    limits?: AccountObservationLimits,
    graph?: "readonly-runner-native-v1",
  ) {
    const reply = (result: Record<string, unknown>) =>
      value?.purpose === "audit_source"
        ? { ...result, purpose: "audit_source", execution_eligible: false }
        : result;
    if (this.infoReadRoute !== "core" || this.network !== "mainnet")
      return reply({ state: "unsupported" });
    const p = this.preparedInput(value),
      stable = preparedOperationalBinding(p);
    if (typeof user !== "string" || !user || user.length > 256)
      throw this.preparedFailure();
    const key = fingerprint([user, p.id]);
    if (this.preparedCreating.has(key))
      return reply({ state: "pending", retry_after_ms: 250 });
    if (this.preparedCreating.size >= 64) throw this.preparedFailure();
    this.preparedCreating.set(key, {
      stable,
      cancelled: false,
      ...(graph ? { graph } : {}),
    });
    try {
      let entry = this.preparedEntries.get(key);
      // Metadata does not prove ownership of an already granted peer lease.
      // Only its handle, expiry or drain may end that live read capability.
      if (entry?.window && !entry.expired && entry.window.expires_at > now())
        return p.purpose !== "audit_source" &&
          p.sleeves.some((s) => s.copy_mode === "fixed")
          ? reply({ state: "unsupported" })
          : reply({ state: "pending", retry_after_ms: 250 });
      const fixed = p.sleeves.filter((s) => s.copy_mode === "fixed");
      if (
        (p.purpose !== "audit_source" && fixed.length > 0) ||
        (p.purpose === "audit_source" &&
          new Set(fixed.map((s) => s.trader.id)).size !== fixed.length)
      ) {
        if (entry && !entry.window && entry.stable === stable) {
          await this.finishPrepared(entry).catch(() => {});
          this.preparedEntries.delete(key);
        }
        return reply({ state: "unsupported" });
      }
      for (const [id, old] of this.preparedEntries) {
        if (old.deadline <= now() && old !== entry) {
          await this.finishPrepared(old).catch(() => {});
          this.preparedEntries.delete(id);
        }
      }
      if (
        entry &&
        (entry.stable !== stable ||
          entry.graph !== graph ||
          entry.expired ||
          entry.deadline <= now())
      ) {
        await this.finishPrepared(entry).catch(() => {});
        this.preparedEntries.delete(key);
        // A changed/expired episode is never immediately replaced in this call.
        throw this.preparedFailure();
      }
      if (entry?.window || entry?.polling)
        return reply({ state: "pending", retry_after_ms: 250 });
      if (!entry) {
        if (this.preparedEntries.size >= 64) throw this.preparedFailure();
        const costOwner = await this.preparedIdentity(user, p);
        if (this.preparedCreating.get(key)?.cancelled)
          throw this.preparedFailure();
        if (this.preparedEntries.size >= 64) throw this.preparedFailure();
        const handle = (randomUUID() + randomUUID()).replaceAll("-", "");
        const deadline = now() + 100000;
        const created: PreparedEntry = {
          handle,
          key,
          user,
          portfolio: p,
          stable,
          costOwner,
          frameOwner: fingerprint([
            costOwner,
            "prepared-portfolio-v1",
            p.id,
            stable,
            ...(graph ? [graph] : []),
          ]),
          ...(graph ? { graph } : {}),
          deadline,
          polling: false,
          expired: false,
          timer: setTimeout(() => {
            void this.finishPrepared(created).catch(() => {});
          }, 100000),
        };
        created.timer.unref();
        entry = created;
        this.preparedEntries.set(key, entry);
      }
      entry.polling = true;
      try {
        const currentOwner = await this.preparedIdentity(user, p);
        if (
          currentOwner !== entry.costOwner ||
          entry.expired ||
          this.preparedEntries.get(key) !== entry ||
          this.preparedCreating.get(key)?.cancelled
        )
          throw this.preparedFailure();
        const native = await this.preparedNativeSourcePlan(entry);
        if (
          entry.expired ||
          this.preparedEntries.get(key) !== entry ||
          this.preparedCreating.get(key)?.cancelled
        )
          throw this.preparedFailure();
        entry.nativeSourcePlan = native?.plan;
        entry.nativeSourceContext = native?.context;
        entry.nativeSourceAddresses = native?.addresses;
        const window = await this.venueReads.prepareAccountWindow(
          entry.costOwner,
          entry.frameOwner,
          entry.deadline,
          entry.pin,
          limits?.signal,
          {
            purpose: p.purpose ?? "audit_submit",
            ...(native
              ? {
                  nativeSourcePlan: native.plan,
                  nativeSourceContext: native.context,
                }
              : {}),
            historySources:
              p.purpose === "audit_source"
                ? [
                    ...new Set(
                      p.sleeves
                        .filter((s) => s.copy_mode === "fixed")
                        .map((s) => s.trader.id),
                    ),
                  ]
                : [],
          },
        );
        if (!window.nativeSourcePlan) {
          entry.nativeSourcePlan = undefined;
          entry.nativeSourceContext = undefined;
          entry.nativeSourceAddresses = undefined;
        }
        if (entry.expired || this.preparedEntries.get(key) !== entry) {
          await window.close();
          throw this.preparedFailure();
        }
        entry.window = window;
        clearTimeout(entry.timer);
        entry.timer = setTimeout(
          () => {
            void this.finishPrepared(entry!).catch(() => {});
          },
          Math.max(0, window.expires_at - now()),
        );
        entry.timer.unref();
        return reply({
          state: "ready",
          handle: entry.handle,
          mode: window.mode,
          expires_at: window.expires_at,
        });
      } catch (error) {
        const localRetry = this.venueReads.preparedLocalRetry(error, {
          owner: entry.costOwner,
          frameOwner: entry.frameOwner,
          firstDeadline: entry.deadline,
          continuation: entry.pin,
          purpose: p.purpose ?? "audit_submit",
          nativeSourcePlan: entry.nativeSourcePlan,
          historySources:
            p.purpose === "audit_source"
              ? [
                  ...new Set(
                    p.sleeves
                      .filter((s) => s.copy_mode === "fixed")
                      .map((s) => s.trader.id),
                  ),
                ]
              : [],
        });
        if (localRetry !== undefined) {
          if (
            entry.expired ||
            entry.deadline <= now() ||
            this.preparedEntries.get(key) !== entry ||
            this.preparedCreating.get(key)?.cancelled ||
            limits?.signal?.aborted
          ) {
            await this.finishPrepared(entry).catch(() => {});
            throw this.preparedFailure();
          }
          // This is private local scheduling metadata, never a Core receipt.
          // Keep the exact entry, optional Core pin and original FIRST deadline.
          return reply({ state: "pending", retry_after_ms: localRetry });
        }
        if (isPreparedBundleUnsupported(error)) {
          await this.finishPrepared(entry).catch(() => {});
          if (this.preparedEntries.get(key) === entry)
            this.preparedEntries.delete(key);
          return reply({ state: "unsupported" });
        }
        const pin = framePendingContinuation(error);
        if (pin && (entry.expired || this.preparedEntries.get(key) !== entry)) {
          await this.venueReads.cancelPreparedPending(pin).catch(() => {});
          throw this.preparedFailure();
        }
        if (pin && !entry.expired && this.preparedEntries.get(key) === entry) {
          if (entry.pin && entry.pin !== pin) throw this.preparedFailure();
          entry.pin = pin;
          return reply({
            state: "pending",
            retry_after_ms:
              (error as AgentError).details?.retry_after_ms ?? 1000,
          });
        }
        await this.finishPrepared(entry).catch(() => {});
        throw error;
      } finally {
        entry.polling = false;
      }
    } finally {
      this.preparedCreating.delete(key);
    }
  }

  private async cancelPreparedPortfolio(
    user: string,
    value: any,
    graph?: "readonly-runner-native-v1",
  ) {
    const p = this.preparedInput(value),
      stable = preparedOperationalBinding(p),
      key = fingerprint([user, p.id]);
    const entry = this.preparedEntries.get(key);
    const readonly = p.purpose === "audit_source";
    const reply = (cancelled: boolean) =>
      readonly ? { ok: true, pending_cancelled: cancelled } : { ok: true };
    if (entry && entry.graph !== graph) return reply(false);
    // A pending interest is not ownership of a peer's ready window.
    if (
      entry?.window &&
      !(
        readonly &&
        entry.stable === stable &&
        (entry.expired || entry.window.expires_at <= now())
      )
    )
      return reply(false);
    const creating = this.preparedCreating.get(key);
    if (creating && creating.graph !== graph) return reply(false);
    if (creating?.stable === stable) creating.cancelled = true;
    if (
      readonly &&
      ((entry && entry.stable !== stable) ||
        (creating && creating.stable !== stable))
    )
      return reply(false);
    if (entry && entry.stable === stable) {
      if (readonly) await this.finishPrepared(entry);
      else await this.finishPrepared(entry).catch(() => {});
      if (this.preparedEntries.get(key) === entry)
        this.preparedEntries.delete(key);
    }
    return reply(!creating);
  }

  private checkPreparedSource(
    entry: PreparedEntry,
    id: string,
    requiresRwa: boolean,
  ) {
    this.assertPrepared(entry);
    if (!entry.auditHash) throw this.preparedFailure();
    const selected = entry.portfolio.sleeves.find(
      (s) => s.state !== "closed" && s.trader.id === id,
    );
    if (
      !selected ||
      sourceRequiresRwa(selected.trader as Candidate) !== requiresRwa
    )
      throw this.preparedFailure();
  }
  private async preparedAccount(
    entry: PreparedEntry,
    user: string,
    p: Portfolio,
    limits?: AccountObservationLimits,
  ) {
    const window = this.assertPrepared(entry);
    const compact = preparedPortfolioInput(p, entry.portfolio.purpose);
    if (
      entry.auditHash ||
      entry.attempted ||
      compact.has_nonterminal_executions ||
      preparedOperationalBinding(compact) !== entry.stable
    )
      throw this.preparedFailure();
    const snap = await window.read(() => this.account(user, p), limits);
    this.assertPrepared(entry);
    entry.auditHash = fingerprint(snap);
    const selectedSources = new Map<string, { requiresRwa: boolean }>();
    for (const s of entry.portfolio.sleeves.filter(
      (s) => s.state !== "closed",
    )) {
      const requiresRwa = sourceRequiresRwa(s.trader as Candidate),
        prior = selectedSources.get(s.trader.id);
      if (prior && prior.requiresRwa !== requiresRwa)
        throw this.preparedFailure();
      selectedSources.set(s.trader.id, { requiresRwa });
    }
    // Only existing verified-unsent interests participate. This synchronous
    // selection neither creates interest nor starts a read or changes backoff.
    entry.disposeSourceRetries = this.sourceFeed.registerPreparedSources(
      [...selectedSources].map(([id, { requiresRwa }]) => {
        const validate = () => {
          this.checkPreparedSource(entry, id, requiresRwa);
          this.assertPrepared(entry).sourceRetryLimits();
        };
        return {
          id,
          validate,
          onDemand: async (work: () => Promise<SourceSnapshot>) => {
            validate();
            return this.assertPrepared(entry).supplement(work);
          },
        };
      }),
      window.sourceRetryLimits(),
    );
    return snap;
  }
  private prepareExecution(entry: PreparedEntry, value: any, proposal: any) {
    if (entry.portfolio.purpose === "audit_source")
      throw this.preparedFailure();
    const window = this.assertPrepared(entry),
      p = this.preparedInput(value);
    window.assertNextChildReady();
    if (
      window.mode !== "warm" ||
      !entry.auditHash ||
      entry.proposal ||
      entry.attempted ||
      value.audit_snapshot_hash !== entry.auditHash ||
      preparedOperationalBinding(p) !== entry.stable ||
      typeof value.write_binding !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.write_binding) ||
      !proposal ||
      typeof proposal.key !== "string" ||
      !proposal.key.startsWith("perps:") ||
      typeof proposal.target_quantity !== "string" ||
      !Number.isFinite(Number(proposal.target_quantity)) ||
      proposal.revision !== p.revision ||
      typeof proposal.reserve_usdc !== "string" ||
      !Number.isFinite(Number(proposal.reserve_usdc)) ||
      !proposal.allocations ||
      Array.isArray(proposal.allocations)
    )
      throw this.preparedFailure();
    entry.proposal = preparedProposalBinding(proposal);
    entry.writeBinding = value.write_binding;
    return { ready: true };
  }
  private bindPreparedExecution(
    entry: PreparedEntry,
    user: string,
    p: Portfolio,
    e: Execution,
  ) {
    const window = this.assertPrepared(entry);
    if (
      window.mode !== "warm" ||
      entry.user !== user ||
      entry.portfolio.id !== p.id ||
      entry.attempted ||
      !entry.proposal ||
      entry.proposal !== preparedProposalBinding(e) ||
      preparedOperationalBinding(preparedPortfolioInput(p)) !== entry.stable ||
      preparedWriteBinding(p, e.id, user) !== entry.writeBinding ||
      e.status !== "queued" ||
      e.task_id ||
      p.executions.filter((x) => x.id === e.id).length !== 1 ||
      e.expires_at !== e.created_at + 60000 ||
      e.created_at > now() ||
      e.fingerprint !==
        fingerprint({
          id: e.id,
          key: e.key,
          target_quantity: e.target_quantity,
          allocations: e.allocations,
          revision: e.revision,
          created_at: e.created_at,
          expires_at: e.expires_at,
        })
    )
      throw this.preparedFailure();
    entry.attempted = { id: e.id, fingerprint: e.fingerprint };
  }
  async perpsAccount(
    user: string,
    p: Portfolio | null,
    bind = false,
    observation?: AccountObservationLimits,
    freshSubmitPurpose?: FreshSubmitReadPurpose,
  ): Promise<AccountSnapshot> {
    return this.venueReads.observeAccount(
      () => this.readPerpsAccount(user, p, bind),
      fingerprint([
        user,
        this.network,
        p?.venue_accounts?.perps ?? p?.account_id,
        bind,
        Boolean(p?.ledger_started_at),
        [
          ...new Set(
            (p?.sleeves ?? [])
              .flatMap((s) => s.trader.assets)
              .filter((asset) => asset.includes(":")),
          ),
        ].sort(),
      ]),
      observation,
      freshSubmitPurpose,
    );
  }
  private perpsCostOwner(
    user: string,
    p: Portfolio | null,
    bind: boolean,
    identity: any,
    accountId: string,
    handoffs: ManualMarketHandoff[],
  ): string {
    return fingerprint([
      ACCOUNT_OBSERVATION_COST_CONTRACT,
      this.infoReadRoute,
      [new URL(this.coreUrl).origin, new URL(this.coreUrl).pathname],
      this.network,
      user,
      accountId,
      identity.network,
      identity.master.toLowerCase(),
      identity.agent.toLowerCase(),
      identity.wallet_generation,
      bind,
      p?.ledger_started_at ?? null,
      [
        ...new Set(
          (p?.sleeves ?? [])
            .flatMap((s) => s.trader.assets)
            .filter((asset) => asset.includes(":")),
        ),
      ].sort(),
      handoffs.map((handoff) => handoff.coin).sort(),
      process.env.RIDE_AGENT_UNIFIED_ENABLED === "true",
      process.env.RIDE_AGENT_RWA_ENABLED === "true",
    ]);
  }
  private async readPerpsAccount(
    user: string,
    p: Portfolio | null,
    bind: boolean,
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
    const handoffs = manualMarkets(identity, accountId);
    // A persistent hint belongs to the current resolved wallet generation,
    // never merely to a requested account ID. Wallet discovery/binding and
    // older incomplete Core identities retain ordinary conservative admission.
    if (
      binding &&
      !bind &&
      identity.account_id === accountId &&
      identity.network === (this.network === "mainnet" ? 2 : 1) &&
      typeof identity.master === "string" &&
      /^0x[0-9a-f]{40}$/i.test(identity.master) &&
      typeof identity.agent === "string" &&
      /^0x[0-9a-f]{40}$/i.test(identity.agent) &&
      Number.isSafeInteger(identity.wallet_generation) &&
      identity.wallet_generation >= 0
    ) {
      this.venueReads.bindAccountCostPlan(
        this.perpsCostOwner(user, p, bind, identity, accountId, handoffs),
      );
    } else this.venueReads.disableAccountCostPlan();
    if (
      p?.manual_ledger?.transfers.some(
        (transfer) =>
          !handoffs.some(
            (handoff) => fingerprint(handoff) === fingerprint(transfer.handoff),
          ),
      )
    )
      throw new AgentError(
        "HANDOFF_CHANGED",
        "Recorded manual market ownership is missing or changed.",
      );
    const recovered: NonNullable<AccountSnapshot["recovered_executions"]> = [];
    const recoveredStatuses = new Map<string, any>();
    for (const execution of (p?.executions ?? []).filter(
      (e) =>
        !["completed", "failed", "superseded"].includes(e.status) &&
        handoffs.some((handoff) => e.key === `perps:${handoff.coin}`),
    )) {
      const status = await this.core("perps_execution_lookup", {
        user_id: user,
        account_id: accountId,
        execution_id: execution.id,
      });
      if (status?.found === false) {
        if (execution.task_id)
          throw new AgentError(
            "HANDOFF_PENDING",
            "The read-only lookup cannot prove ownership of an existing task.",
            true,
          );
        recovered.push({
          execution_id: execution.id,
          task_id: null,
          status: "superseded",
          settled: true,
        });
      } else if (
        status?.found === true &&
        typeof status.task_id === "string" &&
        [1, 2, 3, 4, 5, 6, 7].includes(status.status)
      ) {
        if (execution.task_id && execution.task_id !== status.task_id)
          throw new AgentError(
            "HANDOFF_PENDING",
            "Stable execution identity changed during handoff reconciliation.",
            true,
          );
        let evidence: any;
        try {
          evidence =
            typeof status.snapshot === "string"
              ? JSON.parse(status.snapshot)
              : status.snapshot;
        } catch {}
        if (
          typeof evidence?.fill_settlement_pending !== "boolean" ||
          typeof evidence?.settlement_observation_required !== "boolean"
        )
          throw new AgentError(
            "HANDOFF_PENDING",
            "Stable execution settlement evidence is incomplete.",
            true,
          );
        const pendingSettlement =
          evidence.fill_settlement_pending ||
          evidence.settlement_observation_required;
        const settled =
          [3, 4, 5, 6].includes(status.status) && !pendingSettlement;
        recovered.push({
          execution_id: execution.id,
          task_id: status.task_id,
          status: !settled
            ? "settling"
            : status.status === 3
              ? "completed"
              : status.status === 6
                ? "superseded"
                : "failed",
          settled,
        });
        recoveredStatuses.set(status.task_id, status);
      } else
        throw new AgentError(
          "HANDOFF_PENDING",
          "Stable execution lookup is incomplete; ownership cannot be transferred.",
          true,
        );
    }
    const abstraction = await this.info({
        type: "userAbstraction",
        user: identity.master,
      }),
      mode = perpsAccountMode(abstraction),
      readHistory = async (address: string, start: number, end = now()) => {
        // Read the largest bounded provisional hold before accumulating the
        // other histories' settled weight. Preserve all pages and one fence.
        const fills = await this.paged("userFillsByTime", address, start, end);
        const [funding, flows] = await Promise.all([
          this.paged("userFunding", address, start, end),
          this.paged("userNonFundingLedgerUpdates", address, start, end),
        ]);
        return [fills, funding, flows] as const;
      },
      financialPrefix =
        mode === "unified" &&
        process.env.RIDE_AGENT_UNIFIED_ENABLED === "true" &&
        binding != null &&
        !!p?.ledger_started_at &&
        !bind &&
        !(p?.sleeves ?? []).some((s) =>
          s.trader.assets.some((asset) => asset.includes(":")),
        );
    let state: any, orders: any, mids: any, meta: any, spotPrefix: any;
    let savedHistory: Awaited<ReturnType<typeof readHistory>> | undefined;
    let prefixDexes: any, prefixScopes: ForeignAccountRead | undefined;
    let nativeObservedAt: number | undefined;
    let historyCompletedAt: number | undefined;
    if (financialPrefix) {
      // Discover scopes before financial evidence, so the native pair and all
      // foreign guards share one fresh connection before the history fence.
      prefixDexes = await this.info({ type: "perpDexs" });
      if (
        !Array.isArray(prefixDexes) ||
        prefixDexes[0] !== null ||
        prefixDexes
          .slice(1)
          .some((dex: any) => typeof dex?.name !== "string" || !dex.name.trim())
      )
        throw new AgentError(
          "ACCOUNT_STALE",
          "Complete Perps market scopes are unavailable.",
          true,
        );
      const scopeNames = [
        "",
        ...prefixDexes.slice(1).map((dex: any) => dex.name as string),
      ];
      [prefixScopes, mids, spotPrefix] = await Promise.all([
        this.orderSnapshots
          .readAccount(
            identity.master,
            scopeNames,
            this.venueReads.accountReadSignal(),
          )
          .catch(() => undefined),
        this.info({ type: "allMids" }),
        this.info({ type: "spotClearinghouseState", user: identity.master }),
      ]);
      this.venueReads.accountReadTimeout();
      const observed = now(),
        native =
          prefixScopes?.states instanceof Map
            ? (prefixScopes.states.get("") as any)
            : undefined;
      const nativeOrdersAt =
        prefixScopes?.dispatches?.orders instanceof Map
          ? prefixScopes.dispatches.orders.get("")
          : undefined;
      const nativeStateAt =
        prefixScopes?.dispatches?.states instanceof Map
          ? prefixScopes.dispatches.states.get("")
          : undefined;
      const validDispatch = (at: unknown): at is number =>
        typeof at === "number" &&
        Number.isSafeInteger(at) &&
        at > 0 &&
        at <= observed;
      const nativeDecimal = (value: unknown): value is string | number =>
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" &&
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) &&
          D(value).isFinite());
      if (
        !(prefixScopes?.orders instanceof Map) ||
        !(prefixScopes.states instanceof Map) ||
        scopeNames.some(
          (dex) =>
            !Array.isArray(prefixScopes!.orders.get(dex)) ||
            !Array.isArray(
              (prefixScopes!.states.get(dex) as any)?.assetPositions,
            ),
        ) ||
        prefixScopes.orders.get("")!.length !== 0 ||
        !nativeDecimal(native?.marginSummary?.accountValue) ||
        !nativeDecimal(native?.withdrawable) ||
        !validDispatch(nativeOrdersAt) ||
        !validDispatch(nativeStateAt)
      ) {
        // WS orders do not promise frontend order fields. Nonempty native,
        // partial or unproven batches retain the entire original REST sweep.
        prefixScopes = undefined;
        [state, orders] = await Promise.all([
          this.info({ type: "clearinghouseState", user: identity.master }),
          this.info({ type: "frontendOpenOrders", user: identity.master }),
        ]);
      } else {
        state = {
          ...native,
          marginSummary: {
            ...native.marginSummary,
            accountValue: String(native.marginSummary.accountValue),
          },
          withdrawable: String(native.withdrawable),
        };
        orders = prefixScopes.orders.get("");
        nativeObservedAt = Math.min(nativeOrdersAt, nativeStateAt);
      }
      if (
        !state.marginSummary?.accountValue ||
        !Array.isArray(state.assetPositions)
      )
        throw new AgentError(
          "ACCOUNT_STALE",
          "Account observations are incomplete.",
          true,
        );
      unifiedUsdc(spotPrefix);
      // All returned native financial evidence, including fallback REST, must
      // precede the complete history fence. Later guards cannot backfill it.
      savedHistory = await readHistory(
        identity.master,
        p!.ledger_started_at!,
        now(),
      );
      historyCompletedAt = now();
      meta = await this.info({ type: "meta" });
    } else {
      [state, orders, mids, meta] = await Promise.all([
        this.info({ type: "clearinghouseState", user: identity.master }),
        this.info({ type: "frontendOpenOrders", user: identity.master }),
        this.info({ type: "allMids" }),
        this.info({ type: "meta" }),
      ]);
    }
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
      const readDexAbstraction = async () => {
        if (financialPrefix) {
          try {
            const proof = await this.orderSnapshots.readAbstraction(
              identity.master,
              this.venueReads.accountReadSignal(),
              historyCompletedAt,
            );
            this.venueReads.accountReadTimeout();
            const at = now();
            const fresh = (value: unknown): value is number =>
              typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value > 0 &&
              value <= at &&
              at - value <= 5000;
            if (
              proof &&
              typeof proof.user === "string" &&
              proof.user.toLowerCase() === identity.master.toLowerCase() &&
              proof.dex_abstraction_enabled === false &&
              fresh(proof.dispatch_at) &&
              fresh(proof.server_time) &&
              historyCompletedAt !== undefined &&
              proof.server_time >= historyCompletedAt
            ) {
              nativeObservedAt = Math.min(
                nativeObservedAt ?? Infinity,
                proof.dispatch_at,
                proof.server_time,
              );
              return false;
            }
          } catch {
            /* Fresh independent control proof is optional; retain REST. */
          }
        }
        this.venueReads.accountReadTimeout();
        // webData3 no longer always supplies the legacy boolean. Keep that
        // optional proof strict and re-read the authoritative current enum via
        // the same account budget/deadline after history, never infer false
        // from the field's absence or reuse the earlier account-mode read.
        const current = await this.info({
          type: "userAbstraction",
          user: identity.master,
        });
        if (perpsAbstractionState(current) !== "unified")
          throw new AgentError(
            "ACCOUNT_STALE",
            "Account abstraction changed or could not be verified during the balance observation.",
            true,
          );
        return false;
      };
      const [spot, dexAbstraction, dexes] = await Promise.all([
        financialPrefix
          ? spotPrefix
          : this.info({
              type: "spotClearinghouseState",
              user: identity.master,
            }),
        readDexAbstraction(),
        financialPrefix ? prefixDexes : this.info({ type: "perpDexs" }),
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
      const foreignDexes = dexes.slice(1).map((dex: any) => dex.name as string);
      let freshScopes:
        | { orders: Map<string, unknown[]>; states: Map<string, unknown> }
        | undefined;
      try {
        freshScopes = financialPrefix
          ? prefixScopes
          : await this.orderSnapshots.readAccount(
              identity.master,
              foreignDexes,
              this.venueReads.accountReadSignal(),
            );
      } catch {
        // A failed live snapshot keeps the complete, budgeted REST sweep.
      }
      this.venueReads.accountReadTimeout();
      if (
        !(freshScopes?.orders instanceof Map) ||
        !(freshScopes.states instanceof Map) ||
        foreignDexes.some(
          (dex: string) =>
            !Array.isArray(freshScopes!.orders.get(dex)) ||
            !Array.isArray(
              (freshScopes!.states.get(dex) as { assetPositions?: unknown })
                ?.assetPositions,
            ),
        )
      )
        freshScopes = undefined;
      await Promise.all(
        dexes.slice(1).map(async (dex: any) => {
          const [other, pending] = await Promise.all([
            (freshScopes?.states.get(dex.name) as
              | { assetPositions: { position?: { szi?: string } }[] }
              | undefined) ??
              this.info({
                type: "clearinghouseState",
                user: identity.master,
                dex: dex.name,
              }),
            freshScopes?.orders.get(dex.name) ??
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
        [
          ...(p?.sleeves ?? []).flatMap((s) => s.trader.assets),
          ...handoffs.map((handoff) => handoff.coin),
        ]
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
    if (
      mode === "standard" &&
      perpsAccountMode(
        await this.info({ type: "userAbstraction", user: identity.master }),
      ) !== mode
    )
      throw new AgentError(
        "ACCOUNT_STALE",
        "Account mode changed during the balance observation.",
        true,
      );
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
      manualFills: NonNullable<AccountSnapshot["manual_fills"]> = [],
      funding: AccountSnapshot["funding"] = [],
      flows: AccountSnapshot["flows"] = [],
      coverage = true;
    const oidTasks = new Map<string, string>();
    const orderIsManual = (order: any) =>
      handoffs.some(
        (handoff) =>
          handoff.coin === order.coin &&
          Number.isSafeInteger(order.timestamp) &&
          order.timestamp <= now() &&
          order.timestamp > handoff.at_ms,
      );
    if (p?.ledger_started_at) {
      const [fillRows, fundingRows, flowRows] =
        savedHistory ??
        (await readHistory(identity.master, p.ledger_started_at));
      coverage = fillRows.complete && fundingRows.complete && flowRows.complete;
      if (
        fillRows.events.length ||
        (handoffs.length && orders.some((order: any) => !orderIsManual(order)))
      )
        for (const e of p.executions.filter(
          (e) =>
            e.key.startsWith("perps:") &&
            (e.task_id ||
              recovered.find((entry) => entry.execution_id === e.id)?.task_id),
        )) {
          const task =
            e.task_id ??
            recovered.find((entry) => entry.execution_id === e.id)!.task_id!;
          const status =
            recoveredStatuses.get(task) ??
            (await this.core("perps_execution", {
              user_id: user,
              account_id: accountId,
              task_id: task,
            }));
          for (const leg of status.legs ?? [])
            if (leg.oid) oidTasks.set(String(leg.oid), task);
        }
      for (const f of fillRows.events) {
        const task = oidTasks.get(String(f.oid));
        const handoff = handoffs.find((row) => row.coin === f.coin);
        const manualShape =
          !task &&
          (!Number.isSafeInteger(f.time) ||
            f.time <= 0 ||
            !["B", "A"].includes(f.side) ||
            ![f.sz, f.px, f.fee].every(
              (value) =>
                typeof value === "string" &&
                /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) &&
                D(value).isFinite(),
            ) ||
            !D(f.sz).gt(0) ||
            !D(f.px).gt(0));
        if (
          f.feeToken !== "USDC" ||
          manualShape ||
          (handoff && f.time === handoff.at_ms) ||
          (task && handoff && f.time > handoff.at_ms) ||
          (!task && (!handoff || f.time <= handoff.at_ms))
        ) {
          coverage = false;
          continue;
        }
        const fill = {
          id: `hl_${f.tid}_${f.oid}`,
          order_id: String(f.oid),
          key: `perps:${f.coin}`,
          quantity: D(f.sz)
            .times(f.side === "B" ? 1 : -1)
            .toString(),
          price: String(f.px),
          fee_usdc: String(f.fee),
          at: f.time,
        };
        if (task) fills.push({ ...fill, task_id: task });
        else manualFills.push({ ...fill, handoff_id: handoff!.handoff_id });
      }
      funding = fundingRows.events.map((f) => ({
        id: `fund_${fingerprint(f).slice(0, 32)}`,
        key: `perps:${f.delta.coin}`,
        amount_usdc: String(f.delta.usdc),
        at: f.time,
      }));
      if (
        funding.some((event) =>
          handoffs.some(
            (handoff) =>
              event.key === `perps:${handoff.coin}` &&
              event.at === handoff.at_ms,
          ),
        )
      )
        coverage = false;
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
      observed_at: Math.min(
        this.venueReads.accountObservedAt(),
        nativeObservedAt ?? Infinity,
      ),
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
        ...(handoffs.length
          ? {
              ownership: oidTasks.has(String(x.oid))
                ? ("copy" as const)
                : orderIsManual(x)
                  ? ("manual" as const)
                  : ("unknown" as const),
              ...(oidTasks.has(String(x.oid))
                ? { task_id: oidTasks.get(String(x.oid)) }
                : {}),
            }
          : {}),
      })),
      fills,
      ...(handoffs.length
        ? { manual_markets: handoffs, manual_fills: manualFills }
        : {}),
      ...(recovered.length ? { recovered_executions: recovered } : {}),
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
      ...(snapshots.some((s) => s.manual_markets?.length)
        ? {
            manual_markets: snapshots.flatMap((s) => s.manual_markets ?? []),
            manual_fills: snapshots.flatMap((s) => s.manual_fills ?? []),
          }
        : {}),
      ...(snapshots.some((s) => s.recovered_executions?.length)
        ? {
            recovered_executions: snapshots.flatMap(
              (s) => s.recovered_executions ?? [],
            ),
          }
        : {}),
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
    const hasManual = Boolean(p.manual_ledger?.transfers.length);
    if (
      !fresh(snap.observed_at) ||
      !snap.coverage_complete ||
      snap.orders.some(
        (order) =>
          !hasManual ||
          order.ownership !== "manual" ||
          !manualHandoff(p, order.key),
      ) ||
      (hasManual
        ? !reconcileQuantities({ ...p, snapshot: snap }) ||
          p.sleeves.some((sleeve) =>
            Object.values(sleeve.lots).some(
              (owned) => !D(owned.quantity).isZero(),
            ),
          )
        : Object.values(snap.positions).some((q) => !D(q).isZero()))
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
    observation?: AccountObservationLimits,
    prepared?: PreparedEntry,
  ): Promise<{ task_id: string }> {
    if (e.retirement !== undefined)
      throw new AgentError(
        "EXECUTION_REJECTED",
        "This original execution ID is permanently retired and cannot be submitted.",
      );
    const prediction = e.key.startsWith("prediction:");
    const existing = await this.pool.query(
      "SELECT fingerprint,payload,response FROM ride_agent_core_outbox WHERE execution_id=$1 AND user_id=$2 AND portfolio_id=$3",
      [e.id, user, p.id],
    );
    if (!existing.rowCount && this.activeReadonlyControl(user, p))
      throw this.preparedFailure();
    if (prepared && existing.rowCount) throw this.preparedFailure();
    if (!existing.rowCount && e.expires_at <= now())
      throw new AgentError(
        "EXECUTION_REJECTED",
        "Target expired before submission; fresh planning is required.",
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
      // No outbox is only this existing fresh-read route. It proves neither
      // exchange absence nor permission to replay an old/unknown execution.
      const frozen = (value: Execution) => ({
        id: value.id,
        key: value.key,
        target_quantity: value.target_quantity,
        allocations: value.allocations,
        revision: value.revision,
        created_at: value.created_at,
        expires_at: value.expires_at,
      });
      const executionBinding = (value: Execution) => ({
        ...frozen(value),
        fingerprint: value.fingerprint,
        status: value.status,
        task_id: value.task_id,
        observed_quantity: value.observed_quantity,
        reserve_usdc: value.reserve_usdc,
        error: value.error,
        unfilled_allocations: value.unfilled_allocations,
        retirement: value.retirement,
        first_submission_failure: value.first_submission_failure,
      });
      const eligible = () =>
        this.infoReadRoute === "core" &&
        this.network === "mainnet" &&
        e.status === "queued" &&
        e.task_id === null &&
        e.observed_quantity === null &&
        e.retirement === undefined &&
        e.first_submission_failure === undefined &&
        e.unfilled_allocations === undefined &&
        e.error === null &&
        p.sleeves.length > 0 &&
        p.sleeves.length <= 8 &&
        Object.keys(e.allocations).length <= 8 &&
        e.key.startsWith("perps:") &&
        e.revision === p.revision &&
        typeof (p.venue_accounts?.perps ?? p.account_id) === "string" &&
        p.executions.filter((execution) => execution.id === e.id).length ===
          1 &&
        fingerprint(
          executionBinding(
            p.executions.find((execution) => execution.id === e.id)!,
          ),
        ) === fingerprint(executionBinding(e)) &&
        Number.isSafeInteger(e.created_at) &&
        e.created_at <= now() &&
        e.expires_at === e.created_at + 60000 &&
        e.expires_at > now() &&
        e.fingerprint === fingerprint(frozen(e));
      // Bounded authority and this execution only. Never reserialize the full
      // account snapshot, history, other executions or performance per poll/read.
      const currentBinding = () =>
        fingerprint({
          user,
          network: this.network,
          portfolio: p.id,
          account: p.account_id,
          venue_accounts: p.venue_accounts,
          revision: p.revision,
          control: p.control_id,
          state: p.state,
          loss_latched: p.loss_latched,
          reconciliation: p.reconciliation,
          asset_filter_version: p.asset_filter_version,
          ledger_started_at: p.ledger_started_at,
          preferences: p.preferences,
          sleeves: p.sleeves.map((s) => ({
            copy_id: s.copy_id,
            state: s.state,
            initialized: s.initialized,
            amount_usdc: s.amount_usdc,
            leverage_mode: s.leverage_mode,
            leverage_cap: s.leverage_cap,
            stop_loss_pct: s.stop_loss_pct,
            loss_policy: s.loss_policy,
            emergency_exit_pct: s.emergency_exit_pct,
            copy_mode: s.copy_mode,
            fixed_margin_usdc: s.fixed_margin_usdc,
            proportional_multiplier: s.proportional_multiplier,
            trader: {
              id: s.trader.id,
              market: s.trader.market,
              assets: s.trader.assets,
              asset_category: s.trader.asset_category,
              asset_categories: s.trader.asset_categories,
            },
            source_revision: s.source_revision,
            intent: s.intents[e.key],
            owned: s.lots[e.key],
          })),
          execution: executionBinding(e),
        });
      let purpose: FreshSubmitReadPurpose | undefined;
      if (!prepared && observation && eligible()) {
        const binding = currentBinding();
        purpose = this.venueReads.freshSubmitReadPurpose(
          this,
          {
            user,
            portfolio: p.id,
            account: (p.venue_accounts?.perps ?? p.account_id)!,
            revision: p.revision,
            control: p.control_id ?? "",
            execution: e.id,
            fingerprint: e.fingerprint,
            expiresAt: e.expires_at,
            currentBinding: binding,
          },
          observation,
          () => eligible() && currentBinding() === binding,
        );
      }
      const readAccount = () =>
        this.perpsAccount(
          user,
          p,
          false,
          {
            signal: observation?.signal,
            deadlineMs: Math.min(
              e.expires_at,
              observation?.deadlineMs ?? Infinity,
            ),
            waitForFrameAdmission: true,
          },
          purpose,
        );
      const snap = prepared
        ? await this.assertPrepared(prepared).read(readAccount, observation)
        : await readAccount();
      if (
        snap.manual_markets?.some(
          (handoff) => e.key === `perps:${handoff.coin}`,
        )
      )
        throw new AgentError(
          "EXECUTION_REJECTED",
          "This market was permanently handed to manual trading; no copy target is authorized.",
        );
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
        const source = await this.source(
          s.trader.id,
          sourceRequiresRwa(s.trader),
        );
        const currentSource = source.positions?.find(
          (position) => position.key === intent.key,
        );
        // A structural source revision can stay unchanged for hours. Its old
        // intent timestamp is not the current observation. Re-prove the same
        // source position instead of refreshing the frozen reference price.
        const rawQuantity = (
          intent as typeof intent & {
            raw_source_quantity?: string;
          }
        ).raw_source_quantity;
        const guardFailure = sourcePositionGuardFailure(
          source,
          currentSource,
          intent,
          s,
          () => snap.max_leverages[e.key],
          rawQuantity,
        );
        if (guardFailure)
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Fresh equivalent source-position evidence is required before increasing exposure.",
            false,
            409,
            { reason_code: guardFailure },
          );
        if (D(price).minus(intent.price).abs().div(intent.price).gt(".002"))
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Execution price moved beyond the frozen 0.2% limit.",
          );
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
      if (e.expires_at <= now())
        throw new AgentError(
          "EXECUTION_REJECTED",
          "Target expired during evidence checks; fresh planning is required.",
        );
      // Only a fresh, not-yet-outboxed submission can stop here. Existing
      // frozen actions keep their original acceptance/reconciliation path.
      if (observation?.signal?.aborted) throw observation.signal.reason;
      if (
        observation?.deadlineMs !== undefined &&
        observation.deadlineMs <= now()
      )
        throw new AgentError(
          "VENUE_READ_DEADLINE",
          "Fresh submission evidence deadline expired.",
          true,
          503,
        );
      if (prepared) {
        this.assertPrepared(prepared);
        // Read credit ends before the first durable financial write. Its timer
        // never cancels an outboxed action or adds another financial retry.
        await this.finishPrepared(prepared);
      }
      if (this.activeReadonlyControl(user, p)) throw this.preparedFailure();
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
  private async retireOriginalExecution(
    user: string,
    p: Portfolio,
    e: Execution,
    deadline: number,
  ): Promise<{
    status: "failed";
    observed_quantity: null;
    settled: false;
    retirement: PerpsRetirementReceipt;
  } | null> {
    // Retirement is an explicit Core write. An unset read-only gate does not
    // grant this capability; read-only status queries must never call it.
    if (
      process.env.RIDE_AGENT_READ_ONLY !== "false" ||
      this.network !== "mainnet" ||
      e.status !== "uncertain" ||
      e.task_id ||
      e.expires_at > now() ||
      deadline <= now()
    )
      return null;
    const request = perpsRecoveryRequest(user, this.perpsBinding(p), e);
    if (!request) return null;
    const startedAt = now();
    let response: unknown;
    try {
      response = await this.core(
        "perps_execution_retirement",
        request,
        AbortSignal.timeout(Math.max(1, Math.min(6000, deadline - startedAt))),
      );
    } catch {
      return null;
    }
    const receipt = perpsExecutionRetirement(
      request,
      response,
      startedAt,
      now(),
    );
    return receipt
      ? {
          status: "failed",
          observed_quantity: null,
          settled: false,
          retirement: receipt,
        }
      : null;
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
    retirement?: PerpsRetirementReceipt;
  }> {
    const uncertain = {
      status: "uncertain" as const,
      observed_quantity: null,
      settled: false,
    };
    const proofDeadline = now() + 12_000;
    const retireOrUncertain = async () =>
      (await this.retireOriginalExecution(user, p, e, proofDeadline)) ??
      uncertain;
    if (e.retirement !== undefined) {
      if (e.task_id !== null && e.task_id !== undefined) return uncertain;
      const request = perpsRecoveryRequest(user, this.perpsBinding(p), e);
      const receipt =
        request && persistedPerpsRetirement(request, e.retirement, now());
      return receipt
        ? {
            status: "failed",
            observed_quantity: null,
            settled: false,
            retirement: receipt,
          }
        : uncertain;
    }
    let task = e.task_id;
    let recoveredTask = false;
    if (!task) {
      const saved = await this.pool.query(
        "SELECT response,payload FROM ride_agent_core_outbox WHERE execution_id=$1 AND user_id=$2 AND portfolio_id=$3",
        [e.id, user, p.id],
      );
      if (!saved.rowCount) {
        if (!e.key.startsWith("perps:"))
          return { status: "failed", observed_quantity: null, settled: false };
        const request = perpsRecoveryRequest(user, this.perpsBinding(p), e);
        if (!request || this.network !== "mainnet") return uncertain;
        const startedAt = now();
        let response: unknown;
        try {
          response = await this.core("perps_execution_recovery", request);
        } catch {
          return retireOrUncertain();
        }
        const proof = perpsExecutionRecovery(
          request,
          response,
          startedAt,
          now(),
        );
        if (proof.kind !== "accepted") return retireOrUncertain();
        // Core has the immutable original intent. Recover only its existing
        // task; do not invent or INSERT a missing frozen local submit payload.
        // The caller persists this task in its existing owner transaction.
        task = proof.task_id;
        recoveredTask = true;
      } else if (e.key.startsWith("prediction:") && saved.rows[0].response)
        task = saved.rows[0].response.task_id;
      else if (
        e.key.startsWith("perps:") &&
        typeof saved.rows[0].response?.task_id === "string" &&
        saved.rows[0].response.task_id
      )
        task = saved.rows[0].response.task_id;
      else if (e.key.startsWith("perps:")) {
        const request = perpsAcceptanceRequest(
          user,
          this.perpsBinding(p),
          e,
          saved.rows[0].payload,
        );
        if (!request || this.network !== "mainnet") return retireOrUncertain();
        const startedAt = now();
        let response: unknown;
        try {
          response = await this.core("perps_execution_acceptance", request);
        } catch {
          // Older Core, a lost read response, or incomplete acceptance evidence
          // cannot authorize replay or release an unknown original target.
          return retireOrUncertain();
        }
        const proof = perpsExecutionAcceptance(
          request,
          response,
          startedAt,
          now(),
        );
        if (proof.kind === "unknown") return retireOrUncertain();
        if (proof.kind === "not_accepted_expired") return retireOrUncertain();
        task = proof.task_id;
        await this.pool.query(
          "UPDATE ride_agent_core_outbox SET response=$2 WHERE execution_id=$1",
          [e.id, { task_id: task }],
        );
      } else if (e.key.startsWith("prediction:")) {
        const response = await this.core(
          "prediction_submit",
          saved.rows[0].payload,
        );
        await this.pool.query(
          "UPDATE ride_agent_core_outbox SET response=$2 WHERE execution_id=$1",
          [e.id, response],
        );
        task = response.task_id;
      } else return uncertain;
    }
    if (e.key.startsWith("prediction:"))
      return this.prediction.execution(user, p, e, task!);
    const response = await this.core("perps_execution", {
      user_id: user,
      account_id: this.perpsBinding(p),
      task_id: task,
    });
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      response.task_id !== task ||
      !Number.isInteger(response.status) ||
      response.status < 1 ||
      response.status > 7
    )
      return uncertain;
    let snapshot: any = {};
    try {
      snapshot =
        typeof response.snapshot === "string"
          ? JSON.parse(response.snapshot)
          : (response.snapshot ?? {});
    } catch {}
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
      return uncertain;
    const terminalTask = [3, 4, 5, 6].includes(response.status);
    const settlementEvidence =
      typeof snapshot.fill_settlement_pending === "boolean" &&
      typeof snapshot.settlement_observation_required === "boolean";
    if ((recoveredTask || terminalTask) && !settlementEvidence)
      return uncertain;
    const snap = await this.account(user, p),
      position = snap.positions[e.key] ?? "0";
    const done =
      response.status === 3 &&
      snapshot.fill_settlement_pending === false &&
      snapshot.settlement_observation_required === false;
    const failed = [4, 5].includes(response.status);
    const settlementPending =
      terminalTask &&
      (snapshot.fill_settlement_pending ||
        snapshot.settlement_observation_required);
    return {
      task_id: task!,
      status: settlementPending
        ? "settling"
        : done
          ? "completed"
          : failed
            ? "failed"
            : response.status === 6
              ? "superseded"
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
    signal?: AbortSignal,
    deadline = now() + 20000,
  ): Promise<void> {
    const left = deadline - now();
    if (!Number.isSafeInteger(deadline) || left <= 0 || left > 20000)
      throw new AgentError(
        "PUSH_DELIVERY_TIMEOUT",
        "Notification result is unconfirmed; retry the original event.",
        true,
        503,
      );
    const timeout = AbortSignal.timeout(left);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const check = () => {
      signal!.throwIfAborted();
      if (now() >= deadline)
        throw new AgentError(
          "PUSH_DELIVERY_TIMEOUT",
          "Notification result is unconfirmed; retry the original event.",
          true,
          503,
        );
    };
    check();
    const tokens = await this.core("push_tokens", { user_id: user }, signal);
    check();
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
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      const payload = (await response.json()) as any;
      check();
      if (!response.ok || !payload.access_token)
        throw Error("Push authentication failed");
      this.tokens = {
        value: payload.access_token,
        expiry: now() + (payload.expires_in ?? 3600) * 1000,
      };
    }
    for (const token of tokens) {
      check();
      if (await this.notificationReceipts.acknowledged(user, event, token))
        continue;
      check();
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
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw Error("Push delivery failed");
      const receipt = (await response.json()) as any;
      if (
        typeof receipt?.name !== "string" ||
        !/^projects\/[^/\s]+\/messages\/[^/\s]+$/.test(receipt.name) ||
        !receipt.name.startsWith(`projects/${service.project_id}/messages/`)
      )
        throw new AgentError(
          "PUSH_RESPONSE_INVALID",
          "Push acceptance could not be verified; delivery remains pending.",
          true,
          503,
        );
      // A complete provider acceptance is truthful even if the caller has
      // just cancelled. Persist it before checking time; never send another
      // device after the same absolute cutoff.
      await this.notificationReceipts.acknowledge(user, event, token);
      check();
    }
    check();
  }
  private async sourceFills(
    input: any,
    entry?: PreparedEntry,
    observation?: AccountObservationLimits,
  ) {
    if (entry) {
      this.assertPrepared(entry);
      const fixed = entry.portfolio.sleeves.filter(
        (s) =>
          s.state !== "closed" &&
          s.copy_mode === "fixed" &&
          s.trader.id === input.trader_id,
      );
      if (
        entry.portfolio.purpose !== "audit_source" ||
        !entry.auditHash ||
        fixed.length !== 1 ||
        input.market !== "perps" ||
        !Number.isSafeInteger(fixed[0].fixed_last_fill_at) ||
        input.start_at !== fixed[0].fixed_last_fill_at ||
        !entry.sourceEvidenceEnds?.get(input.trader_id)?.has(input.end_at) ||
        sourceRequiresRwa(fixed[0].trader as Candidate) !==
          (input.minimum_requires_rwa === true)
      )
        throw this.preparedFailure();
      const prior = entry.historyBindings?.get(input.trader_id);
      const binding = {
        start: input.start_at,
        end: input.end_at,
        requiresRwa: input.minimum_requires_rwa === true,
      };
      if (prior && fingerprint(prior) !== fingerprint(binding))
        throw this.preparedFailure();
      (entry.historyBindings ??= new Map()).set(input.trader_id, binding);
    }
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
        reason: "Authenticated prediction source fill history is unavailable.",
      };
    if (
      input.minimum_requires_rwa !== undefined &&
      typeof input.minimum_requires_rwa !== "boolean"
    )
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "Source observation scope is invalid.",
        false,
        400,
      );
    const source = await this.source(
      input.trader_id,
      input.minimum_requires_rwa === true,
      observation,
    );
    const row = await this.resolve(input.trader_id);
    if (!sourceEvidenceReady(source) || !Array.isArray(source.perps_dexes))
      throw new AgentError(
        "SOURCE_FILL_EVIDENCE_MISSING",
        "Observed Perps source scopes are unavailable.",
        true,
      );
    const readHistory = () =>
      this.paged(
        "userFillsByTime",
        row.address,
        input.start_at,
        input.end_at,
        true,
      );
    const history = entry
      ? await this.assertPrepared(entry).history(
          input.trader_id,
          readHistory,
          (payload) => {
            const value = payload as Record<string, unknown>;
            if (
              !value ||
              value.type !== "userFillsByTime" ||
              value.user !== row.address ||
              !Number.isSafeInteger(value.startTime) ||
              (value.startTime as number) < input.start_at ||
              (value.startTime as number) > input.end_at ||
              value.endTime !== input.end_at ||
              value.aggregateByTime !== false ||
              Object.keys(value).some(
                (key) =>
                  ![
                    "type",
                    "user",
                    "startTime",
                    "endTime",
                    "aggregateByTime",
                  ].includes(key),
              )
            )
              throw this.preparedFailure();
          },
          observation,
        )
      : await readHistory();
    return {
      complete: history.complete,
      observation_scope_requires_rwa: source.observation_scope_requires_rwa,
      fills: scopedSourceFills(
        history.events,
        input.trader_id,
        source.perps_dexes,
        input.start_at,
        input.end_at,
      ),
    };
  }
  async operation(
    op: string,
    input: any,
    notificationCaller?: AbortSignal,
    submitObservation?: AccountObservationLimits,
    preparedWindowHandle?: string,
    sourceReadGraph?: "readonly-runner-native-v1",
  ): Promise<unknown> {
    if (
      sourceReadGraph !== undefined &&
      (sourceReadGraph !== "readonly-runner-native-v1" ||
        preparedWindowHandle ||
        !["prepare_portfolio", "cancel_prepared_portfolio"].includes(op) ||
        input?.portfolio?.purpose !== "audit_source")
    )
      throw this.preparedFailure();
    if (op === "prepare_portfolio") {
      if (preparedWindowHandle) throw this.preparedFailure();
      return this.preparePortfolio(
        input.user_id,
        input.portfolio,
        submitObservation,
        sourceReadGraph,
      );
    }
    if (op === "cancel_prepared_portfolio") {
      if (preparedWindowHandle) throw this.preparedFailure();
      return this.cancelPreparedPortfolio(
        input.user_id,
        input.portfolio,
        sourceReadGraph,
      );
    }
    if (preparedWindowHandle) {
      const entry = this.preparedHandle(
        preparedWindowHandle,
        input.user_id,
        input.portfolio?.id ?? input.portfolio_id,
      );
      switch (op) {
        case "finish_portfolio":
          await this.finishPrepared(entry).catch(() => {});
          if (this.preparedEntries.get(entry.key) === entry)
            this.preparedEntries.delete(entry.key);
          return { ok: true };
        case "prepare_execution":
          return this.prepareExecution(entry, input.portfolio, input.proposal);
        case "account":
          return this.preparedAccount(
            entry,
            input.user_id,
            input.portfolio,
            submitObservation,
          );
        case "submit":
          if (entry.portfolio.purpose === "audit_source")
            throw this.preparedFailure();
          this.bindPreparedExecution(
            entry,
            input.user_id,
            input.portfolio,
            input.execution,
          );
          return this.preparedSource.run(entry, () =>
            this.submit(
              input.user_id,
              input.portfolio,
              input.execution,
              submitObservation,
              entry,
            ),
          );
        case "source":
          this.checkPreparedSource(
            entry,
            input.trader_id,
            input.minimum_requires_rwa === true,
          );
          return this.preparedSource.run(entry, () =>
            this.source(
              input.trader_id,
              input.minimum_requires_rwa === true,
              submitObservation,
            ),
          );
        case "source_fills":
          if (entry.portfolio.purpose !== "audit_source")
            throw this.preparedFailure();
          return this.preparedSource.run(entry, () =>
            this.sourceFills(input, entry, submitObservation),
          );
        case "read_plan_evidence":
          if (entry.nativeSourcePlan) throw this.preparedFailure();
          if (!Array.isArray(input.traders) || !input.traders.length)
            throw this.preparedFailure();
          for (const trader of input.traders)
            this.checkPreparedSource(
              entry,
              trader.id,
              sourceRequiresRwa(trader),
            );
          return this.assertPrepared(entry).supplement(() =>
            readSelectedPlanEvidence(input.traders, {
              resolveTrader: (id) => this.resolve(id),
              info: (payload) => this.info(payload, true),
            }),
          );
        default:
          throw this.preparedFailure();
      }
    }
    if (["prepare_execution", "finish_portfolio"].includes(op))
      throw this.preparedFailure();
    switch (op) {
      case "read_plan_evidence":
        return readSelectedPlanEvidence(input?.traders, {
          resolveTrader: (id) => this.resolve(id),
          info: (payload) => this.info(payload, true),
        });
      case "deposit_options":
        return new DepositReads(
          (op, input) => this.core(op, input),
          this.network,
          fetch,
          this.venueReads,
        ).options();
      case "deposit_address":
        return new DepositReads(
          (op, input) => this.core(op, input),
          this.network,
          fetch,
          this.venueReads,
        ).address(input.user_id, input.input, input.portfolio_id);
      case "deposit_status": {
        const status = await new DepositReads(
          (op, input) => this.core(op, input),
          this.network,
          fetch,
          this.venueReads,
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
        if (
          input.minimum_requires_rwa !== undefined &&
          typeof input.minimum_requires_rwa !== "boolean"
        )
          throw new AgentError(
            "SOURCE_SCOPE_UNAVAILABLE",
            "Source observation scope is invalid.",
            false,
            400,
          );
        return this.source(
          input.trader_id,
          input.minimum_requires_rwa === true,
        );
      case "source_fills":
        return this.sourceFills(input);
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
        if (this.activeReadonlyControl(input.user_id, input.portfolio))
          throw this.preparedFailure();
        return this.account(input.user_id, input.portfolio, true);
      case "account":
        return this.account(input.user_id, input.portfolio);
      case "submit":
        return this.submit(
          input.user_id,
          input.portfolio,
          input.execution,
          submitObservation,
        );
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
        const ownedOrders = snap.orders.filter(
          (order) =>
            order.ownership !== "manual" ||
            !manualHandoff(input.portfolio, order.key),
        );
        for (const order of ownedOrders.filter(
          (x) => x.increases_risk && x.key.startsWith("prediction:"),
        ))
          await this.core("prediction_cancel", {
            user_id: input.user_id,
            portfolio_id: input.portfolio.id,
            task_id: order.id,
          });
        if (ownedOrders.some((x) => x.increases_risk))
          throw new AgentError(
            "UNRESOLVED_OPEN_ORDER",
            "Increasing open orders require Core reconciliation before exit.",
            true,
          );
        return { ok: true };
      }
      case "notify": {
        const deadline = input.deadline_ms ?? now() + 20000;
        const remaining = deadline - now();
        if (
          !Number.isSafeInteger(deadline) ||
          remaining <= 0 ||
          remaining > 20000
        )
          throw new AgentError(
            "PUSH_DELIVERY_TIMEOUT",
            "Notification deadline expired; delivery remains unconfirmed.",
            true,
            503,
          );
        const timeout = AbortSignal.timeout(remaining);
        const signal = notificationCaller
          ? AbortSignal.any([timeout, notificationCaller])
          : timeout;
        return this.notify(input.user_id, input.event, signal, deadline).then(
          () => ({
            ok: true,
          }),
        );
      }
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
export interface ManagedCoreBridge {
  listener: Server;
  closed: Promise<void>;
  close(): Promise<void>;
}

/** App-owned startup keeps all existing authentication and operation gates. */
export async function startManagedCoreBridge(
  options: {
    host?: string;
    port?: number;
  } = {},
): Promise<ManagedCoreBridge> {
  const infoReadRoute = process.env.RIDE_AGENT_INFO_READ_ROUTE ?? "official";
  if (infoReadRoute !== "official" && infoReadRoute !== "core")
    throw new Error("RIDE_AGENT_INFO_READ_ROUTE must be official or core");
  const token = required("RIDE_AGENT_EXECUTOR_TOKEN");
  if (token.length < 32)
    throw Error("Executor token must contain 32 characters");
  const bridge = new CoreBridge(
    required("RIDE_AGENT_CORE_URL"),
    required("RIDE_AGENT_CORE_SERVICE_TOKEN"),
    required("RIDE_AGENT_DATABASE_URL"),
    required("RIDE_AGENT_TRADER_ID_SALT"),
    process.env.RIDE_AGENT_NETWORK === "mainnet" ? "mainnet" : "testnet",
    { infoReadRoute },
  );
  try {
    await bridge.migrate();
  } catch (error) {
    await bridge.close().catch(() => {});
    throw error;
  }
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
    const cancellation =
      req.params.operation === "notify"
        ? notificationCancellation(req, res)
        : undefined;
    const submitObservation =
      req.params.operation === "submit" ||
      req.params.operation === "prepare_portfolio" ||
      (["account", "source", "source_fills"].includes(req.params.operation) &&
        !!req.get("x-ride-read-window"))
        ? submitObservationCancellation(req, res)
        : undefined;
    try {
      const sourceReadGraph = req.get("x-ride-source-read-graph");
      if (
        sourceReadGraph !== undefined &&
        sourceReadGraph !== "readonly-runner-native-v1"
      )
        throw new AgentError(
          "VENUE_COST_PLAN_UNAVAILABLE",
          "Read graph is unavailable.",
          true,
          409,
        );
      res.json(
        await bridge.operation(
          req.params.operation,
          req.body,
          cancellation?.signal,
          submitObservation,
          req.get("x-ride-read-window"),
          sourceReadGraph,
        ),
      );
    } catch (e) {
      res
        .status(e instanceof AgentError ? e.httpStatus : 503)
        .json({ error: failure(e, { internalReadDiagnostics: true }).error });
    } finally {
      cancellation?.close();
      submitObservation?.close();
    }
  });
  let listener: Server;
  try {
    listener = await new Promise<Server>((resolve, reject) => {
      const server = app.listen(
        options.port ?? Number(process.env.PORT ?? 3355),
        options.host ?? process.env.HOST ?? "127.0.0.1",
        () => {
          server.off("error", reject);
          resolve(server);
        },
      );
      server.once("error", reject);
    });
  } catch (error) {
    await bridge.close().catch(() => {});
    throw error;
  }
  let resolveClosed: () => void;
  let rejectClosed: (error: unknown) => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      try {
        await drainBridge(listener, bridge);
        resolveClosed();
      } catch (error) {
        rejectClosed(error);
        throw error;
      }
    })());
  listener.on("error", (error) => {
    rejectClosed(error);
    void close().catch(() => {});
  });
  listener.on("close", () => {
    if (!stopping) {
      rejectClosed(
        new Error("Private Agent bridge listener closed unexpectedly"),
      );
      void close().catch(() => {});
    }
  });
  return { listener, closed, close };
}

/** Standalone bridge remains compatible with its existing entrypoint. */
export async function startCoreBridge(): Promise<void> {
  const bridge = await startManagedCoreBridge();
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (force) return;
    force = setTimeout(() => process.exit(0), 45000);
    force.unref();
    void bridge.close().catch(() => {
      console.error("Rider bridge shutdown failed.");
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // Existing callers await startup readiness, not the lifetime of the server.
  // Keep the unref force boundary after successful pool/HTTP drain: unrelated
  // work can still hold this standalone process alive.
  void bridge.closed.then(
    () => {
      process.off("SIGTERM", stop);
      process.off("SIGINT", stop);
    },
    () => {
      console.error("Rider bridge stopped unexpectedly.");
      process.exitCode = 1;
      stop();
    },
  );
}
