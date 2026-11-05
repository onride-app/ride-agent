import { createHash } from "node:crypto";
import { Interface, zeroPadValue } from "ethers";
import { InventoryFileStore } from "./prediction_inventory_store.js";

// Primary sources checked 2026-11-06. These are outcome ledgers, not a NAV or
// complete wallet-asset universe. Genesis origin avoids an unverified start block.
export const PREDICTION_INVENTORY_SCOPE = {
  chain_id: 137,
  version: "polymarket-published-position-ledgers-2026-11-06",
  sources: [
    "https://docs.polymarket.com/resources/contracts",
    "https://docs.polymarket.com/resources/onchain-position-data",
  ],
  ledgers: [
    {
      kind: "ctf",
      address: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
      origin_block: 0,
    },
    {
      kind: "position_manager",
      address: "0x006f54f7f9a22e0000cc2ab60031000000ae9fef",
      origin_block: 0,
    },
  ],
} as const;
for (const ledger of PREDICTION_INVENTORY_SCOPE.ledgers) Object.freeze(ledger);
Object.freeze(PREDICTION_INVENTORY_SCOPE.ledgers);
Object.freeze(PREDICTION_INVENTORY_SCOPE.sources);
Object.freeze(PREDICTION_INVENTORY_SCOPE);
const abi = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
  "function balanceOfBatch(address[] owners,uint256[] ids) view returns(uint256[])",
]);
const topics = [
  abi.getEvent("TransferSingle")!.topicHash,
  abi.getEvent("TransferBatch")!.topicHash,
];
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scopeDigest = digest(PREDICTION_INVENTORY_SCOPE);
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
const address = (v: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v);
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const uint = (v: unknown): v is string =>
  typeof v === "string" &&
  /^(0|[1-9][0-9]{0,77})$/.test(v) &&
  BigInt(v) < 1n << 256n;
