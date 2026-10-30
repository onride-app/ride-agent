import { createHash } from "node:crypto";
import type pg from "pg";
import { AgentError } from "./contracts.js";

export type NotificationEvent = {
  id: string;
  kind: string;
  message: string;
  portfolio_id: string | null;
};

function mismatch(): AgentError {
  return new AgentError(
    "PUSH_EVENT_MISMATCH",
    "Notification identity does not match its immutable delivery payload.",
    false,
    409,
  );
}

function unavailable(): AgentError {
  return new AgentError(
    "PUSH_RECEIPT_UNAVAILABLE",
    "Notification delivery evidence is unavailable; retained for retry.",
    true,
    503,
  );
}

function identity(user: string, event: NotificationEvent, device: string) {
  if (
    typeof user !== "string" ||
    !user ||
    !event ||
    typeof event.id !== "string" ||
    !event.id ||
    typeof event.kind !== "string" ||
    typeof event.message !== "string" ||
    !(event.portfolio_id === null || typeof event.portfolio_id === "string") ||
    typeof device !== "string" ||
    !device
  )
    throw mismatch();
  return {
    // These exact immutable fields exclude leases, retries and deadlines.
    payload: createHash("sha256")
      .update(
        JSON.stringify([
          event.id,
          event.kind,
          event.message,
          event.portfolio_id,
        ]),
      )
      .digest("hex"),
    device: createHash("sha256").update(device).digest("hex"),
  };
}

/** Notification-only evidence; this is independent of financial outboxes. */
export class NotificationReceipts {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async migrate(): Promise<void> {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ride_agent_notification_receipts (
      user_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      device_sha256 TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
      delivered_at TIMESTAMPTZ,
      PRIMARY KEY (user_id, event_id, device_sha256),
      CHECK (
        (device_sha256 = '' AND delivered_at IS NULL)
        OR (device_sha256 ~ '^[0-9a-f]{64}$' AND delivered_at IS NOT NULL)
      )
    )`);
  }

  private async guard(
    user: string,
    eventId: string,
    payload: string,
  ): Promise<void> {
    // Empty device digest is reserved for the event fingerprint. It never
    // proves delivery. The unique insert serializes competing first callers
    // before either may send to a device, including different device tokens.
    const inserted = await this.pool.query<{ payload_sha256: string }>(
      `INSERT INTO ride_agent_notification_receipts
       (user_id,event_id,device_sha256,payload_sha256,delivered_at)
       VALUES ($1,$2,'',$3,NULL) ON CONFLICT DO NOTHING
       RETURNING payload_sha256`,
      [user, eventId, payload],
    );
    if (inserted.rows.length) return;
    const existing = await this.pool.query<{ payload_sha256: string }>(
      `SELECT payload_sha256 FROM ride_agent_notification_receipts
       WHERE user_id=$1 AND event_id=$2 AND device_sha256='' AND delivered_at IS NULL`,
      [user, eventId],
    );
    if (!existing.rows.length) throw unavailable();
    if (existing.rows[0].payload_sha256 !== payload) throw mismatch();
  }

  async acknowledged(
    user: string,
    event: NotificationEvent,
    deviceToken: string,
  ): Promise<boolean> {
    const hash = identity(user, event, deviceToken);
    await this.guard(user, event.id, hash.payload);
    const result = await this.pool.query<{ payload_sha256: string }>(
      `SELECT payload_sha256 FROM ride_agent_notification_receipts
       WHERE user_id=$1 AND event_id=$2 AND device_sha256=$3 AND delivered_at IS NOT NULL`,
      [user, event.id, hash.device],
    );
    if (!result.rows.length) return false;
    if (result.rows[0].payload_sha256 !== hash.payload) throw mismatch();
    return true;
  }

  /** Call only after this device's FCM request returned a real success. */
  async acknowledge(
    user: string,
    event: NotificationEvent,
    deviceToken: string,
  ): Promise<void> {
    const hash = identity(user, event, deviceToken);
    await this.guard(user, event.id, hash.payload);
    const result = await this.pool.query<{ payload_sha256: string }>(
      `INSERT INTO ride_agent_notification_receipts
       (user_id,event_id,device_sha256,payload_sha256,delivered_at)
       VALUES ($1,$2,$3,$4,now()) ON CONFLICT DO NOTHING
       RETURNING payload_sha256`,
      [user, event.id, hash.device, hash.payload],
    );
    if (result.rows.length) return;
    // Duplicate success is idempotent; a different immutable payload is not.
    if (!(await this.acknowledged(user, event, deviceToken)))
      throw unavailable();
  }
}
