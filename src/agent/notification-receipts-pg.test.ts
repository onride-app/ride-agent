import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import pg from "pg";
import {
  NotificationReceipts,
  type NotificationEvent,
} from "./notification-receipts.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 15_000 };

function fixture() {
  const pool = new pg.Pool({ connectionString: database, max: 4 });
  const user = `notification_receipt_${randomUUID()}`;
  const event: NotificationEvent = {
    id: `event_${randomUUID()}`,
    kind: "fixture",
    message: `private_message_${randomUUID()}`,
    portfolio_id: `private_portfolio_${randomUUID()}`,
  };
  return { pool, user, event, receipts: new NotificationReceipts(pool) };
}

it(
  "PostgreSQL fingerprint guards never count as a device receipt and only explicit accepted devices survive a restart",
  options,
  async () => {
    const f = fixture();
    const otherUser = `notification_receipt_other_${randomUUID()}`;
    const deviceA = `private_device_a_${randomUUID()}`;
    const deviceB = `private_device_b_${randomUUID()}`;
    try {
      await f.receipts.migrate();
      assert.equal(
        await f.receipts.acknowledged(f.user, f.event, deviceA),
        false,
      );
      assert.equal(
        await f.receipts.acknowledged(f.user, f.event, deviceB),
        false,
      );
      const before = await f.pool.query(
        "SELECT device_sha256,delivered_at FROM ride_agent_notification_receipts WHERE user_id=$1",
        [f.user],
      );
      assert.deepEqual(before.rows, [
        { device_sha256: "", delivered_at: null },
      ]);
      // A lost/failed external result does not call acknowledge. A fresh reader
      // must still treat that recipient as unknown after the process restarts.
      const restarted = new NotificationReceipts(f.pool);
      assert.equal(
        await restarted.acknowledged(f.user, f.event, deviceB),
        false,
      );
      assert.equal(
        await restarted.acknowledged(otherUser, f.event, deviceA),
        false,
        "Another owner's receipt cannot skip this owner's delivery",
      );
      await f.receipts.acknowledge(f.user, f.event, deviceA);
      assert.equal(
        await restarted.acknowledged(f.user, f.event, deviceA),
        true,
      );
      assert.equal(
        await restarted.acknowledged(f.user, f.event, deviceB),
        false,
      );
      // The deadline/claim is transport state, outside the immutable event hash.
      const withTransportFields = {
        ...f.event,
        deadline_ms: Date.now() + 1000,
        notification_claim: { token: "new-attempt" },
      };
      assert.equal(
        await restarted.acknowledged(f.user, withTransportFields, deviceA),
        true,
      );
      for (const changed of [
        { ...f.event, kind: "different-kind" },
        { ...f.event, message: "different-message" },
        { ...f.event, portfolio_id: "different-portfolio" },
      ])
        await assert.rejects(restarted.acknowledged(f.user, changed, deviceB), {
          code: "PUSH_EVENT_MISMATCH",
        });
      const rows = await f.pool.query(
        "SELECT * FROM ride_agent_notification_receipts WHERE user_id=$1",
        [f.user],
      );
      assert.equal(rows.rowCount, 2);
      const persisted = JSON.stringify(rows.rows);
      for (const privateValue of [
        deviceA,
        deviceB,
        f.event.message,
        f.event.portfolio_id!,
      ])
        assert.equal(persisted.includes(privateValue), false);
      const delivered = rows.rows.find((row) => row.device_sha256 !== "");
      assert.match(delivered.device_sha256, /^[0-9a-f]{64}$/);
      assert.match(delivered.payload_sha256, /^[0-9a-f]{64}$/);
      assert.ok(delivered.delivered_at instanceof Date);
    } finally {
      await f.pool.query(
        "DELETE FROM ride_agent_notification_receipts WHERE user_id=ANY($1::text[])",
        [[f.user, otherUser]],
      );
      await f.pool.end();
    }
  },
);

