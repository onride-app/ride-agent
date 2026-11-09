import assert from "node:assert/strict";
import { it } from "node:test";
import type { Execution } from "./domain.js";
import {
  perpsExecutionRecovery,
  perpsRecoveryRequest,
} from "./execution-core-recovery.js";

function fixture() {
  const user = "00000000-0000-4000-8000-000000000001";
  const account = "00000000-0000-4000-8000-000000000002";
  const e: Execution = {
    id: "execution_original",
    key: "perps:BTC",
    target_quantity: "1",
    allocations: {},
    status: "uncertain",
    revision: 1,
    fingerprint: "f".repeat(64),
    created_at: Date.now() - 120_000,
    expires_at: Date.now() - 60_000,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "10",
    error: null,
  };
  return { user, account, e };
}

function evidence() {
  const f = fixture();
  const request = perpsRecoveryRequest(f.user, f.account, f.e)!;
  const at = Date.now();
  const value = {
    protocol_version: 1,
    acceptance: "accepted",
    reason_code: "ORIGINAL_TASK_FOUND",
    task_id: "00000000-0000-4000-8000-000000000003",
    proof: {
      ...request,
      network: "mainnet",
      observed_at: at,
      intent_id: "00000000-0000-4000-8000-000000000004",
      current_execution_epoch: "00000000-0000-4000-8000-000000000005",
      original_execution_epoch: "00000000-0000-4000-8000-000000000005",
      wallet_generation: 3,
      original_wallet_generation: 3,
      serialized_identity_check: true,
    },
  };
  return { ...f, request, at, value };
}

it("missing-outbox recovery selects only the original durable identity without inventing a frozen submit payload", () => {
  const f = fixture();
  const before = structuredClone(f.e);
  assert.deepEqual(perpsRecoveryRequest(f.user, f.account, f.e), {
    user_id: f.user,
    account_id: f.account,
    execution_id: f.e.id,
    fingerprint: f.e.fingerprint,
    asset: "BTC",
    target_quantity: f.e.target_quantity,
    created_at: f.e.created_at,
    expires_at: f.e.expires_at,
  });
  assert.deepEqual(f.e, before);
});

