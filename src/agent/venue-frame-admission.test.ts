import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import {
  VenueReads,
  type AccountReadFrameCoordinator,
  type AccountReadFrameLease,
} from "./venue-reads.js";
import type { VenueReadFetcher } from "./venue-read-transport.js";

const url = "https://api.hyperliquid.xyz/info";
const owner = "a".repeat(64);
async function flush() {
  for (let n = 0; n < 80; n++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function time() {
  let at = 1700000000000,
    sequence = 0;
  const events = new Map<number, { at: number; run(): void }>();
  const timers: BudgetTimers = {
    setTimeout(run, ms) {
      const id = ++sequence;
      events.set(id, { at: at + ms, run });
      return id;
    },
    clearTimeout(id) {
      events.delete(id as number);
    },
  };
  return {
    clock: () => at,
    timers,
    async advance(ms: number) {
      const end = at + ms;
      await flush();
      for (;;) {
        const next = [...events]
          .filter(([, event]) => event.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        at = next[1].at;
        events.delete(next[0]);
        next[1].run();
        await flush();
      }
      at = end;
      await flush();
    },
  };
}
function setup(
  t: ReturnType<typeof time>,
  coordinator: AccountReadFrameCoordinator,
  fetcher: VenueReadFetcher,
  signal?: AbortSignal,
) {
  const budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  const reads = new VenueReads(fetcher, t.clock, 2, {
    transport: "core_shared_info",
    budget,
    timers: t.timers,
    monotonicClock: t.clock,
    report: () => {},
    frameCoordinator: coordinator,
    signal,
  });
  return { reads, budget };
}

it("spends zero upstream weight while a stable fleet reservation is pending, then passes the grant owner/token through every account request", async () => {
  const t = time(),
    rpc: any[] = [],
    contexts: any[] = [];
  let granted = false,
    calls = 0;
  const coordinator = coreFrameCoordinator(
    "https://core.test",
    "fixture-token",
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      rpc.push(body);
      if (!Object.hasOwn(body, "weight"))
        return Response.json({ state: "closed", frame_id: body.frame_id });
      return Response.json({
        state: granted ? "granted" : "pending",
        frame_id: body.frame_id,
        expires_at: t.clock() + 20000,
        retry_after_ms: 1000,
        reserved_weight: granted ? body.weight : 250,
        guaranteed_complete: false,
      });
    },
    t.clock,
  );
  const { reads, budget } = setup(
    t,
    coordinator,
    async (_url, init, context) => {
      calls++;
      contexts.push(context);
      return Response.json(
        JSON.parse(String(init.body)).type === "userFillsByTime" ? [] : {},
      );
    },
  );
  try {
    await assert.rejects(
      reads.observeAccount(
        () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
        owner,
      ),
      (error) =>
        error instanceof AgentError &&
        error.details?.reason_code === "READ_FRAME_PENDING",
    );
    assert.equal(calls, 0);
    assert.equal(budget.snapshot().used, 0);
    assert.equal(
      rpc.length,
      1,
      "the local near-ready retry loop must not busy-poll a fleet queue",
    );
    await t.advance(60000);
    granted = true;
    await reads.observeAccount(async () => {
      await reads.read(url, { type: "clearinghouseState", user: "wallet" });
      await reads.read(url, { type: "userFillsByTime", user: "wallet" });
    }, owner);
    await flush();
    assert.equal(calls, 2);
    assert.equal(rpc[1].frame_id, rpc[0].frame_id);
    assert.equal(rpc[1].deadline_ms, rpc[0].deadline_ms);
    assert.equal(rpc[0].mode, "cold_trial");
    assert.equal(
      rpc[0].weight,
      900,
      "explicit trial is booked inside Core's unchanged cap",
    );
    assert.ok(
      contexts.every(
        (context) =>
          context.frame_id === rpc[0].frame_id && context.frame_owner === owner,
      ),
    );
    assert.equal(
      budget.snapshot().used,
      22,
      "ending a frame never refunds paid reads",
    );
    assert.equal(reads.diagnostics().frames.capacity_trials, 2);
  } finally {
    await reads.drainAccounts();
  }
});

it("does not discard a learned cost hint when fleet admission rejects before any dispatch", async () => {
  const t = time();
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      throw new AgentError("VENUE_READ_BUDGET_EXHAUSTED", "queued", true, 503, {
        retry_after_ms: 1000,
        reason_code: "READ_FRAME_PENDING",
      });
    },
    async end() {
      assert.fail(
        "pending frame must remain queued across normal callback failure",
      );
    },
  };
  const { reads, budget } = setup(t, coordinator, async () => {
    assert.fail("no upstream");
  });
  budget.restoreObservationPlan(owner, { demand: 200, peaks: [180] }, 600000);
  await assert.rejects(
    reads.observeAccount(() => reads.read(url, { type: "allMids" }), owner),
  );
  const next = budget.beginObservation(owner);
  assert.equal(next.weight, 200);
  next.close(false);
  assert.equal(budget.snapshot().used, 0);
  await reads.drainAccounts();
});

