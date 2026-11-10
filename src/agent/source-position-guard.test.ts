import assert from "node:assert/strict";
import { it } from "node:test";
import { BridgeAdapter, type SourceSnapshot } from "./adapter.js";
import { AgentError, failure } from "./contracts.js";
import { CoreBridge } from "./core_bridge.js";
import {
  D,
  fresh,
  fingerprint,
  now,
  recommend,
  type Execution,
  type PositionIntent,
  type Sleeve,
} from "./domain.js";
import { candidate, snapshot } from "./fixtures.js";
import { fromPlan, portfolioView } from "./service.js";
import { sourceEvidenceReady } from "./source-observations.js";
import {
  sourcePositionGuardFailure,
  SOURCE_POSITION_GUARD_REASONS,
  type SourcePositionGuardReason,
} from "./source-position-guard.js";
import { recordFirstSubmissionFailure } from "./submission-failure-diagnostics.js";

type Evidence = {
  source: SourceSnapshot;
  current: PositionIntent | undefined;
  intent: PositionIntent;
  sleeve: Pick<Sleeve, "leverage_cap" | "leverage_mode">;
  maximum: number | undefined;
  raw: string | undefined;
};
function evidence(): Evidence {
  const current: PositionIntent = {
    key: "perps:BTC",
    asset: "BTC",
    market: "perps",
    quantity: "5",
    price: "100",
    source_entry_price: "100",
    source_leverage: 5,
    source_leverage_verified: true,
    observed_at: now(),
    source_revision: "source_v1",
  };
  return {
    source: {
      observed_at: now(),
      revision: "source_v1",
      account_value_usdc: "1000",
      complete: true,
      positions: [current],
    },
    current,
    intent: { ...current, quantity: "0.1", observed_at: now() - 45000 },
    sleeve: { leverage_cap: 8 },
    maximum: 8,
    raw: "5",
  };
}
const evaluate = (x: Evidence) =>
  sourcePositionGuardFailure(
    x.source,
    x.current,
    x.intent,
    x.sleeve,
    () => x.maximum,
    x.raw,
  );
// Exact pre-change e951 OR, used as a negative-control oracle for this
// diagnostic-only refactor. In particular its defaults and throws stay intact.
function originalGuard(x: Evidence): boolean {
  return (
    !sourceEvidenceReady(x.source) ||
    !x.current ||
    !fresh(x.current.observed_at) ||
    x.current.source_revision !== x.intent.source_revision ||
    x.source.revision !== x.intent.source_revision ||
    x.current.asset !== x.intent.asset ||
    x.current.market !== x.intent.market ||
    D(x.current.quantity).isZero() ||
    !Number.isInteger(x.current.source_leverage) ||
    x.current.source_leverage < 1 ||
    Math.min(
      x.current.source_leverage,
      x.sleeve.leverage_cap ?? Number.POSITIVE_INFINITY,
      x.maximum ?? 1,
    ) !== x.intent.source_leverage ||
    (x.sleeve.leverage_mode != null &&
      x.current.source_leverage_verified === false) ||
    (x.raw != null && !D(x.raw).eq(x.current.quantity))
  );
}
const cases: [SourcePositionGuardReason, (x: Evidence) => void][] = [
  [
    "SOURCE_GUARD_FRAME_NOT_READY",
    (x) => {
      x.source.complete = false;
    },
  ],
  [
    "SOURCE_GUARD_POSITION_MISSING",
    (x) => {
      x.current = undefined;
      x.source.positions = [];
    },
  ],
  [
    "SOURCE_GUARD_POSITION_STALE",
    (x) => {
      x.current!.observed_at = now() - 30001;
    },
  ],
  [
    "SOURCE_GUARD_POSITION_REVISION",
    (x) => {
      x.current!.source_revision = "different";
    },
  ],
  [
    "SOURCE_GUARD_FRAME_REVISION",
    (x) => {
      x.source.revision = "different";
    },
  ],
  [
    "SOURCE_GUARD_ASSET_CHANGED",
    (x) => {
      x.current!.asset = "ETH";
    },
  ],
  [
    "SOURCE_GUARD_MARKET_CHANGED",
    (x) => {
      x.current!.market = "prediction";
    },
  ],
  [
    "SOURCE_GUARD_ZERO_QUANTITY",
    (x) => {
      x.current!.quantity = "0";
    },
  ],
  [
    "SOURCE_GUARD_LEVERAGE_NONINTEGER",
    (x) => {
      x.current!.source_leverage = 1.5;
    },
  ],
  [
    "SOURCE_GUARD_LEVERAGE_NONPOSITIVE",
    (x) => {
      x.current!.source_leverage = 0;
    },
  ],
  [
    "SOURCE_GUARD_EFFECTIVE_LEVERAGE",
    (x) => {
      x.sleeve.leverage_cap = 4;
    },
  ],
  [
    "SOURCE_GUARD_LEVERAGE_UNVERIFIED",
    (x) => {
      x.sleeve.leverage_mode = "follow_source";
      x.current!.source_leverage_verified = false;
    },
  ],
  [
    "SOURCE_GUARD_RAW_QUANTITY_CHANGED",
    (x) => {
      x.current!.quantity = "6";
    },
  ],
];

