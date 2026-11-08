import test from "node:test";
import assert from "node:assert/strict";
import {
  appRuntimeConfig,
  startAppAgentRuntime,
  type AppRuntimeDependencies,
  type RuntimePart,
} from "./app_runtime.js";

const enabled = {
  RIDE_AGENT_APP_RUNTIME_ENABLED: "true",
  RIDE_AGENT_INTERNAL_ONLY: "true",
  RIDE_AGENT_ENABLED: "true",
  RIDE_AGENT_DATABASE_URL: "postgres://fixture.invalid/local_only",
};
const config = appRuntimeConfig(enabled)!;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function fixture() {
  const events: string[] = [];
  const leaseLost = deferred<never>();
  const bridgeDone = deferred<void>();
  const backendDone = deferred<void>();
  const part = (
    name: string,
    done: ReturnType<typeof deferred<void>>,
  ): RuntimePart => ({
    closed: done.promise,
    async close() {
      events.push(`close:${name}`);
      done.resolve();
    },
  });
  const dependencies: AppRuntimeDependencies = {
    async acquireLease() {
      events.push("lease");
      return {
        lost: leaseLost.promise,
        async release() {
          events.push("release");
        },
      };
    },
    async startBridge(options) {
      assert.deepEqual(options, { host: "127.0.0.1", port: 3355 });
      events.push("bridge");
      return part("bridge", bridgeDone);
    },
    async startBackend(options) {
      assert.equal(options.host, "127.0.0.1");
      assert.equal(options.port, 3344);
      assert.equal(options.executorUrl, "http://127.0.0.1:3355");
      assert.equal(options.signal?.aborted, false);
      events.push("backend");
      return part("backend", backendDone);
    },
  };
  return { events, dependencies, leaseLost, bridgeDone, backendDone };
}

