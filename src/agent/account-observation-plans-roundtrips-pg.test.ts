import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import pg from "pg";
import {
  AccountObservationPlans,
  ACCOUNT_OBSERVATION_COST_CONTRACT,
} from "./account-observation-plans.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 15000 };
const signal = () => new AbortController().signal;
const plan = { demand: 180, peaks: [160, 140, 140] };
const key = () => randomBytes(32).toString("hex");

async function fixture() {
  const admin = new pg.Pool({ connectionString: database, max: 4 });
  const schema = "cost_rtt_" + randomBytes(12).toString("hex");
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(database!);
  url.searchParams.set("options", "-c search_path=" + schema);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  const store = new AccountObservationPlans(pool);
  await store.migrate();
  return {
    pool,
    store,
    url,
    async clean(owner: string) {
      const lease = await store.begin(owner, signal());
      assert.equal(await store.complete(lease, plan, signal()), true);
      return store.read(owner, signal());
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

type Hook = (
  client: pg.PoolClient,
  text: string,
  values?: unknown[],
) => Promise<any>;
function counted(pool: pg.Pool, hook?: Hook) {
  const calls: { text: string; parameterized: boolean }[] = [];
  const released: boolean[] = [];
  let latestClient: pg.PoolClient | undefined;
  const connect = async () => {
    const client = await pool.connect();
    latestClient = client;
    return new Proxy(client, {
      get(target, name) {
        if (name === "query")
          return (text: string, values?: unknown[]) => {
            calls.push({ text, parameterized: values !== undefined });
            return hook
              ? hook(target, text, values)
              : target.query(text, values);
          };
        if (name === "release")
          return (destroy?: boolean) => {
            released.push(destroy === true);
            target.release(destroy);
          };
        const value = Reflect.get(target, name);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return {
    store: new AccountObservationPlans({ connect } as Pick<pg.Pool, "connect">),
    calls,
    released,
    client: () => latestClient,
  };
}

async function blocked(pool: pg.Pool, client: () => pg.PoolClient | undefined) {
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    const pid = (client() as unknown as { processID?: number })?.processID;
    if (pid) {
      const result = await pool.query(
        "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
        [pid],
      );
      if (result.rows[0]?.wait_event_type === "Lock") return;
    }
    await delay(5);
  }
  assert.fail("Fixture reader must actually wait for the PostgreSQL row lock");
}

it(
  "PostgreSQL warm metadata admission uses exactly three read and four begin round trips, not five plus seven",
  options,
  async () => {
    const f = await fixture(),
      owner = key();
    try {
      await f.clean(owner);
      const measured = counted(f.pool);
      const hint = await measured.store.read(owner, signal());
      const readCount = measured.calls.length;
      const lease = await measured.store.begin(owner, signal(), hint);
      const beginCount = measured.calls.length - readCount;
      console.log(
        JSON.stringify({
          event: "cost_plan_query_count_fixture",
          read_queries: readCount,
          warm_begin_queries: beginCount,
          pre_dispatch_queries: measured.calls.length,
          real_PostgreSQL: true,
        }),
      );
      assert.deepEqual(lease.plan, plan);
      assert.equal(readCount, 3);
      assert.equal(beginCount, 4);
      assert.equal(measured.calls.length, 7);
      assert.equal(
        measured.calls.filter((q) => q.text.includes("INSERT INTO")).length,
        0,
      );
      const starts = measured.calls.filter((q) => q.text.startsWith("BEGIN"));
      assert.equal(starts.length, 2);
      assert.ok(
        starts.every(
          (q) =>
            q.text ===
              "BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL statement_timeout = '20s'" &&
            !q.parameterized,
        ),
      );
      assert.ok(measured.released.every((x) => !x));
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL missing rows retain their extra clock read and only null or absent hints may initialize a row",
  options,
  async () => {
    const f = await fixture();
    try {
      const measured = counted(f.pool),
        missing = key();
      const empty = await measured.store.read(missing, signal());
      assert.equal(empty.plan, null);
      assert.equal(empty.generation, null);
      assert.equal(measured.calls.length, 4);
      assert.equal(
        measured.calls.filter((q) =>
          q.text.startsWith(
            "SELECT floor(extract(epoch FROM clock_timestamp())",
          ),
        ).length,
        1,
      );
      const knownZero = key();
      await assert.rejects(
        measured.store.begin(knownZero, signal(), {
          owner: knownZero,
          generation: "0",
          plan: null,
          remainingTtlMs: 0,
        }),
        { code: "VENUE_COST_PLAN_UNAVAILABLE" },
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [knownZero],
          )
        ).rows[0].n,
        0,
      );
      await f.pool.query(
        "INSERT INTO ride_agent_account_cost_plans(owner_key,contract) VALUES($1,$2)",
        [knownZero, ACCOUNT_OBSERVATION_COST_CONTRACT],
      );
      const zero = await measured.store.begin(knownZero, signal(), {
        owner: knownZero,
        generation: "0",
        plan: null,
        remainingTtlMs: 0,
      });
      assert.equal(zero.generation, "1");
      assert.equal(zero.plan, null);
      const initialized = await measured.store.begin(missing, signal(), empty);
      assert.equal(initialized.generation, "1");
      assert.equal(initialized.plan, null);
      assert.equal(
        (await measured.store.begin(key(), signal())).generation,
        "1",
      );
      const invalid = key();
      await assert.rejects(
        measured.store.begin(invalid, signal(), {
          owner: invalid,
          generation: "invalid",
          plan: null,
          remainingTtlMs: 0,
        }),
        { code: "VENUE_COST_PLAN_UNAVAILABLE" },
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [invalid],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL locked reads and claims evaluate TTL after the real lock wait, including an unchanged tuple",
  options,
  async () => {
    const f = await fixture(),
      owner = key(),
      blocker = await f.pool.connect();
    try {
      const hint = await f.clean(owner);
      await f.pool.query(
        "UPDATE ride_agent_account_cost_plans SET learned_at=clock_timestamp()-interval '10 minutes'+interval '250 milliseconds' WHERE owner_key=$1",
        [owner],
      );
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE",
        [owner],
      );
      const reading = counted(f.pool),
        claiming = counted(f.pool);
      const read = reading.store.read(owner, signal());
      const claim = claiming.store.begin(owner, signal(), hint).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await Promise.all([
        blocked(f.pool, reading.client),
        blocked(f.pool, claiming.client),
      ]);
      await delay(300);
      await blocker.query("ROLLBACK");
      assert.equal((await read).plan, null);
      const result = await claim;
      assert.ok("error" in result);
      assert.equal(
        (result as { error: { code: string } }).error.code,
        "VENUE_COST_PLAN_UNAVAILABLE",
      );
      const current = (
        await f.pool.query(
          "SELECT generation::text,dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0];
      assert.deepEqual(current, { generation: hint.generation, dirty: false });
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await f.close();
    }
  },
);

it(
  "PostgreSQL an unchanged locked dirty tuple becomes claimable only after its actual lease expires",
  options,
  async () => {
    const f = await fixture(),
      owner = key(),
      blocker = await f.pool.connect();
    try {
      const lease = await f.store.begin(owner, signal(), undefined, 250);
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE",
        [owner],
      );
      const measured = counted(f.pool);
      const claiming = measured.store.begin(owner, signal(), {
        ...lease,
        remainingTtlMs: 0,
      });
      await blocked(f.pool, measured.client);
      await delay(300);
      await blocker.query("ROLLBACK");
      const next = await claiming;
      assert.equal(next.plan, null);
      assert.equal(BigInt(next.generation), BigInt(lease.generation) + 1n);
      assert.equal(await f.store.complete(lease, plan, signal()), false);
      assert.equal(await f.store.complete(next, plan, signal()), true);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await f.close();
    }
  },
);

it(
  "PostgreSQL materialized locked rows retain EPQ generation/plan validation and do not recreate a deleted warm identity",
  options,
  async () => {
    const f = await fixture(),
      owner = key(),
      blocker = await f.pool.connect();
    try {
      const hint = await f.clean(owner);
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE ride_agent_account_cost_plans SET generation=generation+1,demand=220,peaks='[200]'::jsonb WHERE owner_key=$1",
        [owner],
      );
      const measured = counted(f.pool);
      const claiming = measured.store.begin(owner, signal(), hint).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await blocked(f.pool, measured.client);
      await blocker.query("COMMIT");
      const result = await claiming;
      assert.ok("error" in result);
      assert.equal(
        (result as { error: { code: string } }).error.code,
        "VENUE_COST_PLAN_UNAVAILABLE",
      );
      const changed = await f.store.read(owner, signal());
      assert.deepEqual(changed.plan, { demand: 220, peaks: [200] });
      assert.equal(BigInt(changed.generation!), BigInt(hint.generation!) + 1n);
      await assert.rejects(
        f.store.begin(owner, signal(), { ...changed, plan }),
        { code: "VENUE_COST_PLAN_UNAVAILABLE" },
      );
      await blocker.query("BEGIN");
      await blocker.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      const deleting = counted(f.pool);
      const deletedClaim = deleting.store.begin(owner, signal(), changed).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await blocked(f.pool, deleting.client);
      await blocker.query("COMMIT");
      assert.ok("error" in (await deletedClaim));
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [owner],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        deleting.calls.some((q) => q.text.includes("INSERT INTO")),
        false,
      );
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await f.close();
    }
  },
);

it(
  "PostgreSQL startup, socket/drop, invalid clocks and unknown commits destroy sessions without returning an unacknowledged claim or clean",
  options,
  async () => {
    const f = await fixture(),
      owner = key();
    try {
      const hint = await f.clean(owner);
      const startup = counted(f.pool, (c, text, values) =>
        c.query(
          text.startsWith("BEGIN") ? text + "; SELECT 1/0" : text,
          values,
        ),
      );
      await assert.rejects(startup.store.read(owner, signal()), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      assert.deepEqual(startup.released, [true]);
      const invalidClock = counted(f.pool, async (c, text, values) => {
        const result = await c.query(text, values);
        if (
          text.startsWith("SELECT floor(extract(epoch FROM clock_timestamp())")
        )
          return {
            ...result,
            rows: result.rows.map((r) => ({ ...r, current_ms: "0" })),
          };
        return result;
      });
      await assert.rejects(invalidClock.store.read(key(), signal()), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      assert.deepEqual(invalidClock.released, [true]);
      assert.equal(
        invalidClock.calls.filter((q) =>
          q.text.startsWith(
            "SELECT floor(extract(epoch FROM clock_timestamp())",
          ),
        ).length,
        1,
        "The empty-row fallback itself must reject an invalid clock",
      );
      const invalidRowClock = counted(f.pool, async (c, text, values) => {
        const result = await c.query(text, values);
        return text.includes(" AS current_ms")
          ? {
              ...result,
              rows: result.rows.map((r) => ({ ...r, current_ms: "invalid" })),
            }
          : result;
      });
      await assert.rejects(invalidRowClock.store.read(owner, signal()), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      assert.deepEqual(invalidRowClock.released, [true]);
      const socket = counted(f.pool, (c, text, values) => {
        const pending = c.query(text, values);
        if (text.includes("FOR UPDATE"))
          (c as any).connection.stream.destroy(
            new Error("fixture socket loss"),
          );
        return pending;
      });
      await assert.rejects(socket.store.read(owner, signal()), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      assert.deepEqual(socket.released, [true]);
      const ack = counted(f.pool, async (c, text, values) => {
        const result = await c.query(text, values);
        if (text === "COMMIT")
          throw new Error(
            "fixture lost acknowledgment after actual database commit",
          );
        return result;
      });
      let returned = false;
      await assert.rejects(
        ack.store.begin(owner, signal(), hint).then(() => {
          returned = true;
        }),
        { code: "VENUE_COST_PLAN_UNAVAILABLE" },
      );
      assert.equal(returned, false);
      assert.deepEqual(ack.released, [true]);
      assert.equal(
        (
          await f.pool.query(
            "SELECT dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [owner],
          )
        ).rows[0].dirty,
        true,
      );
      await assert.rejects(f.store.begin(owner, signal(), hint), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      const other = key();
      const acknowledgedLease = await f.store.begin(other, signal());
      let cleanReturned = false;
      await assert.rejects(
        ack.store.complete(acknowledgedLease, plan, signal()).then(() => {
          cleanReturned = true;
        }),
        { code: "VENUE_COST_PLAN_UNAVAILABLE" },
      );
      assert.equal(cleanReturned, false);
      assert.deepEqual(ack.released, [true, true]);
      // Actual COMMIT is not fabricated away or replayed after the injected
      // lost acknowledgment, but the caller never receives a success result.
      assert.equal(
        (
          await f.pool.query(
            "SELECT dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [other],
          )
        ).rows[0].dirty,
        false,
      );
      await f.pool.query("DROP TABLE ride_agent_account_cost_plans");
      const dropped = counted(f.pool);
      await assert.rejects(dropped.store.read(owner, signal()), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      assert.deepEqual(dropped.released, [true]);
    } finally {
      await f.close();
    }
  },
);

it(
  "PostgreSQL an aborted materialized lock wait destroys the session without changing the plan",
  options,
  async () => {
    const f = await fixture(),
      owner = key(),
      blocker = await f.pool.connect();
    try {
      const hint = await f.clean(owner);
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT 1 FROM ride_agent_account_cost_plans WHERE owner_key=$1 FOR UPDATE",
        [owner],
      );
      const measured = counted(f.pool),
        control = new AbortController();
      const waiting = measured.store.begin(owner, control.signal, hint);
      await blocked(f.pool, measured.client);
      control.abort();
      await assert.rejects(waiting, { code: "VENUE_COST_PLAN_UNAVAILABLE" });
      assert.deepEqual(measured.released, [true]);
      await blocker.query("ROLLBACK");
      assert.deepEqual((await f.store.read(owner, signal())).plan, plan);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await f.close();
    }
  },
);

it(
  "PostgreSQL real packets under a declared 100ms synthetic RTT use seven warm admission round trips without changing the plan",
  options,
  async () => {
    const f = await fixture(),
      owner = key();
    const sockets = new Set<net.Socket>(),
      timers = new Set<ReturnType<typeof setTimeout>>();
    const proxy = net.createServer((downstream) => {
      const upstream = net.connect({
        host: f.url.hostname,
        port: Number(f.url.port || 5432),
      });
      for (const [from, to] of [
        [downstream, upstream],
        [upstream, downstream],
      ]) {
        sockets.add(from);
        from.on("error", () => to.destroy());
        from.on("close", () => {
          sockets.delete(from);
          to.destroy();
        });
        from.on("data", (chunk) => {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!to.destroyed) to.write(chunk);
          }, 50);
          timers.add(timer);
        });
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    const url = new URL(f.url);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    const pool = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      await f.clean(owner);
      // Warm the one physical connection before timing. Both directions forward
      // actual PostgreSQL packets with a fixed, declared 50ms latency, no mocks.
      const connection = await pool.connect();
      connection.release();
      const measured = counted(pool),
        began = performance.now();
      const hint = await measured.store.read(owner, signal());
      const lease = await measured.store.begin(owner, signal(), hint);
      const elapsed = performance.now() - began;
      console.log(
        JSON.stringify({
          event: "cost_plan_declared_RTT_fixture",
          roundtrips: measured.calls.length,
          injected_one_way_ms: 50,
          declared_RTT_ms: 100,
          warm_read_begin_wall_ms: Math.round(elapsed),
          actual_PostgreSQL_packets: true,
          not_production_latency_or_SLO_proof: true,
        }),
      );
      assert.deepEqual(lease.plan, plan);
      assert.equal(measured.calls.length, 7);
      assert.ok(
        elapsed >= 650,
        "seven sequential actual round trips retain the injected delay",
      );
    } finally {
      await pool.end();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await f.close();
    }
  },
);
