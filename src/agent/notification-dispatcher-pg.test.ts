import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import type { VenueAdapter } from "./adapter.js";
import { AgentError } from "./contracts.js";
import { recommend } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, PgRepository, type Update } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";
import { NotificationDispatcher } from "./notification-dispatcher.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const pgOptions = { skip: !database, timeout: 15_000 };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(
  promise: Promise<T>,
  message: string,
  ms = 5000,
): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function update(id: string): Update {
  return {
    id,
    at: Date.now() - 1000,
    kind: "fixture",
    portfolio_id: null,
    message: "Isolated PostgreSQL notification fixture",
    data: {},
    notification: "pending",
  };
}

it(
  "PostgreSQL permits the next audit and a state edit while an earlier notification is still sending",
  pgOptions,
  async () => {
    const repository = new PgRepository(database!);
    const user = `notification_audit_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const adapter = new FakeAdapter();
    const started = deferred(),
      release = deferred();
    let notifyFinished = false,
      observations = 0;
    const base = Date.now() - 1000;
    adapter.account = async () => ({
      ...snapshot(),
      observed_at: base + ++observations * 10,
    });
    adapter.source = async () => ({
      observed_at: Date.now(),
      revision: "flat",
      account_value_usdc: "1000",
      complete: true,
      positions: [],
    });
    adapter.notify = async () => {
      started.resolve();
      await release.promise;
      notifyFinished = true;
    };
    const runner = new AgentRunner(
      new AgentService(
        repository,
        adapter,
        "https://ride.test",
        new Cursor("s".repeat(32)),
      ),
    );
    let first: Promise<void> | undefined;
    try {
      await repository.migrate();
      const portfolio = fromPlan(
        recommend(
          {
            budget_usdc: "20",
            market: "perps",
            assets: [],
            allow_altcoins: true,
            loss_trigger_pct: 90,
            risk_tolerance: "medium",
            portfolio_kind: "single",
          },
          [candidate(1)],
        ),
      );
      portfolio.account_id = adapter.snap.account_id;
      portfolio.venue_accounts = { perps: portfolio.account_id };
      portfolio.state = "active";
      portfolio.initial_equity = "500";
      portfolio.ledger_started_at = base - 1000;
      portfolio.reconciliation = "complete";
      portfolio.sleeves[0].reviewed_at = Date.now();
      await repository.transact(user, async (state) => {
        state.portfolios.push(portfolio);
        state.updates.push(update(eventId));
      });
      first = runner.tick(user);
      void first.catch(() => {});
      await within(started.promise, "Notification did not start");
      assert.equal(notifyFinished, false);
      // A real server-side NOWAIT probe proves that the sending worker no longer
      // retains the user's row lock. A MemoryRepository cannot establish this.
      await assert.doesNotReject(
        repository.pool.query(
          "SELECT user_id FROM ride_agent_state WHERE user_id=$1 FOR UPDATE NOWAIT",
          [user],
        ),
        "An external notification must not retain the financial state row lock",
      );
      await repository.transact(user, async (state) => {
        state.daily_checkin_days = { notification_pg: "concurrent edit" };
      });
      await runner.tick(user);
      const saved = await repository.read(user);
      assert.equal(notifyFinished, false);
      assert.equal(observations, 2);
      assert.equal(saved.portfolios[0].snapshot?.observed_at, base + 20);
      assert.equal(
        saved.daily_checkin_days?.notification_pg,
        "concurrent edit",
      );
      assert.equal(adapter.submitCount, 0);
    } finally {
      release.resolve();
      await first?.catch(() => {});
      await runner.closeNotifications();
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await repository.close();
    }
  },
);

it(
  "PostgreSQL claims exclude another dispatcher and an expired claim's late acknowledgement cannot clear its replacement",
  pgOptions,
  async () => {
    const firstRepository = new PgRepository(database!);
    const secondRepository = new PgRepository(database!);
    const user = `notification_claim_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const firstStarted = deferred(),
      secondStarted = deferred();
    const firstRelease = deferred(),
      secondRelease = deferred();
    const firstIds: string[] = [],
      secondIds: string[] = [];
    const firstAdapter: VenueAdapter = new FakeAdapter();
    const secondAdapter: VenueAdapter = new FakeAdapter();
    firstAdapter.notify = async (_owner, event) => {
      firstIds.push(event.id);
      firstStarted.resolve();
      await firstRelease.promise;
    };
    secondAdapter.notify = async (_owner, event) => {
      secondIds.push(event.id);
      secondStarted.resolve();
      await secondRelease.promise;
    };
    const options = { timeoutMs: 5000, leaseMs: 6000, maxBatch: 1 };
    const first = new NotificationDispatcher(
      firstRepository,
      firstAdapter,
      options,
    );
    const second = new NotificationDispatcher(
      secondRepository,
      secondAdapter,
      options,
    );
    try {
      await firstRepository.migrate();
      await firstRepository.transact(user, async (state) => {
        state.updates.push(update(eventId));
      });
      first.enqueue(user);
      await within(
        firstStarted.promise,
        "The first durable claim must dispatch",
      );
      const original = (await firstRepository.read(user)).updates[0]
        .notification_claim!;
      assert.equal(typeof original.token, "string");
      second.enqueue(user);
      await within(
        second.idle(),
        "A live claim must let another dispatcher finish without sending",
      );
      assert.deepEqual(secondIds, []);
      assert.equal(
        (await secondRepository.read(user)).updates[0].notification_claim
          ?.token,
        original.token,
      );

      // Simulate a previous process whose lease expired while the external
      // result remained unknown. Recovery keeps the same notification identity.
      await secondRepository.transact(user, async (state) => {
        state.updates[0].notification_claim!.expires_at = Date.now() - 1;
      });
      second.enqueue(user);
      await within(
        secondStarted.promise,
        "An expired claim must recover through a new token",
      );
      const replacement = (await secondRepository.read(user)).updates[0]
        .notification_claim!;
      assert.notEqual(replacement.token, original.token);
      assert.deepEqual(firstIds, [eventId]);
      assert.deepEqual(secondIds, [eventId]);
      firstRelease.resolve();
      await within(first.idle(), "The late first result must settle locally");
      const stillPending = (await firstRepository.read(user)).updates[0];
      assert.equal(stillPending.notification, "pending");
      assert.equal(stillPending.notification_claim?.token, replacement.token);
      secondRelease.resolve();
      await within(second.idle(), "The current claim must acknowledge");
      const delivered = (await firstRepository.read(user)).updates[0];
      assert.equal(delivered.id, eventId);
      assert.equal(delivered.notification, "delivered");
      assert.equal(delivered.notification_claim, undefined);
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
      await Promise.all([first.close(), second.close()]);
      await firstRepository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await Promise.all([firstRepository.close(), secondRepository.close()]);
    }
  },
);

