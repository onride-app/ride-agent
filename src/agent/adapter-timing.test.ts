import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BridgeAdapter } from "./adapter.js";
import { AgentError } from "./contracts.js";
import type { Portfolio } from "./domain.js";
import { snapshot } from "./fixtures.js";
import {
  monitorOperation,
  monitorPhase,
  runMonitorTrace,
  type MonitorTimingRecord,
} from "./monitor-diagnostics.js";

const privateUser = "private-user-payload-9f";
const privateAccount = "private-account-payload-7c";
const privateToken = "private-service-token-3a";
const privateMessage = "private-error-message-5b";
const privateUrl = "https://private-executor-4d.invalid";
const portfolio = { account_id: privateAccount } as Portfolio;

function fixture(t: TestContext) {
  const records: MonitorTimingRecord[] = [];
  const consoleRecords: unknown[][] = [];
  let time = 0;
  t.mock.method(console, "info", (...items: unknown[]) =>
    consoleRecords.push(items),
  );
  return {
    adapter: new BridgeAdapter(privateUrl, privateToken),
    records,
    consoleRecords,
    options: {
      clock: () => time,
      report: (record: MonitorTimingRecord) => records.push(record),
      thresholdMs: 0,
    },
    advance(milliseconds: number) {
      time += milliseconds;
    },
  };
}

function assertSafe(records: MonitorTimingRecord[]) {
  const encoded = JSON.stringify(records);
  for (const secret of [
    privateUser,
    privateAccount,
    privateToken,
    privateMessage,
    privateUrl,
  ])
    assert.ok(
      !encoded.includes(secret),
      "timing records may not contain request or error payloads",
    );
  for (const record of records) {
    assert.equal(record.event, "agent_monitor_timing");
    assert.match(record.tick_ref, /^[0-9a-f-]{36}$/);
    assert.ok(
      Number.isSafeInteger(record.emitted_at_ms) && record.emitted_at_ms! > 0,
      "producer wall time must be a positive safe-integer millisecond value",
    );
    assert.ok(
      Object.keys(record).every((key) =>
        [
          "event",
          "tick_ref",
          "kind",
          "phase",
          "parent_phase",
          "operation",
          "duration_ms",
          "outcome",
          "error_category",
          "emitted_at_ms",
        ].includes(key),
      ),
      "adapter diagnostics must contain only the timing schema",
    );
  }
}

it("does not emit adapter timing outside a monitor trace", async (t) => {
  const f = fixture(t),
    result = snapshot();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(result)),
  );
  assert.deepEqual(await f.adapter.account(privateUser, portfolio), result);
  assert.deepEqual(f.consoleRecords, []);
  assert.deepEqual(f.records, []);
});

it("records complete adapter fetch and JSON time under a random monitor trace without user payloads", async (t) => {
  const emittedAt = 1800000000000;
  t.mock.method(Date, "now", () => emittedAt);
  const f = fixture(t),
    result = snapshot();
  let sentBody: unknown;
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string | URL | Request, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body));
      f.advance(300);
      const response = new Response(JSON.stringify(result));
      response.json = async () => {
        f.advance(50);
        return result;
      };
      return response;
    },
  );
  const observed = await runMonitorTrace(
    () =>
      monitorPhase("account_observation", () =>
        f.adapter.account(privateUser, portfolio),
      ),
    f.options,
  );
  assert.deepEqual(observed, result);
  assert.deepEqual(sentBody, { user_id: privateUser, portfolio });
  const operations = f.records.filter((record) => record.kind === "operation");
  assert.equal(operations.length, 1);
  assert.deepEqual(operations[0], {
    event: "agent_monitor_timing",
    tick_ref: operations[0].tick_ref,
    kind: "operation",
    phase: "account_observation",
    parent_phase: "tick",
    operation: "account",
    duration_ms: 350,
    outcome: "ok",
    emitted_at_ms: emittedAt,
  });
  assert.equal(new Set(f.records.map((record) => record.tick_ref)).size, 1);
  assertSafe(f.records);
});

it("keeps typed adapter failure and retry details while recording only its safe category", async (t) => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async () => {
    f.advance(216);
    return new Response(
      JSON.stringify({
        error: {
          code: "VENUE_READ_BUDGET_EXHAUSTED",
          message: privateMessage,
          retryable: true,
          details: { retry_after_ms: 216 },
        },
      }),
      { status: 503 },
    );
  });
  await assert.rejects(
    runMonitorTrace(() => f.adapter.account(privateUser, portfolio), f.options),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
      assert.equal(error.message, privateMessage);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details, { retry_after_ms: 216 });
      return true;
    },
  );
  const operation = f.records.find((record) => record.kind === "operation");
  assert.equal(operation?.operation, "account");
  assert.equal(operation?.duration_ms, 216);
  assert.equal(operation?.outcome, "error");
  assert.equal(operation?.error_category, "VENUE_READ_BUDGET_EXHAUSTED");
  assertSafe(f.records);
});

it("preserves the exact thrown value and redacts unapproved operation and error labels", async (t) => {
  const f = fixture(t),
    original = new AgentError(privateUser, privateMessage, true, 503);
  await assert.rejects(
    runMonitorTrace(
      () =>
        monitorOperation(privateUrl, async () => {
          f.advance(1);
          throw original;
        }),
      f.options,
    ),
    (error) => error === original,
  );
  const operation = f.records.find((record) => record.kind === "operation");
  assert.equal(operation?.operation, "other");
  assert.equal(operation?.error_category, "other");
  assertSafe(f.records);
});

it("does not let a diagnostic reporter failure change a successful adapter response", async (t) => {
  const f = fixture(t),
    result = snapshot();
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(result)),
  );
  assert.deepEqual(
    await runMonitorTrace(() => f.adapter.account(privateUser, portfolio), {
      ...f.options,
      report: () => {
        throw Error(privateMessage);
      },
    }),
    result,
  );
});
