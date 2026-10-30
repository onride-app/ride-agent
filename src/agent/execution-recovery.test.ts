import { it } from "node:test";
import assert from "node:assert/strict";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget } from "./venue-read-budget.js";
import { CoreBridge } from "./core_bridge.js";
import { AgentError, failure, publicResult } from "./contracts.js";
import { FakeAdapter, candidate, snapshot } from "./fixtures.js";
import { AgentService, fromPlan, portfolioView } from "./service.js";
import { AgentRunner } from "./runner.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { recommend } from "./domain.js";

const pref = {
  budget_usdc: "40",
  market: "perps" as const,
  assets: [],
  allow_altcoins: true,
  loss_trigger_pct: 10,
  risk_tolerance: "medium" as const,
  portfolio_kind: "basket" as const,
  basket_size: 4,
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { resolve, promise };
};

it("deduplicates concurrent reads, isolates values, and never reuses completed account evidence", async () => {
  let count = 0,
    clock = 100;
  const gate = deferred<Response>();
  const reads = new VenueReads(
    (async () => {
      count++;
      return count === 1 ? gate.promise : new Response('{"balance":2}');
    }) as typeof fetch,
    () => clock,
    2,
    { budget: new VenueReadBudget({ clock: () => clock }) },
  );
  const a = reads.read("https://venue.test/info", {
    type: "clearinghouseState",
  });
  const b = reads.read("https://venue.test/info", {
    type: "clearinghouseState",
  });
  gate.resolve(new Response('{"balance":1}'));
  const [x, y] = await Promise.all([a, b]);
  x.balance = 99;
  assert.equal(y.balance, 1);
  assert.equal(count, 1);
  assert.equal(
    (
      await reads.read("https://venue.test/info", {
        type: "clearinghouseState",
      })
    ).balance,
    2,
  );
  assert.equal(count, 2);
  await reads.read("https://venue.test/info", { type: "meta" }, 30000);
  await reads.read("https://venue.test/info", { type: "meta" }, 30000);
  assert.equal(count, 3);
  await reads.read("https://venue.test/info", { type: "meta" }, 0);
  assert.equal(count, 4);
  clock += 1500;
  await reads.read("https://venue.test/info", { type: "meta" }, 1000);
  assert.equal(count, 5);
});

it("does not let hanging public reads prevent a bind failure from committing or mutate committed state later", async () => {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter(),
    source = deferred<any>();
  const p = fromPlan(recommend(pref, adapter.pool));
  adapter.source = async () => source.promise;
  adapter.bind = async () => {
    throw new AgentError("CORE_REJECTED", "Registration blocked.", false);
  };
  await repo.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  const service = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  let timeout: ReturnType<typeof setTimeout>;
  const runner = new AgentRunner(service);
  await Promise.race([
    runner.tick("alice"),
    new Promise((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(Error("Source observation blocked account failure commit")),
        500,
      );
    }),
  ]);
  clearTimeout(timeout!);
  await runner.notificationsIdle();
  const before = await repo.transact("alice", async (s) => structuredClone(s));
  assert.equal(before.portfolios[0].state, "attention");
  source.resolve({
    observed_at: Date.now(),
    revision: "source_complete",
    account_value_usdc: "100",
    positions: [],
    complete: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    await repo.transact("alice", async (s) => structuredClone(s)),
    before,
  );
  assert.equal(adapter.submitCount, 0);
});

it("never calls a portfolio operational with stale source or incomplete/ineligible account evidence", () => {
  const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
  p.account_id = "account_bound_fixture";
  p.state = "active";
  p.reconciliation = "complete";
  p.snapshot = snapshot();
  for (const s of p.sleeves) {
    s.initialized = true;
    s.last_source_at = Date.now();
  }
  assert.equal((portfolioView(p).data.portfolio as any).operational, true);
  p.sleeves[0].last_source_at = Date.now() - 50_000;
  let view = portfolioView(p).data.portfolio as any;
  assert.equal(view.operational, false);
  assert.equal(view.sleeves[0].source_observation_status, "stale");
  p.sleeves[0].last_source_at = Date.now();
  for (const field of ["eligible", "dedicated", "coverage_complete"] as const) {
    p.snapshot[field] = false;
    view = portfolioView(p).data.portfolio as any;
    assert.equal(view.operational, false);
    assert.equal(view.activation.status, "needs_attention");
    p.snapshot[field] = true;
  }
});

it("reserves source capacity while follower reads are hung and bounds each lane", async () => {
  const first = deferred<Response>(),
    second = deferred<Response>();
  const starts: string[] = [];
  const reads = new VenueReads((async (_url, init) => {
    const key = JSON.parse(String(init?.body)).key;
    starts.push(key);
    if (key === "account1") return first.promise;
    if (key === "account2") return second.promise;
    return new Response("{}");
  }) as typeof fetch);
  const a = reads.read("https://venue.test/info", {
    type: "clearinghouseState",
    key: "account1",
  });
  const b = reads.read("https://venue.test/info", {
    type: "clearinghouseState",
    key: "account2",
  });
  await reads.read(
    "https://venue.test/info",
    { type: "clearinghouseState", key: "source" },
    0,
    "source",
  );
  assert.deepEqual(starts, ["account1", "source"]);
  first.resolve(new Response("{}"));
  await a;
  await Promise.resolve();
  assert.deepEqual(starts, ["account1", "source", "account2"]);
  second.resolve(new Response("{}"));
  await b;
});

