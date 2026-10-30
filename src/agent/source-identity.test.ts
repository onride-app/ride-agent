import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { BridgeAdapter } from "./adapter.js";
import { candidate } from "./fixtures.js";

const salt = "source-identity-fixture-salt-32-characters";
const address = "0x" + "1".repeat(40);
const otherAddress = "0x" + "2".repeat(40);
const id = (wallet: string) =>
  "trader_" +
  createHash("sha256")
    .update(`${salt}:perps:${wallet}`)
    .digest("hex")
    .slice(0, 32);

function fixture(registry = new Map<string, any>()) {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://127.0.0.1:1/unused",
    salt,
    "mainnet",
  );
  const stub = bridge as any;
  const reads: string[] = [];
  stub.pool.query = async (sql: string, params: any[] = []) => {
    if (sql.startsWith("INSERT INTO ride_agent_perps_source_identities")) {
      const [ids, addresses, scopes] = params;
      const rows = ids.flatMap((key: string, i: number) => {
        const previous = registry.get(key);
        if (previous && previous.wallet_address !== addresses[i]) return [];
        const row = {
          trader_id: key,
          wallet_address: addresses[i],
          requires_rwa: previous?.requires_rwa || scopes[i],
        };
        registry.set(key, row);
        return [row];
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("FROM ride_agent_perps_source_identities")) {
      const row = registry.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    throw new Error("Unexpected fixture SQL");
  };
  stub.core = async (operation: string, input: any) => {
    reads.push(operation);
    if (operation === "perps_pool")
      return [
        { address: otherAddress, tags: [], expires_at: Date.now() + 60_000 },
      ];
    if (operation === "perps_source_identities") {
      assert.deepEqual(input, { limit: 500 });
      return {
        identities: [{ address, requires_rwa: false }],
        next_cursor: null,
        complete: true,
      };
    }
    assert.fail("Unexpected Core operation " + operation);
  };
  stub.infoWithEvidence = async (input: any) => {
    assert.equal(input.user, address);
    return {
      value: { marginSummary: { accountValue: "1000" }, assetPositions: [] },
      observed_at: Date.now(),
    };
  };
  return { bridge, stub, reads, registry };
}

it("an original source leaving the fresh recommendation pool resolves the same historical identity, and survives a bridge restart without recycling a score", async () => {
  const f = fixture();
  try {
    const source = await f.bridge.source(id(address));
    assert.equal(source.complete, true);
    assert.ok(source.observed_at > Date.now() - 1000);
    assert.equal(
      f.reads.filter((op) => op === "perps_source_identities").length,
      1,
    );
    await assert.rejects(f.bridge.profile(id(address)), {
      code: "SCORE_UNAVAILABLE",
    });
    assert.equal(f.registry.get(id(address))?.wallet_address, address);
    const restarted = fixture(f.registry);
    try {
      restarted.stub.core = async (op: string) => {
        restarted.reads.push(op);
        if (op === "perps_pool") return [];
        assert.fail(
          "A saved source identity must survive independently of historical enumeration",
        );
      };
      const next = await restarted.bridge.source(id(address));
      assert.equal(next.complete, true);
      assert.deepEqual(restarted.reads, []);
      await assert.rejects(restarted.bridge.profile(id(address)), {
        code: "SCORE_UNAVAILABLE",
      });
    } finally {
      await restarted.bridge.close();
    }
  } finally {
    await f.bridge.close();
  }
});

it("a saved RWA source cannot silently fall back to native observations when RWA is disabled", async () => {
  const registry = new Map([
    [
      id(address),
      { trader_id: id(address), wallet_address: address, requires_rwa: true },
    ],
  ]);
  const f = fixture(registry);
  const previous = process.env.RIDE_AGENT_RWA_ENABLED;
  delete process.env.RIDE_AGENT_RWA_ENABLED;
  f.stub.infoWithEvidence = async () =>
    assert.fail("Incomplete native-only observation must not be published");
  try {
    await assert.rejects(f.bridge.source(id(address)), {
      code: "SOURCE_SCOPE_UNAVAILABLE",
    });
    assert.deepEqual(f.reads, []);
  } finally {
    if (previous === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = previous;
    await f.bridge.close();
  }
});

it("a saved RWA source keeps its complete observed foreign scopes and original native timestamp even after its score leaves discovery", async () => {
  const registry = new Map([
    [
      id(address),
      { trader_id: id(address), wallet_address: address, requires_rwa: true },
    ],
  ]);
  const f = fixture(registry);
  const previous = process.env.RIDE_AGENT_RWA_ENABLED;
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  const nativeAt = Date.now() - 1000;
  const observedScopes: string[] = [];
  f.stub.taxonomy = async () => new Map([["xyz:TSLA", "stocks"]]);
  f.stub.info = async (input: any) => {
    if (input.type === "userAbstraction") return "standard";
    if (input.type === "userDexAbstraction") return false;
    if (input.type === "meta") return { collateralToken: 0 };
    assert.fail("Unexpected fixture read");
  };
  f.stub.infoWithEvidence = async (input: any) => {
    observedScopes.push(input.dex ?? "");
    return {
      value: {
        marginSummary: { accountValue: input.dex ? "200" : "800" },
        assetPositions: input.dex
          ? [
              {
                position: {
                  coin: "TSLA",
                  szi: "2",
                  positionValue: "100",
                  leverage: { value: 2 },
                },
              },
            ]
          : [],
      },
      observed_at: input.dex ? Date.now() : nativeAt,
    };
  };
  try {
    const source = await f.bridge.source(id(address));
    assert.equal(source.observed_at, nativeAt);
    assert.equal(source.account_value_usdc, "1000");
    assert.deepEqual(source.perps_dexes, ["", "xyz"]);
    assert.deepEqual(observedScopes, ["", "xyz"]);
    assert.equal(source.positions[0].asset, "xyz:TSLA");
    assert.deepEqual(f.reads, []);
  } finally {
    if (previous === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = previous;
    await f.bridge.close();
  }
});

function completeRwaReads(
  f: ReturnType<typeof fixture>,
  firstNative?: Promise<void>,
) {
  const scopes: string[] = [];
  let nativeReads = 0;
  f.stub.taxonomy = async () => new Map([["xyz:TSLA", "stocks"]]);
  f.stub.info = async (input: any) => {
    if (input.type === "userAbstraction") return "standard";
    if (input.type === "userDexAbstraction") return false;
    if (input.type === "meta") return { collateralToken: 0 };
    assert.fail("Unexpected fixture read");
  };
  f.stub.infoWithEvidence = async (input: any) => {
    scopes.push(input.dex ?? "");
    if (!input.dex && nativeReads++ === 0 && firstNative) await firstNative;
    return {
      value: { marginSummary: { accountValue: "1000" }, assetPositions: [] },
      observed_at: Date.now(),
    };
  };
  return scopes;
}

it("upgrading the original Candidate minimum cannot reuse a cached native frame, and false or omitted hints cannot downgrade it", async (t) => {
  let at = Date.now();
  t.mock.method(Date, "now", () => at);
  const f = fixture(
    new Map([
      [
        id(address),
        {
          trader_id: id(address),
          wallet_address: address,
          requires_rwa: false,
        },
      ],
    ]),
  );
  const previous = process.env.RIDE_AGENT_RWA_ENABLED;
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  const scopes = completeRwaReads(f);
  try {
    assert.equal(
      (await f.bridge.source(id(address))).observation_scope_requires_rwa,
      false,
    );
    await assert.rejects(f.bridge.source(id(address), true), {
      code: "SOURCE_SCOPE_UNAVAILABLE",
    });
    await assert.rejects(f.bridge.source(id(address)), {
      code: "SOURCE_SCOPE_UNAVAILABLE",
    });
    await assert.rejects(
      f.bridge.operation("source", {
        trader_id: id(address),
        minimum_requires_rwa: false,
      }),
      { code: "SOURCE_SCOPE_UNAVAILABLE" },
    );
    assert.deepEqual(scopes, [""]);
    at += 5001;
    const complete = await f.bridge.source(id(address));
    assert.equal(complete.observation_scope_requires_rwa, true);
    assert.deepEqual(complete.perps_dexes, ["", "xyz"]);
    assert.deepEqual(scopes, ["", "", "xyz"]);
    assert.equal(f.registry.get(id(address))?.requires_rwa, true);
  } finally {
    if (previous === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = previous;
    await f.bridge.close();
  }
});

it("a minimum scope upgrade during a native flight rejects that old frame for both waiters until complete RWA evidence arrives", async (t) => {
  let at = Date.now();
  t.mock.method(Date, "now", () => at);
  const f = fixture(
    new Map([
      [
        id(address),
        {
          trader_id: id(address),
          wallet_address: address,
          requires_rwa: false,
        },
      ],
    ]),
  );
  const previous = process.env.RIDE_AGENT_RWA_ENABLED;
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scopes = completeRwaReads(f, gate);
  try {
    const first = assert.rejects(f.bridge.source(id(address)), {
      code: "SOURCE_SCOPE_UNAVAILABLE",
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.deepEqual(scopes, [""]);
    const upgraded = assert.rejects(f.bridge.source(id(address), true), {
      code: "SOURCE_SCOPE_UNAVAILABLE",
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(f.registry.get(id(address))?.requires_rwa, true);
    release();
    await Promise.all([first, upgraded]);
    at += 5001;
    const complete = await f.bridge.source(id(address), true);
    assert.equal(complete.observation_scope_requires_rwa, true);
    assert.deepEqual(complete.perps_dexes, ["", "xyz"]);
  } finally {
    release();
    if (previous === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = previous;
    await f.bridge.close();
  }
});

it("current malformed scope metadata cannot seed a native identity, and invalid identifiers are not treated as missing scores", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.bridge.profile("invalid-source"), {
      code: "SOURCE_IDENTITY_INVALID",
    });
    for (const tags of [undefined, "category:crypto", [null]]) {
      f.stub.core = async () => [
        { address, tags, expires_at: Date.now() + 60_000 },
      ];
      await assert.rejects(f.bridge.profile(id(address)), {
        code: "SOURCE_SCOPE_UNAVAILABLE",
      });
      assert.equal(f.registry.size, 0);
    }
  } finally {
    await f.bridge.close();
  }
});

it("backend source and fill reads only add a stricter RWA hint from the saved Candidate, preserving legacy native payloads", async () => {
  const adapter = new BridgeAdapter("https://bridge.test", "fixture");
  const sent: { operation: string; input: any }[] = [];
  (adapter as any).call = async (operation: string, input: any) => {
    sent.push({ operation, input });
    return {
      observation_scope_requires_rwa: input.minimum_requires_rwa === true,
    };
  };
  const native = candidate(1);
  const originalRwa = { ...native, assets: ["xyz:TSLA"] };
  await adapter.source(native);
  await adapter.sourceFills(native, 1, 2);
  await adapter.source(originalRwa);
  await adapter.sourceFills(originalRwa, 1, 2);
  assert.deepEqual(
    sent.map((row) => row.input.minimum_requires_rwa),
    [undefined, undefined, true, true],
  );
  assert.deepEqual(sent[0].input, { trader_id: native.id });
  assert.deepEqual(sent[1].input, {
    trader_id: native.id,
    market: "perps",
    start_at: 1,
    end_at: 2,
  });
});

it("new backend RWA minimums fail closed against an old bridge that ignores the hint, while legacy native responses remain compatible", async () => {
  const adapter = new BridgeAdapter("https://bridge.test", "fixture");
  (adapter as any).call = async () => ({
    complete: true,
    positions: [],
    fills: [],
  });
  const native = candidate(1);
  const originalRwa = { ...native, assets: ["xyz:TSLA"] };
  await adapter.source(native);
  await adapter.sourceFills(native, 1, 2);
  await assert.rejects(adapter.source(originalRwa), {
    code: "SOURCE_SCOPE_UNAVAILABLE",
  });
  await assert.rejects(adapter.sourceFills(originalRwa, 1, 2), {
    code: "SOURCE_SCOPE_UNAVAILABLE",
  });
});

it("source evidence keeps its original five-second limit when the final durable scope verification is delayed", async (t) => {
  let at = Date.now();
  t.mock.method(Date, "now", () => at);
  const f = fixture(
    new Map([
      [
        id(address),
        {
          trader_id: id(address),
          wallet_address: address,
          requires_rwa: false,
        },
      ],
    ]),
  );
  const resolve = f.stub.resolve.bind(f.stub);
  let calls = 0;
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  f.stub.resolve = async (key: string) => {
    if (++calls === 2) {
      entered = true;
      await gate;
    }
    return resolve(key);
  };
  try {
    const rejected = assert.rejects(f.bridge.source(id(address)), {
      code: "SOURCE_STALE",
    });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(entered, true);
    at += 5001;
    release();
    await rejected;
  } finally {
    release();
    await f.bridge.close();
  }
});
