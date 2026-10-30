import assert from "node:assert/strict";
import { it } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { AgentError } from "./contracts.js";
import type { Execution, Portfolio } from "./domain.js";

function fixture() {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://127.0.0.1:1/unused",
    "fixture-original-source-salt-at-least-32",
    "mainnet",
  );
  const stub = bridge as any;
  const user = "00000000-0000-4000-8000-000000000001";
  const at = Date.now();
  const p = {
    id: "portfolio_fixture",
    account_id: "00000000-0000-4000-8000-000000000002",
    sleeves: [],
  } as unknown as Portfolio;
  const e: Execution = {
    id: "execution_fixture_original",
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
  const payload: any = {
    user_id: user,
    account_id: p.account_id,
    execution_id: e.id,
    fingerprint: e.fingerprint,
    asset: "BTC",
    direction: "long",
    target_position_pct: "10.0000",
    leverage: 2,
    created_at: e.created_at,
    expires_at: e.expires_at,
    policy_revision: 1,
    target_quantity: "1",
    entry_reference_price: "100",
    max_entry_deviation_bps: 20,
  };
  const operations: string[] = [];
  const inputs: any[] = [];
  let writes = 0;
  let response: any = null;
  let present = true;
  stub.pool.query = async (sql: string, params: any[]) => {
    if (sql.startsWith("SELECT response,payload"))
      return present
        ? { rows: [{ response, payload }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    writes++;
    assert.ok(sql.startsWith("UPDATE ride_agent_core_outbox SET response="));
    response = params[1];
    return { rows: [], rowCount: 1 };
  };
  stub.core = async (operation: string) => {
    operations.push(operation);
    throw new AgentError(
      "CORE_UNAVAILABLE",
      "Old Core does not support the read-only acceptance proof.",
      true,
      503,
    );
  };
  return {
    bridge,
    stub,
    user,
    p,
    e,
    payload,
    operations,
    inputs,
    setPresent: (value: boolean) => {
      present = value;
    },
    setResponse: (value: unknown) => {
      response = value;
    },
    writes: () => writes,
  };
}

function proof(f: ReturnType<typeof fixture>, accepted = false) {
  const fields = [
    "user_id",
    "account_id",
    "execution_id",
    "fingerprint",
    "asset",
    "direction",
    "target_position_pct",
    "leverage",
    "created_at",
    "expires_at",
    "policy_revision",
  ];
  return {
    protocol_version: 1,
    acceptance: accepted ? "accepted" : "not_accepted_expired",
    reason_code: accepted
      ? "ORIGINAL_TASK_FOUND"
      : "EXPIRED_ABSENT_UNDER_ADMISSION_LOCK",
    task_id: accepted ? "00000000-0000-4000-8000-000000000004" : null,
    proof: {
      ...Object.fromEntries(fields.map((key) => [key, f.payload[key]])),
      network: "mainnet",
      observed_at: Date.now(),
      current_execution_epoch: "00000000-0000-4000-8000-000000000003",
      serialized_expiry_check: !accepted,
    },
  };
}

function readOnlyCore(f: ReturnType<typeof fixture>, value: any) {
  f.stub.core = async (operation: string, input: any) => {
    f.operations.push(operation);
    f.inputs.push(input);
    if (operation === "perps_execution_acceptance") return value;
    if (operation === "perps_execution")
      return { status: 2, snapshot: {}, legs: [{ quantity: "0.4" }] };
    assert.fail("Acceptance reconciliation cannot submit or mutate Core");
  };
  f.stub.account = async () => ({ positions: { "perps:BTC": "0.4" } });
}

it("reconciliation with an old Core never resubmits an unknown expired original target", async () => {
  const f = fixture();
  try {
    const result = await f.bridge.execution(f.user, f.p, f.e);
    assert.deepEqual(result, {
      status: "uncertain",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, ["perps_execution_acceptance"]);
    assert.equal(f.writes(), 0);
  } finally {
    await f.bridge.close();
  }
});

it("a legacy frozen target without an expiry cannot be proven never accepted or replayed", async () => {
  const f = fixture();
  delete f.payload.expires_at;
  try {
    const result = await f.bridge.execution(f.user, f.p, f.e);
    assert.deepEqual(result, {
      status: "uncertain",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, []);
    assert.equal(f.writes(), 0);
  } finally {
    await f.bridge.close();
  }
});

it("only a serialized, identity-matched expired absence proof can retire the original unknown target, without fills, journal rewrites, or resubmission", async () => {
  const f = fixture();
  const original = JSON.stringify(f.payload);
  readOnlyCore(f, proof(f));
  f.stub.account = async () =>
    assert.fail("Negative admission proof is not follower position evidence");
  try {
    const result = await f.bridge.execution(f.user, f.p, f.e);
    assert.deepEqual(result, {
      status: "failed",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, ["perps_execution_acceptance"]);
    assert.equal(Object.keys(f.inputs[0]).length, 11);
    assert.equal(f.inputs[0].target_quantity, undefined);
    assert.equal(f.inputs[0].entry_reference_price, undefined);
    assert.equal(JSON.stringify(f.payload), original);
    assert.equal(f.writes(), 0);
  } finally {
    await f.bridge.close();
  }
});

it("accepted proof recovers only the original task and continues its read-only partial execution status, never inventing completion", async () => {
  const f = fixture();
  const original = JSON.stringify(f.payload);
  const value = proof(f, true);
  readOnlyCore(f, value);
  try {
    const result = await f.bridge.execution(f.user, f.p, f.e);
    assert.deepEqual(result, {
      task_id: value.task_id,
      status: "partially_filled",
      observed_quantity: "0.4",
      settled: false,
    });
    assert.deepEqual(f.operations, [
      "perps_execution_acceptance",
      "perps_execution",
    ]);
    assert.equal(f.writes(), 1);
    assert.equal(JSON.stringify(f.payload), original);
    f.operations.length = 0;
    await f.bridge.execution(f.user, f.p, f.e);
    assert.deepEqual(f.operations, ["perps_execution"]);
    assert.equal(
      f.writes(),
      1,
      "Original task is durable; no acceptance retry can create another target",
    );
  } finally {
    await f.bridge.close();
  }
});

it("every frozen admission field must match the proof byte for byte before unknown execution can be released", async () => {
  for (const key of [
    "user_id",
    "account_id",
    "execution_id",
    "fingerprint",
    "asset",
    "direction",
    "target_position_pct",
    "leverage",
    "created_at",
    "expires_at",
    "policy_revision",
  ]) {
    const f = fixture();
    const value = proof(f);
    (value.proof as any)[key] =
      typeof (value.proof as any)[key] === "string"
        ? (value.proof as any)[key] + "_different"
        : (value.proof as any)[key] + 1;
    readOnlyCore(f, value);
    try {
      assert.deepEqual(
        await f.bridge.execution(f.user, f.p, f.e),
        { status: "uncertain", observed_quantity: null, settled: false },
        key,
      );
      assert.deepEqual(f.operations, ["perps_execution_acceptance"]);
      assert.equal(f.writes(), 0);
    } finally {
      await f.bridge.close();
    }
  }
});

it("incomplete, conflicting, malformed, stale, cross-network, or unserialized responses never release or replay an unknown target", async () => {
  const variants = [
    (v: any) => {
      v.protocol_version = 2;
    },
    (v: any) => {
      delete v.proof;
    },
    (v: any) => {
      v.reason_code = "NOT_FOUND";
    },
    (v: any) => {
      v.proof.serialized_expiry_check = false;
    },
    (v: any) => {
      v.task_id = "00000000-0000-4000-8000-000000000004";
    },
    (v: any) => {
      v.proof.network = "testnet";
    },
    (v: any) => {
      v.proof.observed_at = Date.now() - 30_001;
    },
    (v: any) => {
      v.proof.observed_at = Date.now() + 2000;
    },
    (v: any) => {
      v.proof.observed_at = String(Date.now());
    },
    (v: any) => {
      delete v.proof.current_execution_epoch;
    },
    (v: any) => {
      v.proof.current_execution_epoch = "00000000-0000-0000-0000-000000000000";
    },
    (v: any) => {
      v.acceptance = "unknown";
      v.reason_code = "INCOMPLETE_RECORD";
      v.proof.serialized_expiry_check = false;
    },
    (v: any) => {
      v.acceptance = "accepted";
      v.reason_code = "ORIGINAL_TASK_FOUND";
      v.task_id = "00000000-0000-0000-0000-000000000000";
      v.proof.serialized_expiry_check = false;
    },
  ];
  for (const mutate of variants) {
    const f = fixture();
    const value = proof(f);
    mutate(value);
    readOnlyCore(f, value);
    try {
      assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.deepEqual(f.operations, ["perps_execution_acceptance"]);
      assert.equal(f.writes(), 0);
    } finally {
      await f.bridge.close();
    }
  }
});

it("missing or changed original admission payload fields cannot be reconstructed from a new account observation", async () => {
  for (const key of [
    "user_id",
    "account_id",
    "execution_id",
    "fingerprint",
    "asset",
    "direction",
    "created_at",
    "expires_at",
    "policy_revision",
    "leverage",
    "target_quantity",
  ]) {
    const f = fixture();
    if (["policy_revision", "leverage"].includes(key)) f.payload[key] = "1";
    else if (typeof f.payload[key] === "number") f.payload[key] += 1;
    else f.payload[key] += "_different";
    try {
      assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.deepEqual(f.operations, []);
      assert.equal(f.writes(), 0);
    } finally {
      await f.bridge.close();
    }
  }
});

it("an unexpired target or a nonstandard original TTL cannot use an absence response as a terminal failure", async () => {
  for (const live of [true, false]) {
    const f = fixture();
    const at = Date.now();
    f.e.created_at = at - (live ? 1000 : 120_000);
    f.e.expires_at = at + (live ? 59_000 : -30_000);
    f.payload.created_at = f.e.created_at;
    f.payload.expires_at = f.e.expires_at;
    readOnlyCore(f, proof(f));
    try {
      assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
        status: "uncertain",
        observed_quantity: null,
        settled: false,
      });
      assert.deepEqual(f.operations, ["perps_execution_acceptance"]);
      assert.equal(f.writes(), 0);
    } finally {
      await f.bridge.close();
    }
  }
});

it("a missing local Perps outbox does not prove absence in Core; Prediction's existing missing-outbox behavior stays unchanged", async () => {
  const f = fixture();
  f.setPresent(false);
  try {
    assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
      status: "uncertain",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, []);
    f.e.key = "prediction:fixture";
    assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
      status: "failed",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, []);
  } finally {
    await f.bridge.close();
  }
});

it("Prediction reconciliation keeps its existing response path and never invokes the new Perps proof protocol", async () => {
  const f = fixture();
  f.e.key = "prediction:fixture";
  f.setResponse({});
  f.stub.prediction.execution = async (
    _user: string,
    _portfolio: Portfolio,
    original: Execution,
    task: unknown,
  ) => {
    assert.equal(original, f.e);
    assert.equal(task, undefined);
    return { status: "uncertain", observed_quantity: null, settled: false };
  };
  try {
    assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
      status: "uncertain",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, []);
    assert.equal(f.writes(), 0);
  } finally {
    await f.bridge.close();
  }
});

it("an expired absence response without a nonnil active epoch remains uncertain, while accepted original tasks may still have no current epoch", async () => {
  const f = fixture();
  const value = proof(f);
  value.proof.current_execution_epoch = null as any;
  readOnlyCore(f, value);
  try {
    assert.deepEqual(await f.bridge.execution(f.user, f.p, f.e), {
      status: "uncertain",
      observed_quantity: null,
      settled: false,
    });
    assert.deepEqual(f.operations, ["perps_execution_acceptance"]);
    assert.equal(f.writes(), 0);
    const accepted = proof(f, true);
    accepted.proof.current_execution_epoch = null as any;
    readOnlyCore(f, accepted);
    const result = await f.bridge.execution(f.user, f.p, f.e);
    assert.equal(result.task_id, accepted.task_id);
    assert.equal(result.status, "partially_filled");
    assert.equal(result.settled, false);
  } finally {
    await f.bridge.close();
  }
});
