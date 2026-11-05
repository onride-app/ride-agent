import assert from "node:assert/strict";
import { it } from "node:test";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  chmod,
} from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Interface } from "ethers";
import { InventoryFileStore } from "./prediction_inventory_store.js";
import {
  PredictionInventoryReader,
  PREDICTION_INVENTORY_SCOPE,
  inventoryHttpRpc,
  type InventoryCheckpoint,
  type InventoryProviderPolicy,
  type InventoryRpc,
} from "./prediction_inventory.js";
import { predictionInventoryCommand } from "../cli/prediction-inventory.js";

const owner = "0x" + "a".repeat(40),
  other = "0x" + "b".repeat(40),
  zero = "0x" + "0".repeat(40);
const abi = new Interface([
  "event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)",
  "event TransferBatch(address indexed operator,address indexed from,address indexed to,uint256[] ids,uint256[] values)",
  "function balanceOfBatch(address[] owners,uint256[] ids) view returns(uint256[])",
]);
const blockHash = (n: number) => "0x" + (n + 1).toString(16).padStart(64, "0");
const hex = (n: number) => "0x" + n.toString(16);
const policy: InventoryProviderPolicy = {
  id: "fixture-complete-rpc",
  documentation: "https://rpc.example/eth_getLogs",
  get_logs_semantics: "complete_or_error",
  historical_logs: "genesis_to_finalized_complete_or_error",
  max_logs: 10,
  max_block_range: 2,
  eip1898: true,
};
function log(
  n: number,
  index: number,
  from: string,
  to: string,
  ids: bigint[],
  ledger = 0,
): any {
  const event = ids.length === 1 ? "TransferSingle" : "TransferBatch";
  const encoded = abi.encodeEventLog(abi.getEvent(event)!, [
    other,
    from,
    to,
    ids.length === 1 ? ids[0] : ids,
    ids.length === 1 ? 1n : ids.map(() => 1n),
  ]);
  return {
    ...encoded,
    address: PREDICTION_INVENTORY_SCOPE.ledgers[ledger].address,
    blockNumber: hex(n),
    blockHash: blockHash(n),
    transactionHash: blockHash(50 + index),
    transactionIndex: "0x0",
    logIndex: hex(index),
    removed: false,
  };
}
class Rpc implements InventoryRpc {
  target = 2;
  timestamp = Math.floor(Date.now() / 1000);
  chain = 137;
  changed = new Map<number, string>();
  logs: any[] = [];
  calls: { method: string; params: any[] }[] = [];
  patch?: (method: string, params: any[]) => any;
  async request(method: string, params: any[]) {
    this.calls.push({ method, params });
    const replacement = this.patch?.(method, params);
    if (replacement !== undefined) return replacement;
    if (method === "eth_chainId") return hex(this.chain);
    if (method === "eth_blockNumber") return hex(this.target + 200);
    if (method === "eth_getCode") return "0x6001";
    if (method === "eth_getBlockByNumber") {
      const number =
        params[0] === "finalized" ? this.target : Number(BigInt(params[0]));
      return {
        number: hex(number),
        hash: this.changed.get(number) ?? blockHash(number),
        timestamp: hex(this.timestamp),
      };
    }
    if (method === "eth_getLogs") {
      const q = params[0];
      return this.logs.filter(
        (l) =>
          l.address === q.address &&
          Number(BigInt(l.blockNumber)) >= Number(BigInt(q.fromBlock)) &&
          Number(BigInt(l.blockNumber)) <= Number(BigInt(q.toBlock)) &&
          l.topics.some(
            (topic: string, i: number) => i > 1 && q.topics[i] === topic,
          ),
      );
    }
    if (method === "eth_call") {
      assert.deepEqual(params[1], {
        blockHash: blockHash(this.target),
        requireCanonical: true,
      });
      const decoded = abi.decodeFunctionData("balanceOfBatch", params[0].data);
      assert(decoded[0].every((o: string) => o.toLowerCase() === owner));
      return abi.encodeFunctionResult("balanceOfBatch", [
        decoded[1].map((id: bigint) => (id === 2n ? 0n : 3n)),
      ]);
    }
    throw new Error("unsupported fixture method");
  }
}
async function setup(
  run: (f: {
    reader: PredictionInventoryReader;
    rpc: Rpc;
    store: InventoryFileStore<InventoryCheckpoint>;
    path: string;
  }) => Promise<void>,
  p = policy,
  limits = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "rider-inventory-")),
    path = join(dir, "checkpoint.json"),
    rpc = new Rpc();
  const store = new InventoryFileStore<InventoryCheckpoint>(path),
    reader = new PredictionInventoryReader(store, rpc, p, limits);
  try {
    await run({ reader, rpc, store, path });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function finish(reader: PredictionInventoryReader) {
  for (let i = 0; i < 20; i++) {
    const s = await reader.advance(owner);
    if (
      s.ledgers.every(
        (l) =>
          l.next_block === s.target.number + 1 &&
          l.balances.length === l.token_ids.length,
      )
    )
      return s;
  }
  throw new Error("fixture did not finish");
}
it("resumes genesis scans over both actual ledgers, mint/burn/batch/self transfers and pinned balances without claiming valuation", async () =>
  setup(async ({ reader, rpc, store, path }) => {
    rpc.logs = [
      log(0, 0, zero, owner, [1n]),
      log(1, 1, owner, zero, [2n]),
      log(1, 2, owner, owner, [3n, 4n]),
      log(2, 3, other, owner, [5n], 1),
    ];
    const initial = await reader.advance(owner);
    assert.deepEqual(
      initial.ledgers.map((l) => l.next_block),
      [0, 0],
    );
    await assert.rejects(reader.read(owner), {
      code: "INVENTORY_BACKFILL_INCOMPLETE",
    });
    const state = await finish(reader);
    assert.deepEqual(
      state.ledgers.map((l) => l.token_ids),
      [["1", "2", "3", "4"], ["5"]],
    );
    const resumed = new PredictionInventoryReader(
      new InventoryFileStore<InventoryCheckpoint>(path),
      rpc,
      policy,
    );
    const proof = await resumed.read(owner);
    assert.equal(proof.holdings.length, 4);
    assert.equal(proof.inventory_complete, true);
    assert.equal(proof.valuation_complete, false);
    assert.equal(proof.prediction_execution_ready, false);
    assert(
      proof.holdings.some(
        (h) => h.ledger === PREDICTION_INVENTORY_SCOPE.ledgers[1].address,
      ),
    );
    assert((await store.read())!.revision > initial.revision);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(path + ".key")).mode & 0o777, 0o600);
    assert(
      rpc.calls
        .filter((c) => c.method === "eth_getLogs")
        .every(
          (c) =>
            c.params[0].fromBlock === "0x0" || c.params[0].fromBlock === "0x2",
        ),
    );
  }));
