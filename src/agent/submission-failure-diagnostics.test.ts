import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { now, recommend, type Execution } from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import { AgentService, fromPlan, portfolioView } from "./service.js";
import { AgentRunner } from "./runner.js";
import { Cursor, MemoryRepository } from "./repository.js";
import type { VenueAdapter } from "./adapter.js";
import { CoordinatedReadError } from "./venue-read-transport.js";
import { recordFirstSubmissionFailure } from "./submission-failure-diagnostics.js";

function execution(): Execution {
  return {
    id: "execution_original",
    key: "perps:BTC",
    target_quantity: "1",
    allocations: {},
    status: "queued",
    revision: 0,
    fingerprint: "f".repeat(64),
    created_at: now() - 5000,
    expires_at: now() + 55000,
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "10",
    error: null,
  };
}
async function fixture(status: Execution["status"] = "queued") {
  const adapter = new FakeAdapter(),
    venue: VenueAdapter = adapter;
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 90,
        risk_tolerance: "medium",
        portfolio_kind: "single",
        basket_size: 1,
      },
      [candidate(1)],
    ),
  );
  p.account_id = randomUUID();
  p.venue_accounts = { perps: p.account_id };
  adapter.snap.account_id = p.account_id;
  p.initial_equity = "500";
  p.ledger_started_at = now() - 60000;
  p.state = "active";
  p.reconciliation = "complete";
  Object.assign(p.sleeves[0], {
    initialized: true,
    reviewed_at: now(),
    source_revision: "source_v1",
  });
  const e = execution();
  e.status = status;
  e.revision = p.revision;
  p.executions.push(e);
  venue.source = async () => ({
    observed_at: now(),
    revision: "source_v1",
    account_value_usdc: "1000",
    complete: true,
    positions: [],
  });
  venue.notify = async () => {};
  const repo = new MemoryRepository(),
    user = randomUUID();
  await repo.transact(user, async (state) => {
    state.portfolios.push(p);
  });
  const service = new AgentService(
      repo,
      venue,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
    runner = new AgentRunner(service);
  return {
    adapter,
    venue,
    p,
    e,
    repo,
    user,
    runner,
    read: async () =>
      structuredClone((await repo.read(user)).portfolios[0].executions[0]),
    tick: async () => {
      await runner.tick(user);
      await runner.notificationsIdle();
    },
  };
}

it("stores only fixed sanitized fields, never raw errors, arbitrary codes or nested payload", () => {
  const e = execution();
  const sensitive = "customer-wallet-identifier-price-123-token-secret-url";
  recordFirstSubmissionFailure(
    e,
    new AgentError(sensitive, sensitive, true, 503, {
      reason_code: sensitive,
      operation: sensitive,
    } as any),
    100,
    () => 1700000000000,
    () => 425.4,
  );
  assert.deepEqual(e.first_submission_failure, {
    code: "OTHER",
    reason_code: "OTHER",
    retryable: true,
    at: 1700000000000,
    elapsed_ms: 325,
  });
  assert.equal(
    JSON.stringify(e.first_submission_failure).includes(sensitive),
    false,
  );
  const plain = execution();
  recordFirstSubmissionFailure(
    plain,
    {
      code: "EXECUTION_REJECTED",
      details: { reason_code: "READ_FRAME_PENDING" },
      retryable: true,
      message: sensitive,
    },
    1,
    () => 1,
    () => 2,
  );
  assert.deepEqual(plain.first_submission_failure, {
    code: "OTHER",
    reason_code: "OTHER",
    retryable: false,
    at: 1,
    elapsed_ms: 1,
  });
});

it("records typed sent and unsent read errors only as diagnostics without inventing acceptance information", () => {
  for (const sent of [false, true]) {
    const e = execution();
    recordFirstSubmissionFailure(
      e,
      new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", sent, 2000),
      0,
      () => 1000,
      () => 500,
    );
    assert.deepEqual(e.first_submission_failure, {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
      reason_code: sent ? "OTHER" : "READ_LOCAL_BUDGET_UNSENT",
      retryable: true,
      at: 1000,
      elapsed_ms: 500,
    });
    assert.equal(e.status, "queued");
    assert.equal(e.task_id, null);
    assert.equal(e.retirement, undefined);
    assert.equal(Object.keys(e.first_submission_failure!).length, 5);
  }
});

it("preserves first packet, caps elapsed timing, and cannot throw or read a message getter", () => {
  const e = execution(),
    error = new AgentError("EXECUTOR_UNAVAILABLE", "fixture", true);
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("raw message must not be inspected");
    },
  });
  recordFirstSubmissionFailure(
    e,
    error,
    0,
    () => 2000,
    () => 999999,
  );
  const first = structuredClone(e.first_submission_failure);
  assert.equal(first?.elapsed_ms, 60000);
  recordFirstSubmissionFailure(
    e,
    new AgentError("EXECUTION_REJECTED", "other"),
    0,
    () => 3000,
    () => 4,
  );
  assert.deepEqual(e.first_submission_failure, first);
  const invalid = execution();
  recordFirstSubmissionFailure(
    invalid,
    null,
    NaN,
    () => Infinity,
    () => -1,
  );
  assert.deepEqual(invalid.first_submission_failure, {
    code: "OTHER",
    reason_code: "OTHER",
    retryable: false,
    at: 0,
    elapsed_ms: 0,
  });
  assert.doesNotThrow(() =>
    recordFirstSubmissionFailure(Object.freeze(execution()), error, 0, () => 1),
  );
  assert.doesNotThrow(() =>
    recordFirstSubmissionFailure(execution(), error, 0, () => {
      throw Error("clock");
    }),
  );
});

