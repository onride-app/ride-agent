import { readPredictionPositionsV2 } from "./polymarket-data.js";
import pg from "pg";
import { JsonRpcProvider, Contract, Interface } from "ethers";
import { AgentError } from "./contracts.js";
import { PredictionHistory } from "./prediction_history.js";
import { PredictionEquityHistory } from "./prediction_equity_history.js";
import {
  D,
  cash,
  fingerprint,
  now,
  fresh,
  type Candidate,
  type Portfolio,
  type Execution,
  type AccountSnapshot,
  type PositionIntent,
  type Fill,
} from "./domain.js";

const transfers = new Interface([
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
]);
const erc20 = ["function balanceOf(address) view returns(uint256)"];
type Core = (operation: string, input: unknown) => Promise<any>;
interface Outcome {
  key: string;
  token_id: string;
  condition_id: string;
  asset: string;
}
export class PredictionVenue {
  private rpc: JsonRpcProvider | null = null;
  private poolCache: { at: number; rows: any[] } | null = null;
  private history: PredictionHistory;
  constructor(
    private pool: pg.Pool,
    private core: Core,
    private salt: string,
    private rpcUrl?: string,
  ) {
    this.history = new PredictionHistory(
      rpcUrl
        ? {
            loader: new PredictionEquityHistory(rpcUrl, () =>
              this.core("prediction_contracts", {}),
            ),
            key: (wallet) => this.id(wallet),
            read: async (key) =>
              (
                await this.pool.query(
                  "SELECT value FROM ride_agent_prediction_history WHERE key=$1",
                  [key],
                )
              ).rows[0]?.value ?? null,
            write: async (key, record) => {
              await this.pool.query(
                "INSERT INTO ride_agent_prediction_history(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
                [key, record],
              );
            },
          }
        : undefined,
    );
  }
  async migrate() {
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS ride_agent_prediction_outcomes (key TEXT PRIMARY KEY, value JSONB NOT NULL)",
    );
    await this.pool.query(
      "CREATE TABLE IF NOT EXISTS ride_agent_prediction_history (key TEXT PRIMARY KEY, value JSONB NOT NULL)",
    );
  }
  private provider() {
    if (!this.rpcUrl)
      throw new AgentError(
        "VENUE_UNAVAILABLE",
        "Prediction RPC is not configured.",
        true,
        503,
      );
    if (!this.rpc)
      this.rpc = new JsonRpcProvider(this.rpcUrl, 137, { staticNetwork: true });
    return this.rpc;
  }
  private id(address: string) {
    return `trader_${fingerprint([this.salt, "prediction", address.toLowerCase()]).slice(0, 32)}`;
  }
  private async positions(address: string) {
    return readPredictionPositionsV2(address);
  }
  private async cashBalance(
    address: string,
    identity?: any,
    blockTag?: number,
  ): Promise<string> {
    const constants = identity ?? (await this.core("prediction_contracts", {}));
    const balances = await Promise.all(
      [constants.collateral, constants.wrapped_collateral].map((token) =>
        new Contract(token, erc20, this.provider()).balanceOf(
          address,
          blockTag == null ? {} : { blockTag },
        ),
      ),
    );
    return D(balances.reduce((n, v) => n + BigInt(v), 0n).toString())
      .div(1e6)
      .toString();
  }
  private async remember(row: any): Promise<Outcome> {
    const token = String(row.asset);
    if (!/^\d{1,100}$/.test(token) || typeof row.conditionId !== "string")
      throw new AgentError(
        "SOURCE_STALE",
        "Prediction token identity is incomplete.",
        true,
      );
    const value: Outcome = {
      key: `prediction:outcome_${fingerprint(token).slice(0, 32)}`,
      token_id: token,
      condition_id: row.conditionId,
      asset: `EVENT${fingerprint(row.conditionId).slice(0, 8).toUpperCase()}`,
    };
    await this.pool.query(
      "INSERT INTO ride_agent_prediction_outcomes(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [value.key, value],
    );
    return value;
  }
  private async outcome(key: string): Promise<Outcome> {
    const r = await this.pool.query(
      "SELECT value FROM ride_agent_prediction_outcomes WHERE key=$1",
      [key],
    );
    if (!r.rowCount)
      throw new AgentError(
        "NOT_FOUND",
        "Prediction outcome metadata is unavailable.",
        false,
        404,
      );
    return r.rows[0].value;
  }
  private async book(token: string): Promise<any> {
    const r = await fetch(
      `https://clob.polymarket.com/book?token_id=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(12000), redirect: "error" },
    );
    if (!r.ok)
      throw new AgentError(
        "STALE_PRICE",
        "Prediction order book unavailable.",
        true,
      );
    const b = (await r.json()) as any;
    if (!Array.isArray(b.bids) || !Array.isArray(b.asks))
      throw new AgentError(
        "STALE_PRICE",
        "Prediction book is incomplete.",
        true,
      );
    return b;
  }
  async rows() {
    if (this.poolCache && now() - this.poolCache.at < 30000)
      return this.poolCache.rows;
    const rows = await this.core("prediction_pool", {});
    if (!Array.isArray(rows))
      throw new AgentError(
        "SOURCE_STALE",
        "Prediction pool is unavailable.",
        true,
      );
    this.poolCache = { at: now(), rows };
    return rows;
  }
  private async resolve(id: string) {
    const row = (await this.rows()).find((x: any) => this.id(x.address) === id);
    if (!row)
      throw new AgentError(
        "NOT_FOUND",
        "Fresh prediction trader identity is unavailable.",
        false,
        404,
      );
    return row;
  }
  async recognizes(id: string) {
    return (await this.rows()).some((r: any) => this.id(r.address) === id);
  }
  async source(id: string) {
    const row = await this.resolve(id);
    const positionEvidence = await this.positions(row.address);
    if (!positionEvidence.coverage_complete)
      throw new AgentError(
        "SOURCE_SCOPE_UNAVAILABLE",
        "Prediction source holdings exclude inactive markets. New copying is paused until complete holdings and equity can be verified.",
        true,
        503,
        { reason_code: "PREDICTION_SERVABLE_ONLY" },
      );
    const rows = positionEvidence.rows;
    const positions: PositionIntent[] = [];
    for (const row of rows.filter((r) => D(r.size).gt(0))) {
      const meta = await this.remember(row);
      positions.push({
        ...meta,
        market: "prediction",
        quantity: String(row.size),
        price: String(row.curPrice),
        source_entry_price: row.avgPrice == null ? null : String(row.avgPrice),
        source_leverage: 1,
        observed_at: now(),
        source_revision: "",
      });
    }
    const balance = await this.cashBalance(row.address);
    const equity = D(balance).plus(
      rows.reduce(
        (n, r) => n.plus(r.currentValue ?? D(r.size).times(r.curPrice)),
        D(0),
      ),
    );
    const revision = fingerprint(
      positions.map((p) => [p.key, p.quantity, p.source_entry_price]),
    );
    positions.forEach((p) => (p.source_revision = revision));
    return {
      observed_at: now(),
      revision,
      account_value_usdc: equity.toString(),
      positions,
      complete: true,
    };
  }
  async profile(id: string): Promise<Candidate> {
    const row = await this.resolve(id);
    const metrics = await this.history.metrics(row.address);
    const expiresAt = Math.min(
      row.expires_at,
      metrics.metric_window
        ? metrics.metric_window.end_at + 36 * 3600000
        : Infinity,
    );
    // Discovery uses the independently refreshed score snapshot. Live inventory
    // and collateral remain separate source() checks before increasing exposure;
    // requiring them here hides otherwise valid candidates on an RPC outage.
    const components = Object.fromEntries(
      Object.entries(row.components ?? {}).map(([k, v]) => [
        k,
        v == null ? null : Number(v),
      ]),
    );
    return {
      id,
      handle:
        typeof row.handle === "string" &&
        !/0x[a-fA-F0-9]{40}\b/.test(row.handle)
          ? row.handle
          : `Ride trader ${id.slice(-6)}`,
      market: "prediction",
      score: Number(row.score),
      score_version: row.score_version,
      components,
      scored_at: row.computed_at,
      expires_at: expiresAt,
      eligibility: expiresAt > now() ? "PASS" : "REJECT",
      assets: row.assets
        ?.map((x: string) =>
          x
            .replace(/[^A-Za-z0-9]/g, "")
            .toUpperCase()
            .slice(0, 16),
        )
        .filter(Boolean) ?? ["PREDICTION"],
      style: row.assets?.[0] ?? "prediction",
      direction: "long",
      median_hold_hours: null,
      ...metrics,
      atr_pct: null,
      venue_max_leverage: 1,
      min_notional_usdc: "5",
      last_trade_at: null,
    };
  }
  async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const rows = (await this.rows()).slice(0, 20);
    // Two bounded batches keep cold historical reads inside the bridge deadline.
    for (let i = 0; i < rows.length; i += 10) {
      const batch = await Promise.allSettled(
        rows.slice(i, i + 10).map((r: any) => this.profile(this.id(r.address))),
      );
      for (const r of batch) if (r.status === "fulfilled") out.push(r.value);
    }
    return out;
  }
  async fundingBalance(user: string) {
    const identity = await this.core("prediction_wallet", {
      user_id: user,
      portfolio_id: null,
    });
    const head = await this.provider().getBlockNumber();
    const block = Math.max(0, head - 2);
    const balance = await this.cashBalance(identity.wallet, identity, block);
    return {
      trading_balance_usdc: cash(balance),
      trading_observed_at: now(),
      chain_block: block,
      available_to_copy: identity.eligible === true && D(balance).gt(0),
      trading_observation: "verified",
    };
  }
  async account(
    user: string,
    p: Portfolio,
    bind = false,
  ): Promise<AccountSnapshot> {
    const input = {
      user_id: user,
      portfolio_id: p.id,
      revision: p.revision,
      budget_usdc: cash(
        p.sleeves
          .filter(
            (s) => s.trader.market === "prediction" && s.state !== "closed",
          )
          .reduce((n, s) => n.plus(s.amount_usdc), D(0)),
      ),
    };
    let identity = await this.core("prediction_wallet", input);
    const positionEvidence = await this.positions(identity.wallet);
    const positionsRows = positionEvidence.rows;
    if (bind) {
      if (!positionEvidence.coverage_complete)
        throw new AgentError(
          "ACCOUNT_NOT_READY",
          "Prediction holdings are incomplete because inactive markets are excluded. Copying cannot start until complete holdings are verified.",
          true,
          503,
          { reason_code: "PREDICTION_SERVABLE_ONLY" },
        );
      if (positionsRows.some((r) => D(r.size).gt(0)))
        throw new AgentError(
          "OWNERSHIP_CONFLICT",
          "Existing prediction inventory must remain with its current owner.",
        );
      await this.core("prediction_claim", input);
      identity = await this.core("prediction_wallet", input);
    }
    const head = await this.provider().getBlockNumber();
    const block = Math.max(0, head - 2);
    const balances = await this.cashBalance(identity.wallet, identity, block);
    const refs = new Map<string, Outcome>();
    for (const row of positionsRows) {
      const o = await this.remember(row);
      refs.set(o.key, o);
    }
    for (const s of p.sleeves)
      for (const key of [
        ...Object.keys(s.intents),
        ...Object.keys(s.lots),
      ].filter((k) => k.startsWith("prediction:")))
        if (!refs.has(key)) refs.set(key, await this.outcome(key));
    const positions: Record<string, string> = {},
      prices: Record<string, string> = {},
      min: Record<string, string> = {};
    const ctf = new Contract(
      identity.conditional_tokens,
      ["function balanceOf(address,uint256) view returns(uint256)"],
      this.provider(),
    );
    for (const ref of refs.values()) {
      positions[ref.key] = D(
        String(
          await ctf.balanceOf(identity.wallet, ref.token_id, {
            blockTag: block,
          }),
        ),
      )
        .div(1e6)
        .toString();
      const row = positionsRows.find((r) => String(r.asset) === ref.token_id);
      try {
        const book = await this.book(ref.token_id);
        const bids = book.bids.map((r: any) => D(r.price)),
          asks = book.asks.map((r: any) => D(r.price));
        const bid = bids.length ? D.max(...bids) : null,
          ask = asks.length ? D.min(...asks) : null;
        if (bid && ask) prices[ref.key] = bid.plus(ask).div(2).toString();
        else if (row && row.curPrice > 0)
          prices[ref.key] = String(row.curPrice);
        min[ref.key] = cash(
          D(book.min_order_size ?? 5).times(prices[ref.key] ?? 1),
        );
      } catch {
        if (row && row.curPrice > 0) prices[ref.key] = String(row.curPrice);
        else if (!D(positions[ref.key]).isZero())
          throw new AgentError(
            "STALE_PRICE",
            "Resolved prediction inventory needs settlement evidence.",
            true,
          );
      }
    }
    const evidence = await this.settlement(user, p, identity, head);
    const marketValue = Object.entries(positions).reduce(
      (n, [k, q]) => n.plus(D(q).times(prices[k] ?? 0)),
      D(0),
    );
    const ownership = identity.ownership;
    return {
      account_id: `account_${fingerprint([user, p.id, "prediction"]).slice(0, 32)}`,
      venue_accounts: { prediction: p.id },
      chain_block: block,
      observed_at: now(),
      account_value_usdc: D(balances).plus(marketValue).toString(),
      available_usdc: balances,
      available_by_market: { prediction: balances },
      dedicated: ownership?.portfolio_id === p.id,
      eligible: identity.eligible === true,
      positions,
      prices,
      min_notionals: min,
      quantity_decimals: Object.fromEntries(
        [...refs.keys()].map((k) => [k, 2]),
      ),
      max_leverages: Object.fromEntries([...refs.keys()].map((k) => [k, 1])),
      orders: evidence.orders,
      fills: evidence.fills,
      funding: [],
      flows: evidence.flows,
      coverage_complete:
        evidence.complete && positionEvidence.coverage_complete,
    };
  }
  private async settlement(
    user: string,
    p: Portfolio,
    identity: any,
    block: number,
  ): Promise<{
    fills: Fill[];
    flows: AccountSnapshot["flows"];
    orders: AccountSnapshot["orders"];
    complete: boolean;
  }> {
    const fills: Fill[] = [],
      flows: AccountSnapshot["flows"] = [],
      orders: AccountSnapshot["orders"] = [];
    let complete = true;
    const known = new Set<string>();
    const wallet = identity.wallet.toLowerCase();
    const records = await Promise.all(
      p.executions
        .filter((e) => e.key.startsWith("prediction:") && e.task_id)
        .map(async (execution) => ({
          execution,
          result: await this.core("prediction_execution", {
            user_id: user,
            portfolio_id: p.id,
            task_id: execution.task_id,
          }),
        })),
    );
    const owners = new Map<string, Set<string>>();
    for (const { execution, result } of records) {
      let response: any;
      try {
        response = JSON.parse(result.response ?? "{}");
      } catch {
        response = {};
      }
      for (const trade of response.agent_settlement?.trades ?? [])
        if (trade.transaction_hash) {
          const key = String(trade.transaction_hash).toLowerCase();
          const group = owners.get(key) ?? new Set<string>();
          group.add(execution.id);
          owners.set(key, group);
        }
    }
    for (const { execution, result } of records) {
      const ref = await this.outcome(execution.key);
      let response: any;
      try {
        response = JSON.parse(result.response ?? "{}");
      } catch {
        response = {};
      }
      if ([1, 2, 7, 8].includes(result.status)) {
        orders.push({
          id: execution.task_id!,
          key: execution.key,
          increases_risk: result.side === 1,
        });
      }
      const settled = response.agent_settlement;
      if (!settled?.complete) {
        if (D(result.filled_size).gt(0) || result.status === 3)
          complete = false;
        continue;
      }
      const byHash = new Map<string, any[]>();
      for (const trade of settled.trades ?? []) {
        if (trade.status !== "CONFIRMED" || !trade.transaction_hash) {
          complete = false;
          continue;
        }
        const rows = byHash.get(trade.transaction_hash) ?? [];
        rows.push(trade);
        byHash.set(trade.transaction_hash, rows);
      }
      for (const [hash, trades] of byHash) {
        if (
          (owners.get(hash.toLowerCase())?.size ?? 0) !== 1 ||
          known.has(hash)
        ) {
          complete = false;
          continue;
        }
        known.add(hash);
        const receipt = await this.provider().getTransactionReceipt(hash);
        if (
          !receipt ||
          receipt.status !== 1 ||
          block - receipt.blockNumber < 2
        ) {
          complete = false;
          continue;
        }
        let cashDelta = 0n,
          quantity = 0n;
        let otherInventory = false;
        for (const log of receipt.logs) {
          try {
            const parsed = transfers.parseLog(log);
            if (!parsed) continue;
            const from = String(parsed.args.from).toLowerCase(),
              to = String(parsed.args.to).toLowerCase(),
              direction =
                (to === wallet ? 1n : 0n) - (from === wallet ? 1n : 0n);
            if (!direction) continue;
            if (
              [identity.collateral, identity.wrapped_collateral].some(
                (t) => String(t).toLowerCase() === log.address.toLowerCase(),
              ) &&
              parsed.name === "Transfer"
            )
              cashDelta += direction * BigInt(parsed.args.value);
            if (
              log.address.toLowerCase() ===
              identity.conditional_tokens.toLowerCase()
            ) {
              const ids =
                parsed.name === "TransferSingle"
                  ? [parsed.args.id]
                  : parsed.args.ids;
              const values =
                parsed.name === "TransferSingle"
                  ? [parsed.args.value]
                  : parsed.args[4];
              for (let i = 0; i < ids.length; i++) {
                if (String(ids[i]) === ref.token_id)
                  quantity += direction * BigInt(values[i]);
                else otherInventory = true;
              }
            }
          } catch {
            /* Unrelated event. */
          }
        }
        if (otherInventory || quantity === 0n || cashDelta === 0n) {
          complete = false;
          continue;
        }
        const q = D(quantity.toString()).div(1e6),
          netCash = D(cashDelta.toString()).div(1e6),
          gross = trades.reduce(
            (n, t) => n.plus(D(t.quantity).times(t.price)),
            D(0),
          ),
          size = trades.reduce((n, t) => n.plus(t.quantity), D(0));
        if (size.isZero()) {
          complete = false;
          continue;
        }
        const price = gross.div(size);
        const fee = q.isPositive()
          ? netCash.neg().minus(q.times(price))
          : q.abs().times(price).minus(netCash);
        if (fee.lt(0) || fee.gt(gross.times(".1"))) {
          complete = false;
          continue;
        }
        const mined = await this.provider().getBlock(receipt.blockNumber);
        if (!mined) {
          complete = false;
          continue;
        }
        fills.push({
          id: `poly_${fingerprint([execution.task_id, hash]).slice(0, 32)}`,
          order_id: result.order_id,
          task_id: execution.task_id!,
          key: execution.key,
          quantity: q.toString(),
          price: price.toString(),
          fee_usdc: fee.toString(),
          at: mined.timestamp * 1000,
        });
      }
    }
    // Full ERC20 cashflow coverage from the ownership checkpoint, including wrapping.
    // Unknown token inventory events remain unresolved and block new risk.
    if (p.ledger_chain_block != null) {
      const sums = new Map<string, { amount: bigint; at: number }>();
      const address = "0x" + wallet.slice(2).padStart(64, "0");
      for (let from = p.ledger_chain_block; from <= block - 2; from += 500) {
        const to = Math.min(block - 2, from + 499);
        for (const token of [identity.collateral, identity.wrapped_collateral])
          for (const topics of [
            [transfers.getEvent("Transfer")!.topicHash, null, address],
            [transfers.getEvent("Transfer")!.topicHash, address],
          ]) {
            const logs = await this.provider().getLogs({
              address: token,
              fromBlock: from,
              toBlock: to,
              topics,
            });
            for (const log of logs) {
              if (known.has(log.transactionHash)) continue;
              const receipt = await this.provider().getTransactionReceipt(
                log.transactionHash,
              );
              if (
                !receipt ||
                receipt.logs.some((l) => {
                  if (
                    l.address.toLowerCase() !==
                    identity.conditional_tokens.toLowerCase()
                  )
                    return false;
                  try {
                    const p = transfers.parseLog(l);
                    return (
                      p &&
                      (String(p.args.from).toLowerCase() === wallet ||
                        String(p.args.to).toLowerCase() === wallet)
                    );
                  } catch {
                    return false;
                  }
                })
              ) {
                complete = false;
                continue;
              }
              const parsed = transfers.parseLog(log)!;
              const fromAddr = String(parsed.args.from).toLowerCase(),
                toAddr = String(parsed.args.to).toLowerCase();
              if (fromAddr === wallet && toAddr === wallet) continue;
              const sign = toAddr === wallet ? 1n : -1n;
              const old = sums.get(log.transactionHash) ?? {
                amount: 0n,
                at: log.blockNumber,
              };
              old.amount += sign * BigInt(parsed.args.value);
              sums.set(log.transactionHash, old);
            }
          }
      }
      for (const [hash, flow] of sums) {
        if (flow.amount === 0n) continue;
        const mined = await this.provider().getBlock(flow.at);
        if (!mined) {
          complete = false;
          continue;
        }
        flows.push({
          id: `poly_flow_${fingerprint(hash).slice(0, 32)}`,
          amount_usdc: D(flow.amount.toString()).div(1e6).toString(),
          at: mined.timestamp * 1000,
        });
      }
    }
    return { fills, flows, orders, complete };
  }
  async release(user: string, p: Portfolio) {
    await this.core("prediction_release", {
      user_id: user,
      portfolio_id: p.id,
      revision: p.revision,
    });
  }
  async fence(user: string, p: Portfolio) {
    await this.core(
      p.loss_latched ? "prediction_fence" : "prediction_activate",
      { user_id: user, portfolio_id: p.id, revision: p.revision },
    );
  }
  async submitPayload(user: string, p: Portfolio, e: Execution) {
    const snap = await this.account(user, p);
    const current = D(snap.positions[e.key] ?? 0),
      target = D(e.target_quantity),
      delta = target.minus(current);
    if (delta.isZero())
      throw new AgentError(
        "EXECUTION_REJECTED",
        "Prediction target already matches owned inventory.",
      );
    if (delta.gt(0) && (!snap.coverage_complete || p.loss_latched))
      throw new AgentError(
        "EXECUTION_REJECTED",
        "Unsettled accounting blocks new prediction risk.",
      );
    const ref = await this.outcome(e.key),
      book = await this.book(ref.token_id);
    const price = delta.gt(0)
      ? D.min(...book.asks.map((x: any) => D(x.price)))
      : D.max(...book.bids.map((x: any) => D(x.price)));
    let anchor = price;
    if (delta.gt(0)) {
      for (const s of p.sleeves.filter((s) => s.intents[e.key])) {
        const intent = s.intents[e.key];
        if (
          !fresh(intent.observed_at) ||
          price.minus(intent.price).abs().div(intent.price).gt(".002")
        )
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Prediction entry exceeds the frozen 0.2% price boundary.",
          );
        anchor = D.min(anchor, D(intent.price));
        const source = await this.source(s.trader.id);
        if (source.revision !== s.source_revision)
          throw new AgentError(
            "EXECUTION_REJECTED",
            "Prediction source changed before execution.",
          );
      }
    }
    if (delta.abs().lt(book.min_order_size))
      throw new AgentError(
        "EXECUTION_REJECTED",
        "Prediction target is below the venue minimum share size.",
      );
    return {
      user_id: user,
      portfolio_id: p.id,
      task_id: e.id.slice("execution_".length),
      revision: p.revision,
      token_id: ref.token_id,
      condition_id: ref.condition_id,
      side: delta.gt(0) ? "BUY" : "SELL",
      size: delta.abs().toString(),
      price: anchor.toString(),
      slippage_bps: delta.gt(0) ? 20 : 1000,
    };
  }
  async execution(user: string, p: Portfolio, e: Execution, task: string) {
    const r = await this.core("prediction_execution", {
      user_id: user,
      portfolio_id: p.id,
      task_id: task,
    });
    const snap = await this.account(user, p);
    let settled: any;
    try {
      settled = JSON.parse(r.response ?? "{}").agent_settlement;
    } catch {}
    const done = settled?.complete && snap.coverage_complete;
    return {
      task_id: task,
      status: done
        ? ("completed" as const)
        : r.status === 6
          ? ("failed" as const)
          : D(r.filled_size).gt(0)
            ? ("partially_filled" as const)
            : ("submitted" as const),
      observed_quantity: snap.positions[e.key] ?? "0",
      settled: !!done,
    };
  }
}