for (const [reason, change] of cases)
  it(`keeps the original refusal and first predicate: ${reason}`, (t) => {
    t.mock.method(Date, "now", () => 1794300000000);
    const x = evidence();
    change(x);
    assert.equal(originalGuard(x), true);
    assert.equal(evaluate(x), reason);
  });

it("keeps equivalent fresh evidence, decimal equality and old optional metadata compatibility", (t) => {
  t.mock.method(Date, "now", () => 1794300000000);
  const values = [evidence(), evidence(), evidence(), evidence()];
  values[1].current!.quantity = "5.000";
  values[2].raw = undefined;
  values[2].sleeve.leverage_mode = "follow_source";
  values[2].current!.source_leverage_verified = undefined;
  values[3].maximum = undefined;
  values[3].intent.source_leverage = 1;
  for (const x of values) {
    assert.equal(originalGuard(x), false);
    assert.equal(evaluate(x), undefined);
  }
});

it("does not evaluate later evidence or leverage getters after the first failed clause", (t) => {
  t.mock.method(Date, "now", () => 1794300000000);
  const x = evidence();
  x.source.complete = false;
  const forbidden = () => {
    throw Error("later operand must remain lazy");
  };
  assert.equal(
    sourcePositionGuardFailure(
      x.source,
      new Proxy(x.current!, { get: forbidden }),
      x.intent,
      new Proxy(x.sleeve, { get: forbidden }),
      forbidden,
      x.raw,
    ),
    "SOURCE_GUARD_FRAME_NOT_READY",
  );
  x.source.complete = true;
  x.current!.source_revision = "changed";
  assert.equal(
    sourcePositionGuardFailure(
      x.source,
      x.current,
      x.intent,
      new Proxy(x.sleeve, { get: forbidden }),
      forbidden,
      x.raw,
    ),
    "SOURCE_GUARD_POSITION_REVISION",
  );
});

it("preserves malformed Decimal throws and the exact existing freshness boundary", (t) => {
  t.mock.method(Date, "now", () => 1794300000000);
  const invalid = evidence();
  invalid.current!.quantity = "not-a-number";
  assert.throws(() => originalGuard(invalid));
  assert.throws(() => evaluate(invalid));
  for (const age of [-1, 0, 29999, 30000, 30001]) {
    const x = evidence();
    x.current!.observed_at = now() - age;
    assert.equal(evaluate(x) !== undefined, originalGuard(x));
  }
});

function bridgeFixture(x = evidence()) {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any,
    snap = snapshot();
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "20",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 10,
        risk_tolerance: "medium",
        portfolio_kind: "single",
        basket_size: 1,
      },
      [candidate(1)],
    ),
  );
  p.account_id = snap.account_id;
  p.initial_equity = "500";
  p.ledger_started_at = now() - 60000;
  p.state = "active";
  p.reconciliation = "complete";
  Object.assign(p.sleeves[0], {
    initialized: true,
    source_revision: "source_v1",
    leverage_mode: x.sleeve.leverage_mode,
    leverage_cap: x.sleeve.leverage_cap,
    intents: { "perps:BTC": { ...x.intent, raw_source_quantity: x.raw } },
  });
  snap.max_leverages["perps:BTC"] = x.maximum as number;
  const frozen = {
    id: "execution_guard_fixture",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: p.revision,
    created_at: now() - 500,
    expires_at: now() + 59500,
  };
  const e: Execution = {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "queued",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  };
  p.executions.push(e);
  const outbox = new Map<string, any>(),
    submissions: unknown[] = [];
  stub.pool.query = async (sql: string, values: any[]) => {
    if (sql.startsWith("SELECT")) {
      const row = outbox.get(values[0]);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (sql.startsWith("INSERT") && !outbox.has(values[0]))
      outbox.set(values[0], {
        fingerprint: values[3],
        payload: structuredClone(values[4]),
        response: null,
      });
    if (sql.startsWith("UPDATE"))
      outbox.get(values[0]).response = structuredClone(values[1]);
    return { rowCount: 1, rows: [] };
  };
  stub.perpsAccount = async () => snap;
  stub.source = async () => x.source;
  stub.core = async (op: string, value: unknown) => {
    if (op === "perps_submit") {
      submissions.push(value);
      return { task_id: "fixture-original-task" };
    }
    return { policy_revision: 1 };
  };
  return { bridge, stub, snap, p, e, outbox, submissions };
}

