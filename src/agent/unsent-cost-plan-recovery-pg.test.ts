import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  AccountObservationPlans,
  type ObservationPlanLease,
} from "./account-observation-plans.js";
import { VenueReadBudget } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
} from "./venue-read-transport.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 15000 };
const plan = { demand: 184, peaks: [164, 164, 164] };
const signal = () => new AbortController().signal;
async function fixture(t: TestContext) {
  assert.ok(database);
  const u = new URL(database);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname),
    "only a loopback test DB is permitted",
  );
  const admin = new pg.Pool({ connectionString: u.toString(), max: 2 }),
    schema = "unsent_" + randomUUID().replaceAll("-", "");
  await admin.query("CREATE SCHEMA " + schema);
  u.searchParams.set("options", "-c search_path=" + schema);
  const app = schema,
    pool = new pg.Pool({
      connectionString: u.toString(),
      application_name: app,
      max: 6,
    }),
    store = new AccountObservationPlans(pool),
    owner = "a".repeat(64);
  await store.migrate();
  await pool.query(
    `INSERT INTO ride_agent_account_cost_plans(owner_key,contract,generation,dirty,demand,peaks,learned_at)
    VALUES($1,'perps-cost-plan-v2',10,false,184,'[164,164,164]',date_trunc('milliseconds',clock_timestamp()-interval '1 second')+interval '123 microseconds')`,
    [owner],
  );
  t.after(async () => {
    await pool.end();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
  });
  const row = async () =>
    (
      await pool.query(
        `SELECT owner_key,contract,generation::text,dirty,demand,peaks,
    to_char(learned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS learned,
    to_char(lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lease FROM ride_agent_account_cost_plans WHERE owner_key=$1`,
        [owner],
      )
    ).rows[0];
  const block = async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "SELECT 1 FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE",
      [owner],
    );
    return {
      release: async () => {
        await client.query("ROLLBACK");
        client.release();
      },
    };
  };
  const waitBlocked = async (count: number) => {
    for (let i = 0; i < 200; i++) {
      const n = Number(
        (
          await admin.query(
            "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
            [app],
          )
        ).rows[0].count,
      );
      if (n >= count) return;
      await delay(2);
    }
    assert.fail(
      "expected owned test transactions to be blocked on the actual PG row",
    );
  };
  return { pool, store, owner, row, block, waitBlocked };
}

it(
  "real PG owned no-send return preserves exact microsecond learned time, plan and generation, then fences late complete",
  options,
  async (t) => {
    const f = await fixture(t),
      before = await f.row(),
      lease = await f.store.begin(f.owner, signal()),
      claimed = await f.row();
    assert.match(before.learned, /123Z$/);
    assert.equal(claimed.dirty, true);
    assert.equal(await f.store.returnUnsent(lease, signal()), true);
    assert.deepEqual(await f.row(), {
      ...before,
      generation: lease.generation,
    });
    assert.equal(await f.store.complete(lease, plan, signal()), false);
    assert.equal(await f.store.returnUnsent(lease, signal()), false);
    const next = await f.store.begin(f.owner, signal());
    assert.equal(BigInt(next.generation), BigInt(lease.generation) + 1n);
    assert.equal(await f.store.returnUnsent(lease, signal()), false);
    assert.equal(await f.store.complete(lease, plan, signal()), false);
    assert.equal(await f.store.returnUnsent(next, signal()), true);
  },
);

it(
  "real PG copied, mutated and restarted tokens cannot authorize hint recovery",
  options,
  async (t) => {
    const f = await fixture(t),
      lease = await f.store.begin(f.owner, signal());
    assert.equal(
      await f.store.returnUnsent(structuredClone(lease), signal()),
      false,
    );
    assert.equal(
      await new AccountObservationPlans(f.pool).returnUnsent(lease, signal()),
      false,
    );
    lease.plan!.peaks[0]--;
    assert.equal(await f.store.returnUnsent(lease, signal()), false);
    lease.plan!.peaks[0]++;
    assert.equal(
      await f.store.returnUnsent(lease, signal()),
      false,
      "a rejected private authority is consumed",
    );
    assert.equal((await f.row()).dirty, true);
  },
);

