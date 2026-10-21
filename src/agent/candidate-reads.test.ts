import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { AgentError } from "./contracts.js";
import { candidate, FakeAdapter } from "./fixtures.js";
import { now } from "./domain.js";
import { AgentService } from "./service.js";
import { Cursor, MemoryRepository } from "./repository.js";

function fixture(t: TestContext, count = 30) {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture",
    "postgresql://localhost/unused",
    "s".repeat(32),
    "mainnet",
  );
  const stub = bridge as any;
  const previous = process.env.RIDE_AGENT_PREDICTION_ENABLED;
  process.env.RIDE_AGENT_PREDICTION_ENABLED = "false";
  t.after(async () => {
    if (previous === undefined)
      delete process.env.RIDE_AGENT_PREDICTION_ENABLED;
    else process.env.RIDE_AGENT_PREDICTION_ENABLED = previous;
    await bridge.close();
  });
  const pool = Array.from({ length: count }, (_, i) => candidate(i + 1));
  stub.traderId = (id: string) => id;
  stub.rows = async () => pool.map((c) => ({ ...c, address: c.id }));
  let reads = 0;
  stub.profile = async (id: string) => {
    reads++;
    return structuredClone(pool.find((c) => c.id === id)!);
  };
  return { bridge, stub, pool, reads: () => reads };
}

it("coalesces concurrent discovery and isolates complete cached snapshots from caller mutations", async (t) => {
  const { bridge, pool, reads } = fixture(t);
  pool.forEach((c) => {
    c.score = 84.99;
  });
  pool.reverse();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => bridge.candidates("perps")),
  );
  const expected = pool.map((c) => c.id).sort();
  assert.ok(results.every((rows) => rows.length === 30));
  for (const rows of results)
    assert.deepEqual(
      rows.map((c) => c.id),
      expected,
    );
  assert.equal(reads(), 30);
  results[0].splice(0, 1);
  results[1][0].assets.push("FAKE");
  const warm = await bridge.candidates("perps");
  assert.equal(warm.length, 30);
  assert(!warm[0].assets.includes("FAKE"));
  assert.equal(reads(), 30);
});

it("expires discovery at one minute and never returns profiles past their score expiry", async (t) => {
  let at = now();
  t.mock.method(Date, "now", () => at);
  const { bridge, pool, reads } = fixture(t, 2);
  await bridge.candidates("perps");
  at += 60_000;
  pool.forEach((c) => {
    c.expires_at = at + 500;
  });
  await bridge.candidates("perps");
  assert.equal(reads(), 4);
  at += 500;
  assert.deepEqual(await bridge.candidates("perps"), []);
});

it("rejects rate-limited partial reads, backs off shared failures and recovers without serving an expired snapshot", async (t) => {
  let at = now();
  t.mock.method(Date, "now", () => at);
  const { bridge, stub } = fixture(t, 3);
  await bridge.candidates("perps");
  at += 60_000;
  const original = stub.profile;
  let attempts = 0,
    failing = true;
  stub.profile = async (id: string) => {
    attempts++;
    if (failing && id === candidate(2).id)
      throw new AgentError("VENUE_RATE_LIMITED", "fixture", true, 503);
    return original(id);
  };
  const responses = await Promise.allSettled(
    Array.from({ length: 8 }, () => bridge.candidates("perps")),
  );
  assert.ok(
    responses.every(
      (r) => r.status === "rejected" && r.reason.code === "VENUE_RATE_LIMITED",
    ),
  );
  assert.equal(attempts, 3);
  await assert.rejects(bridge.candidates("perps"), {
    code: "VENUE_RATE_LIMITED",
  });
  assert.equal(attempts, 3);
  failing = false;
  at += 60_001;
  assert.equal((await bridge.candidates("perps")).length, 3);
  assert.equal(attempts, 6);
});

it("retries a transient profile once and never retries a permanent source rejection", async (t) => {
  const { bridge, stub } = fixture(t, 3);
  const original = stub.profile;
  let attempts = 0;
  stub.profile = async (id: string) => {
    attempts++;
    if (attempts === 2)
      throw new AgentError("VENUE_UNAVAILABLE", "fixture", true, 503);
    return original(id);
  };
  assert.equal((await bridge.candidates("perps")).length, 3);
  assert.equal(attempts, 4);
  let at = now() + 60_001;
  t.mock.method(Date, "now", () => at);
  attempts = 0;
  stub.profile = async () => {
    attempts++;
    throw new AgentError("SOURCE_INVALID", "fixture", false);
  };
  await assert.rejects(bridge.candidates("perps"), {
    code: "CANDIDATE_SOURCE_INCOMPLETE",
  });
  assert.equal(attempts, 3);
});

