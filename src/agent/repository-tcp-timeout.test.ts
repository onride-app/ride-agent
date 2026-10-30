import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { it, type TestContext } from "node:test";
import pg from "pg";
import { PgRepository, emptyState } from "./repository.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const enabled = { skip: !database };
const guardMs = 20000;
const previousOptions = process.env.PGOPTIONS;
async function settings(repo: PgRepository) {
  return (
    await repo.pool.query<{
      tcp: string;
      path: string;
      app: string;
      transaction: string;
      version: string;
      pid: number;
    }>(
      "SELECT (SELECT setting FROM pg_catalog.pg_settings WHERE name='tcp_user_timeout') AS tcp, current_setting('search_path') AS path, current_setting('application_name') AS app, current_setting('transaction_timeout',true) AS transaction, version() AS version, pg_backend_pid() AS pid",
    )
  ).rows[0];
}
function expectedForServer(row: { version: string }, requested = guardMs) {
  return /darwin/i.test(row.version) ? "0" : String(requested);
}
async function until(check: () => Promise<boolean>, timeout = 5000) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return true;
    await delay(20);
  } while (Date.now() < end);
  return false;
}
function optionsUrl(options: string) {
  const url = new URL(database!);
  url.searchParams.set("options", options);
  return url.toString();
}

for (const value of [0, 60000, 500])
  it(
    `preserves URL options and caps effective TCP ${value}ms without relaxing a stricter value`,
    enabled,
    async (t) => {
      t.after(() => {
        if (previousOptions === undefined) delete process.env.PGOPTIONS;
        else process.env.PGOPTIONS = previousOptions;
      });
      process.env.PGOPTIONS =
        "-c search_path=ignored_env,public -c application_name=ignored-env -c tcp_user_timeout=0";
      const repo = new PgRepository(
        optionsUrl(
          `-c search_path=url_keep,public -c application_name=url-keep -c tcp_user_timeout=${value}`,
        ),
      );
      try {
        const row = await settings(repo);
        assert.equal(row.path, "url_keep,public");
        assert.equal(row.app, "url-keep");
        assert.equal(
          row.transaction,
          "0",
          "no transaction wall timer is introduced",
        );
        assert.equal(
          row.tcp,
          expectedForServer(
            row,
            value > 0 ? Math.min(value, guardMs) : guardMs,
          ),
        );
      } finally {
        await repo.close();
      }
    },
  );

