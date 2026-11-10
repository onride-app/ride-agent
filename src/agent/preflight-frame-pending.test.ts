import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import {
  coreFrameCoordinator,
  framePendingContinuation,
} from "./core-frame-coordinator.js";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import type { VenueReadFetcher } from "./venue-read-transport.js";

const A = "a".repeat(64),
  url = "https://api.hyperliquid.xyz/info";
async function flush() {
  for (let n = 0; n < 100; n++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
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
    pending: () => events.size,
    async advance(ms: number) {
      const end = at + ms;
      await flush();
      for (;;) {
        const next = [...events]
          .filter(([, e]) => e.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
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
type Poll = { body: any; at: number; signal?: AbortSignal | null };
function fixture(
  handler?: (call: Poll, index: number) => Promise<Response>,
  fetcher?: VenueReadFetcher,
) {
  const t = time(),
    start = t.clock(),
    calls: Poll[] = [],
    ends: string[] = [],
    wire: { at: number; deadline?: number; user?: string }[] = [];
  const reply = (call: Poll, state = "pending") =>
    Response.json({
      state,
      frame_id: call.body.frame_id,
      expires_at:
        state === "granted" ? t.clock() + 20000 : call.body.deadline_ms,
      reserved_weight: state === "granted" ? call.body.weight : 0,
      retry_after_ms: 1000,
      guaranteed_complete: false,
    });
  const coordinator = coreFrameCoordinator(
    "https://core.test/original-owner-path",
    "fixture",
    async (u, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(u).endsWith("_end")) {
        ends.push(body.frame_id);
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      const call = { body, at: t.clock(), signal: init?.signal };
      calls.push(call);
      return handler
        ? handler(call, calls.length)
        : reply(call, calls.length > 1 ? "granted" : "pending");
    },
    t.clock,
  );
  const budget = new VenueReadBudget({ clock: t.clock, timers: t.timers });
  budget.restoreObservationPlan(A, { demand: 184, peaks: [164] }, 600000);
  const reads = new VenueReads(
    async (u, init, context) => {
      wire.push({
        at: t.clock(),
        deadline: context?.deadline_ms,
        user: JSON.parse(String(init.body)).user,
      });
      return fetcher ? fetcher(u, init, context) : Response.json({});
    },
    t.clock,
    2,
    {
      transport: "core_shared_info",
      budget,
      timers: t.timers,
      monotonicClock: t.clock,
      frameCoordinator: coordinator,
      report: () => {},
    },
  );
  return {
    t,
    start,
    calls,
    ends,
    wire,
    coordinator,
    budget,
    reads,
    reply,
    observe: (limits = {}, user = "preflight") =>
      reads.observeAccount(
        () => reads.readWithEvidence(url, { type: "clearinghouseState", user }),
        A,
        limits,
      ),
  };
}

it("trusted preflight polls the original frame after1s; no ticket or provider read exists until a real grant", async () => {
  const f = fixture(),
    result = f.observe({ waitForFrameAdmission: true });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.wire.length, 0);
  assert.equal(f.budget.snapshot().observations.started, 0);
  assert.equal(f.budget.snapshot().observation_queued, 0);
  await f.t.advance(999);
  assert.equal(f.calls.length, 1);
  await f.t.advance(1);
  const value = await result;
  assert.equal(value.observed_at, f.start + 1000);
  assert.equal(f.wire.length, 1);
  assert.equal(f.wire[0].deadline, f.start + 13000);
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
  assert.equal(f.calls[0].body.deadline_ms, f.start + 100000);
  await f.reads.drainAccounts();
  assert.deepEqual(f.ends, [f.calls[0].body.frame_id]);
  assert.equal(f.t.pending(), 0);
});

it("normal monitoring still makes one poll and retains its pending100s identity for another callback", async () => {
  const f = fixture();
  const error = await f.observe().catch((e) => e);
  assert.equal(error.details.reason_code, "READ_FRAME_PENDING");
  assert.ok(framePendingContinuation(error));
  assert.equal(f.calls.length, 1);
  assert.equal(f.wire.length, 0);
  assert.equal(f.ends.length, 0);
  assert.equal(f.t.pending(), 0);
  await f.t.advance(5000);
  await f.observe();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
});

it("a later private preflight can continue the same monitor-created pending frame without refreshing its first deadline", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(async (call, n) => f.reply(call, n >= 3 ? "granted" : "pending"));
  await f.observe().catch(() => {});
  await f.t.advance(5000);
  const result = f.observe({ waitForFrameAdmission: true });
  await flush();
  assert.equal(f.calls.length, 2);
  await f.t.advance(1000);
  await result;
  assert.deepEqual(
    f.calls.map((c) => c.body),
    [f.calls[0].body, f.calls[0].body, f.calls[0].body],
  );
  assert.equal(f.wire.length, 1);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
});

it("only strict authenticated503local_budget with sent=false can authorize a pending retry", async () => {
  for (const sent of [false, true, undefined]) {
    let f: ReturnType<typeof fixture>;
    f = fixture(async (call, n) =>
      n === 1
        ? Response.json(
            {
              error: {
                code: "local_budget",
                ...(sent === undefined ? {} : { upstream_request_sent: sent }),
                retry_after_ms: 1000,
              },
            },
            { status: 503 },
          )
        : f.reply(call, "granted"),
    );
    const result = f.observe({ waitForFrameAdmission: true }).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    await flush();
    if (sent === false) {
      await f.t.advance(1000);
      assert.equal((await result).ok, true);
      assert.equal(f.calls.length, 2);
      assert.deepEqual(f.calls[1].body, f.calls[0].body);
    } else {
      const outcome = await result;
      assert.equal(outcome.ok, false);
      assert.equal(f.calls.length, 1);
      assert.equal(f.wire.length, 0);
    }
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
  }
});

it("unverified receipts, provider429 and body errors never turn into frame polling", async () => {
  for (const kind of [
    "transport",
    "429",
    "rate_limit",
    "missing_expiry",
    "renewed_expiry",
    "noninteger_expiry",
    "expired",
    "foreign_id",
    "retry",
    "reservation",
  ]) {
    let f: ReturnType<typeof fixture>;
    f = fixture(async (call) => {
      if (kind === "transport")
        throw new AgentError(
          "VENUE_READ_BUDGET_EXHAUSTED",
          "fixture forged",
          true,
          503,
          { reason_code: "READ_FRAME_PENDING", retry_after_ms: 1000 },
        );
      if (kind === "429" || kind === "rate_limit")
        return Response.json(
          {
            error: {
              code:
                kind === "rate_limit"
                  ? "data_provider_rate_limited"
                  : "local_budget",
              upstream_request_sent: false,
              retry_after_ms: 1000,
            },
          },
          { status: kind === "429" ? 429 : 503 },
        );
      const body = await f.reply(call).json();
      if (kind === "missing_expiry") delete body.expires_at;
      if (kind === "renewed_expiry") body.expires_at++;
      if (kind === "noninteger_expiry") body.expires_at += 0.5;
      if (kind === "expired") body.expires_at = f.t.clock();
      if (kind === "foreign_id") body.frame_id = "foreign-frame";
      if (kind === "retry") body.retry_after_ms = 0;
      if (kind === "reservation") body.reserved_weight = 185;
      return Response.json(body);
    });
    await assert.rejects(f.observe({ waitForFrameAdmission: true }));
    assert.equal(f.calls.length, 1);
    assert.equal(f.wire.length, 0);
    assert.equal(f.budget.snapshot().observations.started, 0);
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
    assert.equal(f.t.pending(), 0);
  }
});

it("expiry, caller cancellation, drain and cooldown keep the original window and never send a read before grant", async () => {
  for (const kind of ["expiry", "caller", "drain", "cooldown"]) {
    let f: ReturnType<typeof fixture>;
    f = fixture(async (call) => f.reply(call));
    const stop = new AbortController();
    const result = f
      .observe({
        waitForFrameAdmission: true,
        signal: stop.signal,
        ...(kind === "expiry" ? { deadlineMs: f.start + 500 } : {}),
      })
      .catch((e) => e);
    await flush();
    if (kind === "caller") stop.abort(new Error("fixture disconnect"));
    if (kind === "drain") await f.reads.drainAccounts();
    if (kind === "cooldown") {
      f.budget.note429(60000);
      await f.t.advance(1000);
    }
    const error = await result;
    assert.ok(error instanceof Error);
    assert.equal(f.calls.length, 1);
    assert.equal(f.wire.length, 0);
    assert.equal(f.budget.snapshot().observation_queued, 0);
    if (kind === "cooldown")
      assert.equal((error as AgentError).code, "VENUE_RATE_LIMITED");
    if (kind === "caller")
      assert.equal(
        f.ends.length,
        0,
        "one caller cannot cancel a shared pending reservation",
      );
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
    await f.t.advance(20000);
    assert.equal(f.calls.length, 1);
    assert.equal(f.t.pending(), 0);
  }
});

it("continuous pending cannot extend the original20s preflight or reset IDs and deadlines", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(async (call) => f.reply(call));
  const result = f.observe({ waitForFrameAdmission: true }).catch((e) => e);
  await f.t.advance(20000);
  const error = await result;
  assert.equal(error.details.reason_code, "READ_FRAME_PENDING");
  assert.equal(f.calls.length, 20);
  assert.ok(
    f.calls.every(
      (c) => JSON.stringify(c.body) === JSON.stringify(f.calls[0].body),
    ),
  );
  assert.equal(f.wire.length, 0);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
  assert.equal(f.t.pending(), 0);
});

it("a removed or replaced pinned episode cannot silently create a new frame inside one preflight", async () => {
  for (const replace of [false, true]) {
    let f: ReturnType<typeof fixture>;
    f = fixture(async (call) => f.reply(call));
    const result = f.observe({ waitForFrameAdmission: true }).catch((e) => e);
    await flush();
    const id = f.calls[0].body.frame_id;
    await f.coordinator.end(id);
    if (replace)
      await f.coordinator
        .begin(
          A,
          184,
          f.start + 100000,
          new AbortController().signal,
          "learned",
        )
        .catch(() => {});
    const before = f.calls.length;
    await f.t.advance(1000);
    const error = await result;
    assert.equal(error.details.reason_code, "READ_FRAME_IDENTITY_CHANGED");
    assert.equal(f.calls.length, before);
    assert.equal(f.wire.length, 0);
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, replace ? 2 : 1);
  }
});

it("a continuation rejects changed owner, weight or mode without ending the original frame or booking another", async () => {
  const f = fixture();
  const error = await f.coordinator
    .begin(A, 184, f.start + 100000, new AbortController().signal, "learned")
    .catch((e) => e);
  const pin = framePendingContinuation(error);
  assert.ok(pin);
  for (const kind of ["owner", "weight", "mode"]) {
    await assert.rejects(
      f.coordinator.begin(
        kind === "owner" ? "b".repeat(64) : A,
        kind === "weight" ? 185 : 184,
        f.start + 100000,
        new AbortController().signal,
        kind === "mode" ? "cold_trial" : "learned",
        pin,
      ),
      (e) =>
        e instanceof AgentError &&
        e.details?.reason_code === "READ_FRAME_IDENTITY_CHANGED",
    );
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.ends.length, 0);
  const lease = await f.coordinator.begin(
    A,
    184,
    f.start + 100000,
    new AbortController().signal,
    "learned",
    pin,
  );
  assert.equal(lease.frame_id, f.calls[0].body.frame_id);
  assert.deepEqual(f.calls[1].body, f.calls[0].body);
  await f.coordinator.end(lease.frame_id);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
});

it("ending a frame while request or JSON awaits prevents a late grant and does not send a replacement poll", async () => {
  for (const phase of ["request", "json"]) {
    const gate = deferred<any>();
    let f: ReturnType<typeof fixture>;
    f = fixture(async (call, n) => {
      if (n === 1) return f.reply(call);
      if (phase === "request") return gate.promise;
      const response = f.reply(call, "granted");
      response.json = () => gate.promise;
      return response;
    });
    const result = f.observe({ waitForFrameAdmission: true }).catch((e) => e);
    await flush();
    await f.t.advance(1000);
    assert.equal(f.calls.length, 2);
    await f.coordinator.end(f.calls[0].body.frame_id);
    const response = f.reply(f.calls[1], "granted");
    gate.resolve(phase === "request" ? response : await response.json());
    const error = await result;
    assert.equal(error.details.reason_code, "READ_FRAME_IDENTITY_CHANGED");
    assert.equal(f.wire.length, 0);
    assert.equal(f.calls.length, 2);
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
  }
});

it("a same-owner polling waiter cannot receive or cancel the peer's granted lease", async () => {
  for (const abort of [true, false]) {
    const metadata = deferred<Response>(),
      peerWire = deferred<Response>();
    let f: ReturnType<typeof fixture>;
    f = fixture(
      async (call, n) =>
        n === 1 ? metadata.promise : f.reply(call, "granted"),
      async (_u, init) =>
        JSON.parse(String(init.body)).user === "peer"
          ? peerWire.promise
          : Response.json({}),
    );
    const peer = f.observe({}, "peer");
    await flush();
    const stop = new AbortController();
    const waiting = f
      .observe({ waitForFrameAdmission: true, signal: stop.signal }, "waiter")
      .catch((e) => e);
    await flush();
    assert.equal(f.calls.length, 1);
    assert.equal(f.wire.length, 0);
    metadata.resolve(f.reply(f.calls[0], "granted"));
    await flush();
    assert.equal(f.wire.length, 1);
    assert.equal(f.wire[0].user, "peer");
    if (abort) {
      stop.abort(new Error("only waiter left"));
      await waiting;
      assert.equal(f.ends.length, 0);
      assert.equal(f.budget.snapshot().observation_active, true);
    } else {
      await f.t.advance(250);
      const error = await waiting;
      assert.equal(error.details.reason_code, "READ_FRAME_IN_USE");
      assert.equal(f.ends.length, 0);
    }
    peerWire.resolve(Response.json({}));
    await peer;
    await f.reads.drainAccounts();
    assert.equal(f.ends.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.wire.length, 1);
  }
});

it("the actual wire still times out12s after a1s metadata wait instead of receiving a new20s evidence window", async () => {
  const f = fixture(undefined, () => new Promise(() => {}));
  const result = f.observe({ waitForFrameAdmission: true }).catch((e) => e);
  await f.t.advance(1000);
  assert.equal(f.wire.length, 1);
  await f.t.advance(11999);
  let done = false;
  void result.then(() => (done = true));
  await flush();
  assert.equal(done, false);
  await f.t.advance(1);
  assert.equal((await result).code, "VENUE_READ_DEADLINE");
  assert.equal(f.t.clock(), f.start + 13000);
  assert.equal(f.budget.snapshot().used, 2);
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
  assert.equal(f.t.pending(), 0);
});
