import assert from "node:assert/strict";
import { it } from "node:test";
import type { Execution } from "./domain.js";
import { perpsRecoveryRequest } from "./execution-core-recovery.js";
import {
  perpsExecutionRetirement,
  persistedPerpsRetirement,
} from "./execution-retirement.js";

function fixture() {
  const at = Date.now();
  const e: Execution = {
    id: "execution_original",
    key: "perps:BTC",
    target_quantity: "1",
    allocations: {},
    status: "uncertain",
    revision: 1,
    fingerprint: "f".repeat(64),
    created_at: at - 120_000,
    expires_at: at - 60_000,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "10",
    error: null,
  };
  const request = perpsRecoveryRequest(
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    e,
  )!;
  const receipt = {
    protocol_version: 1,
    retirement: "original_absence_retired",
    reason_code: "ORIGINAL_ABSENCE_PERMANENTLY_RETIRED",
    proof: {
      ...request,
      network: "mainnet",
      observed_at: at,
      current_execution_epoch: "00000000-0000-4000-8000-000000000003",
      retirement_epoch: "00000000-0000-4000-8000-000000000003",
      tombstone_id: "00000000-0000-4000-8000-000000000004",
      retired_at: at,
      serialized_absence_check: true,
      permanent_original_id_fence: true,
      historical_bindings_checked: true,
    },
  };
  return { at, e, request, receipt };
}

it("only an explicit permanent original-ID absence fence becomes a typed retirement receipt, never a fill", () => {
  const f = fixture();
  const original = structuredClone(f);
  assert.deepEqual(
    perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
    f.receipt,
  );
  assert.deepEqual(f, original);
  for (const response of [
    undefined,
    null,
    [],
    { found: false },
    { status: "failed" },
    { acceptance: "not_accepted_expired" },
    { ...f.receipt, protocol_version: 0 },
    { ...f.receipt, retirement: "unknown" },
    { ...f.receipt, reason_code: "NOT_FOUND" },
    { ...f.receipt, proof: null },
  ])
    assert.equal(
      perpsExecutionRetirement(f.request, response, f.at, f.at),
      null,
    );
});

it("retirement requires every unchanged original field, without quantity, timestamp or missing payload reconstruction", () => {
  for (const field of Object.keys(fixture().request)) {
    const f = fixture();
    const proof = f.receipt.proof as Record<string, unknown>;
    delete proof[field];
    assert.equal(
      perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
      null,
      field,
    );
  }
  const f = fixture();
  f.receipt.proof.target_quantity = "1.0";
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
    null,
  );
});

it("unknown fences, incomplete historical-binding checks, wrong network, future or premature retirement preserve uncertainty", () => {
  for (const [field, value] of [
    ["network", "testnet"],
    ["current_execution_epoch", null],
    ["retirement_epoch", null],
    ["tombstone_id", null],
    ["tombstone_id", "00000000-0000-0000-0000-000000000000"],
    ["retired_at", 0],
    ["observed_at", 0],
    ["serialized_absence_check", false],
    ["permanent_original_id_fence", false],
    ["historical_bindings_checked", false],
    ["permanent_original_id_fence", "true"],
  ] as const) {
    const f = fixture();
    Object.assign(f.receipt.proof, { [field]: value });
    assert.equal(
      perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
      null,
      field,
    );
  }
  const f = fixture();
  f.receipt.proof.retired_at = f.at + 1;
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
    null,
  );
  f.receipt.proof.retired_at = f.e.expires_at - 1;
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
    null,
  );
});

it("new retirement responses require bounded fresh evidence while a committed permanent receipt remains valid across restart and epoch rotation", () => {
  const f = fixture();
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at + 1001, f.at + 1001),
    null,
  );
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at, f.at + 30_001),
    null,
  );
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at - 1001, f.at - 1001),
    null,
  );
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, Number.NaN, f.at),
    null,
  );
  assert.equal(
    perpsExecutionRetirement(f.request, f.receipt, f.at, Number.NaN),
    null,
  );
  const later = f.at + 60 * 86400_000;
  assert.deepEqual(
    persistedPerpsRetirement(f.request, f.receipt, later),
    f.receipt,
  );
  f.receipt.proof.current_execution_epoch =
    "00000000-0000-4000-8000-000000000005";
  assert.deepEqual(
    perpsExecutionRetirement(f.request, f.receipt, f.at, f.at),
    f.receipt,
  );
});
