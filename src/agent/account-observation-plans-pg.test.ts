import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";
import pg from "pg";
import { AccountObservationPlans } from "./account-observation-plans.js";
import { CoreBridge } from "./core_bridge.js";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget } from "./venue-read-budget.js";
import { setTimeout as delay } from "node:timers/promises";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 15000 };
const key = () => randomBytes(32).toString("hex");
const signal = () => new AbortController().signal;
const plan = { demand: 180, peaks: [160, 140, 140] };

it(
  "PostgreSQL empty owners stay cold, exact clean plans restore, and only operational metadata is stored",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owner = key();
    const store = new AccountObservationPlans(pool);
    try {
      await store.migrate();
      const first = await store.begin(owner, signal());
      assert.equal(first.plan, null);
      assert.equal(await store.complete(first, plan, signal()), true);
      const second = await new AccountObservationPlans(pool).begin(
        owner,
        signal(),
      );
      assert.deepEqual(second.plan, plan);
      assert.ok(
        second.remainingTtlMs > 590000 && second.remainingTtlMs <= 600000,
      );
      assert.notEqual(second.generation, first.generation);
      const rows = await pool.query(
        "SELECT * FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      assert.deepEqual(Object.keys(rows.rows[0]).sort(), [
        "contract",
        "demand",
        "dirty",
        "generation",
        "learned_at",
        "lease_until",
        "owner_key",
        "peaks",
      ]);
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL dirty or crashed generations cannot restore and an old writer cannot clean a newer scope",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owner = key();
    const store = new AccountObservationPlans(pool);
    try {
      await store.migrate();
      const first = await store.begin(owner, signal());
      await store.complete(first, plan, signal());
      const growth = await store.begin(owner, signal());
      assert.deepEqual(growth.plan, plan);
      await assert.rejects(
        new AccountObservationPlans(pool).begin(owner, signal()),
        { code: "VENUE_COST_PLAN_UNAVAILABLE" },
      );
      await pool.query(
        "UPDATE ride_agent_account_cost_plans SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE owner_key=$1",
        [owner],
      );
      // No completion after growth failure, unknown, cancellation or process loss.
      const restarted = await new AccountObservationPlans(pool).begin(
        owner,
        signal(),
      );
      assert.equal(restarted.plan, null);
      assert.equal(await store.complete(growth, plan, signal()), false);
      assert.equal(
        (
          await pool.query(
            "SELECT dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [owner],
          )
        ).rows[0].dirty,
        true,
      );
      assert.equal(await store.complete(restarted, plan, signal()), true);
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL read hints do not dirty normal deferrals and a raced or expired hint cannot claim a venue scope",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owner = key();
    const store = new AccountObservationPlans(pool);
    try {
      await store.migrate();
      const first = await store.begin(owner, signal());
      await store.complete(first, plan, signal());
      const hint = await store.read(owner, signal());
      assert.deepEqual(hint.plan, plan);
      assert.equal(
        (
          await pool.query(
            "SELECT dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [owner],
          )
        ).rows[0].dirty,
        false,
      );
      const current = await store.begin(owner, signal(), hint, 1000);
      await assert.rejects(store.begin(owner, signal(), hint), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      assert.equal(await store.complete(current, plan, signal()), true);
      const expiring = await store.read(owner, signal());
      await pool.query(
        "UPDATE ride_agent_account_cost_plans SET learned_at=clock_timestamp()-interval '10 minutes' WHERE owner_key=$1",
        [owner],
      );
      await assert.rejects(store.begin(owner, signal(), expiring), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      const cold = await store.read(owner, signal());
      assert.equal(cold.plan, null);
      const fresh = await store.begin(owner, signal(), cold, 1000);
      assert.equal(fresh.plan, null);
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL rejects expired, future-dated, corrupt or contract-mismatched cost hints",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owners: string[] = [];
    const store = new AccountObservationPlans(pool);
    try {
      await store.migrate();
      for (const update of [
        "learned_at=clock_timestamp()-interval '10 minutes'",
        "learned_at=clock_timestamp()+interval '1 minute'",
        "demand=1",
        "peaks='[160,140,140,140]'::jsonb",
        "contract='different-cost-protocol'",
      ]) {
        const owner = key();
        owners.push(owner);
        const lease = await store.begin(owner, signal());
        await store.complete(lease, plan, signal());
        await pool.query(
          `UPDATE ride_agent_account_cost_plans SET ${update} WHERE owner_key=$1`,
          [owner],
        );
        const next = await store.begin(owner, signal());
        assert.equal(next.plan, null, update);
      }
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=ANY($1::text[])",
        [owners],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL pending row locks respect cancellation and never dispatch or clean an uncommitted lease",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owner = key();
    const store = new AccountObservationPlans(pool);
    const blocker = await pool.connect();
    try {
      await store.migrate();
      const lease = await store.begin(owner, signal());
      await store.complete(lease, plan, signal());
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE",
        [owner],
      );
      const control = new AbortController();
      const waiting = store.begin(owner, control.signal);
      setTimeout(() => control.abort(), 30);
      const began = Date.now();
      await assert.rejects(waiting, { code: "VENUE_COST_PLAN_UNAVAILABLE" });
      assert.ok(Date.now() - began < 1000);
      await blocker.query("ROLLBACK");
      const restored = await store.begin(owner, signal());
      assert.deepEqual(
        restored.plan,
        plan,
        "An aborted transaction never committed its dirty generation",
      );
    } finally {
      blocker.release(true);
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL a mid-wire graceful bridge close keeps the pool available until the same metering generation becomes clean",
  options,
  async () => {
    const admin = new pg.Pool({ connectionString: database, max: 2 });
    const owner = key();
    const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      database!,
      "s".repeat(32),
      "mainnet",
    );
    const store = new AccountObservationPlans((bridge as any).pool);
    let finishWire!: () => void, started!: () => void;
    const wireStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const wire = new Promise<void>((resolve) => {
      finishWire = resolve;
    });
    const reads = new VenueReads(
      (async () => {
        started();
        await wire;
        return new Response("[]");
      }) as typeof fetch,
      Date.now,
      2,
      { budget: new VenueReadBudget(), observationPlans: store },
    );
    (bridge as any).venueReads = reads;
    let closing: Promise<void> | undefined;
    try {
      await store.migrate();
      const work = reads.observeAccount(
        () =>
          reads.read("https://venue.test/info", { type: "userFillsByTime" }),
        owner,
      );
      await wireStarted;
      const before = (
        await admin.query(
          "SELECT generation::text,dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0];
      assert.equal(before.dirty, true);
      closing = bridge.close();
      finishWire();
      await work;
      await closing;
      const after = (
        await admin.query(
          "SELECT generation::text,dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0];
      assert.deepEqual(after, { generation: before.generation, dirty: false });
      assert.deepEqual(
        (await new AccountObservationPlans(admin).read(owner, signal())).plan,
        { demand: 140, peaks: [120] },
      );
    } finally {
      finishWire();
      await (closing ?? bridge.close());
      await admin.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await admin.end();
    }
  },
);

it(
  "PostgreSQL a completion blocked behind an unchanged tuple cannot clean after its real lease expires",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owner = key(),
      store = new AccountObservationPlans(pool),
      blocker = await pool.connect();
    try {
      await store.migrate();
      const lease = await store.begin(owner, signal(), undefined, 200);
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE",
        [owner],
      );
      const completing = store.complete(lease, plan, signal());
      await delay(300);
      await blocker.query("ROLLBACK");
      assert.equal(await completing, false);
      assert.equal(
        (
          await pool.query(
            "SELECT dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [owner],
          )
        ).rows[0].dirty,
        true,
      );
    } finally {
      blocker.release(true);
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL fully known successful growth records the higher exact plan while failed growth remains dirty and cannot be restored",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 4 });
    const owner = key(),
      store = new AccountObservationPlans(pool);
    try {
      await store.migrate();
      const initial = await store.begin(owner, signal());
      await store.complete(initial, { demand: 140, peaks: [120] }, signal());
      const budget = new VenueReadBudget();
      const reads = new VenueReads(
        (async () => new Response("[]")) as typeof fetch,
        Date.now,
        2,
        { budget, observationPlans: store },
      );
      await reads.observeAccount(async () => {
        await reads.read("https://venue.test/info", {
          type: "userAbstraction",
        });
        await reads.read("https://venue.test/info", {
          type: "userAbstraction",
        });
        await reads.read("https://venue.test/info", {
          type: "userFillsByTime",
        });
      }, owner);
      await reads.drainAccounts();
      assert.deepEqual((await store.read(owner, signal())).plan, {
        demand: 180,
        peaks: [120, 160],
      });
      assert.equal(
        await store.complete(initial, { demand: 140, peaks: [120] }, signal()),
        false,
      );
      const failedBudget = new VenueReadBudget();
      const other = await failedBudget.acquire(
        "source",
        820,
        "fixture",
        signal(),
      );
      other.sent();
      other.settle(820);
      other.release();
      const failedReads = new VenueReads(
        (async (_url, init) => {
          const type = JSON.parse(String(init?.body)).type;
          return Response.json(
            type === "userFillsByTime"
              ? Array.from({ length: 2000 }, () => ({}))
              : [],
          );
        }) as typeof fetch,
        Date.now,
        2,
        { budget: failedBudget, observationPlans: store },
      );
      await assert.rejects(
        failedReads.observeAccount(async () => {
          for (let i = 0; i < 4; i++)
            await failedReads.read("https://venue.test/info", {
              type: "userAbstraction",
            });
          await failedReads.read("https://venue.test/info", {
            type: "userFillsByTime",
          });
        }, owner),
        { code: "VENUE_READ_BUDGET_EXHAUSTED" },
      );
      const dirty = (
        await pool.query(
          "SELECT dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0].dirty;
      assert.equal(dirty, true);
      await pool.query(
        "UPDATE ride_agent_account_cost_plans SET lease_until=clock_timestamp()-interval '1 millisecond' WHERE owner_key=$1",
        [owner],
      );
      assert.equal((await store.read(owner, signal())).plan, null);
      assert.throws(() => failedBudget.beginObservation(owner), {
        code: "VENUE_READ_BUDGET_EXHAUSTED",
      });
    } finally {
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL pool acquisition cancellation releases a late connection and cannot extend the original scope",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 1 });
    const store = new AccountObservationPlans(pool),
      owner = key();
    await store.migrate();
    const occupied = await pool.connect();
    let released = false;
    try {
      const control = new AbortController();
      const waiting = store.read(owner, control.signal);
      setTimeout(() => control.abort(), 20);
      await assert.rejects(waiting, { code: "VENUE_COST_PLAN_UNAVAILABLE" });
      occupied.release();
      released = true;
      const lease = await store.begin(owner, signal());
      assert.equal(lease.plan, null);
      await store.complete(lease, plan, signal());
    } finally {
      if (!released) occupied.release(true);
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);
