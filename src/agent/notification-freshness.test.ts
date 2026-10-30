import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { FakeAdapter } from "./fixtures.js";
import { Cursor, MemoryRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService } from "./service.js";
import type { VenueAdapter } from "./adapter.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";
import { AgentError } from "./contracts.js";
import type { Update } from "./repository.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

it("a blocked notification does not hold the owner's state transaction or next monitor tick", async () => {
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter();
  const entered = deferred(),
    release = deferred();
  adapter.notify = async () => {
    entered.resolve();
    await release.promise;
  };
  await repository.transact("notice_owner", async (state) => {
    state.updates.push({
      id: "original_event",
      at: 1,
      kind: "fixture",
      portfolio_id: null,
      message: "fixture",
      data: {},
      notification: "pending",
    });
  });
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  const first = runner.tick("notice_owner");
  await entered.promise;
  let writeComplete = false;
  const edit = repository.transact("notice_owner", async (state) => {
    state.selected_trader_ids = ["an_independent_edit"];
    writeComplete = true;
  });
  try {
    await Promise.race([edit, delay(100)]);
    assert.equal(
      writeComplete,
      true,
      "external notification I/O must not retain the user row lock",
    );
    await runner.tick("notice_owner");
  } finally {
    release.resolve();
    await Promise.all([first, edit]);
    await runner.closeNotifications();
  }
});

function update(id: string, at = 1): Update {
  return {
    id,
    at,
    kind: "fixture",
    portfolio_id: null,
    message: "fixture",
    data: {},
    notification: "pending",
  };
}

it("retains 1000 failed notifications while each owner turn stays bounded and later due events are not starved", async (t) => {
  let clock = 1700000000000;
  t.mock.method(Date, "now", () => clock);
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter();
  const ids: string[] = [];
  adapter.notify = async (_owner, event) => {
    ids.push(event.id);
    clock += 250;
    throw new AgentError("PUSH_UNAVAILABLE", "fixture", true);
  };
  await repository.transact("backlog", async (state) => {
    for (let i = 0; i < 1000; i++)
      state.updates.push(update(`event_${String(i).padStart(4, "0")}`));
  });
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  const start = clock;
  await runner.tick("backlog");
  await runner.notificationsIdle();
  assert.equal(ids.length, 4);
  assert.equal(
    clock - start,
    1000,
    "the old all-due loop would spend 250 seconds before the next audit",
  );
  clock += 5000;
  await runner.tick("backlog");
  await runner.notificationsIdle();
  assert.deepEqual(
    ids,
    Array.from({ length: 8 }, (_, i) => `event_${String(i).padStart(4, "0")}`),
  );
  const saved = await repository.read("backlog");
  assert.equal(saved.updates.length, 1000);
  assert.equal(
    saved.updates.filter((item) => item.notification === "pending").length,
    1000,
  );
  assert.equal(
    saved.updates.reduce(
      (sum, item) => sum + (item.notification_attempts ?? 0),
      0,
    ),
    8,
  );
  assert.ok(saved.updates.every((item) => !item.notification_claim));
  await runner.closeNotifications();
});

it("yields a bounded owner batch to FIFO owners and never overlaps one owner's delivery", async () => {
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter(),
    seen: string[] = [];
  for (const user of ["a", "b", "c"])
    await repository.transact(user, async (state) => {
      for (let i = 0; i < 5; i++) state.updates.push(update(`${user}_${i}`));
    });
  adapter.notify = async (user, event) => {
    seen.push(`${user}:${event.id}`);
    throw new Error("fixture");
  };
  const dispatcher = new NotificationDispatcher(repository, adapter, {
    concurrency: 1,
    maxBatch: 2,
  });
  dispatcher.enqueue("a");
  dispatcher.enqueue("a");
  dispatcher.enqueue("b");
  dispatcher.enqueue("c");
  await dispatcher.idle();
  assert.deepEqual(seen, [
    "a:a_0",
    "a:a_1",
    "b:b_0",
    "b:b_1",
    "c:c_0",
    "c:c_1",
  ]);
  await dispatcher.close();
});

