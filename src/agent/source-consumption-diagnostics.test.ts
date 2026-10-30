import test from "node:test";
import assert from "node:assert/strict";
import {
  monitorPhase,
  noteMonitorSourceEvidence,
  runMonitorTrace,
  type MonitorTimingRecord,
} from "./monitor-diagnostics.js";

test("source consumption evidence retains original times and oldest position without owner data", async () => {
  const records: MonitorTimingRecord[] = [];
  const checked = 1_790_000_000_000;
  const privateText = "private-user-account-trader-request";
  await runMonitorTrace(
    () =>
      monitorPhase(privateText, async () => {
        noteMonitorSourceEvidence(checked - 100, checked - 4900, checked, 2);
        noteMonitorSourceEvidence(checked - 100, checked - 6000, checked, 3);
        noteMonitorSourceEvidence(checked + 1000, checked, checked, 1);
        noteMonitorSourceEvidence(Number.NaN, checked, checked, 1);
      }),
    { report: (record) => records.push(record) },
  );
  const evidence = records.filter((record) => record.kind === "source_age");
  assert.equal(evidence.length, 3);
  assert.equal(evidence[0].source_observed_at_ms, checked - 100);
  assert.equal(evidence[0].source_positions_min_observed_at_ms, checked - 4900);
  assert.equal(evidence[0].source_checked_at_ms, checked);
  assert.equal(evidence[0].source_age_ms, 100);
  assert.equal(evidence[0].source_positions_max_age_ms, 4900);
  assert.equal(evidence[0].outcome, "ok");
  assert.equal(evidence[1].outcome, "error");
  assert.equal(evidence[1].error_category, "SOURCE_STALE");
  assert.equal(evidence[2].source_age_ms, -1000);
  assert.equal(evidence[2].outcome, "error");
  assert.ok(evidence.every((row) => row.tick_ref === evidence[0].tick_ref));
  assert.ok(evidence.every((row) => row.phase === "other"));
  assert.equal(JSON.stringify(records).includes(privateText), false);
  let continued = false;
  await runMonitorTrace(
    async () => {
      noteMonitorSourceEvidence(checked, checked, checked, 1);
      continued = true;
    },
    { report: () => { throw new Error(privateText); } },
  );
  assert.equal(continued, true);
});
