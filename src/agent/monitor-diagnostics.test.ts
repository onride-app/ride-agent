import test from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "./contracts.js";
import {
  monitorOperation,
  monitorPhase,
  noteMonitorAccountAge,
  runMonitorTrace,
  type MonitorTimingRecord,
} from "./monitor-diagnostics.js";

test("monitor timings isolate concurrent ticks and retain nested context without owner data", async () => {
  const records: MonitorTimingRecord[] = [];
  let now = 0;
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const first = runMonitorTrace(
    () =>
      monitorPhase("observe_plan", async () => {
        await blocked;
        await runMonitorTrace(() =>
          monitorOperation("account", async () => {
            now += 300;
          }),
        );
        noteMonitorAccountAge(Date.now() - 400);
      }),
    {
      clock: () => now,
      report: (record) => records.push(record),
      thresholdMs: 0,
    },
  );
  await runMonitorTrace(
    () =>
      monitorPhase("durable_notify", () =>
        monitorOperation("notify", async () => {
          now += 500;
        }),
      ),
    {
      clock: () => now,
      report: (record) => records.push(record),
      thresholdMs: 0,
    },
  );
  finish();
  await first;
  const ticks = records.filter((record) => record.kind === "tick");
  assert.equal(ticks.length, 2);
  assert.notEqual(ticks[0].tick_ref, ticks[1].tick_ref);
  const account = records.find((record) => record.operation === "account")!;
  const notification = records.find((record) => record.operation === "notify")!;
  assert.equal(account.phase, "observe_plan");
  assert.equal(account.duration_ms, 300);
  assert.equal(account.tick_ref, ticks[1].tick_ref);
  assert.equal(notification.tick_ref, ticks[0].tick_ref);
  assert.equal(notification.duration_ms, 500);
  assert.ok(
    records.find((record) => record.kind === "account_age")!.account_age_ms! >=
      400,
  );
});

test("monitor timings whitelist labels and errors, preserve failures, and ignore a broken reporter", async () => {
  const records: MonitorTimingRecord[] = [];
  const secret = "private-owner-wallet-request-message";
  const error = new AgentError(secret, secret, false, 500, {
    reason_code: secret,
  });
  await assert.rejects(
    runMonitorTrace(
      () =>
        monitorPhase(secret, () =>
          monitorOperation(secret, async () => {
            throw error;
          }),
        ),
      { report: (record) => records.push(record) },
    ),
    (caught) => caught === error,
  );
  assert.ok(
    records.every(
      (record) =>
        record.outcome === "error" && record.error_category === "other",
    ),
  );
  assert.equal(
    records.find((record) => record.kind === "operation")!.operation,
    "other",
  );
  assert.equal(JSON.stringify(records).includes(secret), false);
  await assert.rejects(
    runMonitorTrace(
      async () => {
        throw error;
      },
      {
        report: () => {
          throw new Error("logger failure");
        },
      },
    ),
    (caught) => caught === error,
  );
  assert.equal(
    await runMonitorTrace(async () => 42, {
      report: () => {
        throw new Error("logger failure");
      },
    }),
    42,
  );
});

test("monitor timings suppress fast phases and remain silent outside a monitor tick", async () => {
  const records: MonitorTimingRecord[] = [];
  await runMonitorTrace(
    () =>
      monitorPhase("observe_plan", () =>
        monitorOperation("account", async () => 1),
      ),
    { clock: () => 0, report: (record) => records.push(record) },
  );
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "tick");
  await monitorPhase("observe_plan", () =>
    monitorOperation("account", async () => {
      noteMonitorAccountAge(Date.now());
    }),
  );
  assert.equal(records.length, 1);
  await runMonitorTrace(
    async () => {
      noteMonitorAccountAge(NaN);
    },
    { report: (record) => records.push(record) },
  );
  assert.equal(
    records.filter((record) => record.kind === "account_age").length,
    0,
  );
});
