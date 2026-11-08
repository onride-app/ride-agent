import test from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import pg from "pg";
import { acquireMonitorLease } from "./app_runtime.js";
import { startManagedBackend } from "./agent/backend.js";
import { startManagedCoreBridge } from "./agent/core_bridge.js";

const database = process.env.RIDE_AGENT_RUNTIME_TEST_DATABASE_URL;
if (database) {
  const u = new URL(database);
  if (u.hostname !== "127.0.0.1" || u.pathname !== "/ride_runtime_test")
    throw Error(
      "Runtime PG fixtures require the dedicated local ride_runtime_test database",
    );
}
const options = { skip: !database, timeout: 15_000 };
const fixtureEnv = () => ({
  RIDE_AGENT_ENABLED: "true",
  RIDE_AGENT_READ_ONLY: "true",
  RIDE_AGENT_APP_RUNTIME_ENABLED: "true",
  RIDE_AGENT_INTERNAL_ONLY: "true",
  RIDE_AGENT_APP_SESSION_STORE_ENABLED: "false",
  RIDE_AGENT_DATABASE_URL: database!,
  RIDE_AGENT_EXECUTOR_TOKEN: "runtime-test-only-token-0000000000000000",
  RIDE_AGENT_CORE_SERVICE_TOKEN: "runtime-test-only-core-0000000000000000",
  RIDE_AGENT_TRADER_ID_SALT: "runtime-test-only-salt-0000000000000000",
  RIDE_AGENT_CURSOR_KEY: "runtime-test-only-cursor-0000000000000000",
  RIDE_AGENT_CORE_URL: "http://127.0.0.1:9",
  RIDE_GRAPHQL_URL: "http://127.0.0.1:9/graphql",
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  RIDE_AGENT_INFO_READ_ROUTE: "official",
  RIDE_AGENT_NETWORK: "testnet",
  RIDE_AGENT_POLYGON_RPC_URL: "",
  DOTENV_CONFIG_PATH: "/dev/null",
});
const readStatus = (port: number, path: string) =>
  new Promise<number>((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode!));
    });
    req.once("error", reject);
  });
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test(
  "local PG monitor session lock rejects a second owner and releases after close",
  options,
  async () => {
    const first = await acquireMonitorLease(database!);
    try {
      await assert.rejects(
        acquireMonitorLease(database!),
        /Another App Agent monitor/,
      );
    } finally {
      await first.release();
    }
    const next = await acquireMonitorLease(database!);
    await next.release();
  },
);

test(
  "actual managed bridge and read-only backend bind loopback, authenticate and drain without financial reads",
  options,
  async () => {
    const saved = { ...process.env };
    Object.assign(process.env, fixtureEnv());
    const originalFetch = globalThis.fetch;
    let externalReads = 0;
    globalThis.fetch = async () => {
      externalReads++;
      throw Error("External reads forbidden in runtime fixture");
    };
    let bridge: Awaited<ReturnType<typeof startManagedCoreBridge>> | undefined;
    let backend: Awaited<ReturnType<typeof startManagedBackend>> | undefined;
    try {
      bridge = await startManagedCoreBridge({ host: "127.0.0.1", port: 0 });
      const b = bridge.listener.address();
      assert.ok(b && typeof b !== "string");
      assert.equal(b.address, "127.0.0.1");
      backend = await startManagedBackend({
        host: "127.0.0.1",
        port: 0,
        executorUrl: `http://127.0.0.1:${b.port}`,
      });
      const a = backend.listener.address();
      assert.ok(a && typeof a !== "string");
      assert.equal(a.address, "127.0.0.1");
      assert.equal(await readStatus(b.port, "/health"), 200);
      assert.equal(await readStatus(a.port, "/health"), 200);
      assert.equal(await readStatus(a.port, "/agent/v1/get_portfolio"), 401);
      await backend.close();
      await backend.closed;
      backend = undefined;
      await bridge.close();
      await bridge.closed;
      bridge = undefined;
      assert.equal(externalReads, 0);
    } finally {
      await backend?.close().catch(() => {});
      await bridge?.close().catch(() => {});
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env))
        if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  },
);

test(
  "actual read-only App child publishes ready then stdin EOF drains and releases monitor lease",
  options,
  async () => {
    const backendPort = await freePort(),
      bridgePort = await freePort();
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/app_runtime.ts"],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...fixtureEnv(),
          RIDE_AGENT_APP_OWNER_PID: String(process.pid),
          RIDE_AGENT_APP_BACKEND_PORT: String(backendPort),
          RIDE_AGENT_APP_BRIDGE_PORT: String(bridgePort),
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (data) => {
        stdout += String(data);
        if (stdout.includes("APP_AGENT_RUNTIME_READY\n")) resolve();
      });
      void exited.then(() => {
        if (!stdout.includes("APP_AGENT_RUNTIME_READY\n"))
          reject(Error("Fixture child exited before ready"));
      });
    });
    try {
      await ready;
      assert.equal(await readStatus(backendPort, "/health"), 200);
      child.stdin.end();
      assert.deepEqual(await exited, { code: 0, signal: null });
      assert.equal(stderr.includes("APP_AGENT_RUNTIME_FAILED"), false);
      assert.equal(stdout.includes("APP_AGENT_RUNTIME_STOPPING\n"), true);
      const pool = new pg.Pool({ connectionString: database!, max: 1 });
      try {
        const result = await pool.query(
          "SELECT COUNT(*)::int AS leases FROM pg_stat_activity WHERE datname=current_database() AND application_name='predictly_app_agent_monitor_lease'",
        );
        assert.equal(result.rows[0].leases, 0);
      } finally {
        await pool.end();
      }
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  },
);