for (const [reason, change] of cases)
  it(`actual CoreBridge refuses before outbox and carries only fixed private reason: ${reason}`, async (t) => {
    t.mock.method(Date, "now", () => 1794300000000);
    const x = evidence();
    change(x);
    const f = bridgeFixture(x);
    try {
      await assert.rejects(
        f.bridge.submit("fixture-user", f.p, f.e),
        (error) => {
          assert.ok(error instanceof AgentError);
          assert.equal(error.code, "EXECUTION_REJECTED");
          assert.equal(
            error.message,
            "Fresh equivalent source-position evidence is required before increasing exposure.",
          );
          assert.equal(error.retryable, false);
          assert.equal(error.httpStatus, 409);
          assert.deepEqual(error.details, { reason_code: reason });
          return true;
        },
      );
      assert.equal(f.outbox.size, 0);
      assert.equal(f.submissions.length, 0);
    } finally {
      await f.bridge.close();
    }
  });

it("actual equivalent source reaches its original outbox/task, while reductions never evaluate this guard", async (t) => {
  t.mock.method(Date, "now", () => 1794300000000);
  for (const reduction of [false, true]) {
    const f = bridgeFixture();
    if (reduction) {
      f.snap.positions["perps:BTC"] = "1";
      f.e.target_quantity = "0";
      f.e.fingerprint = fingerprint({
        id: f.e.id,
        key: f.e.key,
        target_quantity: "0",
        allocations: f.e.allocations,
        revision: f.e.revision,
        created_at: f.e.created_at,
        expires_at: f.e.expires_at,
      });
      f.stub.source = async () =>
        assert.fail(
          "reduction must not read increasing-exposure source evidence",
        );
    }
    try {
      assert.deepEqual(await f.bridge.submit("fixture-user", f.p, f.e), {
        task_id: "fixture-original-task",
      });
      assert.equal(f.outbox.size, 1);
      assert.equal(f.submissions.length, 1);
    } finally {
      await f.bridge.close();
    }
  }
});

it("private transport preserves every fixed reason, first-only packet and public/wire omission", async (t) => {
  t.mock.method(Date, "now", () => 1794300000000);
  const secret = "fixture-wallet-url-quantity-secret";
  for (const reason of SOURCE_POSITION_GUARD_REASONS) {
    const f = bridgeFixture();
    try {
      const error = new AgentError("EXECUTION_REJECTED", secret, false, 409, {
        reason_code: reason,
      });
      t.mock.method(
        globalThis,
        "fetch",
        async (
          url: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          assert.equal(
            JSON.stringify(JSON.parse(String(init?.body))).includes(
              "first_submission_failure",
            ),
            false,
          );
          assert.equal(String(init?.body).includes(reason), false);
          return String(url).endsWith("/submit")
            ? Response.json(failure(error), { status: 409 })
            : Response.json(snapshot());
        },
      );
      const adapter = new BridgeAdapter(
        "https://private.fixture",
        "fixture-token",
      );
      await assert.rejects(
        adapter.submit("fixture-user", f.p, f.e),
        (received) => {
          assert.ok(received instanceof AgentError);
          assert.deepEqual(received.details, { reason_code: reason });
          recordFirstSubmissionFailure(
            f.e,
            received,
            0,
            () => 1,
            () => 2,
          );
          return true;
        },
      );
      assert.deepEqual(f.e.first_submission_failure, {
        code: "EXECUTION_REJECTED",
        reason_code: reason,
        retryable: false,
        at: 1,
        elapsed_ms: 2,
      });
      const first = structuredClone(f.e.first_submission_failure);
      recordFirstSubmissionFailure(
        f.e,
        new AgentError("EXECUTOR_UNAVAILABLE", secret),
        0,
        () => 3,
        () => 4,
      );
      assert.deepEqual(f.e.first_submission_failure, first);
      assert.equal(JSON.stringify(first).includes(secret), false);
      const before = structuredClone(f.p);
      assert.equal(JSON.stringify(portfolioView(f.p)).includes(reason), false);
      assert.equal(
        JSON.stringify(portfolioView(f.p)).includes("first_submission_failure"),
        false,
      );
      await adapter.account("fixture-user", f.p);
      assert.deepEqual(f.p, before);
    } finally {
      t.mock.restoreAll();
      await f.bridge.close();
    }
  }
});

it("never backfills an old OTHER packet with a newly identified source predicate", () => {
  const f = bridgeFixture();
  f.e.first_submission_failure = {
    code: "EXECUTION_REJECTED",
    reason_code: "OTHER",
    retryable: false,
    at: 1,
    elapsed_ms: 2,
  };
  const first = structuredClone(f.e.first_submission_failure);
  recordFirstSubmissionFailure(
    f.e,
    new AgentError("EXECUTION_REJECTED", "fixed fixture", false, 409, {
      reason_code: "SOURCE_GUARD_FRAME_REVISION",
    }),
    0,
    () => 3,
    () => 4,
  );
  assert.deepEqual(f.e.first_submission_failure, first);
  return f.bridge.close();
});