it("shares Retry-After cooldown across source/account lanes without retry storms or cached success", async () => {
  let clock = 1000,
    count = 0;
  const reads = new VenueReads(
    (async () => {
      count++;
      return count === 1
        ? new Response("", { status: 429, headers: { "retry-after": "5" } })
        : new Response("{}");
    }) as typeof fetch,
    () => clock,
    2,
    { budget: new VenueReadBudget({ clock: () => clock }) },
  );
  await assert.rejects(
    reads.read("https://venue.test/info", {
      type: "clearinghouseState",
      key: "account",
    }),
    (e: any) =>
      e.code === "VENUE_RATE_LIMITED" && e.details.retry_after_ms === 60000,
  );
  await assert.rejects(
    reads.read(
      "https://venue.test/info",
      { type: "clearinghouseState", key: "source" },
      0,
      "source",
    ),
    /cooling down/,
  );
  assert.equal(count, 1);
  clock += 5001;
  await assert.rejects(
    reads.read(
      "https://venue.test/info",
      { type: "clearinghouseState", key: "source" },
      0,
      "source",
    ),
    /cooling down/,
  );
  assert.equal(
    count,
    1,
    "a short Retry-After cannot reopen the shared minute window",
  );
  clock += 55000;
  await reads.read(
    "https://venue.test/info",
    { type: "clearinghouseState", key: "source" },
    0,
    "source",
  );
  assert.equal(count, 2);
});

it("rejects blocked registration before funding reads, keeps typed Core context and performs no bind", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any,
    operations: string[] = [];
  stub.core = async (op: string) => {
    operations.push(op);
    return {
      eligible: false,
      blockers: ["BALANCE_TRANSFER_PENDING", "WITHDRAWAL_PENDING"],
      idempotent_existing: false,
    };
  };
  stub.account = () =>
    assert.fail("Readiness rejection must precede venue account reads");
  try {
    await assert.rejects(
      bridge.operation("preflight", {
        user_id: "alice",
        portfolio: fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate))),
      }),
      (e: any) => {
        assert.equal(e.code, "ACTIVATION_BLOCKED");
        assert.deepEqual(e.details.blockers, [
          "BALANCE_TRANSFER_PENDING",
          "WITHDRAWAL_PENDING",
        ]);
        return true;
      },
    );
    assert.deepEqual(operations, ["perps_registration_check"]);
  } finally {
    await bridge.close();
  }
});

it("retains structured registration reasons across Core, bridge and public failure boundaries", async () => {
  const original = globalThis.fetch;
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "CORE_REJECTED",
          message: "Account registration is temporarily unavailable.",
          operation: "perps_bind",
          grpc_code: "UNAVAILABLE",
          reason_code: "CORE_UNAVAILABLE",
          retryable: true,
        },
      }),
      { status: 503 },
    )) as typeof fetch;
  try {
    await assert.rejects((bridge as any).core("perps_bind", {}), (e: any) => {
      const response = publicResult(failure(e));
      assert.equal(response.error?.retryable, true);
      assert.equal(response.error?.details?.grpc_code, "UNAVAILABLE");
      assert.equal(response.error?.details?.operation, "perps_bind");
      return true;
    });
  } finally {
    globalThis.fetch = original;
    await bridge.close();
  }
});

it("observes sources despite bind failure without initializing or submitting, and reports activation truthfully", async () => {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  const p = fromPlan(recommend(pref, adapter.pool));
  const source = adapter.source.bind(adapter),
    observed: string[] = [];
  adapter.source = async (t) => {
    observed.push(t.id);
    return source(t);
  };
  adapter.bind = async () => {
    throw new AgentError(
      "CORE_REJECTED",
      "Account activation is blocked by pending transfers.",
      false,
      409,
      {
        operation: "perps_bind",
        grpc_code: "FAILED_PRECONDITION",
        reason_code: "BALANCE_TRANSFER_PENDING",
      },
    );
  };
  (adapter as any).activationCheck = async () => ({
    eligible: false,
    blockers: ["BALANCE_TRANSFER_PENDING", "WITHDRAWAL_PENDING"],
    idempotent_existing: false,
  });
  await repo.transact("alice", async (s) => {
    s.portfolios.push(p);
  });
  const service = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("s".repeat(32)),
  );
  const runner = new AgentRunner(service);
  await runner.tick("alice");
  await runner.tick("alice");
  const saved = await repo.transact("alice", async (s) =>
    structuredClone(s.portfolios[0]),
  );
  assert.equal(new Set(observed).size, 4);
  assert.equal(saved.account_id, null);
  assert.equal(saved.state, "attention");
  assert(
    saved.sleeves.every(
      (s) =>
        s.last_source_at != null &&
        !s.initialized &&
        Object.keys(s.intents).length === 0,
    ),
  );
  assert.equal(saved.executions.length, 0);
  assert.equal(adapter.submitCount, 0);
  assert.equal(
    saved.last_error?.details?.reason_code,
    "BALANCE_TRANSFER_PENDING",
  );
  const result = await service.tool("alice", "get_portfolio", {});
  const view = result.data.portfolio as any;
  assert.equal(view.operational, false);
  assert.equal(view.account_bound, false);
  assert.equal(view.activation.status, "blocked");
  assert.deepEqual(view.activation.readiness.blockers, [
    "BALANCE_TRANSFER_PENDING",
    "WITHDRAWAL_PENDING",
  ]);
  assert(
    view.sleeves.every(
      (s: any) =>
        s.state === "awaiting_activation" && s.configuration_state === "active",
    ),
  );
  assert.equal(adapter.submitCount, 0);
});
