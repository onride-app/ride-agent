#!/usr/bin/env node
/** App-owned internal Agent runtime. Public requests must pass the Rust API. */
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import pg from "pg";
import { startManagedBackend } from "./agent/backend.js";
import { startManagedCoreBridge } from "./agent/core_bridge.js";
import { startAppSessionStore } from "./app_session_store.js";

export const APP_AGENT_RUNTIME_ABI = 1;
export const APP_AGENT_DRAIN_MS = 45_000;
const MONITOR_LOCK = [0x52494445, 0x4147454e] as const;

export interface RuntimePart {
  closed: Promise<void>;
  close(): Promise<void>;
}
export interface MonitorLease {
  lost: Promise<never>;
  release(): Promise<void>;
}
export interface AppRuntimeConfig {
  databaseUrl: string;
  host: "127.0.0.1";
  backendPort: number;
  bridgePort: number;
  sessionStore?: { redisUrl: string; token: string; port: number };
}
export interface AppRuntimeDependencies {
  acquireLease(database: string): Promise<MonitorLease>;
  startSessionStore?(options: {
    redisUrl: string;
    token: string;
    host: string;
    port: number;
  }): Promise<RuntimePart>;
  startBridge(options: { host: string; port: number }): Promise<RuntimePart>;
  startBackend(options: {
    host: string;
    port: number;
    executorUrl: string;
    signal?: AbortSignal;
  }): Promise<RuntimePart>;
}

export function appRuntimeConfig(
  env: NodeJS.ProcessEnv,
): AppRuntimeConfig | undefined {
  if (
    env.RIDE_AGENT_APP_RUNTIME_ENABLED === undefined ||
    env.RIDE_AGENT_APP_RUNTIME_ENABLED === "false"
  )
    return undefined;
  if (
    env.RIDE_AGENT_APP_RUNTIME_ENABLED !== "true" ||
    env.RIDE_AGENT_INTERNAL_ONLY !== "true" ||
    env.RIDE_AGENT_ENABLED !== "true"
  )
    throw new Error(
      "Explicit private App Agent runtime activation is required",
    );
  if (!env.RIDE_AGENT_DATABASE_URL)
    throw new Error("Agent database configuration required");
  const port = (key: string, fallback: number) => {
    const value = env[key];
    if (value !== undefined && !/^\d+$/.test(value))
      throw new Error("Invalid internal Agent port");
    const result = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(result) || result < 1 || result > 65535)
      throw new Error("Invalid internal Agent port");
    return result;
  };
  const backendPort = port("RIDE_AGENT_APP_BACKEND_PORT", 3344);
  const bridgePort = port("RIDE_AGENT_APP_BRIDGE_PORT", 3355);
  if (backendPort === bridgePort)
    throw new Error("Agent internal ports must differ");
  // HOST/PORT are intentionally ignored: Railway's public Rust listener must
  // never change either Node listener into a public socket.
  let sessionStore: AppRuntimeConfig["sessionStore"];
  if (
    env.RIDE_AGENT_APP_SESSION_STORE_ENABLED !== undefined &&
    env.RIDE_AGENT_APP_SESSION_STORE_ENABLED !== "false"
  ) {
    if (
      env.RIDE_AGENT_APP_SESSION_STORE_ENABLED !== "true" ||
      !env.REDIS_URL ||
      !env.RIDE_AGENT_APP_SESSION_TOKEN
    )
      throw new Error("Explicit App session store configuration required");
    const sessionPort = port("RIDE_AGENT_APP_SESSION_PORT", 3366);
    if (backendPort === sessionPort || bridgePort === sessionPort)
      throw new Error("Agent internal ports must differ");
    sessionStore = {
      redisUrl: env.REDIS_URL,
      token: env.RIDE_AGENT_APP_SESSION_TOKEN,
      port: sessionPort,
    };
  }
  return {
    databaseUrl: env.RIDE_AGENT_DATABASE_URL,
    host: "127.0.0.1",
    backendPort,
    bridgePort,
    ...(sessionStore ? { sessionStore } : {}),
  };
}