it("a vanished coalesced FIFO head cannot permanently block other owners after slots become free", async () => {
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter(),
    release = deferred(),
    entered = deferred();
  let clock = 1700000000000;
  const sent: string[] = [];
  for (const user of ["active", "vanished", "later"])
    await repository.transact(user, async (state) => {
      state.updates.push(update(user));
    });
  adapter.notify = async (user) => {
    sent.push(user);
    if (user === "active") {
      entered.resolve();
      await release.promise;
    }
  };
  const dispatcher = new NotificationDispatcher(repository, adapter, {
    clock: () => clock,
    concurrency: 1,
    maxBatch: 1,
    timeoutMs: 100,
    leaseMs: 1000,
  });
  const prepare = async (user: string) =>
    repository.transact(user, async (state) => dispatcher.prepare(user, state));
  dispatcher.committed(await prepare("active"));
  await entered.promise;
  dispatcher.committed(await prepare("vanished"));
  await repository.transact("vanished", async (state) => {
    state.updates[0].notification = "cancelled";
  });
  release.resolve();
  await dispatcher.flush();
  dispatcher.committed(await prepare("later"));
  assert.deepEqual(sent, ["active"]);
  clock += 1000;
  dispatcher.committed(await prepare("later"));
  await dispatcher.flush();
  assert.deepEqual(sent, ["active", "later"]);
  assert.equal(
    (await repository.read("later")).updates[0].notification,
    "delivered",
  );
  await dispatcher.close();
});

it("expired completion buffers from 2000 vanished owners cannot permanently exhaust notification admission", async () => {
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter();
  let clock = 1700000000000,
    sends = 0;
  adapter.notify = async () => {
    sends++;
  };
  const dispatcher = new NotificationDispatcher(repository, adapter, {
    clock: () => clock,
    maxBatch: 1,
    timeoutMs: 1000,
    leaseMs: 2000,
  });
  const prepare = async (user: string) =>
    repository.transact(user, async (state) => dispatcher.prepare(user, state));
  for (let index = 0; index < 2000; index++) {
    const user = `vanished_${index}`;
    await repository.transact(user, async (state) => {
      state.updates.push(update(user));
    });
    dispatcher.committed(await prepare(user));
    await dispatcher.idle();
    await repository.transact(user, async (state) => {
      state.updates[0].notification = "cancelled";
    });
  }
  assert.equal(sends, 2000);
  await repository.transact("new_owner", async (state) => {
    state.updates.push(update("new_event"));
  });
  dispatcher.committed(await prepare("new_owner"));
  await dispatcher.idle();
  assert.equal(sends, 2000);
  clock += 2000;
  dispatcher.committed(await prepare("new_owner"));
  await dispatcher.flush();
  assert.equal(sends, 2001);
  assert.equal(
    (await repository.read("new_owner")).updates[0].notification,
    "delivered",
  );
  assert.equal(
    (await repository.read("vanished_0")).updates[0].notification,
    "cancelled",
  );
  await dispatcher.close();
});

it("a timed-out sender that ignores cancellation cannot later acknowledge success or overlap its original claim", async () => {
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter(),
    entered = deferred(),
    release = deferred();
  let signal: AbortSignal | undefined;
  await repository.transact("unknown", async (state) => {
    state.updates.push(update("original_unknown_id"));
  });
  adapter.notify = async (_user, event, cancel) => {
    assert.equal(event.id, "original_unknown_id");
    signal = cancel;
    entered.resolve();
    await release.promise;
  };
  const dispatcher = new NotificationDispatcher(repository, adapter, {
    timeoutMs: 20,
    leaseMs: 60,
  });
  dispatcher.enqueue("unknown");
  await entered.promise;
  await dispatcher.idle();
  assert.equal(signal?.aborted, true);
  let saved = await repository.read("unknown");
  assert.equal(saved.updates[0].notification, "pending");
  assert.equal(saved.updates[0].notification_attempts, 1);
  assert.equal(saved.updates[0].notification_error, "PUSH_DELIVERY_TIMEOUT");
  release.resolve();
  await delay(10);
  saved = await repository.read("unknown");
  assert.equal(saved.updates[0].notification, "pending");
  await dispatcher.close();
});

it("shutdown cancels delivery without waiting for an uncooperative sender and preserves the same event for retry", async () => {
  const repository = new MemoryRepository(),
    adapter: VenueAdapter = new FakeAdapter(),
    entered = deferred();
  await repository.transact("shutdown", async (state) => {
    state.updates.push(update("same_event"));
    state.updates.push(update("not_started"));
  });
  let calls = 0,
    signal: AbortSignal | undefined;
  adapter.notify = async (_user, _event, cancel) => {
    calls++;
    signal = cancel;
    entered.resolve();
    await new Promise<void>(() => {});
  };
  const dispatcher = new NotificationDispatcher(repository, adapter);
  dispatcher.enqueue("shutdown");
  await entered.promise;
  await Promise.race([
    dispatcher.close(),
    delay(200).then(() =>
      assert.fail("shutdown cannot wait for the remote sender"),
    ),
  ]);
  assert.equal(signal?.aborted, true);
  dispatcher.enqueue("shutdown");
  await dispatcher.idle();
  assert.equal(calls, 1);
  const saved = await repository.read("shutdown");
  assert.deepEqual(
    saved.updates.map((item) => item.id),
    ["same_event", "not_started"],
  );
  assert.ok(saved.updates.every((item) => item.notification === "pending"));
});
