import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import pg from "pg";
import { PerpsSourceIdentities } from "./source-identities.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 15_000 };
const address = "0x" + "3".repeat(40);

it(
  "PostgreSQL source identity survives restart and concurrent native/RWA writers can only increase the minimum observation scope",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const salt = randomUUID();
    const noHistory = async () =>
      assert.fail(
        "Persisted identity is independent of current scores or historical scans",
      );
    const first = new PerpsSourceIdentities(pool, salt, noHistory);
    const second = new PerpsSourceIdentities(pool, salt, noHistory);
    const id = first.id(address);
    try {
      await first.migrate();
      await first.remember([{ address, requires_rwa: false }]);
      assert.equal((await first.resolve(id)).requires_rwa, false);
      await Promise.all([
        first.remember([{ address, requires_rwa: false }]),
        second.remember([{ address, requires_rwa: true }]),
      ]);
      await first.remember([{ address, requires_rwa: false }]);
      assert.equal(
        (await first.resolve(id)).requires_rwa,
        true,
        "An older native resolver observes another bridge's durable scope upgrade",
      );
      const restarted = new PerpsSourceIdentities(pool, salt, noHistory);
      assert.deepEqual(await restarted.resolve(id), {
        address,
        requires_rwa: true,
      });
      const saved = await pool.query(
        "SELECT * FROM ride_agent_perps_source_identities WHERE trader_id=$1",
        [id],
      );
      assert.equal(saved.rowCount, 1);
      assert.deepEqual(Object.keys(saved.rows[0]).sort(), [
        "created_at",
        "requires_rwa",
        "trader_id",
        "wallet_address",
      ]);
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_perps_source_identities WHERE trader_id=$1",
        [id],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL corrupted or competing address mappings are never overwritten or used as source evidence",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const registry = new PerpsSourceIdentities(pool, randomUUID(), async () =>
      assert.fail(
        "Conflicting durable identity must not trigger a different-source fallback",
      ),
    );
    const id = registry.id(address);
    const differentAddress = "0x" + "4".repeat(40);
    try {
      await registry.migrate();
      await pool.query(
        "INSERT INTO ride_agent_perps_source_identities (trader_id,wallet_address,requires_rwa) VALUES($1,$2,false)",
        [id, differentAddress],
      );
      await assert.rejects(registry.resolve(id), {
        code: "SOURCE_IDENTITY_CONFLICT",
      });
      await assert.rejects(
        registry.remember([{ address, requires_rwa: true }]),
        { code: "SOURCE_IDENTITY_CONFLICT" },
      );
      const saved = await pool.query(
        "SELECT wallet_address,requires_rwa FROM ride_agent_perps_source_identities WHERE trader_id=$1",
        [id],
      );
      assert.deepEqual(saved.rows, [
        { wallet_address: differentAddress, requires_rwa: false },
      ]);
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_perps_source_identities WHERE trader_id=$1",
        [id],
      );
      await pool.end();
    }
  },
);