it(
  "PostgreSQL atomically rejects competing changed event payloads before sending even to a different new device",
  options,
  async () => {
    const f = fixture();
    const deviceA = `private_device_a_${randomUUID()}`;
    const deviceB = `private_device_b_${randomUUID()}`;
    const changed = {
      ...f.event,
      kind: "changed",
      message: "Changed immutable content",
    };
    try {
      await f.receipts.migrate();
      const results = await Promise.allSettled([
        f.receipts.acknowledged(f.user, f.event, deviceA),
        f.receipts.acknowledged(f.user, changed, deviceB),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failed = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.equal(failed.reason.code, "PUSH_EVENT_MISMATCH");
      const winner = results[0].status === "fulfilled" ? f.event : changed;
      const loser = results[0].status === "fulfilled" ? changed : f.event;
      const winnerDevice =
        results[0].status === "fulfilled" ? deviceA : deviceB;
      await f.receipts.acknowledge(f.user, winner, winnerDevice);
      await assert.rejects(
        f.receipts.acknowledged(
          f.user,
          loser,
          `another_device_${randomUUID()}`,
        ),
        { code: "PUSH_EVENT_MISMATCH" },
      );
      await assert.rejects(
        f.receipts.acknowledge(f.user, loser, winnerDevice),
        { code: "PUSH_EVENT_MISMATCH" },
      );
      assert.equal(
        await f.receipts.acknowledged(f.user, winner, winnerDevice),
        true,
      );
      const deviceRows = await f.pool.query(
        "SELECT count(*)::int AS count FROM ride_agent_notification_receipts WHERE user_id=$1 AND delivered_at IS NOT NULL",
        [f.user],
      );
      assert.equal(deviceRows.rows[0].count, 1);
    } finally {
      await f.pool.query(
        "DELETE FROM ride_agent_notification_receipts WHERE user_id=$1",
        [f.user],
      );
      await f.pool.end();
    }
  },
);

it(
  "PostgreSQL deduplicates concurrent device acknowledgements and enforces the guard versus delivered-device constraints",
  options,
  async () => {
    const f = fixture();
    const deviceA = `private_device_a_${randomUUID()}`;
    const deviceB = `private_device_b_${randomUUID()}`;
    try {
      await f.receipts.migrate();
      await Promise.all([
        f.receipts.acknowledge(f.user, f.event, deviceA),
        f.receipts.acknowledge(f.user, f.event, deviceB),
        f.receipts.acknowledge(f.user, f.event, deviceA),
      ]);
      assert.equal(
        await f.receipts.acknowledged(f.user, f.event, deviceA),
        true,
      );
      assert.equal(
        await f.receipts.acknowledged(f.user, f.event, deviceB),
        true,
      );
      const rows = await f.pool.query(
        "SELECT count(*)::int AS count FROM ride_agent_notification_receipts WHERE user_id=$1",
        [f.user],
      );
      assert.equal(
        rows.rows[0].count,
        3,
        "One guard and two device proofs must remain",
      );
      await assert.rejects(
        f.pool.query(
          `INSERT INTO ride_agent_notification_receipts
       (user_id,event_id,device_sha256,payload_sha256,delivered_at) VALUES($1,$2,'',$3,now())`,
          [f.user, `invalid_guard_${randomUUID()}`, "a".repeat(64)],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        f.pool.query(
          `INSERT INTO ride_agent_notification_receipts
       (user_id,event_id,device_sha256,payload_sha256,delivered_at) VALUES($1,$2,$3,$4,NULL)`,
          [
            f.user,
            `invalid_device_${randomUUID()}`,
            "b".repeat(64),
            "a".repeat(64),
          ],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        f.pool.query(
          `INSERT INTO ride_agent_notification_receipts
       (user_id,event_id,device_sha256,payload_sha256,delivered_at) VALUES($1,$2,'raw-device-token',$3,now())`,
          [f.user, `invalid_digest_${randomUUID()}`, "a".repeat(64)],
        ),
        { code: "23514" },
      );
    } finally {
      await f.pool.query(
        "DELETE FROM ride_agent_notification_receipts WHERE user_id=$1",
        [f.user],
      );
      await f.pool.end();
    }
  },
);