for (const [label, update] of [
  [
    "same-millisecond learned timestamp moved one microsecond",
    "learned_at=learned_at+interval '1 microsecond'",
  ],
  [
    "same-millisecond lease timestamp moved one microsecond",
    "lease_until=lease_until+interval '1 microsecond'",
  ],
  ["contract changed", "contract='other-contract'"],
  ["demand changed", "demand=185"],
  ["peaks changed", "peaks='[163,164,164]'::jsonb"],
  ["successor generation", "generation=generation+1"],
  ["another writer already closed the lease", "lease_until=NULL"],
] as const)
  it(`real PG return refuses ${label}`, options, async (t) => {
    const f = await fixture(t),
      lease = await f.store.begin(f.owner, signal()),
      before = await f.row();
    await f.pool.query(
      `UPDATE ride_agent_account_cost_plans SET ${update} WHERE owner_key=$1`,
      [f.owner],
    );
    const altered = await f.row();
    if (label.startsWith("same-millisecond learned"))
      assert.equal(Date.parse(before.learned), Date.parse(altered.learned));
    if (label.startsWith("same-millisecond lease"))
      assert.equal(Date.parse(before.lease), Date.parse(altered.lease));
    assert.equal(await f.store.returnUnsent(lease, signal()), false);
    assert.deepEqual(await f.row(), altered);
  });

for (const initial of ["dirty", "expired", "cold"] as const)
  it(
    `real PG no capability is granted from an initially ${initial} hint`,
    options,
    async (t) => {
      const f = await fixture(t);
      await f.pool.query(
        `UPDATE ride_agent_account_cost_plans SET ${initial === "dirty" ? "dirty=true,lease_until=NULL" : initial === "expired" ? "learned_at=clock_timestamp()-interval '601 seconds'" : "learned_at=NULL,peaks='[]'::jsonb,demand=1000"} WHERE owner_key=$1`,
        [f.owner],
      );
      const lease = await f.store.begin(f.owner, signal());
      assert.equal(lease.plan, null);
      assert.equal(await f.store.returnUnsent(lease, signal()), false);
      assert.equal((await f.row()).dirty, true);
    },
  );

it(
  "real PG duplicate return has exactly one acknowledged winner and does not renew the original hint",
  options,
  async (t) => {
    const f = await fixture(t),
      before = await f.row(),
      lease = await f.store.begin(f.owner, signal());
    const values = await Promise.all([
      f.store.returnUnsent(lease, signal()),
      f.store.returnUnsent(lease, signal()),
    ]);
    assert.deepEqual(values.sort(), [false, true]);
    assert.deepEqual(await f.row(), {
      ...before,
      generation: lease.generation,
    });
  },
);

for (const first of ["return", "complete"] as const)
  it(
    `real PG row-lock ordering: ${first} wins and the late same-generation operation fails`,
    options,
    async (t) => {
      const f = await fixture(t),
        lease = await f.store.begin(f.owner, signal()),
        blocker = await f.block();
      let released = false;
      try {
        const a =
          first === "return"
            ? f.store.returnUnsent(lease, signal())
            : f.store.complete(lease, plan, signal());
        await f.waitBlocked(1);
        const b =
          first === "return"
            ? f.store.complete(lease, plan, signal())
            : f.store.returnUnsent(lease, signal());
        await f.waitBlocked(2);
        await blocker.release();
        released = true;
        assert.equal(await a, true);
        assert.equal(await b, false);
        const row = await f.row();
        assert.equal(row.dirty, false);
        assert.equal(row.lease, null);
        assert.equal(row.generation, lease.generation);
      } finally {
        if (!released) await blocker.release();
      }
    },
  );

for (const expiry of ["lease", "hint"] as const)
  it(
    `real PG a row-lock wait cannot extend the original ${expiry} lifetime`,
    options,
    async (t) => {
      const f = await fixture(t);
      if (expiry === "hint")
        await f.pool.query(
          "UPDATE ride_agent_account_cost_plans SET learned_at=clock_timestamp()-interval '599.7 seconds' WHERE owner_key=$1",
          [f.owner],
        );
      const lease = await f.store.begin(
          f.owner,
          signal(),
          undefined,
          expiry === "lease" ? 300 : 2000,
        ),
        blocker = await f.block();
      let released = false;
      try {
        const result = f.store.returnUnsent(lease, signal()).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await f.waitBlocked(1);
        await delay(350);
        const outcome = await result;
        assert.ok("error" in outcome || outcome.value === false);
        await blocker.release();
        released = true;
        assert.equal((await f.row()).dirty, true);
        assert.equal(await f.store.returnUnsent(lease, signal()), false);
      } finally {
        if (!released) await blocker.release();
      }
    },
  );