it(
  "preserves PGOPTIONS escaped values and the original URL-over-environment precedence",
  enabled,
  async (t) => {
    t.after(() => {
      if (previousOptions === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previousOptions;
    });
    process.env.PGOPTIONS =
      "-c search_path=env_keep,public -c application_name=env\\ name -c tcp_user_timeout=0";
    const url = new URL(database!);
    url.searchParams.delete("options");
    const repo = new PgRepository(url.toString());
    try {
      const row = await settings(repo);
      assert.equal(row.path, "env_keep,public");
      assert.equal(row.app, "env name");
      assert.equal(row.tcp, expectedForServer(row));
    } finally {
      await repo.close();
    }
  },
);

it(
  "configures every new connection before checkout and reuses an idle connection without another initialization query",
  enabled,
  async () => {
    const repo = new PgRepository(optionsUrl("-c tcp_user_timeout=0"));
    const original = repo.pool.options.onConnect;
    assert.equal(typeof original, "function");
    let initialized = 0;
    repo.pool.options.onConnect = async (client) => {
      await original!(client);
      initialized++;
    };
    try {
      const first = await settings(repo),
        reused = await settings(repo);
      assert.equal(first.tcp, expectedForServer(first));
      assert.equal(reused.tcp, first.tcp);
      assert.equal(reused.pid, first.pid);
      assert.equal(initialized, 1);
      const client = await repo.pool.connect();
      client.release(true);
      const fresh = await settings(repo);
      assert.notEqual(fresh.pid, first.pid);
      assert.equal(fresh.tcp, expectedForServer(fresh));
      assert.equal(initialized, 2);
    } finally {
      await repo.close();
    }
  },
);

it(
  "does not hand an initialization-failed connection to a financial state callback",
  enabled,
  async () => {
    const repo = new PgRepository(database!),
      failure = new Error("fixture TCP setup failure");
    const original = repo.pool.options.onConnect;
    assert.equal(typeof original, "function");
    repo.pool.options.onConnect = async (client) => {
      client.query = (() => Promise.reject(failure)) as typeof client.query;
      await original!(client);
    };
    let callbacks = 0;
    try {
      await assert.rejects(
        repo.transact(`setup_failure_${randomUUID()}`, async () => {
          callbacks++;
        }),
        (error) => error === failure,
      );
      assert.equal(callbacks, 0);
      assert.equal(repo.pool.totalCount, 0);
    } finally {
      await repo.close();
    }
  },
);

it(
  "rejects a real initialization socket failure and recovers idle failures without uncaught pool errors or throwing diagnostics",
  enabled,
  async () => {
    // A child process proves that an unhandled pool 'error' cannot terminate
    // the backend. Keep its raw driver stderr (which can contain credentials)
    // out of assertion output, even when this regression is RED.
    const script = `
      import { PgRepository } from ${JSON.stringify(new URL("./repository.ts", import.meta.url).href)};
      import { setTimeout as delay } from 'node:timers/promises';
      const repo = new PgRepository(process.env.RIDE_AGENT_TEST_DATABASE_URL);
      const original = repo.pool.options.onConnect;
      const failure = new Error('fixture initialization socket failure');
      const diagnostics = [];
      console.error = (...args) => diagnostics.push(args);
      repo.pool.options.onConnect = async client => {
        const query = client.query.bind(client);
        client.query = (...args) => {
          if (typeof args[0] === 'string' && args[0].includes('tcp_user_timeout'))
            client.connection.stream.destroy(failure);
          return query(...args);
        };
        await original(client);
      };
      let callbacks = 0, rejected = false;
      try { await repo.transact('init_network_fixture', async () => { callbacks++; }); }
      catch (error) { rejected = error === failure; }
      const failedPoolEmpty = repo.pool.totalCount === 0;
      repo.pool.options.onConnect = original;
      const first = await repo.pool.query("SELECT setting AS tcp, version() AS version FROM pg_catalog.pg_settings WHERE name='tcp_user_timeout'");
      const client = await repo.pool.connect();
      client.release();
      console.error = () => { throw new Error('fixture diagnostic sink unavailable'); };
      client.connection.stream.destroy(new Error('fixture idle socket failure'));
      await delay(30);
      const idlePurged = repo.pool.totalCount === 0;
      const recovered = await repo.pool.query("SELECT setting AS tcp FROM pg_catalog.pg_settings WHERE name='tcp_user_timeout'");
      await repo.close();
      process.stdout.write(JSON.stringify({
        rejected, callbacks, failedPoolEmpty, idlePurged,
        firstTcp: first.rows[0].tcp, recoveredTcp: recovered.rows[0].tcp,
        unsupported: /darwin/i.test(first.rows[0].version),
        diagnostics: diagnostics.length === 1 && diagnostics[0].length === 1 && diagnostics[0][0] === 'Rider database pool connection failed.',
      }));
    `;
    const result = await new Promise<{
      success: boolean;
      unhandledPoolError: boolean;
      output: string;
    }>((resolve) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", script],
        { env: process.env, timeout: 10000 },
        (error, stdout, stderr) =>
          resolve({
            success: !error,
            unhandledPoolError: stderr.includes("Unhandled 'error' event"),
            output: stdout,
          }),
      );
    });
    assert.deepEqual(
      {
        success: result.success,
        unhandledPoolError: result.unhandledPoolError,
      },
      { success: true, unhandledPoolError: false },
    );
    const observed = JSON.parse(result.output);
    assert.deepEqual(observed, {
      rejected: true,
      callbacks: 0,
      failedPoolEmpty: true,
      idlePurged: true,
      firstTcp: observed.unsupported ? "0" : String(guardMs),
      recoveredTcp: observed.unsupported ? "0" : String(guardMs),
      unsupported: observed.unsupported,
      diagnostics: true,
    });
  },
);

