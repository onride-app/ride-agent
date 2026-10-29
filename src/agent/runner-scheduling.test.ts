import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService } from "./service.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
class SchedulerClock {
  at = 0;
  private sequence = 0;
  readonly events = new Map<number, { at: number; run(): void }>();
  constructor(t: TestContext) {
    t.mock.method(Date, "now", () => this.at);
    t.mock.method(globalThis, "setTimeout", ((run: () => void, ms = 0) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    }) as unknown as typeof setTimeout);
    t.mock.method(globalThis, "clearTimeout", (id: unknown) => {
      this.events.delete(id as number);
    });
  }
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    for (;;) {
      const first = [...this.events]
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!first) break;
      this.at = first[1].at;
      this.events.delete(first[0]);
      first[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}
function fixture(users: string[]) {
  const repository = new MemoryRepository();
  repository.users = async () => users;
  const runner = new AgentRunner(
    new AgentService(
      repository,
      new FakeAdapter(),
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  return { repository, runner, controller: new AbortController() };
}

it("checks a healthy user while the first user's account read is blocked, and drains that read on abort", async () => {
  const f = fixture(["slow", "healthy"]),
    slow = deferred(),
    started: string[] = [];
  f.runner.tick = async (user) => {
    started.push(user);
    if (user === "slow") await slow.promise;
  };
  let finished = false;
  const running = f.runner.run(f.controller.signal, 60_000).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(started, ["slow", "healthy"]);
    f.controller.abort();
    await flush();
    assert.equal(finished, false, "shutdown must await the in-flight user");
  } finally {
    f.controller.abort();
    slow.resolve();
    await running;
  }
  assert.equal(finished, true);
  assert.deepEqual(started, ["slow", "healthy"]);
});

it("limits monitoring to two users and starts no queued user after abort", async () => {
  const f = fixture(["a", "b", "c", "d", "e"]),
    gates = new Map(
      ["a", "b", "c", "d", "e"].map((user) => [user, deferred()]),
    ),
    started: string[] = [];
  let active = 0,
    maximum = 0,
    finished = false;
  f.runner.tick = async (user) => {
    started.push(user);
    maximum = Math.max(maximum, ++active);
    await gates.get(user)!.promise;
    active--;
  };
  const running = f.runner.run(f.controller.signal, 60_000).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(started, ["a", "b"]);
    gates.get("a")!.resolve();
    await flush();
    assert.deepEqual(started, ["a", "b", "c"]);
    assert.equal(maximum, 2);
    f.controller.abort();
    await flush();
    assert.equal(finished, false);
  } finally {
    f.controller.abort();
    for (const gate of gates.values()) gate.resolve();
    await running;
  }
  assert.deepEqual(started, ["a", "b", "c"]);
  assert.equal(active, 0);
});

it("keeps monitoring other users after one user fails and drains both workers", async (t) => {
  const f = fixture(["broken", "healthy", "last"]),
    healthy = deferred(),
    started: string[] = [],
    errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  f.runner.tick = async (user) => {
    started.push(user);
    if (user === "broken") throw new Error("fixture user read failed");
    if (user === "healthy") await healthy.promise;
    if (user === "last") f.controller.abort();
  };
  let finished = false;
  const running = f.runner.run(f.controller.signal, 60_000).then(() => {
    finished = true;
  });
  try {
    await flush();
    assert.deepEqual(started, ["broken", "healthy", "last"]);
    assert.equal(errors.length, 1);
    assert.equal(finished, false);
  } finally {
    f.controller.abort();
    healthy.resolve();
    await running;
  }
});

it("keeps both scheduling slots usable after synchronous user failures", async (t) => {
  const f = fixture(["broken-1", "broken-2", "healthy"]),
    started: string[] = [];
  t.mock.method(console, "error", () => {});
  f.runner.tick = (user) => {
    started.push(user);
    if (user.startsWith("broken"))
      throw new Error("fixture synchronous failure");
    f.controller.abort();
    return Promise.resolve();
  };
  const running = f.runner.run(f.controller.signal, 60_000);
  try {
    await flush();
    assert.deepEqual(started, ["broken-1", "broken-2", "healthy"]);
  } finally {
    f.controller.abort();
    await running;
  }
});

it("rechecks healthy users independently after completion without duplicating or overlapping discovered users", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["slow", "healthy", "healthy"]),
    slow = deferred(),
    firstHealthy = deferred(),
    calls = new Map<string, number[]>(),
    active = new Map<string, number>();
  let maximumPerUser = 0;
  f.runner.tick = async (user) => {
    const times = calls.get(user) ?? [];
    times.push(time.at);
    calls.set(user, times);
    active.set(user, (active.get(user) ?? 0) + 1);
    maximumPerUser = Math.max(maximumPerUser, active.get(user)!);
    if (user === "slow") await slow.promise;
    if (user === "healthy" && times.length === 1) await firstHealthy.promise;
    active.set(user, active.get(user)! - 1);
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    assert.deepEqual(calls.get("healthy"), [0]);
    await time.advance(3000);
    firstHealthy.resolve();
    await flush();
    await time.advance(4999);
    assert.deepEqual(calls.get("healthy"), [0]);
    await time.advance(1);
    assert.deepEqual(calls.get("healthy"), [0, 8000]);
    await time.advance(10000);
    assert.deepEqual(calls.get("healthy"), [0, 8000, 13000, 18000]);
    assert.deepEqual(calls.get("slow"), [0]);
    assert.equal(maximumPerUser, 1);
  } finally {
    f.controller.abort();
    slow.resolve();
    firstHealthy.resolve();
    await running;
  }
  assert.equal(time.events.size, 0);
});

it("refreshes user discovery while another user is blocked and drops removed users", async (t) => {
  const time = new SchedulerClock(t),
    f = fixture(["slow", "old"]),
    slow = deferred(),
    started: string[] = [];
  let discovered = ["slow", "old"];
  f.repository.users = async () => discovered;
  f.runner.tick = async (user) => {
    started.push(user);
    if (user === "slow") await slow.promise;
  };
  const running = f.runner.run(f.controller.signal);
  try {
    await flush();
    assert.deepEqual(started, ["slow", "old"]);
    discovered = ["slow", "new"];
    await time.advance(5000);
    assert.deepEqual(started, ["slow", "old", "new"]);
    await time.advance(5000);
    assert.deepEqual(started, ["slow", "old", "new", "new"]);
  } finally {
    f.controller.abort();
    slow.resolve();
    await running;
  }
  assert.equal(time.events.size, 0);
});

it("does not enter a user callback when aborted during user discovery", async () => {
  const f = fixture(["queued"]),
    discovery = deferred();
  let started = 0;
  f.repository.users = async () => {
    await discovery.promise;
    return ["queued"];
  };
  f.runner.tick = async () => {
    started++;
  };
  const running = f.runner.run(f.controller.signal);
  f.controller.abort();
  discovery.resolve();
  await running;
  assert.equal(started, 0);
});