/** Dedicated session, held through drain. No schema mutation or TTL takeover. */
export async function acquireMonitorLease(
  database: string,
): Promise<MonitorLease> {
  const client = new pg.Client({
    connectionString: database,
    application_name: "predictly_app_agent_monitor_lease",
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  let rejectLost: (error: Error) => void = () => {};
  const lost = new Promise<never>((_, reject) => {
    rejectLost = reject;
  });
  void lost.catch(() => {});
  let released = false;
  let pinging = false;
  const fail = () => {
    if (!released) rejectLost(new Error("App Agent monitor lease lost"));
  };
  client.on("error", fail);
  client.on("end", fail);
  try {
    await client.connect();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer,$2::integer) AS locked",
      [...MONITOR_LOCK],
    );
    if (result.rows[0]?.locked !== true)
      throw new Error("Another App Agent monitor owns this database");
  } catch (error) {
    released = true;
    await client.end().catch(() => {});
    throw error;
  }
  const heartbeat = setInterval(() => {
    if (released || pinging) return;
    pinging = true;
    void client
      .query("SELECT 1")
      .catch(fail)
      .finally(() => {
        pinging = false;
      });
  }, 5000);
  heartbeat.unref();
  let releasePromise: Promise<void> | undefined;
  return {
    lost,
    release: () =>
      (releasePromise ??= (async () => {
        released = true;
        clearInterval(heartbeat);
        // Closing the session releases the advisory lock only after the owned
        // backend and bridge have finished their durable shutdown path.
        await client.end();
      })()),
  };
}

const production: AppRuntimeDependencies = {
  acquireLease: acquireMonitorLease,
  async startSessionStore(options) {
    const store = await startAppSessionStore(options);
    let resolveClosed: () => void = () => {};
    let rejectClosed: (error: unknown) => void = () => {};
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    void closed.catch(() => {});
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= store.close().then(resolveClosed, (error) => {
        rejectClosed(error);
        throw error;
      }));
    store.server.on("error", rejectClosed);
    store.server.on("close", () => {
      if (!closing)
        rejectClosed(new Error("App session store stopped unexpectedly"));
    });
    return { closed, close };
  },
  startBridge: startManagedCoreBridge,
  startBackend: startManagedBackend,
};

/** Dependencies are injectable so lifecycle tests never start real monitors. */
export async function startAppAgentRuntime(
  config: AppRuntimeConfig,
  dependencies: AppRuntimeDependencies = production,
  signal?: AbortSignal,
  onStopping?: () => void,
): Promise<RuntimePart> {
  let lease: MonitorLease | undefined;
  let bridge: RuntimePart | undefined;
  let sessionStore: RuntimePart | undefined;
  let backend: RuntimePart | undefined;
  const leaseAbort = new AbortController();
  let startupLeaseError: unknown;
  let starting = true;
  const watchStartupPart = (part: RuntimePart) => {
    const fail = (error: unknown) => {
      if (starting) {
        startupLeaseError = error;
        leaseAbort.abort();
      }
    };
    void part.closed.then(
      () => fail(new Error("App runtime component stopped during startup")),
      fail,
    );
  };
  const backendSignal = signal
    ? AbortSignal.any([signal, leaseAbort.signal])
    : leaseAbort.signal;
  const checkOwner = () => {
    if (signal?.aborted) throw new Error("App runtime owner stopped");
    if (startupLeaseError !== undefined) throw startupLeaseError;
  };
  try {
    checkOwner();
    lease = await dependencies.acquireLease(config.databaseUrl);
    void lease.lost.catch((error) => {
      startupLeaseError = error;
      leaseAbort.abort();
    });
    // Observe a lease already lost during acquisition before either service.
    await Promise.race([lease.lost, Promise.resolve()]);
    checkOwner();
    if (config.sessionStore) {
      if (!dependencies.startSessionStore)
        throw new Error("App session store implementation required");
      sessionStore = await dependencies.startSessionStore({
        ...config.sessionStore,
        host: config.host,
      });
      watchStartupPart(sessionStore);
      checkOwner();
    }
    bridge = await dependencies.startBridge({
      host: config.host,
      port: config.bridgePort,
    });
    watchStartupPart(bridge);
    checkOwner();
    backend = await dependencies.startBackend({
      host: config.host,
      port: config.backendPort,
      executorUrl: `http://127.0.0.1:${config.bridgePort}`,
      signal: backendSignal,
    });
    checkOwner();
    starting = false;
  } catch (error) {
    starting = false;
    await backend?.close().catch(() => {});
    await bridge?.close().catch(() => {});
    await sessionStore?.close().catch(() => {});
    await lease?.release().catch(() => {});
    throw error;
  }
  const ownedLease = lease,
    ownedBridge = bridge,
    ownedBackend = backend;
  let resolveClosed: () => void = () => {};
  let rejectClosed: (error: unknown) => void = () => {};
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void closed.catch(() => {});
  let stopping: Promise<void> | undefined;
  let fatalError: unknown;
  const close = () =>
    (stopping ??= (async () => {
      onStopping?.();
      const errors: unknown[] = [];
      // Keep the bridge available until the backend finishes callbacks. Keep
      // the monitor lock until both have drained; never release to a new owner
      // while a known old callback is still using this runtime.
      for (const stop of [
        () => ownedBackend.close(),
        () => ownedBridge.close(),
        async () => {
          await sessionStore?.close();
        },
        () => ownedLease.release(),
      ]) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      signal?.removeEventListener("abort", onAbort);
      const failure = errors[0] ?? fatalError;
      if (failure !== undefined) {
        rejectClosed(failure);
        throw failure;
      }
      resolveClosed();
    })());
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  void Promise.race([
    ownedLease.lost,
    ...(sessionStore
      ? [
          sessionStore.closed.then(() => {
            throw new Error("App session store stopped unexpectedly");
          }),
        ]
      : []),
    ownedBridge.closed.then(() => {
      throw new Error("App Agent bridge stopped unexpectedly");
    }),
    ownedBackend.closed.then(() => {
      throw new Error("App Agent backend stopped unexpectedly");
    }),
  ]).catch((error) => {
    if (!stopping) {
      // Admission closes immediately; existing financial work keeps its
      // original identity and is drained, never replayed under a new ID.
      fatalError = error;
      void close().catch(() => {});
    }
  });
  return { closed, close };
}

