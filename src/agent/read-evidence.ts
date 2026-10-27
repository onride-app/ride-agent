import { AgentError } from "./contracts.js";
import {
  D,
  fingerprint,
  PERPS_COPY_MAX_LEVERAGE,
  type Candidate,
  type PositionIntent,
} from "./domain.js";
import type { SourceSnapshot } from "./adapter.js";
import { perpsAccountMode, unifiedUsdc } from "./perps_account.js";
import { HYPERLIQUID_MIN_OPEN_NOTIONAL_USDC } from "./order_rules.js";

export type SourceEquityBasis =
  | "standard_clearinghouse_account_value"
  | "unified_spot_usdc_total"
  | "unavailable";
export interface ReadEvidencePosition extends PositionIntent {
  mark_price: string | null;
  position_notional_usdc: string | null;
  source_leverage_verified: boolean;
  position_notional_basis?: "current_mark" | "venue_position_value";
}
export interface ReadEvidenceSnapshot extends SourceSnapshot {
  positions: ReadEvidencePosition[];
}
export interface PlanSourceEvidence {
  trader_id: string;
  status: "available" | "partial" | "unavailable" | "unsupported";
  snapshot: ReadEvidenceSnapshot | null;
  equity_basis: SourceEquityBasis;
  equity_verified: boolean;
  account_mode: "standard" | "unified" | "unsupported" | "unknown";
  scope: "base_perps";
  coverage_complete: boolean;
  timestamp_basis: "exchange_time" | "read_completed_at" | null;
  reason_code?: string;
}
export interface PlanMarketEvidence {
  observed_at: number;
  prices: Record<string, string>;
  max_leverages: Record<string, number>;
  quantity_decimals: Record<string, number>;
  min_notionals: Record<string, string>;
  coverage_complete: boolean;
  scope: "base_perps";
  product_planning_max_leverage: number;
  legacy_candidate_venue_max_leverage_basis: "product_planning_envelope";
  reason_codes: string[];
}
export interface PlanReadEvidence {
  observed_at: number;
  sources: PlanSourceEvidence[];
  market: PlanMarketEvidence;
  read_only: true;
  execution_authorized: false;
}
export interface PlanEvidenceReader {
  resolveTrader(id: string): Promise<{ address: string; tags?: string[] }>;
  /** Must use the existing public-source VenueReads lane; no account writes. */
  info(payload: Record<string, unknown>): Promise<unknown>;
}
export interface PlanEvidenceReadOptions {
  clock?: () => number;
  timeout_ms?: number;
  signal?: AbortSignal;
}

const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const numeric = (value: unknown, positive = false): string | null => {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value))
    return null;
  try {
    const number = D(value);
    return number.isFinite() && (!positive || number.gt(0))
      ? number.toFixed()
      : null;
  } catch {
    return null;
  }
};

function unavailable(
  trader: Pick<Candidate, "id">,
  reason: string,
  account_mode: PlanSourceEvidence["account_mode"] = "unknown",
): PlanSourceEvidence {
  return {
    trader_id: trader.id,
    status: account_mode === "unsupported" ? "unsupported" : "unavailable",
    snapshot: null,
    equity_basis: "unavailable",
    equity_verified: false,
    account_mode,
    scope: "base_perps",
    coverage_complete: false,
    timestamp_basis: null,
    reason_code: reason,
  };
}

function reason(error: unknown): string {
  return error instanceof AgentError &&
    /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)
    ? error.code
    : "SOURCE_EVIDENCE_UNAVAILABLE";
}

/** A separate read-only observation. It must never replace execution source().
 * Account-mode balance basis: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes
 */