it("shares closed daily candles across profiles while every source/account read remains fresh", async (t) => {
  let at = now();
  t.mock.method(Date, "now", () => at);
  const { bridge, stub } = fixture(t, 0);
  stub.profile = CoreBridge.prototype.profile.bind(bridge);
  const c = candidate(1);
  stub.resolve = async () => ({
    ...c,
    raw: JSON.stringify({ copyScoreV2_5: { components: c.components } }),
  });
  let sources = 0;
  stub.source = async () => {
    sources++;
    return { complete: true, positions: [{ asset: "BTC", quantity: "1" }] };
  };
  const requests: any[] = [];
  stub.info = async (input: any, source: boolean) => {
    assert.equal(source, true);
    assert.equal(input.type, "candleSnapshot");
    requests.push(input);
    await Promise.resolve();
    return Array.from({ length: 16 }, (_, i) => ({
      t: i,
      h: "102",
      l: "98",
      c: "100",
    }));
  };
  const profiles = await Promise.all(
    Array.from({ length: 10 }, (_, i) => bridge.profile(candidate(i + 1).id)),
  );
  assert.equal(sources, 10);
  assert.equal(requests.length, 1);
  assert.ok(profiles.every((c) => c.atr_pct === 4));
  await bridge.profile(c.id);
  assert.equal(sources, 11);
  assert.equal(requests.length, 1);
  at += 5 * 60_000 + 1;
  await bridge.profile(c.id);
  assert.equal(requests.length, 2);
  at += 86400_000;
  await bridge.profile(c.id);
  assert.equal(requests.length, 3);
  assert.notEqual(requests[1].req.endTime, requests[2].req.endTime);
});

it("keeps optional ATR unavailable and coalesces failed candles without repeated rate-limit bursts", async (t) => {
  const { bridge, stub } = fixture(t, 0);
  stub.profile = CoreBridge.prototype.profile.bind(bridge);
  stub.resolve = async () => ({ ...candidate(1), raw: "{}" });
  stub.source = async () => ({
    complete: true,
    positions: [{ asset: "BTC", quantity: "1" }],
  });
  let requests = 0;
  stub.info = async () => {
    requests++;
    throw new AgentError("VENUE_RATE_LIMITED", "fixture", true, 503);
  };
  const profiles = await Promise.all(
    Array.from({ length: 10 }, () => bridge.profile(candidate(1).id)),
  );
  assert.ok(profiles.every((c) => c.atr_pct === null));
  await bridge.profile(candidate(1).id);
  assert.equal(requests, 1);
});

it("recognizes a real 429 response as retryable rate limiting", async (t) => {
  const { stub } = fixture(t, 0);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("rate limited", { status: 429 }),
  );
  await assert.rejects(stub.info({ type: "clearinghouseState" }, true), {
    code: "VENUE_RATE_LIMITED",
    retryable: true,
  });
});

it("preserves saved discovery, pinned traders, plans and proposals when recommendation source reads fail", async () => {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  const ids = adapter.pool.slice(0, 2).map((c) => c.id);
  await api.tool("fixture", "recommend_traders", {
    preferences: { budget_usdc: "20", loss_trigger_pct: 10, market: "perps" },
    trader_ids: ids,
  });
  const before = await repo.transact("fixture", async (s) =>
    structuredClone(s),
  );
  assert.equal(before.plans.length, 1);
  adapter.candidates = async () => {
    throw new AgentError("VENUE_RATE_LIMITED", "fixture", true, 503);
  };
  const result = await api.tool("fixture", "recommend_traders", {});
  assert.equal(result.status, "stale");
  assert.equal(result.error?.code, "VENUE_RATE_LIMITED");
  assert.equal(result.error?.retryable, true);
  assert.equal((result.data.candidates_meta as any).total, null);
  assert.equal(result.data.missing_selected_trader_ids, null);
  assert.equal(
    (result.data.candidate_source as any).previous_snapshot_retained,
    true,
  );
  assert.equal(result.data.saved_plan_id, before.plans[0].id);
  const after = await repo.transact("fixture", async (s) => structuredClone(s));
  for (const key of [
    "discovery",
    "plans",
    "proposals",
    "selected_trader_ids",
  ] as const)
    assert.deepEqual(after[key], before[key]);
  const browsed = await api.tool("fixture", "browse_traders", {});
  assert.equal(
    (browsed.data.candidates_meta as any).total,
    adapter.pool.length,
  );
  assert.equal(adapter.submitCount, 0);
});