test("App Agent runtime is off by default with no database access", () => {
  assert.equal(appRuntimeConfig({}), undefined);
  assert.equal(
    appRuntimeConfig({ ...enabled, RIDE_AGENT_APP_RUNTIME_ENABLED: "false" }),
    undefined,
  );
});
test("App runtime requires all explicit activation gates", () => {
  for (const key of ["RIDE_AGENT_INTERNAL_ONLY", "RIDE_AGENT_ENABLED"]) {
    assert.throws(
      () => appRuntimeConfig({ ...enabled, [key]: "false" }),
      /activation/,
    );
  }
  assert.throws(
    () =>
      appRuntimeConfig({ ...enabled, RIDE_AGENT_APP_RUNTIME_ENABLED: "TRUE" }),
    /activation/,
  );
});
test("public HOST and PORT cannot expose Node and internal ports are strict", () => {
  assert.deepEqual(
    appRuntimeConfig({ ...enabled, HOST: "0.0.0.0", PORT: "8001" }),
    config,
  );
  for (const port of ["0", "65536", "3344.5", "3344x", "-1"]) {
    assert.throws(
      () => appRuntimeConfig({ ...enabled, RIDE_AGENT_APP_BACKEND_PORT: port }),
      /port/,
    );
  }
  assert.throws(
    () => appRuntimeConfig({ ...enabled, RIDE_AGENT_APP_BRIDGE_PORT: "3344" }),
    /differ/,
  );
});
test("real orchestration holds lease through backend then bridge drain and closes once", async () => {
  const f = fixture();
  const runtime = await startAppAgentRuntime(config, f.dependencies);
  assert.deepEqual(f.events, ["lease", "bridge", "backend"]);
  const first = runtime.close();
  assert.equal(runtime.close(), first);
  await first;
  await runtime.closed;
  assert.deepEqual(f.events, [
    "lease",
    "bridge",
    "backend",
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
test("backend startup failure closes bridge before releasing lease", async () => {
  const f = fixture();
  f.dependencies.startBackend = async () => {
    throw new Error("fixture start failed");
  };
  await assert.rejects(
    startAppAgentRuntime(config, f.dependencies),
    /fixture start failed/,
  );
  assert.deepEqual(f.events, ["lease", "bridge", "close:bridge", "release"]);
});
test("lease loss is fatal rather than reported as successful drain", async () => {
  const f = fixture();
  const runtime = await startAppAgentRuntime(config, f.dependencies);
  f.leaseLost.reject(new Error("fixture lease lost"));
  await assert.rejects(runtime.closed, /fixture lease lost/);
  assert.deepEqual(f.events.slice(-3), [
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
test("unexpected backend finish fails closed and drains both owned parts", async () => {
  const f = fixture();
  const runtime = await startAppAgentRuntime(config, f.dependencies);
  f.backendDone.resolve();
  await assert.rejects(runtime.closed, /backend stopped unexpectedly/);
  assert.deepEqual(f.events.slice(-3), [
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
test("owner death before startup does not acquire a lease", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    startAppAgentRuntime(config, f.dependencies, controller.signal),
    /owner stopped/,
  );
  assert.deepEqual(f.events, []);
});
test("owner death during lease acquisition releases without starting a monitor", async () => {
  const f = fixture();
  const acquired = deferred<void>();
  const controller = new AbortController();
  const old = f.dependencies.acquireLease;
  f.dependencies.acquireLease = async (db) => {
    await acquired.promise;
    return old(db);
  };
  const starting = startAppAgentRuntime(
    config,
    f.dependencies,
    controller.signal,
  );
  controller.abort();
  acquired.resolve();
  await assert.rejects(starting, /owner stopped/);
  assert.deepEqual(f.events, ["lease", "release"]);
});
test("lost lease during startup never starts backend", async () => {
  const f = fixture();
  f.leaseLost.reject(new Error("fixture lease lost"));
  await assert.rejects(
    startAppAgentRuntime(config, f.dependencies),
    /fixture lease lost/,
  );
  assert.deepEqual(f.events, ["lease", "release"]);
});
test("owner abort drains backend before bridge and lease", async () => {
  const f = fixture();
  const controller = new AbortController();
  const runtime = await startAppAgentRuntime(
    config,
    f.dependencies,
    controller.signal,
  );
  controller.abort();
  await runtime.closed;
  assert.deepEqual(f.events.slice(-3), [
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
test("backend drain failure still closes bridge and releases lease", async () => {
  const f = fixture();
  const old = f.dependencies.startBackend;
  f.dependencies.startBackend = async (options) => {
    const backend = await old(options);
    return {
      closed: backend.closed,
      async close() {
        await backend.close();
        throw new Error("fixture drain failure");
      },
    };
  };
  const runtime = await startAppAgentRuntime(config, f.dependencies);
  await assert.rejects(runtime.close(), /fixture drain failure/);
  await assert.rejects(runtime.closed, /fixture drain failure/);
  assert.deepEqual(f.events.slice(-3), [
    "close:backend",
    "close:bridge",
    "release",
  ]);
});

test("session store is separately opt-in with private required config", () => {
  assert.equal(config.sessionStore, undefined);
  assert.throws(
    () =>
      appRuntimeConfig({
        ...enabled,
        RIDE_AGENT_APP_SESSION_STORE_ENABLED: "true",
      }),
    /session store/,
  );
  const configured = appRuntimeConfig({
    ...enabled,
    RIDE_AGENT_APP_SESSION_STORE_ENABLED: "true",
    REDIS_URL: "redis://fixture.invalid",
    RIDE_AGENT_APP_SESSION_TOKEN: "fixture-only-no-real-credential",
  })!;
  assert.equal(configured.sessionStore?.port, 3366);
  assert.throws(
    () =>
      appRuntimeConfig({
        ...enabled,
        RIDE_AGENT_APP_SESSION_STORE_ENABLED: "true",
        REDIS_URL: "redis://fixture.invalid",
        RIDE_AGENT_APP_SESSION_TOKEN: "fixture-only-no-real-credential",
        RIDE_AGENT_APP_BACKEND_PORT: "3366",
      }),
    /differ/,
  );
});
test("session store starts before monitor and drains before lease release", async () => {
  const f = fixture();
  const done = deferred<void>();
  f.dependencies.startSessionStore = async (options) => {
    assert.equal(options.host, "127.0.0.1");
    assert.equal(options.port, 3366);
    f.events.push("sessions");
    return {
      closed: done.promise,
      async close() {
        f.events.push("close:sessions");
        done.resolve();
      },
    };
  };
  const runtime = await startAppAgentRuntime(
    {
      ...config,
      sessionStore: {
        redisUrl: "redis://fixture.invalid",
        token: "fixture",
        port: 3366,
      },
    },
    f.dependencies,
  );
  assert.deepEqual(f.events, ["lease", "sessions", "bridge", "backend"]);
  await runtime.close();
  await runtime.closed;
  assert.deepEqual(f.events.slice(-4), [
    "close:backend",
    "close:bridge",
    "close:sessions",
    "release",
  ]);
});
test("bridge failure while startup is pending prevents monitor readiness", async () => {
  const f = fixture();
  const original = f.dependencies.startBackend;
  f.dependencies.startBackend = async (options) => {
    f.bridgeDone.reject(new Error("fixture bridge startup failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(options.signal?.aborted, true);
    return original({ ...options, signal: new AbortController().signal });
  };
  await assert.rejects(
    startAppAgentRuntime(config, f.dependencies),
    /bridge startup failure/,
  );
  assert.deepEqual(f.events.slice(-3), [
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
test("session port override uses the same strict parser and collision checks", () => {
  const env = {
    ...enabled,
    RIDE_AGENT_APP_SESSION_STORE_ENABLED: "true",
    REDIS_URL: "redis://fixture.invalid",
    RIDE_AGENT_APP_SESSION_TOKEN: "fixture",
  };
  assert.equal(
    appRuntimeConfig({ ...env, RIDE_AGENT_APP_SESSION_PORT: "3367" })
      ?.sessionStore?.port,
    3367,
  );
  assert.throws(
    () => appRuntimeConfig({ ...env, RIDE_AGENT_APP_SESSION_PORT: "3344" }),
    /differ/,
  );
  assert.throws(
    () => appRuntimeConfig({ ...env, RIDE_AGENT_APP_SESSION_PORT: "3367x" }),
    /port/,
  );
});
test("stopping callback fires once before normal drain starts", async () => {
  const f = fixture();
  let markers = 0;
  const runtime = await startAppAgentRuntime(
    config,
    f.dependencies,
    undefined,
    () => {
      markers++;
      f.events.push("stopping");
    },
  );
  await runtime.close();
  await runtime.close();
  await runtime.closed;
  assert.equal(markers, 1);
  assert.deepEqual(f.events.slice(-4), [
    "stopping",
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
test("internal fatal announces stopping before cleanup rather than leaving readiness true", async () => {
  const f = fixture();
  let markers = 0;
  const runtime = await startAppAgentRuntime(
    config,
    f.dependencies,
    undefined,
    () => {
      markers++;
      f.events.push("stopping");
    },
  );
  f.leaseLost.reject(new Error("fixture lease failure"));
  await assert.rejects(runtime.closed, /fixture lease failure/);
  assert.equal(markers, 1);
  assert.deepEqual(f.events.slice(-4), [
    "stopping",
    "close:backend",
    "close:bridge",
    "release",
  ]);
});
