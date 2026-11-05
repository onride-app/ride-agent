import {
  Interface,
  ZeroHash,
  ZeroAddress,
  solidityPackedKeccak256,
} from "ethers";
import { D, now, type Candidate } from "./domain.js";
import type { Metrics } from "./prediction_history.js";

const DAY = 86400;
const abi20 = new Interface([
  "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function transferFrom(address,address,uint256) returns(bool)",
  "function VAULT() view returns(address)",
]);
const safe = new Interface([
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)",
]);
const abi1155 = new Interface([
  "function balanceOfBatch(address[],uint256[]) view returns(uint256[])",
  "function payoutDenominator(bytes32) view returns(uint256)",
  "function payoutNumerators(bytes32,uint256) view returns(uint256)",
  "function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)",
]);
const negRisk = new Interface(["function wcol() view returns(address)"]);
// Polygon deployment in Polymarket's contract-security registry. Resolve its
// immutable wrapped collateral on-chain rather than assuming a token mapping.
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";
const hex = (n: number) => `0x${n.toString(16)}`;
const lower = (s: string) => s.toLowerCase();
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);
function check(ok: unknown, reason: string, context?: unknown): asserts ok {
  if (!ok) throw new Error(reason, { cause: context });
}
type Contracts = {
  collateral: string;
  wrapped_collateral: string;
  conditional_tokens: string;
};
export type Movement = {
  at: number;
  block: number;
  asset: string;
  amount: bigint;
  hash: string;
  kind: "cash" | "outcome";
  from?: string;
  to?: string;
};
export type Funding = { at: number; amount: string | number };
export type Mark = {
  timestamp: number;
  price: number;
  resolution_seconds: number;
};
export function canonicalOutcomeSlot(
  token: string,
  collections: string[],
  collaterals: string[],
) {
  const matches = collections.flatMap((collection, index) =>
    collaterals.some(
      (collateral) =>
        BigInt(
          solidityPackedKeccak256(
            ["address", "bytes32"],
            [collateral, collection],
          ),
        ).toString() === token,
    )
      ? [index]
      : [],
  );
  check(matches.length === 1, "unverified_ctf_token_identity");
  return matches[0];
}

// Only an exact ERC20 transfer, directly or in a Safe CALL, can fill a missing
// external funding row. Never infer funding from arbitrary contract calls.
export function explicitCollateralTransfer(tx: any, m: Movement) {
  try {
    if (m.kind !== "cash" || !m.from || !m.to || BigInt(tx.value) !== 0n)
      return false;
    const token = m.asset.slice(5);
    let target = lower(tx.to),
      caller = lower(tx.from),
      input = tx.input;
    if (target !== token) {
      const call = safe.parseTransaction({ data: input });
      if (
        !call ||
        call.name !== "execTransaction" ||
        call.args.operation !== 0n ||
        call.args.value !== 0n
      )
        return false;
      caller = target;
      target = lower(call.args.to);
      input = call.args.data;
    }
    if (target !== token) return false;
    const call = abi20.parseTransaction({ data: input });
    if (!call || !["transfer", "transferFrom"].includes(call.name))
      return false;
    const from = call.name === "transfer" ? caller : lower(call.args[0]);
    const to = lower(call.args[call.name === "transfer" ? 0 : 1]);
    const amount = BigInt(call.args[call.name === "transfer" ? 1 : 2]);
    return (
      from === lower(m.from) &&
      to === lower(m.to) &&
      amount === (m.amount < 0n ? -m.amount : m.amount)
    );
  } catch {
    return false;
  }
}
export function collateralConversion(
  movements: Movement[],
  wallet: string,
  pusd: string,
  usdce: string,
  vault = pusd,
) {
  const legs = movements.filter((m) => m.amount !== 0n);
  if (
    legs.length !== 2 ||
    legs.some((m) => m.kind !== "cash") ||
    legs[0].hash !== legs[1].hash ||
    legs[0].block !== legs[1].block
  )
    return false;
  const p = legs.find((m) => m.asset === `cash:${lower(pusd)}`),
    u = legs.find((m) => m.asset === `cash:${lower(usdce)}`);
  if (!p || !u || p.amount + u.amount !== 0n) return false;
  if (p.amount > 0n)
    return (
      p.from === ZeroAddress &&
      p.to === lower(wallet) &&
      u.from === lower(wallet) &&
      u.to === lower(pusd)
    );
  return (
    p.from === lower(wallet) &&
    (p.to === ZeroAddress || p.to === lower(pusd)) &&
    u.from === lower(vault) &&
    u.to === lower(wallet)
  );
}