export async function readSelectedPlanEvidence(
  traders: Candidate[],
  reader: PlanEvidenceReader,
  options: PlanEvidenceReadOptions = {},
): Promise<PlanReadEvidence> {
  if (
    !Array.isArray(traders) ||
    traders.length < 1 ||
    traders.length > 8 ||
    traders.some(
      (t) =>
        !record(t) ||
        typeof t.id !== "string" ||
        !/^[a-zA-Z0-9_-]{8,100}$/.test(t.id) ||
        !["perps", "prediction"].includes(t.market) ||
        !Array.isArray(t.assets) ||
        t.assets.length > 100 ||
        t.assets.some(
          (asset: unknown) =>
            typeof asset !== "string" || !/^[A-Za-z0-9:_-]{1,100}$/.test(asset),
        ),
    ) ||
    new Set(traders.map((t) => t.id)).size !== traders.length
  )
    throw new AgentError(
      "INVALID_EVIDENCE_REQUEST",
      "Read evidence requires one to eight unique selected traders.",
      false,
      400,
    );

  const clock = options.clock ?? Date.now;
  const deadline =
    clock() + Math.max(1, Math.min(options.timeout_ms ?? 14_000, 15_000));
  let budgetExpired = false;
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    if (options.signal?.aborted)
      throw new AgentError(
        "EVIDENCE_READ_ABORTED",
        "Read-only evidence request was cancelled.",
        true,
        503,
      );
    const remaining = deadline - clock();
    if (budgetExpired || remaining <= 0)
      throw new AgentError(
        "EVIDENCE_READ_TIMEOUT",
        "Read-only evidence deadline expired.",
        true,
        503,
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            budgetExpired = true;
            reject(
              new AgentError(
                "EVIDENCE_READ_TIMEOUT",
                "Read-only evidence deadline expired.",
                true,
                503,
              ),
            );
          }, remaining);
          abort = () =>
            reject(
              new AgentError(
                "EVIDENCE_READ_ABORTED",
                "Read-only evidence request was cancelled.",
                true,
                503,
              ),
            );
          options.signal?.addEventListener("abort", abort, { once: true });
          if (options.signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) options.signal?.removeEventListener("abort", abort);
    }
  };
  const info = (payload: Record<string, unknown>) =>
    bounded(() => reader.info(payload));
  const perps = traders.filter((t) => t.market === "perps");
  // VenueReads supplies its existing shared concurrency, cooldown and HTTP
  // timeout. Cancelling this view stops new reads, not shared execution flights.
  let marketObservedAt = clock();
  const marketReads = (
    perps.length
      ? Promise.allSettled([info({ type: "meta" }), info({ type: "allMids" })])
      : Promise.resolve([] as PromiseSettledResult<unknown>[])
  ).then((result) => {
    marketObservedAt = clock();
    return result;
  });
  interface RawSource {
    trader: Candidate;
    state: Record<string, any>;
    equity: string;
    mode: "standard" | "unified";
    observed_at: number;
    timestamp_basis: "exchange_time" | "read_completed_at";
  }
  const raw = new Map<string, RawSource>();
  const sources: PlanSourceEvidence[] = new Array(traders.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, traders.length) }, async () => {
      while (index < traders.length) {
        const at = index++;
        const trader = traders[at];
        let mode: PlanSourceEvidence["account_mode"] = "unknown";
        try {
          if (trader.market !== "perps") {
            sources[at] = unavailable(
              trader,
              "PREDICTION_EVIDENCE_UNSUPPORTED",
              "unsupported",
            );
            continue;
          }
          if (
            trader.asset_category === "rwa" ||
            trader.assets?.some((asset) => asset.includes(":"))
          ) {
            sources[at] = unavailable(
              trader,
              "SOURCE_SCOPE_UNSUPPORTED",
              "unsupported",
            );
            continue;
          }
          const identity = await bounded(() => reader.resolveTrader(trader.id));
          if (identity.tags?.includes("category:stocks_rwa")) {
            sources[at] = unavailable(
              trader,
              "SOURCE_SCOPE_UNSUPPORTED",
              "unsupported",
            );
            continue;
          }
          const abstraction = await info({
            type: "userAbstraction",
            user: identity.address,
          });
          mode = perpsAccountMode(abstraction);
          if (mode === "unsupported") {
            sources[at] = unavailable(
              trader,
              "SOURCE_ACCOUNT_MODE_UNSUPPORTED",
              mode,
            );
            continue;
          }
          if (mode === "standard") {
            const dexAbstraction = await info({
              type: "userDexAbstraction",
              user: identity.address,
            });
            if (![false, null].includes(dexAbstraction as any)) {
              sources[at] = unavailable(
                trader,
                "SOURCE_DEX_ABSTRACTION_UNVERIFIED",
                mode,
              );
              continue;
            }
          }
          const state = await info({
            type: "clearinghouseState",
            user: identity.address,
          });
          const stateObservedAt = clock();
          if (
            !record(state) ||
            !record(state.marginSummary) ||
            !Array.isArray(state.assetPositions)
          )
            throw new AgentError(
              "SOURCE_STATE_INCOMPLETE",
              "Public source positions were incomplete.",
              true,
              503,
            );
          let equity: string | null;
          let equityObservedAt = stateObservedAt;
          if (mode === "unified") {
            const spot = await info({
              type: "spotClearinghouseState",
              user: identity.address,
            });
            equityObservedAt = clock();
            if (record(spot) && spot.time != null) {
              if (
                !Number.isSafeInteger(spot.time) ||
                spot.time > equityObservedAt + 1000 ||
                equityObservedAt - spot.time > 30_000
              )
                throw new AgentError(
                  "SOURCE_STALE",
                  "Public source equity timestamp is not fresh.",
                  true,
                  503,
                );
              equityObservedAt = spot.time;
            }
            equity = unifiedUsdc(spot).equity;
          } else equity = numeric(state.marginSummary.accountValue);
          if (equity === null)
            throw new AgentError(
              "SOURCE_EQUITY_UNAVAILABLE",
              "Public source equity could not be verified.",
              true,
              503,
            );
          const completed = clock();
          const timestamp = state.time;
          if (
            timestamp != null &&
            (!Number.isSafeInteger(timestamp) ||
              timestamp > completed + 1000 ||
              completed - timestamp > 30_000)
          )
            throw new AgentError(
              "SOURCE_STALE",
              "Public source timestamp is not fresh.",
              true,
              503,
            );
          raw.set(trader.id, {
            trader,
            state,
            equity,
            mode,
            observed_at: Math.min(
              timestamp ?? stateObservedAt,
              equityObservedAt,
            ),
            timestamp_basis:
              timestamp == null ? "read_completed_at" : "exchange_time",
          });
        } catch (error) {
          sources[at] = unavailable(trader, reason(error), mode);
        }
      }
    }),
  );
  const [metaResult, midsResult] = await marketReads;
  const meta = metaResult?.status === "fulfilled" ? metaResult.value : null;
  const mids = midsResult?.status === "fulfilled" ? midsResult.value : null;
  const market: PlanMarketEvidence = {
    observed_at: marketObservedAt,
    prices: {},
    max_leverages: {},
    quantity_decimals: {},
    min_notionals: {},
    scope: "base_perps",
    coverage_complete: true,
    product_planning_max_leverage: PERPS_COPY_MAX_LEVERAGE,
    legacy_candidate_venue_max_leverage_basis: "product_planning_envelope",
    reason_codes: [],
  };
  const assets = new Set<string>();
  for (const source of raw.values())
    for (const row of source.state.assetPositions) {
      if (
        record(row?.position) &&
        typeof row.position.coin === "string" &&
        !row.position.coin.includes(":")
      )
        assets.add(row.position.coin);
    }
  if (!record(meta) || !Array.isArray(meta.universe) || !record(mids)) {
    market.coverage_complete = false;
    market.reason_codes.push("VENUE_RULES_UNAVAILABLE");
  }
  if (!perps.length) {
    market.coverage_complete = false;
    market.reason_codes.push("PREDICTION_EVIDENCE_UNSUPPORTED");
  }
  if (perps.length && !assets.size && !raw.size) {
    market.coverage_complete = false;
    market.reason_codes.push("SOURCE_ASSET_SCOPE_UNAVAILABLE");
  }
  for (const asset of assets) {
    const key = `perps:${asset}`;
    const row =
      record(meta) && Array.isArray(meta.universe)
        ? meta.universe.find((r: any) => r?.name === asset)
        : null;
    const price = record(mids) ? numeric(mids[asset], true) : null;
    if (price) market.prices[key] = price;
    if (row && Number.isInteger(row.maxLeverage) && row.maxLeverage >= 1)
      market.max_leverages[key] = row.maxLeverage;
    if (
      row &&
      Number.isInteger(row.szDecimals) &&
      row.szDecimals >= 0 &&
      row.szDecimals <= 8
    )
      market.quantity_decimals[key] = row.szDecimals;
    if (
      price &&
      market.max_leverages[key] != null &&
      market.quantity_decimals[key] != null
    )
      market.min_notionals[key] = HYPERLIQUID_MIN_OPEN_NOTIONAL_USDC;
    else {
      market.coverage_complete = false;
      if (!market.reason_codes.includes("VENUE_RULES_UNAVAILABLE"))
        market.reason_codes.push("VENUE_RULES_UNAVAILABLE");
    }
  }
  for (let at = 0; at < traders.length; at++) {
    const observed = raw.get(traders[at].id);
    if (!observed) continue;
    try {
      if (clock() - observed.observed_at > 30_000)
        throw new AgentError(
          "SOURCE_STALE",
          "Public source evidence expired during the read.",
          true,
          503,
        );
      const positions: ReadEvidencePosition[] = [];
      let verified = true;
      for (const row of observed.state.assetPositions) {
        const p = row?.position;
        if (
          !record(p) ||
          typeof p.coin !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(p.coin)
        )
          throw new AgentError(
            "SOURCE_SCOPE_UNSUPPORTED",
            "Public source positions include an unsupported scope.",
            true,
            503,
          );
        const quantity = numeric(p.szi);
        if (quantity == null)
          throw new AgentError(
            "SOURCE_POSITION_UNAVAILABLE",
            "Source position quantity is unavailable.",
            true,
            503,
          );
        if (D(quantity).isZero()) continue;
        const key = `perps:${p.coin}`;
        if (positions.some((position) => position.key === key))
          throw new AgentError(
            "SOURCE_POSITION_UNAVAILABLE",
            "Duplicate source positions cannot be evaluated.",
            true,
            503,
          );
        const mark = market.prices[key] ?? null;
        const rawNotional = numeric(p.positionValue);
        const sourcePrice =
          rawNotional == null
            ? null
            : D(rawNotional).abs().div(D(quantity).abs()).toFixed();
        const price =
          mark ?? (sourcePrice && D(sourcePrice).gt(0) ? sourcePrice : null);
        if (!price)
          throw new AgentError(
            "SOURCE_POSITION_PRICE_UNAVAILABLE",
            "Source position price is unavailable.",
            true,
            503,
          );
        const leverage = p.leverage?.value;
        const leverageVerified = Number.isInteger(leverage) && leverage >= 1;
        verified &&= leverageVerified && mark != null;
        positions.push({
          key,
          asset: p.coin,
          market: "perps",
          quantity,
          price,
          source_entry_price: numeric(p.entryPx, true),
          source_leverage: leverageVerified ? leverage : 1,
          source_leverage_verified: leverageVerified,
          mark_price: mark,
          position_notional_usdc: mark
            ? D(quantity).abs().times(mark).toFixed()
            : rawNotional == null
              ? null
              : D(rawNotional).abs().toFixed(),
          ...(mark || rawNotional != null
            ? {
                position_notional_basis: mark
                  ? ("current_mark" as const)
                  : ("venue_position_value" as const),
              }
            : {}),
          observed_at: observed.observed_at,
          source_revision: "",
        });
      }
      const positiveEquity =
        D(observed.equity).gt(0) ||
        (D(observed.equity).isZero() && !positions.length);
      const complete =
        observed.mode === "standard" && verified && positiveEquity;
      const revision = fingerprint({
        observed_at: observed.observed_at,
        equity: observed.equity,
        positions,
      });
      for (const p of positions) p.source_revision = revision;
      sources[at] = {
        trader_id: observed.trader.id,
        status: complete ? "available" : "partial",
        snapshot: {
          observed_at: observed.observed_at,
          revision,
          account_value_usdc: observed.equity,
          positions,
          complete,
        },
        equity_basis:
          observed.mode === "unified"
            ? "unified_spot_usdc_total"
            : "standard_clearinghouse_account_value",
        equity_verified: true,
        account_mode: observed.mode,
        scope: "base_perps",
        coverage_complete: complete,
        timestamp_basis: observed.timestamp_basis,
        ...(!complete
          ? {
              reason_code:
                observed.mode === "unified"
                  ? "UNIFIED_DEX_COVERAGE_UNVERIFIED"
                  : !positiveEquity
                    ? "SOURCE_EQUITY_NONPOSITIVE"
                    : "SOURCE_POSITION_EVIDENCE_INCOMPLETE",
            }
          : {}),
      };
    } catch (error) {
      sources[at] = unavailable(observed.trader, reason(error), observed.mode);
    }
  }
  return {
    observed_at: clock(),
    sources,
    market,
    read_only: true,
    execution_authorized: false,
  };
}

