import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { AccountObservationPlans } from "./account-observation-plans.js";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget } from "./venue-read-budget.js";
import { recordCoordinatedEvidence } from "./venue-read-transport.js";
const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
async function fixture(t: TestContext) {
  assert.ok(database);
  const u = new URL(database);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname),
    "test database must be loopback",
  );
  const admin = new pg.Pool({ connectionString: u.toString(), max: 2 }),
    schema = "prepared_" + randomUUID().replaceAll("-", "");
  await admin.query("CREATE SCHEMA " + schema);
  u.searchParams.set("options", "-c search_path=" + schema);
  const pool = new pg.Pool({ connectionString: u.toString(), max: 4 }),
    store = new AccountObservationPlans(pool);
  await store.migrate();
  const owner = "a".repeat(64);
  await pool.query(
    "INSERT INTO ride_agent_account_cost_plans(owner_key,contract,generation,dirty,demand,peaks,learned_at)VALUES($1,'perps-cost-plan-v2',100,false,184,'[164]',clock_timestamp())",
    [owner],
  );
  let wire = 0;
  const observedGenerations: string[] = [];
  const budget = new VenueReadBudget();
  const reads = new VenueReads(
    async () => {
      wire++;
      const row = (
        await pool.query(
          "SELECT generation::text,dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0];
      observedGenerations.push(row.generation);
      if ((reads as any).accountScope.getStore()?.preparedHint !== undefined)
        assert.equal(
          row.dirty,
          true,
          "the real PG generation must be dirty before a new account wire",
        );
      const r = Response.json([]);
      recordCoordinatedEvidence(r, Date.now());
      return r;
    },
    Date.now,
    2,
    {
      transport: "core_shared_info",
      budget,
      observationPlans: store,
      report: () => {},
      frameCoordinator: {
        capacity: 900,
        async begin() {
          return {
            frame_id: "frame_fixture_012345678901",
            expires_at: Date.now() + 20000,
          };
        },
        async end() {},
      },
    },
  );
  t.after(async () => {
    await reads.drainAccounts();
    await pool.end();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
  });
  const row = async () =>
    (
      await pool.query(
        "SELECT generation::text,dirty,demand,peaks,lease_until FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      )
    ).rows[0];
  const prepare = () =>
    reads.prepareAccountWindow(owner, "b".repeat(64), Date.now() + 100000);
  const child = async () => {
    reads.bindAccountCostPlan(owner);
    for (const type of [
      "userFillsByTime",
      "userFunding",
      "userNonFundingLedgerUpdates",
    ])
      await reads.read("https://api.hyperliquid.xyz/info", {
        type,
        user: "fixture",
      });
  };
  return {
    pool,
    store,
    owner,
    reads,
    budget,
    row,
    prepare,
    child,
    wire: () => wire,
    observedGenerations,
  };
}
it(
  "real PG unused prepared credit never creates a dirty generation or learns a cost",
  { skip: !database },
  async (t) => {
    const f = await fixture(t),
      before = await f.row(),
      window = await f.prepare();
    assert.equal(f.wire(), 0);
    assert.deepEqual(await f.row(), before);
    await window.close();
    await f.reads.drainAccounts();
    assert.deepEqual(await f.row(), before);
    assert.equal(f.budget.snapshot().used, 0);
  },
);
it(
  "real PG each complete child claims and synchronously cleans its own generation without parent cost inflation",
  { skip: !database },
  async (t) => {
    const f = await fixture(t),
      window = await f.prepare();
    await window.read(f.child);
    let row = await f.row();
    assert.equal(row.generation, "101");
    assert.equal(row.dirty, false);
    assert.equal(row.lease_until, null);
    assert.equal(row.demand, 184);
    await window.read(f.child);
    row = await f.row();
    assert.equal(row.generation, "102");
    assert.equal(row.dirty, false);
    assert.equal(row.demand, 184);
    assert.deepEqual([...new Set(f.observedGenerations)], ["101", "102"]);
    await window.close();
    assert.equal(f.budget.snapshot().used, 120);
  },
);
it(
  "real PG a partial first child retains dirty/paid evidence and cannot restore its old warm hint after actual lease expiry",
  { skip: !database },
  async (t) => {
    const f = await fixture(t),
      window = await f.prepare();
    await assert.rejects(
      window.read(async () => {
        f.reads.bindAccountCostPlan(f.owner);
        await f.reads.read("https://api.hyperliquid.xyz/info", {
          type: "userFillsByTime",
          user: "fixture",
        });
        throw new Error("fixture incomplete account");
      }),
    );
    const row = await f.row();
    assert.equal(row.generation, "101");
    assert.equal(row.dirty, true);
    assert.equal(f.budget.snapshot().used, 20);
    await window.close();
    await f.pool.query(
      "UPDATE ride_agent_account_cost_plans SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE owner_key=$1",
      [f.owner],
    );
    const hint = await f.store.read(f.owner, new AbortController().signal);
    assert.equal(hint.plan, null);
    assert.equal(hint.remainingTtlMs, 0);
    assert.equal(f.budget.peekObservationFramePlan(f.owner, 780).cold, true);
    assert.equal(f.budget.snapshot().used, 20);
  },
);

it(
  "real PG cached metadata then validation failure never dirties a prepared generation or erases its warm hint",
  { skip: !database },
  async (t) => {
    const f = await fixture(t),
      payload = { type: "meta" };
    await f.reads.read(
      "https://api.hyperliquid.xyz/info",
      payload,
      60000,
      "source",
    );
    const before = await f.row(),
      wire = f.wire();
    const window = await f.prepare();
    await assert.rejects(
      window.read(async () => {
        f.reads.bindAccountCostPlan(f.owner);
        await f.reads.read("https://api.hyperliquid.xyz/info", payload, 60000);
        throw new Error("fixture validation before any new provider dispatch");
      }),
    );
    await window.close();
    assert.equal(f.wire(), wire);
    assert.deepEqual(await f.row(), before);
    assert.equal(f.budget.peekObservationFramePlan(f.owner, 780).cold, false);
    assert.equal(f.budget.snapshot().used, 20);
  },
);
