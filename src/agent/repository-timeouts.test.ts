import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import pg from "pg";
import {
  PgRepository,
  MemoryRepository,
  emptyState,
  Cursor,
} from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService } from "./service.js";
import { FakeAdapter } from "./fixtures.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;

async function until(check: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await delay(20);
  } while (Date.now() < end);
  assert.fail("Timed out waiting for the isolated PostgreSQL lock condition");
}

async function pausedFixture(transportOnly: boolean) {
  const admin = new pg.Pool({
    connectionString: database,
    max: 2,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
  });
  const repo = new PgRepository(database!, {
    statementTimeoutMs: transportOnly ? 1000 : 5000,
    queryTimeoutMs: transportOnly ? 4000 : 8000,
  });
  await admin.query(
    "CREATE TABLE IF NOT EXISTS ride_agent_state (user_id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const user = `paused_${randomUUID()}`;
  // Linux Docker TCP forwarding can buffer the reported 5.55 MB entirely.
  // Exceed those buffers so the test must reach real server ClientWrite.
  const state = {
    ...emptyState(),
    fixture_padding: "x".repeat(24 * 1024 * 1024),
  };
  await admin.query(
    "INSERT INTO ride_agent_state (user_id,state) VALUES ($1,$2)",
    [user, state],
  );
  let pid = 0,
    stream: any,
    callbackRan = false,
    settled = false;
  const connect = repo.pool.connect.bind(repo.pool);
  (repo.pool as any).connect = async () => {
    const client = await connect();
    (repo.pool as any).connect = connect;
    pid = (client as any).processID;
    if (transportOnly) await client.query("SET statement_timeout = 0");
    const query = client.query.bind(client);
    (client as any).query = (text: any, ...args: any[]) => {
      if (
        typeof text === "string" &&
        text.includes("SELECT state") &&
        text.endsWith("FOR UPDATE")
      ) {
        stream = (client as any).connection.stream;
        stream.pause();
      }
      return (query as any)(text, ...args);
    };
    return client;
  };
  const work = repo.transact(user, async () => {
    callbackRan = true;
  });
  const outcome = work.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  const hasLock = async () => {
    try {
      await admin.query(
        "SELECT user_id FROM ride_agent_state WHERE user_id=$1 FOR UPDATE NOWAIT",
        [user],
      );
      return false;
    } catch (error: any) {
      if (error.code === "55P03") return true;
      throw error;
    }
  };
  return {
    admin,
    repo,
    user,
    work,
    outcome,
    hasLock,
    get pid() {
      return pid;
    },
    get callbackRan() {
      return callbackRan;
    },
    get settled() {
      return settled;
    },
    resume() {
      stream?.resume();
    },
    async observedClientWrite() {
      await until(async () => {
        if (!pid) return false;
        const row = (
          await admin.query(
            "SELECT state,wait_event FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0];
        return row?.state === "active" && row.wait_event === "ClientWrite";
      }, 3000);
      assert.equal(await hasLock(), true);
    },
    async close() {
      stream?.destroy();
      await outcome;
      await repo.close();
      await admin.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
        user,
      ]);
      await admin.end();
    },
  };
}

it("sets bounded database and transport deadlines and rejects invalid timeout ordering", () => {
  for (const options of [
    { statementTimeoutMs: 0 },
    { statementTimeoutMs: -1 },
    { queryTimeoutMs: Infinity },
    { statementTimeoutMs: 20, queryTimeoutMs: 20 },
  ])
    assert.throws(
      () => new PgRepository("postgresql://unused", options),
      RangeError,
    );
  const repo = new PgRepository("postgresql://unused");
  assert.equal((repo.pool.options as any).statement_timeout, 20000);
  assert.equal((repo.pool.options as any).query_timeout, 25000);
  return repo.close();
});

it(
  "shutdown closes a real paused large state read before its driver deadline and releases its row lock without running the callback",
  { skip: !database },
  async () => {
    const f = await pausedFixture(false);
    try {
      await f.observedClientWrite();
      assert.equal(f.settled, false);
      const closing = f.repo.close();
      await Promise.race([
        closing,
        delay(2000).then(() => {
          throw new Error("Shutdown exceeded its pre-driver deadline");
        }),
      ]);
      const error = await f.outcome;
      assert.match(String(error), /connection terminated/i);
      assert.equal(f.callbackRan, false);
      await assert.rejects(
        f.repo.transact(f.user, async () => {}),
        /closing/,
      );
      await until(async () => !(await f.hasLock()));
      await until(
        async () =>
          (
            await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
              f.pid,
            ])
          ).rowCount === 0,
      );
      assert.equal(f.repo.pool.totalCount, 0);
    } finally {
      await f.close();
    }
  },
);

