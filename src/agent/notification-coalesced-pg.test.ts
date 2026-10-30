import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import type { VenueAdapter } from "./adapter.js";
import { FakeAdapter } from "./fixtures.js";
import {
  NotificationDispatcher,
  type PreparedNotifications,
} from "./notification-dispatcher.js";
import { PgRepository, type Update } from "./repository.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const pgOptions = { skip: !database, timeout: 15_000 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(work: Promise<T>, message: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5000);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function event(): Update {
  return {
    id: `event_${randomUUID()}`,
    at: Date.now() - 1000,
    kind: "fixture",
    portfolio_id: null,
    message: "Coalesced local PostgreSQL fixture",
    data: {},
    notification: "pending",
  };
}

async function commit(
  repository: PgRepository,
  dispatcher: NotificationDispatcher,
  user: string,
) {
  let prepared: PreparedNotifications | undefined;
  try {
    await repository.transact(user, async (state) => {
      prepared = dispatcher.prepare(user, state);
    });
    dispatcher.committed(prepared!);
  } catch (error) {
    if (prepared) dispatcher.rollback(prepared);
    throw error;
  }
}

it(
  "PostgreSQL coalesced notification reservations roll back without sends and dispatch only after the real C commit",
  pgOptions,
  async () => {
    const repository = new PgRepository(database!);
    const user = `coalesced_commit_${randomUUID()}`;
    const update = event(),
      ids: string[] = [];
    const adapter: VenueAdapter = new FakeAdapter();
    adapter.notify = async (_user, notification) => {
      ids.push(notification.id);
    };
    const dispatcher = new NotificationDispatcher(repository, adapter, {
      concurrency: 1,
      maxBatch: 1,
    });
    const preparedSignal = deferred(),
      releaseCommit = deferred();
    let rollbackPrepared: PreparedNotifications | undefined;
    let prepared: PreparedNotifications | undefined;
    let transaction: Promise<void> | undefined;
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.updates.push(update);
      });
      await assert.rejects(
        repository.transact(user, async (state) => {
          rollbackPrepared = dispatcher.prepare(user, state);
          throw new Error("isolated forced C rollback");
        }),
        /forced C rollback/,
      );
      dispatcher.rollback(rollbackPrepared!);
      assert.deepEqual(ids, []);
      assert.equal(
        (await repository.read(user)).updates[0].notification_claim,
        undefined,
      );
      transaction = repository.transact(user, async (state) => {
        prepared = dispatcher.prepare(user, state);
        preparedSignal.resolve();
        await releaseCommit.promise;
      });
      await within(
        preparedSignal.promise,
        "A rolled-back reservation must release the single global slot",
      );
      assert.deepEqual(
        ids,
        [],
        "Preparing inside an open financial transaction must never send",
      );
      assert.equal(
        (await repository.read(user)).updates[0].notification_claim,
        undefined,
      );
      releaseCommit.resolve();
      await transaction;
      assert.deepEqual(
        ids,
        [],
        "Committing a row alone must not start an unannounced prepared job",
      );
      dispatcher.committed(prepared!);
      await within(dispatcher.idle(), "A committed notification must dispatch");
      assert.deepEqual(ids, [update.id]);
      assert.equal(
        (await repository.read(user)).updates[0].notification,
        "pending",
        "Network results wait for a later durable C merge",
      );
      await commit(repository, dispatcher, user);
      const saved = (await repository.read(user)).updates[0];
      assert.equal(saved.notification, "delivered");
      assert.equal(saved.notification_claim, undefined);
    } finally {
      releaseCommit.resolve();
      await transaction?.catch(() => {});
      if (prepared) dispatcher.rollback(prepared);
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
  "PostgreSQL coalesced ACK buffers survive C rollback and later merge without overwriting cancelled or replaced claims",
  pgOptions,
  async () => {
    const repository = new PgRepository(database!);
    const user = `coalesced_ack_${randomUUID()}`;
    const updates = [event(), event(), event()];
    const sent: string[] = [];
    const adapter: VenueAdapter = new FakeAdapter();
    adapter.notify = async (_owner, update) => {
      sent.push(update.id);
    };
    const dispatcher = new NotificationDispatcher(repository, adapter, {
      maxBatch: 3,
    });
    let rolledBack: PreparedNotifications | undefined;
    const replacement = `replacement_${randomUUID()}`;
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.updates.push(...updates);
      });
      await commit(repository, dispatcher, user);
      await within(
        dispatcher.idle(),
        "The prepared batch must finish outside the row transaction",
      );
      assert.equal(sent.length, 3);
      assert.ok(
        (await repository.read(user)).updates.every(
          (update) => update.notification === "pending",
        ),
      );
      await assert.rejects(
        repository.transact(user, async (state) => {
          rolledBack = dispatcher.prepare(user, state);
          assert.ok(
            state.updates.every(
              (update) => update.notification === "delivered",
            ),
          );
          throw new Error("isolated ACK merge rollback");
        }),
        /ACK merge rollback/,
      );
      dispatcher.rollback(rolledBack!);
      assert.ok(
        (await repository.read(user)).updates.every(
          (update) => update.notification === "pending",
        ),
      );
      await repository.transact(user, async (state) => {
        state.updates[0].notification = "cancelled";
        delete state.updates[0].notification_claim;
        state.updates[1].notification_claim = {
          token: replacement,
          expires_at: Date.now() + 60_000,
        };
        state.daily_checkin_days = {
          coalesced_ack: "preserve independent edit",
        };
      });
      await commit(repository, dispatcher, user);
      await dispatcher.idle();
      const saved = await repository.read(user);
      assert.equal(saved.updates[0].notification, "cancelled");
      assert.equal(saved.updates[1].notification, "pending");
      assert.equal(saved.updates[1].notification_claim?.token, replacement);
      assert.equal(
        saved.updates[2].notification,
        "delivered",
        "The previously rolled-back ACK must still be available",
      );
      assert.equal(saved.updates[2].notification_claim, undefined);
      assert.equal(
        saved.daily_checkin_days?.coalesced_ack,
        "preserve independent edit",
      );
      assert.equal(
        sent.length,
        3,
        "A late ACK merge must not resubmit an accepted event",
      );
    } finally {
      if (rolledBack) dispatcher.rollback(rolledBack);
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
  "PostgreSQL prepared jobs skip expired, replaced and cancelled leases then recover the expired event through a fresh C claim",
  pgOptions,
  async () => {
    const repository = new PgRepository(database!);
    const user = `coalesced_stale_${randomUUID()}`;
    const updates = [event(), event(), event()],
      sent: string[] = [];
    const adapter: VenueAdapter = new FakeAdapter();
    adapter.notify = async (_owner, update) => {
      sent.push(update.id);
    };
    const dispatcher = new NotificationDispatcher(repository, adapter, {
      maxBatch: 3,
    });
    let prepared: PreparedNotifications | undefined;
    const replacement = `replacement_${randomUUID()}`;
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.updates.push(...updates);
      });
      await repository.transact(user, async (state) => {
        prepared = dispatcher.prepare(user, state);
      });
      await repository.transact(user, async (state) => {
        state.updates[0].notification_claim!.expires_at = Date.now() - 1;
        state.updates[1].notification_claim = {
          token: replacement,
          expires_at: Date.now() + 60_000,
        };
        state.updates[2].notification = "cancelled";
        delete state.updates[2].notification_claim;
      });
      dispatcher.committed(prepared!);
      await within(
        dispatcher.idle(),
        "Stale prepared jobs must release local admission without sending",
      );
      assert.deepEqual(sent, []);
      assert.ok(
        (await repository.read(user)).updates.every(
          (update) => update.notification_attempts === undefined,
        ),
      );
      await commit(repository, dispatcher, user);
      await within(
        dispatcher.idle(),
        "The expired event must be recoverable by a new C claim",
      );
      assert.deepEqual(sent, [updates[0].id]);
      await commit(repository, dispatcher, user);
      const saved = await repository.read(user);
      assert.equal(saved.updates[0].notification, "delivered");
      assert.equal(saved.updates[1].notification_claim?.token, replacement);
      assert.equal(saved.updates[2].notification, "cancelled");
    } finally {
      if (prepared) dispatcher.rollback(prepared);
      await dispatcher.close();
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await repository.close();
    }
  },
);
