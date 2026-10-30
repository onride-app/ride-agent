import assert from "node:assert/strict";
import { it } from "node:test";
import { PerpsSourceIdentities } from "./source-identities.js";

const salt = "source-identity-fixture-salt-32-characters";
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
function memory() {
  const rows = new Map<string, any>();
  const pool = {
    async query(sql: string, params: any[] = []) {
      if (sql.startsWith("INSERT INTO ride_agent_perps_source_identities")) {
        const [ids, addresses, scopes] = params;
        const saved = ids.flatMap((key: string, i: number) => {
          const previous = rows.get(key);
          if (previous && previous.wallet_address !== addresses[i]) return [];
          const row = {
            trader_id: key,
            wallet_address: addresses[i],
            requires_rwa: previous?.requires_rwa || scopes[i],
          };
          rows.set(key, row);
          return [row];
        });
        return { rows: saved, rowCount: saved.length };
      }
      if (sql.includes("FROM ride_agent_perps_source_identities")) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      throw new Error("Unexpected fixture query");
    },
  } as any;
  return { rows, pool };
}

it("identity persistence only keeps address and minimum scope, never downgrades RWA and detects a corrupted identity after restart", async () => {
  const f = memory();
  const read = async () =>
    assert.fail("Saved identity requires no historical scan");
  const registry = new PerpsSourceIdentities(f.pool, salt, read);
  const source = { address: address(1), requires_rwa: false };
  await registry.remember([source]);
  await registry.remember([{ ...source, requires_rwa: true }]);
  await registry.remember([source]);
  const restarted = new PerpsSourceIdentities(f.pool, salt, read);
  assert.deepEqual(await restarted.resolve(registry.id(source.address)), {
    ...source,
    requires_rwa: true,
  });
  assert.deepEqual(Object.keys(f.rows.values().next().value).sort(), [
    "requires_rwa",
    "trader_id",
    "wallet_address",
  ]);
  f.rows.set(registry.id(source.address), {
    wallet_address: address(2),
    requires_rwa: false,
  });
  const corrupted = new PerpsSourceIdentities(f.pool, salt, read);
  await assert.rejects(corrupted.resolve(registry.id(source.address)), {
    code: "SOURCE_IDENTITY_CONFLICT",
  });
  await assert.rejects(corrupted.remember([source]), {
    code: "SOURCE_IDENTITY_CONFLICT",
  });
});

it("concurrent missing sources share a complete, bounded paginated historical read; negative results do not rescan each monitor tick", async () => {
  const f = memory();
  let at = 1000;
  const calls: any[] = [];
  let sharedSignal: AbortSignal | undefined;
  const registry = new PerpsSourceIdentities(
    f.pool,
    salt,
    async (input, signal) => {
      calls.push(input);
      sharedSignal ??= signal;
      assert.equal(
        signal,
        sharedSignal,
        "Every page shares the same absolute deadline",
      );
      await Promise.resolve();
      if (!input.cursor)
        return {
          identities: [{ address: address(1), requires_rwa: false, score: 99 }],
          next_cursor: address(1),
          complete: false,
        };
      assert.equal(input.cursor, address(1));
      return {
        identities: [{ address: address(2), requires_rwa: true }],
        next_cursor: null,
        complete: true,
      };
    },
    () => at,
  );
  const found = await Promise.all([
    registry.resolve(registry.id(address(1))),
    registry.resolve(registry.id(address(2))),
  ]);
  assert.deepEqual(found, [
    { address: address(1), requires_rwa: false },
    { address: address(2), requires_rwa: true },
  ]);
  assert.equal(calls.length, 2);
  for (let i = 0; i < 10; i++)
    await assert.rejects(registry.resolve(registry.id(address(3))), {
      code: "NOT_FOUND",
    });
  assert.equal(calls.length, 2);
  at += 30_001;
  sharedSignal = undefined;
  await assert.rejects(registry.resolve(registry.id(address(3))), {
    code: "NOT_FOUND",
  });
  assert.equal(calls.length, 4);
});

for (const [name, response] of [
  [
    "missing explicit scope",
    {
      identities: [{ address: address(1) }],
      next_cursor: null,
      complete: true,
    },
  ],
  [
    "uppercase address",
    {
      identities: [{ address: "0x" + "A".repeat(40), requires_rwa: false }],
      next_cursor: null,
      complete: true,
    },
  ],
  [
    "false completion marker",
    { identities: [], next_cursor: null, complete: false },
  ],
  [
    "cursor not the last verified address",
    {
      identities: [{ address: address(1), requires_rwa: false }],
      next_cursor: address(2),
      complete: false,
    },
  ],
  [
    "unsorted or duplicate identities",
    {
      identities: [
        { address: address(2), requires_rwa: false },
        { address: address(1), requires_rwa: true },
      ],
      next_cursor: null,
      complete: true,
    },
  ],
] as const) {
  it(`historical identity lookup fails closed on ${name} without exposing source or salt`, async () => {
    const f = memory();
    let calls = 0;
    const registry = new PerpsSourceIdentities(f.pool, salt, async () => {
      calls++;
      return response;
    });
    const test = async () => {
      try {
        await registry.resolve(registry.id(address(1)));
        assert.fail("Malformed identity evidence was accepted");
      } catch (error: any) {
        assert.match(
          error.code,
          /^SOURCE_(SCOPE_UNAVAILABLE|IDENTITY_(UNAVAILABLE|CONFLICT))$/,
        );
        assert.equal(error.message.includes(address(1)), false);
        assert.equal(error.message.includes(salt), false);
      }
    };
    await test();
    await test();
    assert.equal(calls, 1, "Failed enumeration has a bounded cooldown");
    assert.equal(f.rows.size, 0);
  });
}

it("historical enumeration rejects an endless forward cursor after its fixed page bound", async () => {
  const f = memory();
  let pages = 0;
  const registry = new PerpsSourceIdentities(f.pool, salt, async () => {
    pages++;
    const next = address(pages);
    return {
      identities: [{ address: next, requires_rwa: false }],
      next_cursor: next,
      complete: false,
    };
  });
  await assert.rejects(registry.resolve(registry.id(address(1))), {
    code: "SOURCE_IDENTITY_UNAVAILABLE",
  });
  assert.equal(pages, 100);
  assert.equal(f.rows.size, 0, "An unverified partial prefix is never saved");
});

it("unknown scope on an unrelated historical identity does not hide a verified original source; a matching unknown scope fails closed", async () => {
  const f = memory();
  let calls = 0;
  const registry = new PerpsSourceIdentities(f.pool, salt, async () => {
    calls++;
    return {
      identities: [
        { address: address(1), requires_rwa: null },
        { address: address(2), requires_rwa: false },
      ],
      next_cursor: null,
      complete: true,
    };
  });
  assert.deepEqual(await registry.resolve(registry.id(address(2))), {
    address: address(2),
    requires_rwa: false,
  });
  await assert.rejects(registry.resolve(registry.id(address(1))), {
    code: "SOURCE_SCOPE_UNAVAILABLE",
  });
  await assert.rejects(registry.resolve(registry.id(address(1))), {
    code: "SOURCE_SCOPE_UNAVAILABLE",
  });
  assert.equal(calls, 1);
  assert.equal(f.rows.has(registry.id(address(1))), false);
  assert.deepEqual(
    await registry.resolve(registry.id(address(1)), true),
    { address: address(1), requires_rwa: true },
    "A required RWA minimum may choose strictly more complete observations, never native by default",
  );
  assert.equal(f.rows.get(registry.id(address(1)))?.requires_rwa, true);
});