it(
  "PostgreSQL cancellation during an in-flight send survives its late success",
  pgOptions,
  async () => {
    const repository = new PgRepository(database!);
    const user = `notification_cancel_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const started = deferred(),
      release = deferred();
    const adapter: VenueAdapter = new FakeAdapter();
    adapter.notify = async () => {
      started.resolve();
      await release.promise;
    };
    const dispatcher = new NotificationDispatcher(repository, adapter, {
      timeoutMs: 5000,
      leaseMs: 6000,
      maxBatch: 1,
    });
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.updates.push(update(eventId));
      });
      dispatcher.enqueue(user);
      await within(
        started.promise,
        "A send must be in flight before cancellation",
      );
      await repository.transact(user, async (state) => {
        state.updates[0].notification = "cancelled";
        delete state.updates[0].notification_claim;
        state.daily_checkin_days = { concurrent_edit: "keep" };
      });
      release.resolve();
      await within(
        dispatcher.idle(),
        "Late success must finish without resurrecting delivery",
      );
      const saved = await repository.read(user);
      assert.equal(saved.updates[0].notification, "cancelled");
      assert.equal(saved.updates[0].notification_claim, undefined);
      assert.equal(saved.updates[0].id, eventId);
      assert.equal(saved.daily_checkin_days?.concurrent_edit, "keep");
    } finally {
      release.resolve();
      await dispatcher.close();
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await repository.close();
    }
  },
);

it(
  "PostgreSQL retains unknown notification outcomes for durable retry with the original event identity",
  pgOptions,
  async () => {
    const repository = new PgRepository(database!);
    const user = `notification_unknown_${randomUUID()}`;
    const eventId = `event_${randomUUID()}`;
    const ids: string[] = [];
    const adapter: VenueAdapter = new FakeAdapter();
    adapter.notify = async (_owner, event) => {
      ids.push(event.id);
      throw new AgentError(
        "EXECUTOR_UNAVAILABLE",
        "Unknown transport result",
        true,
        503,
      );
    };
    const failed = new NotificationDispatcher(repository, adapter, {
      maxBatch: 1,
    });
    let resumed: NotificationDispatcher | undefined;
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.updates.push(update(eventId));
      });
      failed.enqueue(user);
      await within(
        failed.idle(),
        "Unknown outcomes must persist without being marked delivered",
      );
      const pending = (await repository.read(user)).updates[0];
      assert.equal(pending.notification, "pending");
      assert.equal(pending.notification_attempts, 1);
      assert.equal(pending.notification_error, "EXECUTOR_UNAVAILABLE");
      assert.equal(pending.notification_claim, undefined);
      assert.ok(pending.next_notification_at! > Date.now());
      await failed.close();
      await repository.transact(user, async (state) => {
        state.updates[0].next_notification_at = Date.now() - 1;
      });
      adapter.notify = async (_owner, event) => {
        ids.push(event.id);
      };
      resumed = new NotificationDispatcher(repository, adapter, {
        maxBatch: 1,
      });
      resumed.enqueue(user);
      await within(
        resumed.idle(),
        "A restarted dispatcher must resume the same event",
      );
      const delivered = (await repository.read(user)).updates[0];
      assert.deepEqual(ids, [eventId, eventId]);
      assert.equal(delivered.id, eventId);
      assert.equal(delivered.notification, "delivered");
      assert.equal(delivered.notification_error, undefined);
      assert.equal(delivered.next_notification_at, undefined);
    } finally {
      await failed.close();
      await resumed?.close();
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await repository.close();
    }
  },
);
