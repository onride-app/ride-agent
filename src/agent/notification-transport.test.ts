import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import pg from "pg";
import { BridgeAdapter } from "./adapter.js";
import { CoreBridge } from "./core_bridge.js";
import { notificationCancellation } from "./notification-cancellation.js";

const event = {
  id: "original_notification_id",
  kind: "fixture",
  message: "fixture",
  portfolio_id: null,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
function bridge(database = "postgresql://localhost/unused") {
  return new CoreBridge(
    "https://core.test",
    "fixture",
    database,
    "s".repeat(32),
    "mainnet",
  );
}

it("an unverified bridge HTTP200 cannot acknowledge notification delivery", async () => {
  const app = express();
  app.use(express.json());
  app.post("/internal/agent/notify", (_req, res) => res.json({}));
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address !== "string");
  try {
    await assert.rejects(
      new BridgeAdapter(`http://127.0.0.1:${address.port}`, "fixture").notify(
        "fixture",
        event,
      ),
      (error: any) => error.code === "EXECUTOR_RESPONSE_INVALID",
    );
  } finally {
    listener.close();
  }
});

it("invalid FCM200 bodies and interrupted JSON never become device acceptance receipts", async () => {
  const service = bridge(),
    old = process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64,
    originalFetch = globalThis.fetch;
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(
    JSON.stringify({
      type: "service_account",
      project_id: "ride-fiamma",
      client_email: "fixture@ride-fiamma.iam.gserviceaccount.com",
      private_key: privateKey,
    }),
  ).toString("base64");
  (service as any).core = async () => ["fixture_device"];
  (service as any).tokens = { value: "fixture", expiry: Date.now() + 3600000 };
  let accepted = 0;
  (service as any).notificationReceipts = {
    acknowledged: async () => false,
    acknowledge: async () => {
      accepted++;
    },
  };
  try {
    for (const body of [
      "{}",
      "<html>unexpected</html>",
      JSON.stringify({ name: "projects/foreign/messages/fixture" }),
    ]) {
      globalThis.fetch = async () => new Response(body, { status: 200 });
      await assert.rejects(
        service.operation("notify", {
          user_id: "fixture",
          event,
          deadline_ms: Date.now() + 1000,
        }),
      );
      assert.equal(accepted, 0);
    }
    globalThis.fetch = async (_url, init) => {
      const response = new Response("{}");
      response.json = () =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          ),
        );
      return response;
    };
    const keepAlive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(
        service.operation("notify", {
          user_id: "fixture",
          event,
          deadline_ms: Date.now() + 30,
        }),
      );
    } finally {
      clearTimeout(keepAlive);
    }
    assert.equal(accepted, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (old === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64;
    else process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64 = old;
    await service.close();
  }
});

it("a real HTTP notification abort cancels Core push-token work while complete request bodies do not", async () => {
  const service = bridge(),
    entered = deferred(),
    cancelled = deferred();
  let signal: AbortSignal | undefined;
  (service as any).core = async (
    op: string,
    _input: unknown,
    requestSignal: AbortSignal,
  ) => {
    assert.equal(op, "push_tokens");
    signal = requestSignal;
    entered.resolve();
    await new Promise((_, reject) =>
      requestSignal.addEventListener(
        "abort",
        () => {
          cancelled.resolve();
          reject(requestSignal.reason);
        },
        { once: true },
      ),
    );
  };
  const app = express();
  app.use(express.json());
  app.post("/internal/agent/notify", async (req, res) => {
    const cancellation = notificationCancellation(req, res);
    try {
      res.json(
        await service.operation("notify", req.body, cancellation.signal),
      );
    } catch {
      if (!res.destroyed)
        res
          .status(503)
          .json({
            error: {
              code: "PUSH_UNAVAILABLE",
              message: "fixture",
              retryable: true,
            },
          });
    } finally {
      cancellation.close();
    }
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address !== "string");
  const adapter = new BridgeAdapter(
      `http://127.0.0.1:${address.port}`,
      "fixture",
    ),
    caller = new AbortController();
  const work = adapter
    .notify("fixture_owner", event, caller.signal)
    .catch((error) => error);
  try {
    await entered.promise;
    await delay(10);
    assert.equal(
      signal?.aborted,
      false,
      "normal body completion cannot cancel notification work",
    );
    caller.abort();
    await work;
    await Promise.race([
      cancelled.promise,
      delay(1000).then(() =>
        assert.fail("client abort must propagate to Core work"),
      ),
    ]);
    assert.equal(signal?.aborted, true);
  } finally {
    caller.abort();
    listener.close();
    await service.close();
  }
});

it("the absolute notification deadline includes push-token preflight and rejects expired work before starting", async () => {
  const service = bridge();
  let calls = 0,
    signal: AbortSignal | undefined;
  (service as any).core = async (
    _op: string,
    _input: unknown,
    cancel: AbortSignal,
  ) => {
    calls++;
    signal = cancel;
    return new Promise((_, reject) =>
      cancel.addEventListener("abort", () => reject(cancel.reason), {
        once: true,
      }),
    );
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      service.operation("notify", {
        user_id: "fixture",
        event,
        deadline_ms: Date.now() - 1,
      }),
    );
    assert.equal(calls, 0);
    await assert.rejects(
      service.operation("notify", {
        user_id: "fixture",
        event,
        deadline_ms: Date.now() + 30,
      }),
    );
    assert.equal(calls, 1);
    assert.equal(signal?.aborted, true);
  } finally {
    clearTimeout(keepAlive);
    await service.close();
  }
});