it("starts the unchanged evidence deadline only after grant and preserves original dispatch age", async () => {
  const t = time();
  let ended = 0;
  const contexts: any[] = [];
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      await t.advance(10000);
      return {
        frame_id: "frame_granted_000001",
        expires_at: t.clock() + 20000,
      };
    },
    async end() {
      ended++;
    },
  };
  const { reads } = setup(t, coordinator, async (_url, _init, context) => {
    contexts.push(context);
    return Response.json({});
  });
  const start = t.clock();
  const result = await reads.observeAccount(async () => {
    const first = await reads.readWithEvidence(url, {
      type: "clearinghouseState",
      user: "wallet",
    });
    await t.advance(19000);
    const second = await reads.readWithEvidence(url, { type: "allMids" });
    return { first, second, at: reads.accountObservedAt() };
  }, owner);
  assert.equal(result.first.observed_at, start + 10000);
  assert.equal(result.second.observed_at, start + 29000);
  assert.equal(
    result.at,
    start + 10000,
    "later steps must not re-age the financial prefix",
  );
  assert.equal(contexts[1].deadline_ms, start + 30000);
  await reads.drainAccounts();
  assert.equal(ended, 1);
});

it("releases a late grant after cancellation and drain waits for that release", async () => {
  const t = time(),
    begin = deferred<AccountReadFrameLease>(),
    release = deferred<void>(),
    stop = new AbortController();
  let endCalls = 0,
    wireCalls = 0,
    drained = false;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    begin: () => begin.promise,
    async end() {
      endCalls++;
      await release.promise;
    },
  };
  const { reads, budget } = setup(
    t,
    coordinator,
    async () => {
      wireCalls++;
      return Response.json({});
    },
    stop.signal,
  );
  const work = reads.observeAccount(
    () => reads.read(url, { type: "allMids" }),
    owner,
  );
  await flush();
  stop.abort(new Error("fixture shutdown"));
  await assert.rejects(work);
  const draining = reads.drainAccounts().then(() => {
    drained = true;
  });
  begin.resolve({
    frame_id: "frame_late_grant_0001",
    expires_at: t.clock() + 20000,
  });
  await flush();
  assert.equal(endCalls, 1);
  assert.equal(drained, false);
  assert.equal(wireCalls, 0);
  release.resolve();
  await draining;
  assert.equal(budget.snapshot().used, 0);
});

it("does not refund a sent-unknown bounded request when an account frame is cancelled", async () => {
  const t = time(),
    stop = new AbortController(),
    wire = deferred<Response>();
  let calls = 0,
    ended = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      return {
        frame_id: "frame_unknown_wire_001",
        expires_at: t.clock() + 20000,
      };
    },
    async end() {
      ended++;
    },
  };
  const { reads, budget } = setup(
    t,
    coordinator,
    async () => {
      calls++;
      return wire.promise;
    },
    stop.signal,
  );
  const work = reads.observeAccount(
    () => reads.read(url, { type: "userFillsByTime", user: "wallet" }),
    owner,
  );
  await flush();
  assert.equal(calls, 1);
  stop.abort(new Error("fixture shutdown"));
  await assert.rejects(work);
  await reads.drainAccounts();
  assert.equal(ended, 1);
  assert.equal(budget.snapshot().used, 120);
  wire.resolve(Response.json([]));
  await flush();
  assert.equal(budget.snapshot().used, 120);
});

it("does not reuse completed account data and never lends an account frame token to a public source", async () => {
  const t = time(),
    contexts: any[] = [];
  let sequence = 0;
  const coordinator: AccountReadFrameCoordinator = {
    capacity: 900,
    async begin() {
      return {
        frame_id: `frame_complete_${String(++sequence).padStart(8, "0")}`,
        expires_at: t.clock() + 20000,
      };
    },
    async end() {},
  };
  const { reads } = setup(t, coordinator, async (_url, _init, context) => {
    contexts.push(context);
    return Response.json({});
  });
  await reads.observeAccount(
    () => reads.read(url, { type: "clearinghouseState", user: "wallet" }),
    owner,
  );
  await t.advance(3000);
  await reads.observeAccount(
    () => reads.read(url, { type: "clearinghouseState", user: "wallet" }),
    owner,
  );
  await reads.read(url, { type: "allMids" }, 0, "source");
  assert.equal(contexts.length, 3);
  assert.notEqual(contexts[0].frame_id, contexts[1].frame_id);
  assert.equal(contexts[2].frame_id, undefined);
  assert.equal(contexts[2].frame_owner, undefined);
  await reads.drainAccounts();
});