it(
  "does not enter a state callback or reenter checkout when shutdown races with connection initialization",
  enabled,
  async () => {
    const repo = new PgRepository(database!),
      original = repo.pool.options.onConnect;
    assert.equal(typeof original, "function");
    let enter!: () => void,
      release!: () => void,
      callbacks = 0,
      closed = false;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    repo.pool.options.onConnect = async (client) => {
      await original!(client);
      enter();
      await gate;
    };
    const work = repo
      .transact(`setup_close_${randomUUID()}`, async () => {
        callbacks++;
      })
      .catch((error: unknown) => error);
    try {
      await entered;
      const closing = repo.close().then(() => {
        closed = true;
      });
      await delay(20);
      assert.equal(closed, false);
      assert.equal(callbacks, 0);
      release();
      assert.match(String(await work), /closing/);
      await closing;
      assert.equal(callbacks, 0);
      assert.equal(repo.pool.totalCount, 0);
    } finally {
      release();
      await work;
      await repo.close();
    }
  },
);

it(
  "retains the real committed state after a lost COMMIT acknowledgment without rerunning its callback",
  enabled,
  async () => {
    const repo = new PgRepository(database!),
      user = `tcp_commit_ack_${randomUUID()}`;
    const lostAck = new Error("fixture lost COMMIT acknowledgment");
    let callbacks = 0;
    try {
      await repo.migrate();
      await repo.transact(user, async (state) => {
        state.updates.push({
          id: "original_event",
          at: Date.now(),
          kind: "fixture",
          portfolio_id: null,
          message: "Original immutable fixture",
          data: {},
          notification: "pending",
        });
      });
      const expected = await repo.read(user);
      expected.preference_draft = { budget_usdc: "20" };
      const connect = repo.pool.connect.bind(repo.pool);
      repo.pool.connect = (async () => {
        const client = await connect();
        repo.pool.connect = connect;
        const query = client.query.bind(client);
        client.query = ((text: unknown, ...args: unknown[]) => {
          const result = (query as (...args: unknown[]) => Promise<unknown>)(
            text,
            ...args,
          );
          return text === "COMMIT"
            ? result.then(() => {
                throw lostAck;
              })
            : result;
        }) as typeof client.query;
        return client;
      }) as typeof repo.pool.connect;
      await assert.rejects(
        repo.transact(user, async (state) => {
          callbacks++;
          state.preference_draft = { budget_usdc: "20" };
        }),
        (error) => error === lostAck,
      );
      assert.equal(callbacks, 1);
      assert.equal(
        repo.pool.totalCount,
        0,
        "ambiguous transport session is discarded",
      );
      assert.deepEqual(
        await repo.read(user),
        expected,
        "no rollback fabrication, new event ID or blind callback replay",
      );
    } finally {
      await repo.pool.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
        user,
      ]);
      await repo.close();
    }
  },
);