it("empty terminal upstream/known-ledger data cannot seed coverage; actual empty scans prove only the fixed ledger scope", async () =>
  setup(async ({ reader }) => {
    await assert.rejects(reader.read(owner), { code: "INVENTORY_UNAVAILABLE" });
    await finish(reader);
    const proof = await reader.read(owner);
    assert.deepEqual(proof.holdings, []);
    assert.equal(proof.valuation_complete, false);
    assert.equal(proof.scope.ledgers.length, 2);
  }));
it("cap shrinks range without advancing, and a capped single block never advances", async () =>
  setup(async ({ reader, rpc, store }) => {
    await reader.advance(owner);
    rpc.patch = (method) =>
      method === "eth_getLogs" ? Array(10).fill({}) : undefined;
    const shrunk = await reader.advance(owner);
    assert.equal(shrunk.ledgers[0].next_block, 0);
    assert.equal(shrunk.ledgers[0].window_span, 1);
    await assert.rejects(reader.advance(owner), {
      code: "INVENTORY_SINGLE_BLOCK_CAP",
    });
    assert.equal((await store.read())!.revision, shrunk.revision);
  }));
for (const kind of [
  "foreign address",
  "removed log",
  "out of range",
  "foreign owner",
  "conflicting duplicate",
  "log reorg",
  "malformed batch",
] as const) {
  it(`does not persist coverage on ${kind}`, async () =>
    setup(async ({ reader, rpc, store }) => {
      await reader.advance(owner);
      const original = log(0, 0, zero, owner, [1n]);
      let rows = [structuredClone(original)];
      if (kind === "foreign address") rows[0].address = other;
      if (kind === "removed log") rows[0].removed = true;
      if (kind === "out of range") rows[0].blockNumber = "0x2";
      if (kind === "foreign owner") rows = [log(0, 0, zero, other, [1n])];
      if (kind === "conflicting duplicate")
        rows.push(log(0, 0, zero, owner, [2n]));
      if (kind === "log reorg") rows[0].blockHash = blockHash(999);
      if (kind === "malformed batch") {
        rows = [log(0, 0, zero, owner, [1n, 2n])];
        rows[0].data = "0x";
      }
      rpc.patch = (method, params) =>
        method === "eth_getLogs" && params[0].topics[3] ? rows : undefined;
      await assert.rejects(reader.advance(owner));
      assert.equal((await store.read())!.revision, 1);
    }));
}
it("rejects owner/chain/provider binding mismatches, reorgs and stale proofs", async () =>
  setup(async ({ reader, rpc, store }) => {
    await finish(reader);
    await assert.rejects(reader.read(other), {
      code: "CHECKPOINT_BINDING_INVALID",
    });
    const otherProvider = new PredictionInventoryReader(store, rpc, {
      ...policy,
      id: "different-provider",
    });
    await assert.rejects(otherProvider.read(owner), {
      code: "CHECKPOINT_BINDING_INVALID",
    });
    rpc.chain = 1;
    await assert.rejects(reader.read(owner), {
      code: "INVENTORY_CHAIN_MISMATCH",
    });
    rpc.chain = 137;
    rpc.changed.set(2, blockHash(222));
    await assert.rejects(reader.read(owner), { code: "INVENTORY_REORG" });
    rpc.changed.clear();
    await assert.rejects(reader.read(owner, 0), {
      code: "INVENTORY_FRESHNESS_INVALID",
    });
    await assert.rejects(reader.read(owner, 601), {
      code: "INVENTORY_FRESHNESS_INVALID",
    });
  }));