it("invalid owners, original execution identity, market, quantity or times cannot start Core recovery", () => {
  for (const [field, value] of [
    ["id", ""],
    ["id", "execution\nother"],
    ["fingerprint", "F".repeat(64)],
    ["fingerprint", "f".repeat(63)],
    ["key", "prediction:fixture"],
    ["key", "perps:"],
    ["key", "perps:BTC/ETH"],
    ["target_quantity", "NaN"],
    ["target_quantity", "Infinity"],
    ["target_quantity", "not-a-quantity"],
    ["target_quantity", 1],
    ["created_at", 0],
    ["created_at", 1.5],
    ["expires_at", 0],
    ["expires_at", Number.MAX_SAFE_INTEGER + 1],
  ] as const) {
    const f = fixture();
    Object.assign(f.e, { [field]: value });
    assert.equal(perpsRecoveryRequest(f.user, f.account, f.e), null, field);
  }
  const f = fixture();
  for (const id of [
    null,
    undefined,
    "",
    "not-a-uuid",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    assert.equal(perpsRecoveryRequest(f.user, id, f.e), null);
    if (typeof id === "string")
      assert.equal(perpsRecoveryRequest(id, f.account, f.e), null);
  }
  f.e.expires_at = f.e.created_at;
  assert.equal(perpsRecoveryRequest(f.user, f.account, f.e), null);
});

it("supported DEX asset identity and original expired times are not rewritten into a new admission", () => {
  const f = fixture();
  f.e.key = "perps:xyz:GOLD";
  f.e.target_quantity = "-1e-8";
  const request = perpsRecoveryRequest(f.user, f.account, f.e)!;
  assert.equal(request.asset, "xyz:GOLD");
  assert.equal(request.target_quantity, "-1e-8");
  assert.equal(request.created_at, f.e.created_at);
  assert.equal(request.expires_at, f.e.expires_at);
  assert.deepEqual(Object.keys(request).sort(), [
    "account_id",
    "asset",
    "created_at",
    "execution_id",
    "expires_at",
    "fingerprint",
    "target_quantity",
    "user_id",
  ]);
});

it("a fresh same-owner, original-quantity, wallet-generation and epoch-bound positive proof recovers only the existing task", () => {
  const f = evidence();
  const original = structuredClone(f);
  assert.deepEqual(perpsExecutionRecovery(f.request, f.value, f.at, f.at), {
    kind: "accepted",
    task_id: f.value.task_id,
  });
  assert.deepEqual(f, original);
});

it("a legacy, absent, expired or held-only response can never become negative acceptance evidence", () => {
  const f = evidence();
  for (const value of [
    undefined,
    null,
    [],
    { found: false },
    { found: true, task_id: f.value.task_id },
    { ...f.value, protocol_version: 0 },
    { ...f.value, acceptance: "unknown" },
    { ...f.value, acceptance: "not_accepted_expired" },
    { ...f.value, reason_code: "EXPIRED_ABSENT_UNDER_ADMISSION_LOCK" },
    { ...f.value, proof: null },
    { ...f.value, task_id: null },
    { ...f.value, task_id: "00000000-0000-0000-0000-000000000000" },
  ])
    assert.deepEqual(perpsExecutionRecovery(f.request, value, f.at, f.at), {
      kind: "unknown",
    });
});

it("every original identity field must be echoed exactly, with no quantity or expiry reconstruction", () => {
  for (const field of Object.keys(evidence().request)) {
    const f = evidence();
    const proof = f.value.proof as Record<string, unknown>;
    const original = proof[field];
    delete proof[field];
    assert.deepEqual(
      perpsExecutionRecovery(f.request, f.value, f.at, f.at),
      {
        kind: "unknown",
      },
      field,
    );
    proof[field] =
      typeof original === "number" ? original + 1 : original + "other";
    assert.deepEqual(
      perpsExecutionRecovery(f.request, f.value, f.at, f.at),
      {
        kind: "unknown",
      },
      field,
    );
  }
  const f = evidence();
  f.value.proof.target_quantity = "1.0";
  assert.deepEqual(
    perpsExecutionRecovery(f.request, f.value, f.at, f.at),
    {
      kind: "unknown",
    },
    "Core validates numeric equality with its stored original size but must echo the caller's original quantity string",
  );
});

it("unknown generation, rotated epoch, stale/reordered proof and unverified serialization stay unknown", () => {
  for (const [field, value] of [
    ["network", "testnet"],
    ["intent_id", "not-an-intent"],
    ["current_execution_epoch", null],
    ["current_execution_epoch", "00000000-0000-0000-0000-000000000000"],
    ["original_execution_epoch", null],
    ["original_execution_epoch", "00000000-0000-4000-8000-000000000009"],
    ["wallet_generation", null],
    ["wallet_generation", 0],
    ["wallet_generation", -1],
    ["wallet_generation", 1.5],
    ["original_wallet_generation", null],
    ["original_wallet_generation", 0],
    ["original_wallet_generation", 4],
    ["serialized_identity_check", false],
    ["serialized_identity_check", "true"],
    ["observed_at", 0],
    ["observed_at", Number.NaN],
  ] as const) {
    const f = evidence();
    Object.assign(f.value.proof, { [field]: value });
    assert.deepEqual(
      perpsExecutionRecovery(f.request, f.value, f.at, f.at),
      {
        kind: "unknown",
      },
      field,
    );
  }
  const f = evidence();
  for (const [started, completed, observed] of [
    [f.at, f.at, f.at - 1001],
    [f.at, f.at, f.at + 1001],
    [f.at, f.at + 30_001, f.at],
    [f.at + 1, f.at, f.at],
    [Number.NaN, f.at, f.at],
    [f.at, Number.NaN, f.at],
  ]) {
    f.value.proof.observed_at = observed;
    assert.deepEqual(
      perpsExecutionRecovery(f.request, f.value, started, completed),
      {
        kind: "unknown",
      },
    );
  }
});