it(
  "the transport watchdog destroys a stalled transaction connection, releases its real row lock and never runs its state callback",
  { skip: !database },
  async () => {
    const f = await pausedFixture(true);
    try {
      await f.observedClientWrite();
      const error = await f.outcome;
      assert.match(String(error), /query read timeout/i);
      assert.equal(f.callbackRan, false);
      assert.equal(f.repo.pool.totalCount, 0);
      await until(async () => !(await f.hasLock()));
      await until(
        async () =>
          (
            await f.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
              f.pid,
            ])
          ).rowCount === 0,
      );
      // A new connection can read the identical row; no poisoned session was
      // returned to the pool and no failed transition was persisted.
      const row = await f.repo.read(f.user);
      assert.equal(row.portfolios.length, 0);
    } finally {
      await f.close();
    }
  },
);

it(
  "shutdown lets an already-entered transaction callback commit once without starting another transaction",
  { skip: !database },
  async () => {
    const repo = new PgRepository(database!),
      admin = new pg.Pool({ connectionString: database, query_timeout: 5000 }),
      user = `shutdown_${randomUUID()}`;
    await repo.migrate();
    let enter!: () => void,
      finish!: () => void,
      closed = false,
      callbacks = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = repo.transact(user, async (state) => {
      callbacks++;
      enter();
      await gate;
      state.preference_draft = { budget_usdc: "20" };
    });
    try {
      await entered;
      const closing = repo.close().then(() => {
        closed = true;
      });
      await delay(10);
      assert.equal(closed, false);
      await assert.rejects(
        repo.transact(user, async () => {
          callbacks++;
        }),
        /closing/,
      );
      finish();
      await work;
      await closing;
      assert.equal(callbacks, 1);
      assert.equal(
        (
          await admin.query(
            "SELECT state->'preference_draft'->>'budget_usdc' AS budget FROM ride_agent_state WHERE user_id=$1",
            [user],
          )
        ).rows[0].budget,
        "20",
      );
    } finally {
      finish();
      await work.catch(() => {});
      await repo.close();
      await admin.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
        user,
      ]);
      await admin.end();
    }
  },
);

it(
  "a checked-out socket failure during a callback rejects the transaction without an unhandled client error or a state write",
  { skip: !database },
  async () => {
    const repo = new PgRepository(database!),
      admin = new pg.Pool({ connectionString: database, query_timeout: 5000 }),
      user = `socket_failure_${randomUUID()}`;
    await repo.migrate();
    let pid = 0,
      enter!: () => void,
      finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const connect = repo.pool.connect.bind(repo.pool);
    (repo.pool as any).connect = async () => {
      const client = await connect();
      (repo.pool as any).connect = connect;
      pid = (client as any).processID;
      return client;
    };
    const work = repo.transact(user, async (state) => {
      enter();
      await gate;
      state.preference_draft = { budget_usdc: "99" };
    });
    const outcome = work.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered;
      // Only this disposable test connection in the isolated test database.
      assert.equal(
        (
          await admin.query("SELECT pg_terminate_backend($1) AS terminated", [
            pid,
          ])
        ).rows[0].terminated,
        true,
      );
      await until(
        async () =>
          (
            await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
              pid,
            ])
          ).rowCount === 0,
      );
      finish();
      assert.match(
        String(await outcome),
        /terminating connection|connection terminated/i,
      );
      assert.equal(
        (
          await admin.query("SELECT 1 FROM ride_agent_state WHERE user_id=$1", [
            user,
          ])
        ).rowCount,
        0,
      );
      assert.equal(repo.pool.totalCount, 0);
    } finally {
      finish();
      await outcome;
      await repo.close();
      await admin.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
        user,
      ]);
      await admin.end();
    }
  },
);

it("shutdown finishes the current monitoring user and does not start another user or wait another scheduler interval", async () => {
  const repo = new MemoryRepository(),
    controller = new AbortController();
  repo.users = async () => ["first", "second"];
  const service = new AgentService(
    repo,
    new FakeAdapter(),
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  const runner = new AgentRunner(service),
    calls: string[] = [];
  runner.tick = async (user) => {
    calls.push(user);
    controller.abort();
  };
  await runner.run(controller.signal, 60_000);
  assert.deepEqual(calls, ["first"]);
});

it(
  "the database deadline still cancels ordinary active SQL with a responsive client",
  { skip: !database },
  async () => {
    const repo = new PgRepository(database!, {
      statementTimeoutMs: 100,
      queryTimeoutMs: 1000,
    });
    try {
      await assert.rejects(repo.pool.query("SELECT pg_sleep(3)"), {
        code: "57014",
      });
    } finally {
      await repo.close();
    }
  },
);