function ambiguousCommit(
  pool: pg.Pool,
  fail: () => boolean,
): Pick<pg.Pool, "connect"> {
  return {
    connect: (async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query")
            return async (sql: string, values?: unknown[]) => {
              const result = await target.query(sql, values);
              if (sql === "COMMIT" && fail())
                throw new Error("fixture commit acknowledgement lost");
              return result;
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as pg.Pool["connect"],
  };
}
it(
  "real PG ambiguous begin acknowledgement creates no returned recovery authority",
  options,
  async (t) => {
    const f = await fixture(t),
      store = new AccountObservationPlans(ambiguousCommit(f.pool, () => true));
    await assert.rejects(store.begin(f.owner, signal()), {
      code: "VENUE_COST_PLAN_UNAVAILABLE",
    });
    assert.equal((await f.row()).dirty, true);
    const invented: ObservationPlanLease = {
      owner: f.owner,
      generation: "11",
      plan,
      remainingTtlMs: 599000,
    };
    assert.equal(await store.returnUnsent(invented, signal()), false);
  },
);
it(
  "real PG ambiguous return commit is never reported as an acknowledged recovery and its capability is spent",
  options,
  async (t) => {
    const f = await fixture(t);
    let fail = false;
    const store = new AccountObservationPlans(
        ambiguousCommit(f.pool, () => fail),
      ),
      lease = await store.begin(f.owner, signal());
    fail = true;
    await assert.rejects(store.returnUnsent(lease, signal()), {
      code: "VENUE_COST_PLAN_UNAVAILABLE",
    });
    assert.equal(await store.returnUnsent(lease, signal()), false);
    assert.equal(
      (await f.row()).dirty,
      false,
      "the ambiguous COMMIT may actually have reached PG; no success is invented",
    );
  },
);

for (const a1 of [false, true])
  it(
    `real VenueReads + PG ${a1 ? "A1 publication then A2" : "ordinary A"} recovers only its own clean hint after a verified no-send failure`,
    options,
    async (t) => {
      const f = await fixture(t),
        budget = new VenueReadBudget();
      let noSend = !a1;
      const reads = new VenueReads(
        async () => {
          assert.equal(
            (await f.row()).dirty,
            true,
            "dirty claim remains before every actual read attempt",
          );
          if (noSend)
            throw new CoordinatedReadError(
              "VENUE_READ_BUDGET_EXHAUSTED",
              false,
              1000,
            );
          const response = Response.json({});
          recordCoordinatedEvidence(response, Date.now());
          return response;
        },
        Date.now,
        2,
        {
          transport: "core_shared_info",
          budget,
          observationPlans: f.store,
          report: () => {},
          frameCoordinator: {
            capacity: 900,
            begin: async () => ({
              frame_id: "pg_unsent_fixture_frame",
              expires_at: Date.now() + 20000,
            }),
            end: async () => {},
          },
        },
      );
      const child = async () => {
        reads.bindAccountCostPlan(f.owner);
        return reads.read(
          "https://api.hyperliquid.xyz/info",
          { type: "clearinghouseState", user: "fixture" },
          0,
        );
      };
      let window:
        Awaited<ReturnType<VenueReads["prepareAccountWindow"]>> | undefined;
      try {
        let prior = await f.row();
        if (a1) {
          window = await reads.prepareAccountWindow(
            f.owner,
            "b".repeat(64),
            Date.now() + 100000,
          );
          await window.read(child);
          prior = await f.row();
          noSend = true;
          await assert.rejects(window.read(child), {
            code: "VENUE_READ_BUDGET_EXHAUSTED",
          });
          assert.equal(
            (await f.row()).dirty,
            true,
            "a live parent may not expose its hint as clean",
          );
          await window.close();
        } else
          await assert.rejects(reads.observeAccount(child, f.owner), {
            code: "VENUE_READ_BUDGET_EXHAUSTED",
          });
        await reads.drainAccounts();
        assert.deepEqual(await f.row(), {
          ...prior,
          generation: String(BigInt(prior.generation) + 1n),
        });
        assert.equal(budget.snapshot().used, a1 ? 2 : 0);
      } finally {
        await window?.close();
        await reads.drainAccounts();
      }
    },
  );