// A bucket's timestamp is its START, not its closing mark. Never use prices
// observed after the valuation instant, nor extrapolate a sparse quote forever.
export function historicalMark(
  points: Mark[],
  at: number,
  settlement?: { at: number; price: number },
) {
  if (settlement && settlement.at <= at) return settlement.price;
  const eligible = points.filter(
    (p) =>
      p.timestamp + p.resolution_seconds <= at &&
      p.resolution_seconds <= 10800 &&
      (!settlement || p.timestamp + p.resolution_seconds < settlement.at),
  );
  const p = eligible.at(-1);
  check(
    p &&
      at - (p.timestamp + p.resolution_seconds) <= 6 * 3600 &&
      valid(p.price) &&
      p.price >= 0 &&
      p.price <= 1,
    "missing_historical_price",
  );
  return p.price;
}

export function inventoryAt(
  current: Map<string, bigint>,
  movements: Movement[],
  at: number,
) {
  const inventory = new Map(current);
  for (const m of movements)
    if (m.at > at)
      inventory.set(m.asset, (inventory.get(m.asset) ?? 0n) - m.amount);
  check(
    [...inventory.values()].every((n) => n >= 0n),
    "incomplete_transfer_inventory",
  );
  return inventory;
}

export function equityMetrics(
  points: { at: number; equity: string }[],
  funding: Funding[],
  provenance: NonNullable<Candidate["metric_provenance"]>,
): Metrics {
  check(
    points.length >= 29 && points.at(-1)!.at - points[0].at >= 28 * DAY,
    "insufficient_equity_history",
  );
  let nav = D(1),
    peak = D(1),
    dd = D(0);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    check(
      Number.isSafeInteger(p.at) && D(p.equity).gt(0),
      "nonpositive_historical_equity",
    );
    if (!i) continue;
    const previous = points[i - 1];
    check(
      p.at > previous.at && p.at - previous.at <= 26 * 3600,
      "equity_history_gap",
    );
    const flows = funding.filter((f) => f.at > previous.at && f.at <= p.at);
    check(
      flows.every((f) => Number.isSafeInteger(f.at) && D(f.amount).isFinite()),
      "invalid_funding_ledger",
    );
    const deposits = flows.reduce((n, f) => n.plus(D.max(0, f.amount)), D(0));
    const withdrawals = flows.reduce(
      (n, f) => n.plus(D.max(0, D(f.amount).negated())),
      D(0),
    );
    nav = nav
      .times(D(p.equity).plus(withdrawals))
      .div(D(previous.equity).plus(deposits));
    peak = D.max(peak, nav);
    dd = D.max(dd, D(1).minus(nav.div(peak)));
  }
  return {
    source_roi_pct: nav.minus(1).times(100).toNumber(),
    source_drawdown_pct: dd.times(100).toNumber(),
    metric_window: {
      start_at: points[0].at * 1000,
      end_at: points.at(-1)!.at * 1000,
      basis: "polygon_inventory_nav_1m_daily_v2",
    },
    metric_provenance: provenance,
  };
}

// Bound reconstruction work independently from recommendation request latency.
// A single instance is shared by the source roster, with two wallet jobs and
// six public-data requests in flight at most; completed metrics are persisted.
export class Gate {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private maximum: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum)
      await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await f();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}