it("rolls forward only from authenticated complete coverage, rechecks all balances and stays incomplete while catching up", async () =>
  setup(async ({ reader, rpc }) => {
    rpc.logs = [log(0, 0, zero, owner, [1n])];
    await finish(reader);
    rpc.target = 4;
    const changed = await reader.advance(owner);
    assert.equal(changed.target.number, 4);
    assert.equal(changed.ledgers[0].next_block, 3);
    assert.deepEqual(changed.ledgers[0].balances, []);
    await assert.rejects(reader.read(owner), {
      code: "INVENTORY_BACKFILL_INCOMPLETE",
    });
    await finish(reader);
    assert.equal((await reader.read(owner)).block.number, 4);
  }));
it("authenticated files cannot be edited/imported as a complete checkpoint", async () =>
  setup(async ({ reader, path }) => {
    await reader.advance(owner);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    const payload = JSON.parse(envelope.payload);
    payload.ledgers.forEach(
      (l: any) => (l.next_block = payload.target.number + 1),
    );
    envelope.payload = JSON.stringify(payload);
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(reader.read(owner), { code: "CHECKPOINT_UNTRUSTED" });
  }));
it("concurrent producers fail closed rather than overwrite a checkpoint", async () =>
  setup(async ({ store, reader }) => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      waiting = new Promise<void>((r) => (release = r));
    const transaction = store.transaction(async () => {
      entered();
      await waiting;
      throw new Error("fixture stop");
    });
    await started;
    await assert.rejects(reader.advance(owner), { code: "CHECKPOINT_BUSY" });
    release();
    await assert.rejects(transaction, /fixture stop/);
    await reader.advance(owner);
  }));