const hex = (v: number) => "0x" + v.toString(16);
const quantity = (v: any): number => {
  if (
    typeof v !== "string" ||
    !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v) ||
    !Number.isSafeInteger(Number(BigInt(v)))
  )
    fail("RPC_SHAPE_INVALID");
  return Number(BigInt(v));
};
export class InventoryProofError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new InventoryProofError(code);
}
export interface InventoryRpc {
  request(method: string, params: unknown[], signal: AbortSignal): Promise<any>;
}
export interface InventoryProviderPolicy {
  id: string;
  // Explicit operator-reviewed provider contract, never inferred from an HTTP200.
  get_logs_semantics: "complete_or_error";
  historical_logs: "genesis_to_finalized_complete_or_error";
  documentation: string;
  max_logs: number;
  max_block_range: number;
  eip1898: true;
}
interface Block {
  number: number;
  hash: string;
  timestamp: number;
}
interface LedgerProgress {
  address: string;
  next_block: number;
  window_span: number;
  anchor: { number: number; hash: string } | null;
  token_ids: string[];
  balances: string[];
}
export interface InventoryCheckpoint {
  version: 1;
  revision: number;
  owner: string;
  chain_id: 137;
  scope_digest: string;
  provider_policy_digest: string;
  target: Block;
  ledgers: LedgerProgress[];
}
export interface InventoryProof {
  owner: string;
  chain_id: 137;
  block: Block;
  scope: typeof PREDICTION_INVENTORY_SCOPE;
  inventory_complete: true;
  valuation_complete: false;
  prediction_execution_ready: false;
  holdings: { ledger: string; token_id: string; raw_balance: string }[];
}
export interface InventoryBudget {
  max_rpc_calls?: number;
  max_duration_ms?: number;
  max_token_ids?: number;
  balance_batch?: number;
}
function policyDigest(p: InventoryProviderPolicy) {
  let url: URL;
  try {
    url = new URL(p.documentation);
  } catch {
    return fail("PROVIDER_CONTRACT_REQUIRED");
  }
  if (
    !/^[a-zA-Z0-9._-]{1,64}$/.test(p.id) ||
    p.get_logs_semantics !== "complete_or_error" ||
    p.historical_logs !== "genesis_to_finalized_complete_or_error" ||
    p.eip1898 !== true ||
    !integer(p.max_logs) ||
    p.max_logs < 2 ||
    p.max_logs > 100_000 ||
    !integer(p.max_block_range) ||
    p.max_block_range < 1 ||
    p.max_block_range > 100_000 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("PROVIDER_CONTRACT_REQUIRED");
  return digest({
    id: p.id,
    get_logs_semantics: p.get_logs_semantics,
    historical_logs: p.historical_logs,
    documentation: p.documentation,
    max_logs: p.max_logs,
    max_block_range: p.max_block_range,
    eip1898: p.eip1898,
  });
}
export class PredictionInventoryReader {
  private policyHash: string;
  private limits: Required<InventoryBudget>;
  constructor(
    private store: InventoryFileStore<InventoryCheckpoint>,
    private rpc: InventoryRpc,
    private policy: InventoryProviderPolicy,
    budget: InventoryBudget = {},
  ) {
    this.policyHash = policyDigest(policy);
    this.policy = structuredClone(policy);
    this.limits = {
      max_rpc_calls: 40,
      max_duration_ms: 25_000,
      max_token_ids: 20_000,
      balance_batch: 50,
      ...budget,
    };
    const l = this.limits;
    if (
      !integer(l.max_rpc_calls) ||
      l.max_rpc_calls < 12 ||
      l.max_rpc_calls > 100 ||
      !integer(l.max_duration_ms) ||
      l.max_duration_ms < 1 ||
      l.max_duration_ms > 55_000 ||
      !integer(l.max_token_ids) ||
      l.max_token_ids < 1 ||
      l.max_token_ids > 100_000 ||
      !integer(l.balance_batch) ||
      l.balance_batch < 1 ||
      l.balance_batch > 100
    )
      fail("BUDGET_INVALID");
  }
  private gate() {
    let calls = 0;
    const deadline = Date.now() + this.limits.max_duration_ms;
    const call = async (method: string, params: unknown[]) => {
      if (++calls > this.limits.max_rpc_calls || Date.now() >= deadline)
        fail("INVENTORY_BUDGET_EXHAUSTED");
      const remaining = deadline - Date.now(),
        signal = AbortSignal.timeout(Math.max(1, remaining));
      // Enforce the bound even when a custom RPC ignores AbortSignal.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          this.rpc.request(method, params, signal),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(new InventoryProofError("INVENTORY_BUDGET_EXHAUSTED")),
              remaining,
            );
          }),
        ]);
      } catch (error) {
        if (error instanceof InventoryProofError) throw error;
        fail("INVENTORY_RPC_UNAVAILABLE");
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    return Object.assign(call, {
      remaining: () => this.limits.max_rpc_calls - calls,
    });
  }
  private async block(
    call: ReturnType<PredictionInventoryReader["gate"]>,
    tag: string,
  ): Promise<Block> {
    const b = await call("eth_getBlockByNumber", [tag, false]);
    if (!b || !hash(b.hash)) fail("RPC_BLOCK_INVALID");
    return {
      number: quantity(b.number),
      hash: b.hash.toLowerCase(),
      timestamp: quantity(b.timestamp),
    };
  }
  private validate(s: InventoryCheckpoint, owner: string) {
    if (
      !address(owner) ||
      s.version !== 1 ||
      s.owner !== owner.toLowerCase() ||
      s.chain_id !== 137 ||
      s.scope_digest !== scopeDigest ||
      s.provider_policy_digest !== this.policyHash ||
      !integer(s.revision) ||
      s.revision < 1 ||
      !integer(s.target?.number) ||
      !hash(s.target?.hash) ||
      !integer(s.target?.timestamp) ||
      s.target.timestamp === 0 ||
      s.ledgers?.length !== PREDICTION_INVENTORY_SCOPE.ledgers.length
    )
      fail("CHECKPOINT_BINDING_INVALID");
    for (let i = 0; i < s.ledgers.length; i++) {
      const l = s.ledgers[i];
      if (
        l.address !== PREDICTION_INVENTORY_SCOPE.ledgers[i].address ||
        !integer(l.next_block) ||
        l.next_block > s.target.number + 1 ||
        !integer(l.window_span) ||
        l.window_span < 1 ||
        l.window_span > this.policy.max_block_range ||
        !Array.isArray(l.token_ids) ||
        l.token_ids.length > this.limits.max_token_ids ||
        l.token_ids.some(
          (id, j) =>
            !uint(id) || (j > 0 && BigInt(id) <= BigInt(l.token_ids[j - 1])),
        ) ||
        !Array.isArray(l.balances) ||
        l.balances.length > l.token_ids.length ||
        l.balances.some((v) => !uint(v)) ||
        (l.balances.length > 0 && l.next_block !== s.target.number + 1) ||
        (l.next_block === 0
          ? l.anchor !== null
          : !l.anchor ||
            l.anchor.number !== l.next_block - 1 ||
            !hash(l.anchor.hash))
      )
        fail("CHECKPOINT_COVERAGE_INVALID");
    }
  }
  private complete(s: InventoryCheckpoint) {
    return s.ledgers.every(
      (l) =>
        l.next_block === s.target.number + 1 &&
        l.balances.length === l.token_ids.length,
    );
  }
  private async canonical(
    call: ReturnType<PredictionInventoryReader["gate"]>,
    s: InventoryCheckpoint,
  ) {
    if (quantity(await call("eth_chainId", [])) !== 137)
      fail("INVENTORY_CHAIN_MISMATCH");
    const head = quantity(await call("eth_blockNumber", []));
    if (s.target.number > head - 128) fail("INVENTORY_NOT_FINAL");
    if ((await this.block(call, hex(s.target.number))).hash !== s.target.hash)
      fail("INVENTORY_REORG");
    for (const l of s.ledgers)
      if (
        l.anchor &&
        (await this.block(call, hex(l.anchor.number))).hash !== l.anchor.hash
      )
        fail("INVENTORY_REORG");
  }
  private async target(call: ReturnType<PredictionInventoryReader["gate"]>) {
    if (quantity(await call("eth_chainId", [])) !== 137)
      fail("INVENTORY_CHAIN_MISMATCH");
    const b = await this.block(call, "finalized"),
      head = quantity(await call("eth_blockNumber", []));
    if (
      b.number > head - 128 ||
      b.timestamp <= 0 ||
      b.timestamp > Date.now() / 1000 + 30
    )
      fail("INVENTORY_NOT_FINAL");
    for (const l of PREDICTION_INVENTORY_SCOPE.ledgers) {
      const code = await call("eth_getCode", [
        l.address,
        { blockHash: b.hash, requireCanonical: true },
      ]);
      if (
        typeof code !== "string" ||
        !/^0x[0-9a-f]+$/i.test(code) ||
        code === "0x0"
      )
        fail("INVENTORY_SCOPE_UNAVAILABLE");
    }
    return b;
  }
  // Exactly one contiguous window (both directions) or one balance batch per
  // transaction. No v2 positions/ledger seeds, imported high-water marks or flags.
  async advance(owner: string): Promise<InventoryCheckpoint> {
    if (!address(owner)) fail("INVENTORY_OWNER_INVALID");
    owner = owner.toLowerCase();
    const call = this.gate();
    return this.store.transaction(async (previous) => {
      if (!previous)
        return {
          version: 1,
          revision: 1,
          owner,
          chain_id: 137,
          scope_digest: scopeDigest,
          provider_policy_digest: this.policyHash,
          target: await this.target(call),
          ledgers: PREDICTION_INVENTORY_SCOPE.ledgers.map((l) => ({
            address: l.address,
            next_block: 0,
            window_span: this.policy.max_block_range,
            anchor: null,
            token_ids: [],
            balances: [],
          })),
        };
      this.validate(previous, owner);
      const s: InventoryCheckpoint = structuredClone(previous);
      await this.canonical(call, s);
      if (this.complete(s)) {
        const target = await this.target(call);
        if (
          target.number < s.target.number ||
          (target.number === s.target.number && target.hash !== s.target.hash)
        )
          fail("INVENTORY_REORG");
        if (target.number > s.target.number) {
          s.target = target;
          for (const l of s.ledgers) l.balances = [];
        }
      } else {
        const l = s.ledgers.find((l) => l.next_block <= s.target.number);
        if (l) await this.window(call, s, l);
        else {
          const balance = s.ledgers.find(
            (l) => l.balances.length < l.token_ids.length,
          );
          if (!balance) fail("CHECKPOINT_COVERAGE_INVALID");
          const ids = balance.token_ids.slice(
            balance.balances.length,
            balance.balances.length + this.limits.balance_batch,
          );
          const raw = await call("eth_call", [
            {
              to: balance.address,
              data: abi.encodeFunctionData("balanceOfBatch", [
                ids.map(() => owner),
                ids,
              ]),
            },
            { blockHash: s.target.hash, requireCanonical: true },
          ]);
          let values: string[];
          try {
            values = Array.from(
              abi.decodeFunctionResult("balanceOfBatch", raw)[0],
              (v: any) => BigInt(v).toString(),
            );
          } catch {
            return fail("INVENTORY_BALANCE_INVALID");
          }
          if (values.length !== ids.length || values.some((v) => !uint(v)))
            fail("INVENTORY_BALANCE_INVALID");
          balance.balances.push(...values);
        }
      }
      if ((await this.block(call, hex(s.target.number))).hash !== s.target.hash)
        fail("INVENTORY_REORG");
      s.revision++;
      this.validate(s, owner);
      return s;
    });
  }
  private async window(
    call: ReturnType<PredictionInventoryReader["gate"]>,
    s: InventoryCheckpoint,
    l: LedgerProgress,
  ) {
    const from = l.next_block,
      end = Math.min(s.target.number, from + l.window_span - 1);
    const before = await this.block(call, hex(end));
    const owner = zeroPadValue(s.owner, 32);
    const ids = new Set(l.token_ids),
      seen = new Map<string, string>();
    const blocks = new Map<number, string>();
    for (const direction of [2, 3]) {
      const filter: any[] = [topics, null, null, null];
      filter[direction] = owner;
      const logs = await call("eth_getLogs", [
        {
          address: l.address,
          fromBlock: hex(from),
          toBlock: hex(end),
          topics: filter,
        },
      ]);
      if (!Array.isArray(logs)) fail("INVENTORY_LOGS_INVALID");
      if (logs.length >= this.policy.max_logs) {
        if (l.window_span === 1) fail("INVENTORY_SINGLE_BLOCK_CAP");
        l.window_span = Math.max(1, Math.floor(l.window_span / 2));
        return; // Never advance coverage for a possibly capped response.
      }
      for (const log of logs) {
        if (
          !log ||
          log.address?.toLowerCase() !== l.address ||
          log.removed !== false ||
          !hash(log.blockHash) ||
          !hash(log.transactionHash) ||
          !Array.isArray(log.topics) ||
          log.topics.length !== 4 ||
          log.topics.some((t: unknown) => !hash(t)) ||
          log.topics[direction].toLowerCase() !== owner ||
          !topics.includes(log.topics[0])
        )
          fail("INVENTORY_LOGS_INVALID");
        const n = quantity(log.blockNumber),
          index = quantity(log.logIndex);
        quantity(log.transactionIndex);
        if (
          n < from ||
          n > end ||
          (blocks.has(n) && blocks.get(n) !== log.blockHash.toLowerCase())
        )
          fail("INVENTORY_LOGS_INVALID");
        blocks.set(n, log.blockHash.toLowerCase());
        const key = `${n}:${index}`,
          content = digest([
            log.transactionHash.toLowerCase(),
            log.topics,
            log.data,
          ]);
        if (seen.has(key) && seen.get(key) !== content)
          fail("INVENTORY_LOGS_CONFLICT");
        seen.set(key, content);
        try {
          const event = abi.parseLog(log);
          if (!event) throw 0;
          const eventIds: bigint[] =
            event.name === "TransferSingle"
              ? [event.args[3]]
              : Array.from(event.args[3]);
          const values: bigint[] =
            event.name === "TransferSingle"
              ? [event.args[4]]
              : Array.from(event.args[4]);
          if (eventIds.length !== values.length) throw 0;
          for (const id of eventIds) {
            if (!uint(id.toString())) throw 0;
            ids.add(id.toString());
          }
        } catch {
          fail("INVENTORY_LOGS_INVALID");
        }
        if (ids.size > this.limits.max_token_ids) fail("INVENTORY_TOKEN_CAP");
      }
    }
    // Header verification and the final two canonicality checks must also fit.
    // Dense windows below the provider log cap must not retry forever at the
    // same span. Reduce only the future query size; discard this window's IDs.
    if (blocks.size + 2 > call.remaining()) {
      if (l.window_span === 1) fail("INVENTORY_SINGLE_BLOCK_BUDGET");
      l.window_span = Math.max(
        1,
        Math.min(Math.floor(l.window_span / 2), call.remaining() - 2),
      );
      return;
    }
    for (const [number, blockHash] of blocks)
      if ((await this.block(call, hex(number))).hash !== blockHash)
        fail("INVENTORY_REORG");
    if ((await this.block(call, hex(end))).hash !== before.hash)
      fail("INVENTORY_REORG");
    l.token_ids = [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    l.next_block = end + 1;
    l.anchor = { number: end, hash: before.hash };
  }
  // Recovery for a busy window that exceeds the bounded RPC/time/response
  // budget. This changes no claimed coverage or balances and makes no RPC call.
  async narrowWindow(owner: string): Promise<InventoryCheckpoint> {
    return this.store.transaction(async (previous) => {
      if (!previous) fail("INVENTORY_UNAVAILABLE");
      this.validate(previous, owner);
      const s = structuredClone(previous);
      const l = s.ledgers.find((l) => l.next_block <= s.target.number);
      if (!l || l.window_span === 1) fail("INVENTORY_WINDOW_MINIMUM");
      l.window_span = Math.max(1, Math.floor(l.window_span / 2));
      s.revision++;
      return s;
    });
  }
  async read(owner: string, maxAgeSeconds = 600): Promise<InventoryProof> {
    if (!integer(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 600)
      fail("INVENTORY_FRESHNESS_INVALID");
    const s = await this.store.read();
    if (!s) fail("INVENTORY_UNAVAILABLE");
    this.validate(s, owner);
    if (!this.complete(s)) fail("INVENTORY_BACKFILL_INCOMPLETE");
    if (
      s.target.timestamp > Date.now() / 1000 + 30 ||
      Date.now() / 1000 - s.target.timestamp > maxAgeSeconds
    )
      fail("INVENTORY_STALE");
    await this.canonical(this.gate(), s);
    return {
      owner: s.owner,
      chain_id: 137,
      block: s.target,
      scope: PREDICTION_INVENTORY_SCOPE,
      inventory_complete: true,
      valuation_complete: false,
      prediction_execution_ready: false,
      holdings: s.ledgers.flatMap((l) =>
        l.token_ids.flatMap((id, i) =>
          l.balances[i] === "0"
            ? []
            : [{ ledger: l.address, token_id: id, raw_balance: l.balances[i] }],
        ),
      ),
    };
  }
}

// Only read methods. Do not use ethers provider batching/retries or expose RPC
// error objects (which can contain credential-bearing endpoint URLs).
export function inventoryHttpRpc(endpoint: string): InventoryRpc {
  const allowed = new Set([
    "eth_chainId",
    "eth_blockNumber",
    "eth_getBlockByNumber",
    "eth_getCode",
    "eth_getLogs",
    "eth_call",
  ]);
  let id = 0;
  return {
    async request(method, params, signal) {
      if (!allowed.has(method)) fail("INVENTORY_RPC_METHOD_FORBIDDEN");
      const requestId = ++id;
      let response: Response, payload: any;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method,
            params,
          }),
          signal,
        });
        if (Number(response.headers.get("content-length")) > 8 * 1024 * 1024)
          fail("INVENTORY_RPC_RESPONSE_CAP");
        const body = response.body?.getReader();
        if (!body) fail("INVENTORY_RPC_UNAVAILABLE");
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for (;;) {
            const next = await body.read();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > 8 * 1024 * 1024) fail("INVENTORY_RPC_RESPONSE_CAP");
            chunks.push(next.value);
          }
        } finally {
          await body.cancel().catch(() => {});
        }
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch (error) {
        if (error instanceof InventoryProofError) throw error;
        return fail("INVENTORY_RPC_UNAVAILABLE");
      }
      if (
        !response.ok ||
        payload?.jsonrpc !== "2.0" ||
        payload?.id !== requestId ||
        payload?.error ||
        !Object.hasOwn(payload, "result")
      )
        fail("INVENTORY_RPC_UNAVAILABLE");
      return payload.result;
    },
  };
}