export class PredictionEquityHistory {
  private httpGate = new Gate(6);
  private blockStarts = new Map<number, Promise<number>>();
  private prices = new Map<string, { until: number; value: Promise<Mark[]> }>();
  constructor(
    private rpcUrl: string,
    private contracts: () => Promise<Contracts>,
    private accountingAnchor?: (
      wallet: string,
      signal: AbortSignal,
    ) => Promise<{ wallet: string; equity: ReturnType<typeof D>; at: number }>,
  ) {}
  async load(wallet: string): Promise<{ metrics: Metrics; evidence: unknown }> {
    if (!this.accountingAnchor) throw new Error("accounting_snapshot_retired");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("equity_history_timeout")),
      300_000,
    );
    try {
      return await this.reconstruct(wallet, controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  private async reconstruct(
    wallet: string,
    signal: AbortSignal,
  ): Promise<{ metrics: Metrics; evidence: unknown }> {
    check(/^0x[0-9a-f]{40}$/i.test(wallet), "invalid_history_identity");
    const read = async (url: URL | string, body?: unknown): Promise<Buffer> =>
      this.httpGate.run(async () => {
        signal.throwIfAborted();
        const r = await fetch(url, {
          signal,
          redirect: "error",
          ...(body
            ? {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              }
            : {}),
        });
        check(r.ok && r.body, "equity_source_unavailable");
        let size = 0;
        const chunks: Uint8Array[] = [];
        for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          check(size <= 8 * 1024 * 1024, "history_response_too_large");
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      });
    let rpcId = 0;
    const callQueue: {
      payload: unknown;
      id: number;
      resolve(value: any): void;
      reject(error: unknown): void;
    }[] = [];
    let batchScheduled = false;
    const flushCalls = async () => {
      const batch = callQueue.splice(0, 20);
      try {
        const response = JSON.parse(
          (
            await read(
              this.rpcUrl,
              batch.map((x) => x.payload),
            )
          ).toString(),
        );
        check(
          Array.isArray(response) && response.length === batch.length,
          "incomplete_archive_rpc_batch",
        );
        for (const entry of batch) {
          const result = response.find((x) => x.id === entry.id);
          if (!result || result.error || result.result == null)
            entry.reject(new Error("archive_rpc_unavailable"));
          else entry.resolve(result.result);
        }
      } catch (e) {
        batch.forEach((entry) => entry.reject(e));
      } finally {
        if (callQueue.length) setTimeout(() => void flushCalls(), 10);
        else batchScheduled = false;
      }
    };
    const rpc = async (method: string, params: unknown[]): Promise<any> => {
      const id = ++rpcId;
      if (["eth_call", "eth_getTransactionByHash"].includes(method))
        return new Promise((resolve, reject) => {
          callQueue.push({
            payload: { jsonrpc: "2.0", id, method, params },
            id,
            resolve,
            reject,
          });
          if (!batchScheduled) {
            batchScheduled = true;
            setTimeout(() => void flushCalls(), 10);
          }
        });
      const result = JSON.parse(
        (
          await read(this.rpcUrl, {
            jsonrpc: "2.0",
            id,
            method,
            params,
          })
        ).toString(),
      );
      check(!result.error && result.result != null, "archive_rpc_unavailable");
      return result.result;
    };
    const data = async (path: string, params: Record<string, string>) => {
      const url = new URL(path, "https://data-api.polymarket.com");
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      return JSON.parse((await read(url)).toString());
    };
    const paged = async (
      path: string,
      params: Record<string, string>,
      maximum = 50,
    ): Promise<any[]> => {
      const out: any[] = [],
        seen = new Set<string>();
      let cursor: string | undefined;
      for (let i = 0; i < maximum; i++) {
        const r = await data(path, {
          ...params,
          limit: "1000",
          ...(cursor ? { cursor } : {}),
        });
        check(
          Array.isArray(r.data) &&
            r.data.length <= 1000 &&
            typeof r.pagination?.has_more === "boolean",
          "incomplete_equity_source_pages",
        );
        out.push(...r.data);
        if (!r.pagination.has_more) {
          check(
            r.pagination.next_cursor === null,
            "incomplete_equity_source_pages",
          );
          return out;
        }
        cursor = r.pagination.next_cursor;
        check(
          cursor && !seen.has(cursor) && r.data.length,
          "incomplete_equity_source_pages",
        );
        seen.add(cursor);
      }
      throw new Error("equity_source_page_limit");
    };
    const c = await this.contracts();
    check(
      Number(BigInt(await rpc("eth_chainId", []))) === 137,
      "wrong_history_network",
    );
    const head = Number(BigInt(await rpc("eth_blockNumber", []))) - 6;
    const block = await rpc("eth_getBlockByNumber", [hex(head), false]);
    const end = Number(BigInt(block.timestamp)),
      start = Math.floor(end / DAY) * DAY - 29 * DAY;
    check(now() / 1000 - end < 300, "stale_inventory_anchor");
    let startPromise = this.blockStarts.get(start);
    if (!startPromise) {
      startPromise = (async () => {
        let lo = Math.max(1, head - 40 * DAY),
          hi = head;
        let lt = Number(
            BigInt(
              (await rpc("eth_getBlockByNumber", [hex(lo), false])).timestamp,
            ),
          ),
          ht = end;
        check(lt < start, "history_block_range_unavailable");
        for (let n = 0; hi - lo > 1 && n < 40; n++) {
          const mid = Math.max(
            lo + 1,
            Math.min(
              hi - 1,
              lo + Math.floor(((start - lt) * (hi - lo)) / (ht - lt)),
            ),
          );
          const mt = Number(
            BigInt(
              (await rpc("eth_getBlockByNumber", [hex(mid), false])).timestamp,
            ),
          );
          if (mt <= start) {
            lo = mid;
            lt = mt;
          } else {
            hi = mid;
            ht = mt;
          }
        }
        check(
          hi - lo === 1 && lt <= start && ht > start,
          "history_block_range_unavailable",
        );
        return lo;
      })();
      this.blockStarts.set(start, startPromise);
      startPromise.catch(() => this.blockStarts.delete(start));
      if (this.blockStarts.size > 3)
        this.blockStarts.delete(this.blockStarts.keys().next().value!);
    }
    const startBlock = await startPromise;
    const [open, lost, activity, snapshot] = await Promise.all([
      paged("/v2/positions", {
        user: wallet,
        status: "OPEN",
        include_archived: "true",
      }),
      paged("/v2/positions", { user: wallet, status: "REDEEMABLE_LOST" }),
      paged("/v2/activity", {
        user: wallet,
        start: String(start),
        end: String(end),
        type: "TRADE,SPLIT,MERGE,REDEEM,REWARD,CONVERSION,DEPOSIT,WITHDRAWAL,MAKER_REBATE,TAKER_REBATE,REFERRAL_REWARD,YIELD,MIGRATION,TIP",
        exclude_deposits_withdrawals: "false",
        sort_direction: "ASC",
      }),
      this.accountingAnchor!(wallet, signal),
    ]);
    check(
      lower(snapshot.wallet) === lower(wallet),
      "accounting_anchor_owner_mismatch",
    );
    check(
      Number.isSafeInteger(snapshot.at) &&
        snapshot.at > 0 &&
        snapshot.equity.isFinite() &&
        snapshot.equity.gt(0),
      "invalid_accounting_anchor",
    );
    check(Math.abs(snapshot.at / 1000 - end) <= 180, "stale_inventory_anchor");
    const addresses = [
      c.collateral,
      c.wrapped_collateral,
      c.conditional_tokens,
    ].map(lower);
    const tokens = new Set<string>();
    for (const p of [...open, ...lost]) {
      check(
        lower(p.proxy_wallet) === lower(wallet) &&
          /^\d+$/.test(p.token_id) &&
          valid(p.current_size) &&
          p.current_size >= 0,
        "invalid_position_inventory",
      );
      if (p.current_size > 0) tokens.add(p.token_id);
    }
    const movements: Movement[] = [],
      ids = new Map<string, string>();
    const transferPage = async (direction: "fromAddress" | "toAddress") => {
      let pageKey: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 50; page++) {
        const r = await rpc("alchemy_getAssetTransfers", [
          {
            fromBlock: hex(startBlock),
            toBlock: hex(head),
            [direction]: wallet,
            contractAddresses: addresses,
            category: ["erc20", "erc1155"],
            maxCount: "0x3e8",
            excludeZeroValue: false,
            withMetadata: true,
            order: "asc",
            ...(pageKey ? { pageKey } : {}),
          },
        ]);
        check(
          Array.isArray(r.transfers) && r.transfers.length <= 1000,
          "incomplete_chain_transfer_pages",
        );
        for (const t of r.transfers) {
          check(
            typeof t.uniqueId === "string" && typeof t.hash === "string",
            "invalid_chain_transfer",
          );
          const contract = lower(t.rawContract?.address ?? "");
          check(addresses.includes(contract), "unexpected_inventory_contract");
          const digest = JSON.stringify(t),
            previous = ids.get(t.uniqueId);
          if (previous) {
            check(previous === digest, "conflicting_chain_transfer");
            continue;
          }
          ids.set(t.uniqueId, digest);
          const at = Date.parse(t.metadata?.blockTimestamp) / 1000,
            number = Number(BigInt(t.blockNum));
          check(
            Number.isSafeInteger(at) &&
              number >= startBlock &&
              number <= head &&
              at <= end &&
              (lower(t.from) === lower(wallet) ||
                lower(t.to) === lower(wallet)),
            "invalid_chain_transfer",
          );
          const sign = BigInt(
            Number(lower(t.to) === lower(wallet)) -
              Number(lower(t.from) === lower(wallet)),
          );
          if (t.category === "erc20") {
            check(
              contract !== lower(c.conditional_tokens) &&
                /^0x[0-9a-f]+$/i.test(t.rawContract.value),
              "invalid_cash_transfer",
            );
            movements.push({
              at,
              block: number,
              asset: `cash:${contract}`,
              amount: BigInt(t.rawContract.value) * sign,
              hash: lower(t.hash),
              kind: "cash",
              from: lower(t.from),
              to: lower(t.to),
            });
          } else {
            check(
              contract === lower(c.conditional_tokens) &&
                Array.isArray(t.erc1155Metadata) &&
                t.erc1155Metadata.length > 0,
              "unsupported_outcome_contract",
            );
            for (const entry of t.erc1155Metadata) {
              const token = BigInt(entry.tokenId).toString(),
                amount = BigInt(entry.value) * sign;
              if (!amount) continue;
              tokens.add(token);
              movements.push({
                at,
                block: number,
                asset: token,
                amount,
                hash: lower(t.hash),
                kind: "outcome",
              });
            }
          }
        }
        if (!r.pageKey) return;
        check(
          typeof r.pageKey === "string" &&
            !seen.has(r.pageKey) &&
            r.transfers.length > 0,
          "incomplete_chain_transfer_pages",
        );
        seen.add(r.pageKey);
        pageKey = r.pageKey;
      }
      throw new Error("chain_transfer_page_limit");
    };
    await Promise.all([transferPage("fromAddress"), transferPage("toAddress")]);
    check(tokens.size <= 2000, "historical_token_limit");
    const tokenIds = [...tokens],
      transactions = new Set(activity.map((a) => lower(a.transaction_hash)));
    const financialTypes = new Set([
      "TRADE",
      "SPLIT",
      "MERGE",
      "REDEEM",
      "REWARD",
      "CONVERSION",
      "DEPOSIT",
      "WITHDRAWAL",
      "MAKER_REBATE",
      "TAKER_REBATE",
      "REFERRAL_REWARD",
      "YIELD",
      "MIGRATION",
      "TIP",
    ]);
    for (const a of activity)
      check(
        lower(a.proxy_wallet) === lower(wallet) &&
          financialTypes.has(a.type) &&
          Number.isSafeInteger(a.timestamp) &&
          a.timestamp >= start &&
          a.timestamp <= end,
        "invalid_wallet_activity",
      );
    const additionalFunding: Funding[] = [],
      inspected = new Map<string, any>(),
      conversions = new Set<string>();
    let collateralVault: string | undefined;
    for (const m of movements.filter(
      (m) => m.at > start && m.amount !== 0n && !transactions.has(m.hash),
    )) {
      if (conversions.has(m.hash)) continue;
      const related = movements.filter((other) => other.hash === m.hash);
      if (
        !collateralVault &&
        related.length === 2 &&
        related.every((leg) => leg.kind === "cash") &&
        related[0].amount + related[1].amount === 0n
      )
        collateralVault = abi20.decodeFunctionResult(
          "VAULT",
          await rpc("eth_call", [
            { to: c.collateral, data: abi20.encodeFunctionData("VAULT") },
            hex(head),
          ]),
        )[0];
      if (
        collateralConversion(
          related,
          wallet,
          c.collateral,
          c.wrapped_collateral,
          collateralVault,
        )
      ) {
        conversions.add(m.hash);
        continue;
      }
      check(
        m.kind === "cash" &&
          !movements.some(
            (other) =>
              other.hash === m.hash &&
              other.kind === "outcome" &&
              other.amount !== 0n,
          ),
        "unclassified_outcome_capital_transfer",
        m,
      );
      let tx = inspected.get(m.hash);
      if (!tx) {
        tx = await rpc("eth_getTransactionByHash", [m.hash]);
        inspected.set(m.hash, tx);
      }
      check(explicitCollateralTransfer(tx, m), "unclassified_cash_transfer", m);
      additionalFunding.push({
        at: m.at,
        amount: D(m.amount.toString()).div(1e6).toString(),
      });
    }
    const chainTransactions = new Set(movements.map((m) => m.hash));
    for (const a of activity.filter(
      (a) =>
        ["TRADE", "DEPOSIT", "WITHDRAWAL"].includes(a.type) && a.usdc_size > 0,
    ))
      check(
        chainTransactions.has(lower(a.transaction_hash)),
        "activity_missing_from_chain_transfers",
      );
    const funding: Funding[] = activity
      .filter((a) => ["DEPOSIT", "WITHDRAWAL", "TIP"].includes(a.type))
      .map((a) => {
        check(
          valid(a.usdc_size) &&
            a.usdc_size >= 0 &&
            (a.type !== "TIP" || ["IN", "OUT"].includes(a.side)),
          "invalid_funding_ledger",
        );
        return {
          at: a.timestamp,
          amount:
            a.usdc_size *
            (a.type === "WITHDRAWAL" || a.side === "OUT" ? -1 : 1),
        };
      });
    funding.push(...additionalFunding);
    const balances = async (atBlock: number) => {
      const out = new Map<string, bigint>();
      await Promise.all(
        addresses.slice(0, 2).map(async (token) => {
          const result = await rpc("eth_call", [
            {
              to: token,
              data: abi20.encodeFunctionData("balanceOf", [wallet]),
            },
            hex(atBlock),
          ]);
          out.set(
            `cash:${token}`,
            BigInt(abi20.decodeFunctionResult("balanceOf", result)[0]),
          );
        }),
      );
      for (let i = 0; i < tokenIds.length; i += 200) {
        const ids = tokenIds.slice(i, i + 200);
        const result = await rpc("eth_call", [
          {
            to: c.conditional_tokens,
            data: abi1155.encodeFunctionData("balanceOfBatch", [
              ids.map(() => wallet),
              ids,
            ]),
          },
          hex(atBlock),
        ]);
        const values = abi1155.decodeFunctionResult(
          "balanceOfBatch",
          result,
        )[0];
        check(values.length === ids.length, "incomplete_inventory_balances");
        ids.forEach((id, j) => out.set(id, BigInt(values[j])));
      }
      return out;
    };
    const [current, initial] = await Promise.all([
      balances(head),
      balances(startBlock),
    ]);
    const reconstructedInitial = inventoryAt(
      current,
      movements.filter((m) => m.block > startBlock),
      start - 1,
    );
    check(
      [...initial].every(
        ([key, amount]) => reconstructedInitial.get(key) === amount,
      ),
      "chain_transfer_boundary_mismatch",
    );
    const times = Array.from({ length: 30 }, (_, i) => start + i * DAY);
    if (end > times.at(-1)!) times.push(end);
    const inventories = times.map((at) => inventoryAt(current, movements, at));
    const heldTokens = tokenIds.filter((id) =>
      inventories.some((inventory) => inventory.get(id)! > 0n),
    );
    const refs = new Map<string, any>();
    for (let i = 0; i < heldTokens.length; i += 50) {
      const r = await data("/v2/tokens", {
        token_id: heldTokens.slice(i, i + 50).join(","),
      });
      check(Array.isArray(r.data), "missing_token_metadata");
      r.data.forEach((t: any) => refs.set(t.token_id, t));
    }
    check(
      heldTokens.every((id) => refs.get(id)?.module === "v1_ctf"),
      "unsupported_historical_token_module",
    );
    const resolutionHints = new Map<string, any>(),
      hintTransactions = new Map<string, Promise<number | undefined>>();
    const resolvedConditions = [
      ...new Set(
        [...refs.values()]
          .filter((ref) => ref.resolved)
          .map((ref) => ref.condition_id as string),
      ),
    ];
    await Promise.all(
      Array.from(
        { length: Math.ceil(resolvedConditions.length / 20) },
        async (_, index) => {
          // Hints only accelerate locating a block. Both sides of the actual CTF
          // payout transition are independently verified before a hint is accepted.
          try {
            const r = await data("/v2/resolutions", {
              condition: resolvedConditions
                .slice(index * 20, index * 20 + 20)
                .join(","),
            });
            if (Array.isArray(r.data))
              for (const row of r.data)
                if (
                  typeof row.condition_id === "string" &&
                  row.status === "resolved"
                )
                  resolutionHints.set(lower(row.condition_id), row);
          } catch {
            /* The verified archive binary search remains available. */
          }
        },
      ),
    );
    const settlementBlocks = new Map<
      string,
      Promise<{ at: number; denominator: bigint } | null>
    >();
    const collaterals = [c.collateral, c.wrapped_collateral];
    if ([...refs.values()].some((ref) => ref.neg_risk === true)) {
      const wrapped = negRisk.decodeFunctionResult(
        "wcol",
        await rpc("eth_call", [
          { to: NEG_RISK_ADAPTER, data: negRisk.encodeFunctionData("wcol") },
          hex(head),
        ]),
      )[0];
      collaterals.push(wrapped);
    }
    const collections = new Map<string, Promise<string[]>>();
    const outcomeSlot = async (id: string, condition: string) => {
      let result = collections.get(condition);
      if (!result) {
        result = Promise.all(
          [0, 1].map(
            async (index) =>
              abi1155.decodeFunctionResult(
                "getCollectionId",
                await rpc("eth_call", [
                  {
                    to: c.conditional_tokens,
                    data: abi1155.encodeFunctionData("getCollectionId", [
                      ZeroHash,
                      condition,
                      1 << index,
                    ]),
                  },
                  hex(head),
                ]),
              )[0] as string,
          ),
        );
        collections.set(condition, result);
      }
      return canonicalOutcomeSlot(id, await result, collaterals);
    };
    const denominator = async (condition: string, number: number) =>
      BigInt(
        abi1155.decodeFunctionResult(
          "payoutDenominator",
          await rpc("eth_call", [
            {
              to: c.conditional_tokens,
              data: abi1155.encodeFunctionData("payoutDenominator", [
                condition,
              ]),
            },
            hex(number),
          ]),
        )[0],
      );
    const settlement = (condition: string) => {
      let result = settlementBlocks.get(condition);
      if (!result) {
        result = (async () => {
          const current = await denominator(condition, head);
          if (current === 0n) return null;
          if ((await denominator(condition, startBlock)) > 0n)
            return { at: start, denominator: current };
          const hint = resolutionHints.get(lower(condition));
          let hintBlock = hint?.resolved_block;
          if (
            !Number.isSafeInteger(hintBlock) &&
            /^0x[0-9a-f]{64}$/i.test(hint?.transaction_hash ?? "")
          ) {
            let transaction = hintTransactions.get(hint.transaction_hash);
            if (!transaction) {
              transaction = rpc("eth_getTransactionByHash", [
                hint.transaction_hash,
              ])
                .then((tx) => Number(BigInt(tx.blockNumber)))
                .catch(() => undefined);
              hintTransactions.set(hint.transaction_hash, transaction);
            }
            hintBlock = await transaction;
          }
          if (
            Number.isSafeInteger(hintBlock) &&
            hintBlock > startBlock &&
            hintBlock <= head
          ) {
            const [before, after] = await Promise.all([
              denominator(condition, hintBlock - 1),
              denominator(condition, hintBlock),
            ]);
            if (before === 0n && after === current) {
              const settledBlock = await rpc("eth_getBlockByNumber", [
                hex(hintBlock),
                false,
              ]);
              return {
                at: Number(BigInt(settledBlock.timestamp)),
                denominator: current,
              };
            }
          }
          let lo = startBlock,
            hi = head;
          while (hi - lo > 1) {
            const mid = Math.floor((hi + lo) / 2);
            if ((await denominator(condition, mid)) > 0n) hi = mid;
            else lo = mid;
          }
          const settledBlock = await rpc("eth_getBlockByNumber", [
            hex(hi),
            false,
          ]);
          return {
            at: Number(BigInt(settledBlock.timestamp)),
            denominator: current,
          };
        })();
        settlementBlocks.set(condition, result);
      }
      return result;
    };
    const priceCurves = new Map<string, Mark[]>(),
      settlements = new Map<string, { at: number; price: number }>();
    await Promise.all(
      heldTokens.map(async (id) => {
        const ref = refs.get(id),
          slot = await outcomeSlot(id, ref.condition_id),
          resolved = await settlement(ref.condition_id);
        if (resolved) {
          const numerator = BigInt(
            abi1155.decodeFunctionResult(
              "payoutNumerators",
              await rpc("eth_call", [
                {
                  to: c.conditional_tokens,
                  data: abi1155.encodeFunctionData("payoutNumerators", [
                    ref.condition_id,
                    slot,
                  ]),
                },
                hex(head),
              ]),
            )[0],
          );
          const price = D(numerator.toString())
            .div(resolved.denominator.toString())
            .toNumber();
          check(price >= 0 && price <= 1, "invalid_settlement_payout");
          settlements.set(id, { at: resolved.at, price });
          if (resolved.at <= start) {
            priceCurves.set(id, []);
            return;
          }
        }
        let cachedPrices = this.prices.get(id);
        if (!cachedPrices || cachedPrices.until <= now()) {
          const value = paged(
            "/v2/prices-history",
            { token_id: id, interval: "1m", bucket_seconds: "10800" },
            5,
          ).then((rows) => {
            check(rows.length <= 320, "unexpected_price_history_window");
            return rows as Mark[];
          });
          cachedPrices = { until: now() + 3600_000, value };
          this.prices.set(id, cachedPrices);
          value.catch(() => {
            if (this.prices.get(id)?.value === value) this.prices.delete(id);
          });
          if (this.prices.size > 512)
            this.prices.delete(this.prices.keys().next().value!);
        }
        const p = [...(await cachedPrices.value)];
        // A current three-hour average can differ materially from the current
        // snapshot even with a complete inventory. Read the anchor's own latest
        // observation instead of increasing the reconciliation tolerance.
        const anchor = await data("/v2/prices-history", {
          token_id: id,
          as_of: String(end),
        });
        check(
          Array.isArray(anchor.data) &&
            anchor.data.length <= 1 &&
            anchor.pagination?.has_more === false &&
            anchor.pagination.next_cursor === null,
          "invalid_anchor_price",
        );
        for (const point of anchor.data) {
          const existing = p.findIndex((x) => x.timestamp === point.timestamp);
          if (existing >= 0) p.splice(existing, 1);
          p.push(point);
        }
        p.sort((a, b) => a.timestamp - b.timestamp);
        check(
          p.every(
            (x, i) =>
              Number.isSafeInteger(x.timestamp) &&
              valid(x.price) &&
              x.price >= 0 &&
              x.price <= 1 &&
              Number.isSafeInteger(x.resolution_seconds) &&
              x.resolution_seconds >= 0 &&
              (i === 0 || x.timestamp > p[i - 1].timestamp),
          ),
          "invalid_historical_price_curve",
        );
        priceCurves.set(id, p);
      }),
    );
    const fallbackPriceSources = new Set<string>();
    const priceAt = async (id: string, at: number) => {
      const curve = priceCurves.get(id)!,
        settlement = settlements.get(id);
      try {
        return historicalMark(curve, at, settlement);
      } catch (e) {
        if (!(e instanceof Error) || e.message !== "missing_historical_price")
          throw e;
        // A coarse series can have a hole while a finer point-in-time tier
        // retains an actual observation. Keep the same age/no-future checks.
        let cutoff = at;
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await data("/v2/prices-history", {
              token_id: id,
              as_of: String(cutoff),
            });
            check(
              Array.isArray(r.data) &&
                r.data.length <= 1 &&
                r.pagination?.has_more === false &&
                r.pagination.next_cursor === null,
              "invalid_historical_price_curve",
            );
            const point = r.data[0];
            check(
              point &&
                Number.isSafeInteger(point.timestamp) &&
                Number.isSafeInteger(point.resolution_seconds) &&
                point.resolution_seconds >= 0 &&
                point.resolution_seconds <= 10800 &&
                valid(point.price) &&
                point.price >= 0 &&
                point.price <= 1,
              "missing_historical_price",
              { token_id: id, at },
            );
            if (point.timestamp + point.resolution_seconds <= at) {
              try {
                const price = historicalMark([point], at, settlement);
                fallbackPriceSources.add("polymarket_data_v2_point_in_time");
                return price;
              } catch {
                throw new Error("missing_historical_price", {
                  cause: { token_id: id, at, observation: point },
                });
              }
            }
            cutoff = at - point.resolution_seconds;
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "missing_historical_price"
          )
            throw error;
        }
        // The official CLOB archive retains periodic marks absent from the
        // native v2 tier. Request a bounded window and discard its occasionally
        // appended terminal point outside that window. Never use it as history.
        try {
          const url = new URL("/prices-history", "https://clob.polymarket.com");
          for (const [key, value] of Object.entries({
            market: id,
            startTs: String(at - 12 * 3600),
            endTs: String(at),
            fidelity: "60",
          }))
            url.searchParams.set(key, value);
          const response = JSON.parse((await read(url)).toString());
          check(
            Array.isArray(response.history) && response.history.length <= 1000,
            "missing_historical_price",
          );
          const points = response.history
            .filter(
              (p: any) =>
                Number.isSafeInteger(p.t) && p.t >= at - 12 * 3600 && p.t <= at,
            )
            .map((p: any) => ({
              timestamp: p.t,
              price: p.p,
              resolution_seconds: 3600,
            }))
            .sort((a: Mark, b: Mark) => a.timestamp - b.timestamp);
          check(
            points.every(
              (p: Mark, i: number) =>
                valid(p.price) &&
                p.price >= 0 &&
                p.price <= 1 &&
                (!i || p.timestamp > points[i - 1].timestamp),
            ),
            "missing_historical_price",
          );
          const price = historicalMark(points, at, settlement);
          fallbackPriceSources.add("polymarket_clob_prices_history");
          return price;
        } catch {
          throw new Error("missing_historical_price", {
            cause: { token_id: id, at },
          });
        }
      }
    };
    const curve = await Promise.all(
      times.map(async (at, index) => {
        const inventory = inventories[index];
        let equity = addresses
          .slice(0, 2)
          .reduce(
            (n, token) =>
              n.plus(D(inventory.get(`cash:${token}`)!.toString()).div(1e6)),
            D(0),
          );
        const values = await Promise.all(
          heldTokens
            .filter((id) => inventory.get(id)! > 0n)
            .map(async (id) =>
              D(inventory.get(id)!.toString())
                .div(1e6)
                .times(await priceAt(id, at)),
            ),
        );
        equity = values.reduce((n, value) => n.plus(value), equity);
        return { at, equity: equity.toString() };
      }),
    );
    const difference = D(curve.at(-1)!.equity)
      .minus(snapshot.equity)
      .abs()
      .div(snapshot.equity)
      .times(100);
    check(difference.lte(1), "equity_reconciliation_failed", {
      difference_pct: difference.toNumber(),
      reconstructed: curve.at(-1),
      snapshot: snapshot.equity.toString(),
      tokens: heldTokens.map((id) => ({
        id,
        quantity: current.get(id)!.toString(),
      })),
    });
    check(
      (await rpc("eth_getBlockByNumber", [hex(head), false])).hash ===
        block.hash,
      "inventory_anchor_reorg",
    );
    const metrics = equityMetrics(curve, funding, {
      source: "polygon_transfers_and_polymarket_historical_marks",
      sampling: "daily",
      estimated: true,
      cashflow_adjusted: true,
      flow_timing: "deposits_at_start_withdrawals_at_end",
      reconciliation_difference_pct: difference.toNumber(),
      inventory_start_block: startBlock,
      inventory_end_block: head,
      inventory_end_block_hash: block.hash,
      token_count: tokenIds.length,
      transfer_count: ids.size,
      max_price_age_seconds: 6 * 3600,
      price_bucket_seconds: 10800,
      fallback_price_sources: [...fallbackPriceSources].sort(),
    });
    return {
      metrics,
      evidence: {
        curve,
        funding,
        start_block: startBlock,
        end_block: head,
        end_block_hash: block.hash,
        token_count: tokenIds.length,
        transfer_count: ids.size,
        activity_count: activity.length,
        reconciliation_difference_pct: difference.toNumber(),
      },
    };
  }
}