function consistentSourceEvidence(source: Record<string, any>): boolean {
  const hasTimestamp = ["exchange_time", "read_completed_at"].includes(
    source.timestamp_basis,
  );
  if (source.status === "available")
    return (
      source.account_mode === "standard" &&
      source.equity_basis === "standard_clearinghouse_account_value" &&
      source.equity_verified === true &&
      source.scope === "base_perps" &&
      source.coverage_complete === true &&
      source.snapshot?.complete === true &&
      hasTimestamp
    );
  if (source.status === "partial")
    return (
      ["standard", "unified"].includes(source.account_mode) &&
      source.equity_basis ===
        (source.account_mode === "standard"
          ? "standard_clearinghouse_account_value"
          : "unified_spot_usdc_total") &&
      source.equity_verified === true &&
      source.coverage_complete === false &&
      source.snapshot?.complete === false &&
      hasTimestamp
    );
  return (
    ["unavailable", "unsupported"].includes(source.status) &&
    (source.status !== "unsupported" ||
      source.account_mode === "unsupported") &&
    source.equity_basis === "unavailable" &&
    source.equity_verified === false &&
    source.coverage_complete === false &&
    source.snapshot === null &&
    source.timestamp_basis === null
  );
}

export function isPlanReadEvidence(value: unknown): value is PlanReadEvidence {
  const timestamp = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  const positionEvidence = (position: unknown, available: boolean) =>
    record(position) &&
    typeof position.asset === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(position.asset) &&
    position.key === `perps:${position.asset}` &&
    position.market === "perps" &&
    timestamp(position.observed_at) &&
    typeof position.source_revision === "string" &&
    numeric(position.quantity) != null &&
    numeric(position.price, true) != null &&
    typeof position.source_leverage_verified === "boolean" &&
    typeof position.source_leverage === "number" &&
    Number.isFinite(position.source_leverage) &&
    (!position.source_leverage_verified ||
      (Number.isInteger(position.source_leverage) &&
        position.source_leverage >= 1)) &&
    (position.mark_price === null ||
      numeric(position.mark_price, true) != null) &&
    (position.position_notional_usdc === null ||
      (numeric(position.position_notional_usdc) != null &&
        D(position.position_notional_usdc).gte(0))) &&
    (!available ||
      (position.source_leverage_verified === true &&
        position.mark_price !== null &&
        position.position_notional_usdc !== null));
  const stringMap = (v: unknown) =>
    record(v) && Object.values(v).every((x) => numeric(x, true) != null);
  const numberMap = (v: unknown, decimals = false) =>
    record(v) &&
    Object.values(v).every(
      (x) =>
        typeof x === "number" &&
        Number.isInteger(x) &&
        (decimals ? x >= 0 && x <= 8 : x >= 1),
    );
  return (
    record(value) &&
    timestamp(value.observed_at) &&
    value.read_only === true &&
    value.execution_authorized === false &&
    Array.isArray(value.sources) &&
    value.sources.length >= 1 &&
    value.sources.length <= 8 &&
    new Set(
      value.sources.map((source: unknown) =>
        record(source) ? source.trader_id : null,
      ),
    ).size === value.sources.length &&
    value.sources.every(
      (source: unknown) =>
        record(source) &&
        typeof source.trader_id === "string" &&
        ["available", "partial", "unavailable", "unsupported"].includes(
          source.status,
        ) &&
        [
          "standard_clearinghouse_account_value",
          "unified_spot_usdc_total",
          "unavailable",
        ].includes(source.equity_basis) &&
        typeof source.equity_verified === "boolean" &&
        ["standard", "unified", "unsupported", "unknown"].includes(
          source.account_mode,
        ) &&
        typeof source.coverage_complete === "boolean" &&
        source.scope === "base_perps" &&
        consistentSourceEvidence(source) &&
        (source.snapshot === null ||
          (record(source.snapshot) &&
            timestamp(source.snapshot.observed_at) &&
            typeof source.snapshot.revision === "string" &&
            numeric(source.snapshot.account_value_usdc) != null &&
            typeof source.snapshot.complete === "boolean" &&
            Array.isArray(source.snapshot.positions) &&
            new Set(
              source.snapshot.positions.map((position: unknown) =>
                record(position) ? position.key : null,
              ),
            ).size === source.snapshot.positions.length &&
            source.snapshot.positions.every((position: unknown) =>
              positionEvidence(position, source.status === "available"),
            ))),
    ) &&
    record(value.market) &&
    timestamp(value.market.observed_at) &&
    stringMap(value.market.prices) &&
    stringMap(value.market.min_notionals) &&
    numberMap(value.market.max_leverages) &&
    numberMap(value.market.quantity_decimals, true) &&
    typeof value.market.coverage_complete === "boolean" &&
    value.market.scope === "base_perps" &&
    value.market.product_planning_max_leverage === PERPS_COPY_MAX_LEVERAGE &&
    value.market.legacy_candidate_venue_max_leverage_basis ===
      "product_planning_envelope" &&
    Array.isArray(value.market.reason_codes) &&
    value.market.reason_codes.every((v: unknown) => typeof v === "string")
  );
}