it("normal notification HTTP completion preserves a successful bounded response", async () => {
  const service = bridge();
  let signal: AbortSignal | undefined;
  service.notify = async (_user, _event, cancel) => {
    signal = cancel;
    await delay(10);
    assert.equal(cancel?.aborted, false);
  };
  const app = express();
  app.use(express.json());
  app.post("/internal/agent/notify", async (req, res) => {
    const c = notificationCancellation(req, res);
    try {
      res.json(await service.operation("notify", req.body, c.signal));
    } finally {
      c.close();
    }
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address !== "string");
  try {
    await new BridgeAdapter(
      `http://127.0.0.1:${address.port}`,
      "fixture",
    ).notify("fixture", event);
    await delay(10);
    assert.equal(signal?.aborted, false);
  } finally {
    listener.close();
    await service.close();
  }
});

it(
  "resumes three 8-second device deliveries across the 20-second cutoff using real PostgreSQL receipts",
  { skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL },
  async (t) => {
    const database = process.env.RIDE_AGENT_TEST_DATABASE_URL!,
      service = bridge(database),
      owner = `fanout_${randomUUID()}`,
      admin = new pg.Pool({ connectionString: database });
    const old = process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64;
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(
      JSON.stringify({
        type: "service_account",
        project_id: "ride-fiamma",
        client_email: "fixture@ride-fiamma.iam.gserviceaccount.com",
        private_key: privateKey,
      }),
    ).toString("base64");
    const originalFetch = globalThis.fetch;
    let clock = 1700000000000;
    t.mock.method(Date, "now", () => clock);
    const devices = [
        "fixture_device_1",
        "fixture_device_2",
        "fixture_device_3",
      ],
      sent: string[] = [];
    (service as any).core = async () => devices;
    (service as any).tokens = { value: "fixture", expiry: clock + 3600000 };
    await (service as any).notificationReceipts.migrate();
    let wireDeadline = clock + 20000;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.message.data.event_id, event.id);
      sent.push(body.message.token);
      if (clock + 8000 > wireDeadline) {
        clock = wireDeadline;
        throw new DOMException("fixture wire deadline", "TimeoutError");
      }
      clock += 8000;
      return Response.json({ name: "projects/ride-fiamma/messages/fixture" });
    };
    try {
      await assert.rejects(
        service.operation("notify", {
          user_id: owner,
          event,
          deadline_ms: wireDeadline,
        }),
        (error: any) => error.name === "TimeoutError",
      );
      const receipts = (service as any).notificationReceipts;
      assert.equal(await receipts.acknowledged(owner, event, devices[0]), true);
      assert.equal(await receipts.acknowledged(owner, event, devices[1]), true);
      assert.equal(
        await receipts.acknowledged(owner, event, devices[2]),
        false,
      );
      clock += 1000;
      wireDeadline = clock + 20000;
      assert.deepEqual(
        await service.operation("notify", {
          user_id: owner,
          event,
          deadline_ms: wireDeadline,
        }),
        { ok: true },
      );
      assert.deepEqual(
        sent,
        [...devices, devices[2]],
        "confirmed prefix devices are skipped; an unconfirmed last send retries the same event id",
      );
      assert.equal(await receipts.acknowledged(owner, event, devices[2]), true);
    } finally {
      globalThis.fetch = originalFetch;
      if (old === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64;
      else process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64 = old;
      await admin.query(
        "DELETE FROM ride_agent_notification_receipts WHERE user_id=$1",
        [owner],
      );
      await admin.end();
      await service.close();
    }
  },
);
