import test from "node:test";
import assert from "node:assert/strict";
import { AgentError } from "./contracts.js";
import {
  monitorOperation,
  monitorPhase,
  noteMonitorAccountAge,
  noteMonitorSourceEvidence,
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

test("publication age is labeled only after the caller has committed the audit", async () => {
  const records: MonitorTimingRecord[] = [];
  await runMonitorTrace(
    async () => {
      await monitorPhase("audit_control", async () => {});
      noteMonitorAccountAge(Date.now() - 500, "published");
    },
    { report: (record) => records.push(record) },
  );
  const age = records.find((record) => record.kind === "account_age")!;
  assert.equal(age.phase, "audit_control");
  assert.equal(age.parent_phase, "tick");
  assert.ok(age.account_age_ms! >= 500);
});

test("account diagnostics retain exact observation and stage with one consistent wall capture", (t) => {
  const base = 1800000000000;
  let wall = base;
  t.mock.method(Date, "now", () => wall++);
  const records: MonitorTimingRecord[] = [];
  return runMonitorTrace(
    async () => {
      noteMonitorAccountAge(base - 123, "returned");
      noteMonitorAccountAge(base - 123, "published");
    },
    { clock: () => 0, report: (record) => records.push(record) },
  ).then(() => {
    const accounts = records.filter((record) => record.kind === "account_age");
    assert.deepEqual(
      accounts.map((record) => [
        record.account_observed_at_ms,
        record.account_stage,
        record.emitted_at_ms,
        record.account_age_ms,
      ]),
      [
        [base - 123, "returned", base, 123],
        [base - 123, "published", base + 1, 124],
      ],
    );
    assert.equal(records.at(-1)?.emitted_at_ms, base + 2);
  });
});

test("every emitted timing has producer wall time without changing monotonic timing or fast suppression", async (t) => {
  const base = 1800000000000;
  t.mock.method(Date, "now", () => base);
  const records: MonitorTimingRecord[] = [];
  let mono = 0;
  await runMonitorTrace(
    async () => {
      await monitorPhase("observe_plan", async () => {
        await monitorOperation("source", async () => {
          mono += 300;
        });
        noteMonitorSourceEvidence(base - 20, base - 25, base, 1);
      });
      await monitorPhase("durable_notify", async () => {});
    },
    { clock: () => mono, report: (record) => records.push(record) },
  );
  assert.ok(records.every((record) => record.emitted_at_ms === base));
  assert.deepEqual(
    records.map((record) => [record.kind, record.phase, record.duration_ms]),
    [
      ["operation", "observe_plan", 300],
      ["source_age", "observe_plan", 0],
      ["phase", "observe_plan", 300],
      ["tick", "tick", 300],
    ],
  );
  assert.ok(
    records.every(
      (record) =>
        record.kind === "account_age" ||
        (!Object.hasOwn(record, "account_observed_at_ms") &&
          !Object.hasOwn(record, "account_stage")),
    ),
  );
});

test("invalid raw observation timestamps and arbitrary stages cannot leak into diagnostics", async (t) => {
  const base = 1800000000000;
  t.mock.method(Date, "now", () => base);
  const records: MonitorTimingRecord[] = [];
  const secret = "private-owner-stage-do-not-log";
  await runMonitorTrace(
    async () => {
      for (const at of [NaN, Infinity, 0, -1, base + 0.5, 2 ** 53])
        noteMonitorAccountAge(at);
      noteMonitorAccountAge({
        valueOf() {
          throw new Error(secret);
        },
      } as unknown as number);
      noteMonitorAccountAge(base, secret as "returned");
    },
    { clock: () => 0, report: (record) => records.push(record) },
  );
  assert.equal(
    records.filter((record) => record.kind === "account_age").length,
    0,
  );
  assert.equal(JSON.stringify(records).includes(secret), false);
});

test("invalid wall readings drop diagnostics without changing successful work", async (t) => {
  let wall = NaN;
  t.mock.method(Date, "now", () => wall);
  const records: MonitorTimingRecord[] = [];
  for (const value of [NaN, Infinity, 0, -1, 1800000000000.5, 2 ** 53]) {
    wall = value;
    assert.equal(
      await runMonitorTrace(
        async () => {
          noteMonitorAccountAge(1800000000000);
          return 42;
        },
        { clock: () => 0, report: (record) => records.push(record) },
      ),
      42,
    );
  }
  assert.equal(records.length, 0);
});

test("throwing diagnostic wall capture cannot replace business results or errors", async (t) => {
  t.mock.method(Date, "now", () => {
    throw new Error("fixture clock unavailable");
  });
  const records: MonitorTimingRecord[] = [];
  const options = {
    clock: () => 0,
    report: (record: MonitorTimingRecord) => records.push(record),
  };
  assert.equal(
    await runMonitorTrace(async () => {
      noteMonitorAccountAge(1800000000000);
      return 42;
    }, options),
    42,
  );
  const original = new Error("fixture original business failure");
  await assert.rejects(
    runMonitorTrace(
      () =>
        monitorPhase("audit_control", async () => {
          throw original;
        }),
      options,
    ),
    (error) => error === original,
  );
  assert.equal(records.length, 0);
});

test("wall-clock reversals do not replace monotonic durations or rewrite future observations", async (t) => {
  const base = 1800000000000;
  let wall = base,
    mono = 0;
  t.mock.method(Date, "now", () => wall);
  const records: MonitorTimingRecord[] = [];
  await runMonitorTrace(
    () =>
      monitorPhase("audit_control", async () => {
        mono = 300;
        wall = base - 1000;
        noteMonitorAccountAge(base, "returned");
        wall = base - 2000;
      }),
    { clock: () => mono, report: (record) => records.push(record) },
  );
  const account = records.find((record) => record.kind === "account_age")!;
  assert.equal(account.account_observed_at_ms, base);
  assert.equal(account.emitted_at_ms, base - 1000);
  assert.equal(
    account.account_age_ms,
    0,
    "original age clamping is retained; raw future evidence remains visible",
  );
  assert.ok(
    records
      .filter((record) => record.kind !== "account_age")
      .every((record) => record.duration_ms === 300),
  );
});

test("identical observation timestamps keep independent ephemeral tick references", async (t) => {
  const base = 1800000000000;
  t.mock.method(Date, "now", () => base + 100);
  const records: MonitorTimingRecord[] = [];
  const options = {
    clock: () => 0,
    report: (record: MonitorTimingRecord) => records.push(record),
  };
  await Promise.all(
    [1, 2].map(() =>
      runMonitorTrace(async () => {
        noteMonitorAccountAge(base, "returned");
        await Promise.resolve();
        noteMonitorAccountAge(base, "published");
      }, options),
    ),
  );
  const accounts = records.filter((record) => record.kind === "account_age");
  assert.equal(accounts.length, 4);
  assert.equal(new Set(accounts.map((record) => record.tick_ref)).size, 2);
  assert.ok(accounts.every((record) => record.account_observed_at_ms === base));
  for (const ref of new Set(accounts.map((record) => record.tick_ref)))
    assert.deepEqual(
      accounts
        .filter((record) => record.tick_ref === ref)
        .map((record) => record.account_stage),
      ["returned", "published"],
    );
});