it(
  "releases a real server ClientWrite row lock under the default 20s TCP bound while the client remains paused",
  { ...enabled, timeout: 40000 },
  async (t: TestContext) => {
    const repo = new PgRepository(database!, {
      statementTimeoutMs: 40000,
      queryTimeoutMs: 60000,
    });
    const admin = new pg.Pool({
      connectionString: database,
      max: 2,
      query_timeout: 5000,
    });
    const user = `tcp_boundary_${randomUUID()}`;
    let stream: { pause(): void; destroy(): void } | undefined,
      pid = 0,
      callbackRan = false,
      settled = false;
    let work: Promise<unknown> | undefined;
    try {
      const capability = await settings(repo);
      if (/darwin/i.test(capability.version)) {
        assert.equal(capability.tcp, "0");
        t.skip(
          "Darwin server reports effective0: TCP_USER_TIMEOUT is unsupported; this is not server-side protection proof",
        );
        return;
      }
      assert.equal(capability.tcp, String(guardMs));
      await repo.migrate();
      await admin.query(
        "INSERT INTO ride_agent_state(user_id,state) VALUES ($1,$2)",
        [
          user,
          { ...emptyState(), fixture_padding: "x".repeat(24 * 1024 * 1024) },
        ],
      );
      const connect = repo.pool.connect.bind(repo.pool);
      repo.pool.connect = (async () => {
        const client = await connect();
        repo.pool.connect = connect;
        pid = (client as unknown as { processID: number }).processID;
        const query = client.query.bind(client);
        client.query = ((text: unknown, ...args: unknown[]) => {
          if (
            typeof text === "string" &&
            text.includes("SELECT state") &&
            text.endsWith("FOR UPDATE")
          ) {
            stream = (
              client as unknown as { connection: { stream: typeof stream } }
            ).connection.stream;
            stream!.pause();
          }
          return (query as (...args: unknown[]) => unknown)(text, ...args);
        }) as typeof client.query;
        return client;
      }) as typeof repo.pool.connect;
      const started = Date.now();
      work = repo
        .transact(user, async () => {
          callbackRan = true;
        })
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      const activity = async () =>
        (
          await admin.query(
            "SELECT state,wait_event FROM pg_stat_activity WHERE pid=$1",
            [pid],
          )
        ).rows[0];
      const locked = async () => {
        try {
          await admin.query(
            "SELECT 1 FROM ride_agent_state WHERE user_id=$1 FOR UPDATE NOWAIT",
            [user],
          );
          return false;
        } catch (error: unknown) {
          if ((error as { code?: string }).code === "55P03") return true;
          throw error;
        }
      };
      assert.equal(
        await until(
          async () =>
            pid > 0 && (await activity())?.wait_event === "ClientWrite",
          5000,
        ),
        true,
      );
      assert.equal(await locked(), true);
      assert.equal(
        await until(async () => !(await activity()), 27000),
        true,
        "server must reclaim the connection independently of client driver/close/terminate",
      );
      assert.equal(callbackRan, false);
      assert.equal(
        settled,
        false,
        "driver60s has not fired; the still-paused client has not completed its SELECT",
      );
      assert.equal(await locked(), false);
      t.diagnostic(
        JSON.stringify({
          tcp_user_timeout_ms: guardMs,
          serverReleasedMs: Date.now() - started,
          callbackRan,
          clientStillPaused: true,
          serverPidGone: true,
        }),
      );
    } finally {
      stream?.destroy();
      await work;
      if (
        pid &&
        !(await until(
          async () =>
            (
              await admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1", [
                pid,
              ])
            ).rowCount === 0,
          2000,
        ))
      )
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      if (work)
        await admin.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
          user,
        ]);
      await repo.close();
      await admin.end();
    }
  },
);

it(
  "allows a healthy already-entered financial callback to exceed the TCP bound and commit once",
  { ...enabled, timeout: 40000 },
  async (t: TestContext) => {
    const repo = new PgRepository(database!),
      user = `tcp_long_callback_${randomUUID()}`;
    let callbacks = 0,
      initialized = false;
    try {
      const capability = await settings(repo);
      if (/darwin/i.test(capability.version)) {
        assert.equal(capability.tcp, "0");
        t.skip(
          "Darwin effective0 is unsupported; cannot prove healthy callback behavior under a20s TCP bound here",
        );
        return;
      }
      assert.equal(capability.tcp, String(guardMs));
      assert.equal(capability.transaction, "0");
      await repo.migrate();
      initialized = true;
      const started = Date.now();
      await repo.transact(user, async (state) => {
        callbacks++;
        await delay(guardMs + 1000);
        state.preference_draft = { budget_usdc: "20" };
      });
      assert.equal(callbacks, 1);
      assert.equal((await repo.read(user)).preference_draft?.budget_usdc, "20");
      t.diagnostic(
        JSON.stringify({
          tcp_user_timeout_ms: guardMs,
          callbackWallMs: Date.now() - started,
          callbacks,
          commitSucceeded: true,
        }),
      );
    } finally {
      if (initialized)
        await repo.pool.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
          user,
        ]);
      await repo.close();
    }
  },
);
