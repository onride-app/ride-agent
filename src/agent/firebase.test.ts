import { it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { firebaseAccount } from "./firebase.js";
import { CoreBridge } from "./core_bridge.js";
import { now } from "./domain.js";
const private_key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const account = {
  type: "service_account",
  project_id: "ride-fiamma",
  client_email: "fixture@ride-fiamma.iam.gserviceaccount.com",
  private_key,
};
it("accepts existing Ride base64 and legacy raw JSON without changing the credential", () => {
  assert.equal(firebaseAccount({}), null);
  const raw = JSON.stringify(account);
  for (const env of [
    { FIREBASE_SERVICE_ACCOUNT_JSON: raw },
    { FCM_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from(raw).toString("base64") },
    { FCM_SERVICE_ACCOUNT_JSON: raw },
  ]) {
    assert.deepEqual(
      firebaseAccount({ ...env, RIDE_AGENT_FCM_PROJECT_ID: "ride-fiamma" }),
      {
        project_id: account.project_id,
        client_email: account.client_email,
        private_key,
      },
    );
  }
});
it("rejects malformed or foreign credentials without disclosing their content", () => {
  for (const env of [
    { FCM_SERVICE_ACCOUNT_JSON_BASE64: "not-a-valid-secret" },
    {
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        ...account,
        private_key: "sensitive-invalid-key",
      }),
    },
    {
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
      RIDE_AGENT_FCM_PROJECT_ID: "different-project",
    },
  ])
    assert.throws(
      () => firebaseAccount(env),
      (e) =>
        e instanceof Error &&
        /invalid or belong/.test(e.message) &&
        !e.message.includes("sensitive"),
    );
});

it("uses existing Firebase project and delivers only the report owner's event payload", async () => {
  const old = process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64;
  process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(
    JSON.stringify(account),
  ).toString("base64");
  const fetchBefore = globalThis.fetch;
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "x".repeat(32),
    "testnet",
  );
  const stub = bridge as any;
  stub.notificationReceipts = {
    acknowledged: async () => false,
    acknowledge: async () => {},
  };
  stub.core = async (op: string, args: any) => {
    assert.equal(op, "push_tokens");
    assert.deepEqual(args, { user_id: "alice" });
    return ["test-device-token"];
  };
  stub.tokens = { value: "fixture-oauth", expiry: now() + 3600_000 };
  let sends = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(
      url,
      "https://fcm.googleapis.com/v1/projects/ride-fiamma/messages:send",
    );
    const { message } = JSON.parse(options!.body as string);
    assert.equal(message.token, "test-device-token");
    assert.deepEqual(message.data, {
      type: "ride_agent",
      event_id: "update_test_report",
      event_kind: "daily_digest",
    });
    assert.equal(message.notification.body, "TEST report");
    sends++;
    return new Response(
      JSON.stringify({ name: "projects/ride-fiamma/messages/fixture" }),
      { status: 200 },
    );
  };
  try {
    await bridge.notify("alice", {
      id: "update_test_report",
      kind: "daily_digest",
      message: "TEST report",
      portfolio_id: null,
    });
    assert.equal(sends, 1);
  } finally {
    globalThis.fetch = fetchBefore;
    if (old === undefined) delete process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64;
    else process.env.FCM_SERVICE_ACCOUNT_JSON_BASE64 = old;
    await bridge.close();
  }
});