it("budget deadlines are enforced even for a noncooperative custom RPC", async () =>
  setup(
    async ({ reader, rpc }) => {
      rpc.patch = () => new Promise(() => {});
      await assert.rejects(reader.advance(owner), {
        code: "INVENTORY_BUDGET_EXHAUSTED",
      });
    },
    policy,
    { max_duration_ms: 15 },
  ));
it("RPC/provider contracts and optional operator entry point are default-protected", async () => {
  await assert.rejects(predictionInventoryCommand("advance", {}), {
    code: "INVENTORY_PROOF_DISABLED",
  });
  for (const patch of [
    { get_logs_semantics: "paginated" },
    { historical_logs: "pruned" },
    { eip1898: false },
    { max_logs: 0 },
    { documentation: "https://rpc.example/docs?key=secret" },
  ]) {
    assert.throws(
      () =>
        new PredictionInventoryReader(
          new InventoryFileStore("unused"),
          new Rpc(),
          { ...policy, ...patch } as any,
        ),
      { code: "PROVIDER_CONTRACT_REQUIRED" },
    );
  }
});

it("an expired complete scan stays unknown until roll-forward; scanning is not a fresh accounting anchor", async () =>
  setup(async ({ reader, rpc }) => {
    rpc.timestamp -= 1000;
    await finish(reader);
    await assert.rejects(reader.read(owner), { code: "INVENTORY_STALE" });
  }));
it("a failed outgoing/incoming half never persists the other half", async () =>
  setup(async ({ reader, rpc, store }) => {
    await reader.advance(owner);
    rpc.logs = [log(0, 0, owner, zero, [1n])];
    rpc.patch = (method, params) => {
      if (method === "eth_getLogs" && params[0].topics[3])
        throw new Error("private provider URL must not escape");
    };
    await assert.rejects(reader.advance(owner), {
      code: "INVENTORY_RPC_UNAVAILABLE",
    });
    assert.equal((await store.read())!.revision, 1);
    assert.deepEqual((await store.read())!.ledgers[0].token_ids, []);
  }));
it("malformed same-block batch balances cannot make a scan consumable", async () =>
  setup(async ({ reader, rpc, store }) => {
    rpc.logs = [log(0, 0, zero, owner, [1n])];
    let state = await reader.advance(owner);
    while (state.ledgers.some((l) => l.next_block <= state.target.number))
      state = await reader.advance(owner);
    rpc.patch = (method) =>
      method === "eth_call"
        ? abi.encodeFunctionResult("balanceOfBatch", [[]])
        : undefined;
    await assert.rejects(reader.advance(owner), {
      code: "INVENTORY_BALANCE_INVALID",
    });
    assert.equal((await store.read())!.revision, state.revision);
    await assert.rejects(reader.read(owner), {
      code: "INVENTORY_BACKFILL_INCOMPLETE",
    });
  }));
it("oversized token enumeration rolls back, and a window can be narrowed without changing coverage", async () =>
  setup(
    async ({ reader, rpc, store }) => {
      await reader.advance(owner);
      rpc.logs = [log(0, 0, zero, owner, [1n, 2n])];
      await assert.rejects(reader.advance(owner), {
        code: "INVENTORY_TOKEN_CAP",
      });
      const before = (await store.read())!,
        count = rpc.calls.length;
      const after = await reader.narrowWindow(owner);
      assert.equal(rpc.calls.length, count);
      assert.deepEqual(
        after.ledgers.map((l) => l.next_block),
        before.ledgers.map((l) => l.next_block),
      );
      assert.equal(after.ledgers[0].window_span, 1);
    },
    policy,
    { max_token_ids: 1 },
  ));
