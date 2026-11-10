import assert from "node:assert/strict";
import { it } from "node:test";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import {
  coreFrameCoordinator,
  framePendingContinuation,
} from "./core-frame-coordinator.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
} from "./venue-read-transport.js";
import { SourceFeed } from "./source-feed.js";
import { AgentError } from "./contracts.js";
async function flush() {
  for (let n = 0; n < 200; n++) await Promise.resolve();
}
class Time {
  at = 1700000000000;
  sequence = 0;
  events = new Map<number, { at: number; run(): void }>();
  clock = () => this.at;
  timers: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    },
    clearTimeout: (id) => {
      this.events.delete(id as number);
    },
  };
  async advance(ms: number) {
    const end = this.at + ms;
    await flush();
    for (;;) {
      const n = [...this.events]
        .filter(([, e]) => e.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!n) break;
      this.at = n[1].at;
      this.events.delete(n[0]);
      n[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  async run<T>(work: Promise<T>) {
    let done = false,
      value!: T,
      error: unknown;
    void work.then(
      (v) => {
        done = true;
        value = v;
      },
      (e) => {
        done = true;
        error = e;
      },
    );
    for (let n = 0; !done && n < 25000; n++) await this.advance(1);
    assert.equal(done, true, "bounded fake-time work must settle");
    if (error) throw error;
    return value;
  }
}
function fixture() {
  const time = new Time(),
    owner = "a".repeat(64),
    frameOwner = "b".repeat(64),
    begins: any[] = [],
    contexts: any[] = [],
    events: string[] = [];
  let hangProvider = false;
  let held = 0,
    paid = 532,
    grant = true,
    generation = 1,
    dirty = false,
    plan = { demand: 184, peaks: [164] },
    cleanBarrier: Promise<void> | undefined;
  const coordinator = coreFrameCoordinator(
    "http://127.0.0.1:9999",
    "fixture-token",
    (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("_end")) {
        held = 0;
        events.push("end");
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      begins.push(body);
      if (grant) held = body.weight;
      return Response.json({
        state: grant ? "granted" : "pending",
        frame_id: body.frame_id,
        expires_at: grant ? time.at + 20000 : body.deadline_ms,
        retry_after_ms: grant ? 0 : 1000,
        reserved_weight: grant ? body.weight : 0,
        capacity: 900,
        guaranteed_complete: false,
      });
    }) as typeof fetch,
    time.clock,
  );
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const reads = new VenueReads(
    async (_url, init, context) => {
      const payload = JSON.parse(String(init.body)),
        cost = readCost(payload);
      contexts.push(context);
      const active = !!context?.frame_id;
      if (active) {
        assert.equal(context?.frame_id, begins.at(-1).frame_id);
        assert.equal(context?.frame_owner, frameOwner);
        assert.ok(held >= cost.reserve);
        held -= cost.reserve;
        paid += cost.reserve;
      } else {
        if (paid + held + cost.reserve > 900)
          throw new CoordinatedReadError(
            "VENUE_READ_BUDGET_EXHAUSTED",
            false,
            1000,
          );
        paid += cost.reserve;
      }
      if (hangProvider) return new Promise<Response>(() => {});
      const data = [
        "userFillsByTime",
        "userFunding",
        "userNonFundingLedgerUpdates",
      ].includes(payload.type)
        ? []
        : {};
      const actual = responseCost(cost, data);
      paid += actual - cost.reserve;
      if (active) held += cost.reserve - actual;
      const response = Response.json(data);
      recordCoordinatedEvidence(response, time.at);
      events.push("wire");
      return response;
    },
    time.clock,
    2,
    {
      transport: "core_shared_info",
      frameCoordinator: coordinator,
      budget,
      timers: time.timers,
      monotonicClock: time.clock,
      report: () => {},
      observationPlans: {
        read: async () => {
          events.push("load");
          if (dirty) throw new Error("busy fixture");
          return {
            owner,
            generation: String(generation),
            plan,
            remainingTtlMs: 600000,
          };
        },
        begin: async (_o, _s, expected) => {
          assert.equal(expected!.generation, String(generation));
          assert.equal(dirty, false);
          dirty = true;
          generation++;
          events.push("dirty");
          return {
            owner,
            generation: String(generation),
            plan,
            remainingTtlMs: 600000,
          };
        },
        complete: async (lease, value, signal) => {
          if (cleanBarrier) await cleanBarrier;
          if (signal.aborted) return false;
          assert.equal(lease.generation, String(generation));
          dirty = false;
          plan = structuredClone(value);
          events.push("clean");
          return true;
        },
      },
    },
  );
  async function audit() {
    reads.bindAccountCostPlan(owner);
    for (const type of [
      "userAbstraction",
      "userFillsByTime",
      "userFunding",
      "userNonFundingLedgerUpdates",
      "clearinghouseState",
      "spotClearinghouseState",
    ])
      await reads.read(
        "https://api.hyperliquid.xyz/info",
        { type, user: "fixture" },
        0,
      );
    return "fresh-audit";
  }
  return {
    time,
    reads,
    budget,
    owner,
    frameOwner,
    begins,
    contexts,
    events,
    audit,
    bank: () => ({ paid, held, used: paid + held, dirty, generation }),
    grant: (v: boolean) => {
      grant = v;
    },
    barrier: (v: Promise<void> | undefined) => {
      cleanBarrier = v;
    },
    hang: (value: boolean) => {
      hangProvider = value;
    },
    prepare: (pin?: object, first = time.at + 100000) =>
      reads.prepareAccountWindow(owner, frameOwner, first, pin),
  };
}
it("real factory pending keeps one UUID/first deadline and performs no dirty claim or provider read", async () => {
  const f = fixture();
  f.grant(false);
  const first = f.time.at + 100000;
  let pin: object | undefined;
  await assert.rejects(f.prepare(undefined, first), (e) => {
    pin = framePendingContinuation(e);
    return !!pin;
  });
  assert.equal(f.events.includes("wire"), false);
  assert.equal(f.bank().dirty, false);
  await f.time.advance(10000);
  f.grant(true);
  const window = await f.prepare(pin, first);
  assert.equal(f.begins.length, 2);
  assert.equal(f.begins[0].frame_id, f.begins[1].frame_id);
  assert.equal(f.begins[0].deadline_ms, f.begins[1].deadline_ms);
  assert.equal(f.budget.snapshot().observation_reserved, 368);
  assert.equal(f.bank().dirty, false);
  await window.close();
  await f.reads.drainAccounts();
});
it("full900 bank allows audit84 then selected SourceFeed6 and preserves a fresh second184 scope", async () => {
  const f = fixture(),
    window = await f.prepare();
  assert.equal(f.bank().used, 900);
  await f.time.run(window.read(f.audit));
  assert.equal(f.bank().dirty, false);
  assert.equal(f.bank().paid, 616);
  assert.equal(f.bank().held, 284);
  await assert.rejects(
    f.time.run(
      f.reads.read(
        "https://api.hyperliquid.xyz/info",
        { type: "clearinghouseState", user: "ordinary" },
        0,
        "source",
      ),
    ),
    { code: "VENUE_READ_BUDGET_EXHAUSTED" },
  );
  const feed = new SourceFeed(
    async (id) => {
      await f.reads.read(
        "https://api.hyperliquid.xyz/info",
        { type: "clearinghouseState", user: id },
        0,
        "source",
      );
      return {
        observed_at: f.time.at,
        revision: "same",
        account_value_usdc: "1",
        positions: [],
        complete: true,
      };
    },
    {
      clock: f.time.clock,
      timers: { setInterval: () => 1, clearInterval: () => {} },
    },
  );
  for (const id of ["one", "two", "three"])
    await f.time.run(feed.read(id, (work) => window.supplement(work)));
  assert.equal(f.bank().paid, 622);
  assert.equal(f.bank().held, 278);
  await f.time.run(window.read(f.audit));
  assert.equal(f.bank().paid, 706);
  assert.equal(f.bank().used, 900);
  assert.equal(f.bank().dirty, false);
  await window.close();
  await f.reads.drainAccounts();
  feed.close();
  assert.equal(f.bank().held, 0);
  assert.equal(f.budget.snapshot().used, 174);
});
it("audit returns only after real first-child clean CAS, under the same parent timer", async () => {
  const f = fixture(),
    window = await f.prepare();
  let release!: () => void;
  f.barrier(new Promise<void>((r) => (release = r)));
  let returned = false;
  const work = window.read(f.audit).then(() => {
    returned = true;
  });
  await flush();
  assert.equal(returned, false);
  assert.equal(f.bank().dirty, true);
  release();
  await work;
  assert.equal(f.bank().dirty, false);
  await window.close();
  await f.reads.drainAccounts();
});
it("parent expiry never renews a child or leaves unused credit/dirty generations", async () => {
  const f = fixture(),
    window = await f.prepare();
  await f.time.advance(20001);
  await assert.rejects(window.read(f.audit));
  await f.reads.drainAccounts();
  assert.equal(f.bank().dirty, false);
  assert.equal(f.bank().held, 0);
  assert.equal(f.budget.snapshot().used, 0);
});
it("an ordinary same-owner read cannot invalidate a prepared hint or steal its local ticket", async () => {
  const f = fixture(),
    window = await f.prepare();
  await assert.rejects(
    f.reads.observeAccount(
      () =>
        f.reads.read("https://api.hyperliquid.xyz/info", { type: "allMids" }),
      f.owner,
    ),
  );
  assert.equal(f.bank().dirty, false);
  await f.time.run(window.read(f.audit));
  await window.close();
  await f.reads.drainAccounts();
});
it("SourceFeed interval created in a window later samples normally without inheriting read credit", async () => {
  const f = fixture(),
    window = await f.prepare();
  await f.time.run(window.read(f.audit));
  let interval!: () => void;
  const feed = new SourceFeed(
    async () => {
      await f.reads.read(
        "https://api.hyperliquid.xyz/info",
        { type: "clearinghouseState", user: "selected" },
        0,
        "source",
      );
      return {
        observed_at: f.time.at,
        revision: "same",
        account_value_usdc: "1",
        positions: [],
        complete: true,
      };
    },
    {
      clock: f.time.clock,
      timers: {
        setInterval: (cb) => {
          interval = cb;
          assert.equal((f.reads as any).accountScope.getStore(), undefined);
          return 1;
        },
        clearInterval: () => {},
      },
    },
  );
  await f.time.run(feed.read("selected", (work) => window.supplement(work)));
  assert.ok(f.contexts.at(-1).frame_id);
  await window.close();
  await f.reads.drainAccounts();
  await f.time.advance(5001);
  interval();
  await f.time.run(feed.pollOnce());
  assert.equal(f.contexts.at(-1).frame_id, undefined);
  feed.close();
});
it("a pre-existing SourceFeed flight is joined without reissuing under supplemental credit", async () => {
  const f = fixture();
  let release!: (v: any) => void,
    calls = 0,
    wrapped = 0;
  const observed = f.time.at;
  const feed = new SourceFeed(
    async () => {
      calls++;
      return new Promise<any>((r) => (release = r));
    },
    {
      clock: f.time.clock,
      timers: { setInterval: () => 1, clearInterval: () => {} },
    },
  );
  const original = feed.read("same");
  await flush();
  const window = await f.prepare();
  await f.time.run(window.read(f.audit));
  const joined = feed.read("same", (work) => {
    wrapped++;
    return window.supplement(work);
  });
  release({
    observed_at: observed,
    revision: "same",
    account_value_usdc: "1",
    positions: [],
    complete: true,
  });
  const [a, b] = await Promise.all([original, joined]);
  assert.equal(calls, 1);
  assert.equal(wrapped, 0);
  assert.equal(a.observed_at, observed);
  assert.equal(b.observed_at, observed);
  await window.close();
  feed.close();
  await f.reads.drainAccounts();
});
it("SourceFeed provider cooldown is preserved and never forced by a prepared window", async () => {
  const f = fixture();
  let calls = 0,
    wrapped = 0;
  const error = new AgentError("VENUE_RATE_LIMITED", "fixture429", true, 503, {
    retry_after_ms: 60000,
  });
  const feed = new SourceFeed(
    async () => {
      calls++;
      throw error;
    },
    {
      clock: f.time.clock,
      timers: { setInterval: () => 1, clearInterval: () => {} },
    },
  );
  await assert.rejects(feed.read("same"), (e) => e === error);
  const window = await f.prepare();
  await f.time.run(window.read(f.audit));
  await assert.rejects(
    feed.read("same", (work) => {
      wrapped++;
      return window.supplement(work);
    }),
    (e) => e === error,
  );
  assert.equal(calls, 1);
  assert.equal(wrapped, 0);
  await window.close();
  feed.close();
  await f.reads.drainAccounts();
});

it("two slow scopes cannot renew the original20s parent or receive a new12s wire window", async () => {
  const f = fixture(),
    window = await f.prepare();
  await f.time.run(
    window.read(async () => {
      await f.audit();
      await new Promise<void>((r) => f.time.timers.setTimeout(r, 12000));
    }),
  );
  const remaining = window.expires_at - f.time.at;
  assert.ok(remaining > 0 && remaining <= 8000);
  f.hang(true);
  await assert.rejects(f.time.run(window.read(f.audit)), {
    code: "VENUE_READ_DEADLINE",
  });
  assert.ok(f.contexts.at(-1).deadline_ms <= window.expires_at);
  assert.equal(f.bank().held, 0);
  assert.equal(f.bank().dirty, true);
  await f.reads.drainAccounts();
});
it("a queued outside SourceFeed flight is never adopted and a later normal-backoff retry can use only surplus credit", async () => {
  const f = fixture();
  let firstRelease!: (v: any) => void,
    secondRelease!: (v: any) => void,
    wrapped = 0,
    calls = 0;
  const snapshot = () => ({
    observed_at: f.time.at,
    revision: "same",
    account_value_usdc: "1",
    positions: [],
    complete: true,
  });
  const feed = new SourceFeed(
    async (id) => {
      calls++;
      if (id === "one") return new Promise<any>((r) => (firstRelease = r));
      if (id === "two") return new Promise<any>((r) => (secondRelease = r));
      await f.reads.read(
        "https://api.hyperliquid.xyz/info",
        { type: "clearinghouseState", user: id },
        0,
        "source",
      );
      return snapshot();
    },
    {
      clock: f.time.clock,
      timers: { setInterval: () => 1, clearInterval: () => {} },
    },
  );
  const one = feed.read("one"),
    two = feed.read("two"),
    outside = feed.read("three");
  await flush();
  assert.equal(calls, 2);
  const window = await f.prepare();
  await f.time.run(window.read(f.audit));
  const joined = feed.read("three", (work) => {
    wrapped++;
    return window.supplement(work);
  });
  const outsideFailed = assert.rejects(outside, {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
    }),
    joinedFailed = assert.rejects(joined, {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
    });
  firstRelease(snapshot());
  secondRelease(snapshot());
  await Promise.all([one, two]);
  await f.time.run(Promise.all([outsideFailed, joinedFailed]));
  assert.equal(wrapped, 0);
  assert.equal(calls, 3);
  await assert.rejects(
    feed.read("three", (work) => {
      wrapped++;
      return window.supplement(work);
    }),
    { code: "VENUE_READ_BUDGET_EXHAUSTED" },
  );
  assert.equal(wrapped, 0);
  await f.time.advance(5001);
  const value = await f.time.run(
    feed.read("three", (work) => {
      wrapped++;
      return window.supplement(work);
    }),
  );
  assert.equal(value.complete, true);
  assert.equal(wrapped, 1);
  assert.equal(calls, 4);
  await f.time.run(window.read(f.audit));
  await window.close();
  feed.close();
  await f.reads.drainAccounts();
  assert.equal(f.bank().dirty, false);
});