for (const code of [
  "VENUE_READ_BUDGET_EXHAUSTED",
  "EXECUTOR_UNAVAILABLE",
  "EXECUTION_REJECTED",
])
  it(`captures actual submit ${code} without changing the existing status or frozen identity`, async () => {
    const f = await fixture(),
      before = structuredClone(f.e);
    let submits = 0;
    f.venue.submit = async () => {
      submits++;
      throw new AgentError(code, "private fixture message", true, 503, {
        reason_code: "READ_FRAME_PENDING",
      });
    };
    await f.tick();
    const saved = await f.read();
    assert.equal(submits, 1);
    assert.equal(
      saved.status,
      code === "EXECUTION_REJECTED" ? "failed" : "uncertain",
    );
    assert.equal(saved.first_submission_failure?.code, code);
    assert.equal(
      saved.first_submission_failure?.reason_code,
      "READ_FRAME_PENDING",
    );
    assert.ok(
      saved.first_submission_failure!.elapsed_ms >= 0 &&
        saved.first_submission_failure!.elapsed_ms <= 60000,
    );
    assert.ok(saved.first_submission_failure!.at >= before.created_at);
    for (const field of [
      "id",
      "fingerprint",
      "key",
      "target_quantity",
      "created_at",
      "expires_at",
      "revision",
      "allocations",
      "reserve_usdc",
    ] as const)
      assert.deepEqual(saved[field], before[field]);
    assert.equal(saved.task_id, null);
    assert.equal(saved.retirement, undefined);
  });

it("does not create or backfill a submission packet from reconciliation failures or already retired/terminal work", async () => {
  for (const status of ["uncertain", "failed"] as const) {
    const f = await fixture(status);
    let submits = 0,
      reconciliations = 0;
    f.venue.execution = async () => {
      reconciliations++;
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "recovery only",
        true,
      );
    };
    f.venue.submit = async () => {
      submits++;
      assert.fail("no new submit");
    };
    await f.tick();
    const saved = await f.read();
    assert.equal(submits, 0);
    assert.equal(reconciliations, status === "uncertain" ? 1 : 0);
    assert.equal(saved.first_submission_failure, undefined);
    assert.equal(saved.status, status);
  }
});

it("keeps the first submit diagnostic across later recovery errors while preserving an uncertain original", async () => {
  const f = await fixture();
  let submits = 0;
  f.venue.submit = async () => {
    submits++;
    throw new AgentError("EXECUTOR_UNAVAILABLE", "response lost", true);
  };
  await f.tick();
  const first = await f.read();
  f.venue.execution = async () => {
    throw new AgentError("VENUE_RATE_LIMITED", "recovery failed", true);
  };
  await f.tick();
  const saved = await f.read();
  assert.equal(submits, 1);
  assert.equal(saved.status, "uncertain");
  assert.deepEqual(
    saved.first_submission_failure,
    first.first_submission_failure,
  );
  assert.equal(saved.id, first.id);
  assert.equal(saved.fingerprint, first.fingerprint);
});

for (const sent of [false, true])
  it(`keeps an actual submit read-budget error financially uncertain independent of sent=${sent}`, async () => {
    const f = await fixture();
    f.venue.submit = async () => {
      throw new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", sent, 2000);
    };
    await f.tick();
    const saved = await f.read();
    assert.equal(saved.status, "uncertain");
    assert.equal(saved.task_id, null);
    assert.equal(saved.retirement, undefined);
    assert.equal(
      saved.first_submission_failure?.code,
      "VENUE_READ_BUDGET_EXHAUSTED",
    );
    assert.equal(
      saved.first_submission_failure?.reason_code,
      sent ? "OTHER" : "READ_LOCAL_BUDGET_UNSENT",
    );
  });

it("a successful submit creates no failure diagnostic", async () => {
  const f = await fixture();
  f.venue.submit = async () => ({ task_id: "fixture_original_task" });
  await f.tick();
  const saved = await f.read();
  assert.equal(saved.status, "submitted");
  assert.equal(saved.task_id, "fixture_original_task");
  assert.equal(saved.first_submission_failure, undefined);
});

it("does not put the private diagnostic into portfolio presentation", async () => {
  const f = await fixture();
  recordFirstSubmissionFailure(
    f.p.executions[0],
    new AgentError("EXECUTOR_UNAVAILABLE", "fixture", true),
    0,
    () => 1,
    () => 2,
  );
  const before = structuredClone(f.p);
  assert.equal(
    JSON.stringify(portfolioView(f.p)).includes("first_submission_failure"),
    false,
  );
  assert.deepEqual(f.p, before);
});