it("checkpoint CAS checks contents even if another trusted writer reused the revision", async () =>
  setup(async ({ reader, store, path }) => {
    await reader.advance(owner);
    await assert.rejects(
      store.transaction(async (old) => {
        const replacement = structuredClone(old!);
        replacement.ledgers[0].window_span = 1;
        const payload = JSON.stringify(replacement),
          key = Buffer.from(await readFile(path + ".key", "utf8"), "hex");
        await writeFile(
          path,
          JSON.stringify({
            payload,
            mac: createHmac("sha256", key).update(payload).digest("hex"),
          }),
        );
        return { ...old!, revision: old!.revision + 1 };
      }),
      { code: "CHECKPOINT_CAS_FAILED" },
    );
    assert.equal((await store.read())!.revision, 1);
  }));
it("broad key permissions are refused", async () =>
  setup(async ({ reader, path }) => {
    await reader.advance(owner);
    await chmod(path + ".key", 0o644);
    await assert.rejects(reader.read(owner), {
      code: "CHECKPOINT_FILE_UNSAFE",
    });
  }));
it("HTTP adapter permits only read calls and strips upstream secrets and oversized responses", async () => {
  const original = globalThis.fetch;
  const rpc = inventoryHttpRpc("https://rpc.example/private-token");
  try {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        error: { message: "private-token secret-wallet" },
      });
    }) as typeof fetch;
    await assert.rejects(
      rpc.request("eth_sendRawTransaction", [], AbortSignal.timeout(1000)),
      { code: "INVENTORY_RPC_METHOD_FORBIDDEN" },
    );
    assert.equal(calls, 0);
    await assert.rejects(
      rpc.request("eth_chainId", [], AbortSignal.timeout(1000)),
      (error) =>
        !String(error).includes("private-token") &&
        !String(error).includes("secret-wallet"),
    );
    globalThis.fetch = (async () =>
      new Response("x".repeat(8 * 1024 * 1024 + 1))) as typeof fetch;
    await assert.rejects(
      rpc.request("eth_getLogs", [], AbortSignal.timeout(1000)),
      { code: "INVENTORY_RPC_RESPONSE_CAP" },
    );
  } finally {
    globalThis.fetch = original;
  }
});

it("dense windows below the log cap automatically narrow within the header budget and resume", async () =>
  setup(
    async ({ reader, rpc, store }) => {
      rpc.target = 49;
      rpc.logs = Array.from({ length: 50 }, (_, n) =>
        log(n, n, zero, owner, [BigInt(n + 1)]),
      );
      await reader.advance(owner);
      const narrow = await reader.advance(owner);
      assert.equal(narrow.ledgers[0].next_block, 0);
      assert(narrow.ledgers[0].window_span < 50);
      assert.deepEqual(narrow.ledgers[0].token_ids, []);
      await finish(reader);
      assert.equal((await store.read())!.ledgers[0].token_ids.length, 50);
      assert.equal((await reader.read(owner)).inventory_complete, true);
    },
    { ...policy, max_block_range: 50, max_logs: 1000 },
  ));
it("a write larger than the read cap fails before replacing the previous checkpoint", async () =>
  setup(async ({ path }) => {
    const store = new InventoryFileStore<{
      revision: number;
      padding?: string;
    }>(path);
    await store.transaction(async () => ({ revision: 1 }));
    await assert.rejects(
      store.transaction(async () => ({
        revision: 2,
        padding: "x".repeat(16 * 1024 * 1024),
      })),
      { code: "CHECKPOINT_SIZE_CAP" },
    );
    assert.deepEqual(await store.read(), { revision: 1 });
  }));