export async function runAppAgentRuntime(): Promise<void> {
  const config = appRuntimeConfig(process.env);
  if (!config) {
    process.stdout.write("APP_AGENT_RUNTIME_DISABLED\n");
    return;
  }
  const owner = Number(process.env.RIDE_AGENT_APP_OWNER_PID);
  if (
    !Number.isSafeInteger(owner) ||
    owner <= 1 ||
    owner !== process.ppid ||
    process.stdin.isTTY
  )
    throw new Error("A live Rust App owner and lifecycle pipe are required");
  const controller = new AbortController();
  let force: ReturnType<typeof setTimeout> | undefined;
  let stoppingMarkerSent = false;
  const markStopping = () => {
    // Bound internal failures too, even if the parent cannot acknowledge the
    // marker/close its pipe. Do not recursively abort while close initializes.
    if (!force) {
      force = setTimeout(() => process.exit(1), APP_AGENT_DRAIN_MS);
      force.unref();
    }
    if (!stoppingMarkerSent) {
      stoppingMarkerSent = true;
      process.stdout.write("APP_AGENT_RUNTIME_STOPPING\n");
    }
  };
  const stop = () => {
    markStopping();
    controller.abort();
  };
  process.stdout.on("error", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  // Rust holds this pipe. EOF also detects an ungraceful parent death; a
  // PID-only poll would leave a child running after SIGKILL or PID reuse.
  process.stdin.once("end", stop);
  process.stdin.once("error", stop);
  process.stdin.resume();
  if (process.stdin.readableEnded) stop();
  try {
    const runtime = await startAppAgentRuntime(
      config,
      production,
      controller.signal,
      markStopping,
    );
    if (!controller.signal.aborted)
      process.stdout.write("APP_AGENT_RUNTIME_READY\n");
    await runtime.closed;
  } finally {
    if (force) clearTimeout(force);
    process.stdout.off("error", stop);
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.stdin.off("end", stop);
    process.stdin.off("error", stop);
    process.stdin.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  runAppAgentRuntime().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      console.error("APP_AGENT_RUNTIME_FAILED");
      // Do not leave dependency sockets or an unowned monitor alive after a
      // partial startup. Unknown external work remains durable for reconcile.
      process.exit(1);
    },
  );
}
