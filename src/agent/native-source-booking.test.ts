import assert from "node:assert/strict";
import { it } from "node:test";
import { VenueReads, type PreparedAccountWindow } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import {
  coreFrameCoordinator,
  framePendingContinuation,
} from "./core-frame-coordinator.js";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
} from "./venue-read-transport.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import type { ObservationCostPlan } from "./account-observation-plans.js";

async function flush() {
  for (let n = 0; n < 100; n++) await Promise.resolve();
}
class Time {
  at = 1793200000000;
  clock = () => this.at;
  sequence = 0;
  events = new Map<number, { at: number; run(): void }>();
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
      const next = [...this.events]
        .filter(([, e]) => e.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = end;
    await flush();
  }
  async run<T>(work: Promise<T>): Promise<T> {
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
    for (let i = 0; !done && i < 21000; i++) await this.advance(1);
    assert.equal(
      done,
      true,
      "original fake deadlines must resolve every pending task",
    );
    if (error) throw error;
    return value;
  }
}
const url = "https://api.hyperliquid.xyz/info",
  owner = "a".repeat(64),
  frameOwner = "b".repeat(64);
function fixture(n = 3, fixed = 1, cold = false) {
  const time = new Time(),
    issuer = {},
    sources = Array.from({ length: n }, (_, i) => ({
      id: `trader_${(i + 1).toString(16).padStart(32, "0")}`,
      address: "0x" + (i + 1).toString(16).repeat(40),
      requires_rwa: false as const,
    })),
    historySources = sources.slice(0, fixed).map((s) => s.id),
    first = time.at + 100000;
  const context = {
    costOwner: owner,
    frameOwner,
    firstDeadline: first,
    operationalBinding: "c".repeat(64),
    purpose: "audit_source" as const,
    network: "mainnet" as const,
  };
  let plan: ObservationCostPlan | null = cold
      ? null
      : { demand: 184, peaks: [164, 164, 164] },
    generation = 1,
    dirty = false;
  let pending = false,
    live = true,
    broader = false,
    calls = 0,
    held = 0,
    paid = 0,
    barrier: Promise<void> | undefined;
  const begins: any[] = [],
    wires: any[] = [],
    ends: string[] = [];
  const budget = new VenueReadBudget({
    clock: time.clock,
    timers: time.timers,
  });
  const coordinator = coreFrameCoordinator(
    "http://127.0.0.1:1",
    "fixture-token",
    async (u, init) => {
      const p = JSON.parse(String(init?.body));
      if (String(u).endsWith("_end")) {
        ends.push(p.frame_id);
        held = 0;
        return Response.json({ state: "closed", frame_id: p.frame_id });
      }
      begins.push(p);
      if (!pending) held = p.weight;
      return Response.json({
        state: pending ? "pending" : "granted",
        frame_id: p.frame_id,
        expires_at: pending ? p.deadline_ms : time.at + 20000,
        retry_after_ms: pending ? 1000 : 0,
        reserved_weight: pending ? 0 : p.weight,
        capacity: 900,
        guaranteed_complete: false,
      });
    },
    time.clock,
  );
  const reads = new VenueReads(
    async (_u, init, frame) => {
      calls++;
      const p = JSON.parse(String(init.body)),
        cost = readCost(p),
        reserve = cost.unknownSurcharge ? 120 : cost.reserve;
      assert.ok(frame?.frame_id);
      assert.ok(held >= reserve);
      held -= reserve;
      paid += reserve;
      const data = cost.rows || p.type === "frontendOpenOrders" ? [] : {};
      const actual = responseCost(cost, data);
      paid += actual - reserve;
      held += reserve - actual;
      wires.push({ payload: p, frame, actual });
      const r = Response.json(data);
      recordCoordinatedEvidence(r, time.at);
      return r;
    },
    time.clock,
    2,
    {
      transport: "core_shared_info",
      frameCoordinator: coordinator,
      budget,
      timers: time.timers,
      monotonicClock: time.clock,
      nativeSourcePlanIssuer: issuer,
      report: () => {},
      observationPlans: {
        read: async () => {
          assert.equal(dirty, false);
          return {
            owner,
            generation: String(generation),
            plan,
            remainingTtlMs: plan ? 590000 : 0,
          };
        },
        begin: async () => {
          assert.equal(dirty, false);
          dirty = true;
          return {
            owner,
            generation: String(++generation),
            plan,
            remainingTtlMs: plan ? 590000 : 0,
          };
        },
        complete: async (_lease, value) => {
          dirty = false;
          plan = value;
          return true;
        },
      },
    },
  );
  const native = () =>
    reads.createNativeSourcePlan(
      issuer,
      context,
      { sources, nonClosedSleeves: n, fixedSourceIds: historySources },
      async (source) => {
        if (barrier) await barrier;
        assert.ok(
          live &&
            !broader &&
            sources.some(
              (s) => s.id === source.id && s.address === source.address,
            ),
          "latest source authority is unchanged",
        );
      },
    );
  const prepare = (continuation?: object, token = native()) =>
    reads.prepareAccountWindow(
      owner,
      frameOwner,
      first,
      continuation,
      undefined,
      {
        purpose: "audit_source",
        historySources,
        nativeSourcePlan: token,
        nativeSourceContext: context,
      },
    );
  const audit = async (window: PreparedAccountWindow) =>
    time.run(
      window.read(async () => {
        reads.bindAccountCostPlan(owner);
        await reads.read(
          url,
          { type: "userFillsByTime", user: "fixture-follower" },
          0,
        );
      }),
    );
  const source = (
    window: PreparedAccountWindow,
    payload: unknown = { type: "clearinghouseState", user: sources[0].address },
    target = url,
    lane: "source" | "account" = "source",
  ) => time.run(window.supplement(() => reads.read(target, payload, 0, lane)));
  return {
    time,
    reads,
    budget,
    issuer,
    context,
    sources,
    historySources,
    begins,
    wires,
    ends,
    native,
    prepare,
    audit,
    source,
    calls: () => calls,
    bank: () => ({ held, paid }),
    pending: (v: boolean) => {
      pending = v;
    },
    setPlan: (demand: number | null) => {
      plan =
        demand === null
          ? null
          : { demand, peaks: [demand - 20, demand - 20, demand - 20] };
      generation++;
    },
    broader: () => {
      broader = true;
    },
    invalidate: () => {
      live = false;
    },
    barrier: (p: Promise<void>) => {
      barrier = p;
    },
  };
}

for (let n = 1; n <= 8; n++)
  it(`native ${n}-source full graph quota reserves G0/R1/aged allowance independently of A`, async () => {
    const f = fixture(n, 0),
      window = await f.prepare();
    try {
      const quota = 2 * (n + 2 * (n + n));
      assert.equal(
        f.begins[0].weight,
        184 + quota,
        "the whole window remains capped900",
      );
      await f.audit(window);
      for (const s of f.sources)
        await f.source(window, { type: "clearinghouseState", user: s.address });
      assert.equal(f.bank().paid, 20 + 2 * n);
    } finally {
      await window.close();
      await f.reads.drainAccounts();
    }
  });

it("multiple Fixed histories still refuse a complete parent larger than900 before any Core booking", async () => {
  const f = fixture(8, 8);
  try {
    await assert.rejects(f.prepare(), { code: "VENUE_READ_BUDGET_EXHAUSTED" });
    assert.equal(f.begins.length, 0);
    assert.equal(f.calls(), 0);
  } finally {
    await f.reads.drainAccounts();
  }
});

it("a native single Fixed parent reserves184+34+240 while history keeps its original120 request reservation", async () => {
  const f = fixture(),
    window = await f.prepare();
  try {
    assert.equal(f.begins[0].weight, 458);
    assert.ok(window.nativeSourcePlan);
    await f.audit(window);
    await f.source(window);
    await window.history(
      f.historySources[0],
      () =>
        f.reads.read(
          url,
          { type: "userFillsByTime", user: f.sources[0].address },
          0,
          "source",
        ),
      (p) => assert.equal((p as any).type, "userFillsByTime"),
    );
    assert.equal(f.bank().paid, 42);
    assert.ok(f.wires.every((w) => w.frame.frame_id === f.begins[0].frame_id));
  } finally {
    await window.close();
    await f.reads.drainAccounts();
  }
});

it("a cold account retains originalS120/H240 and cannot use a smaller native trial before it has learned", async () => {
  const f = fixture(3, 1, true),
    window = await f.prepare();
  try {
    assert.equal(window.mode, "cold");
    assert.equal(window.nativeSourcePlan, undefined);
    assert.equal(f.begins[0].weight, 900);
    await f.audit(window);
  } finally {
    await window.close();
    await f.reads.drainAccounts();
  }
});

for (const [name, make] of [
  [
    "wrong address",
    (f: ReturnType<typeof fixture>) => ({
      type: "clearinghouseState",
      user: "0x" + "f".repeat(40),
    }),
  ],
  [
    "extra DEX",
    (f: ReturnType<typeof fixture>) => ({
      type: "clearinghouseState",
      user: f.sources[0].address,
      dex: "xyz",
    }),
  ],
  [
    "history method",
    (f: ReturnType<typeof fixture>) => ({
      type: "userFillsByTime",
      user: f.sources[0].address,
    }),
  ],
] as const)
  it(`native S rejects ${name} before provider dispatch`, async () => {
    const f = fixture(),
      window = await f.prepare();
    try {
      await f.audit(window);
      const before = f.calls();
      await assert.rejects(f.source(window, make(f)));
      assert.equal(f.calls(), before);
    } finally {
      await window.close();
      await f.reads.drainAccounts();
    }
  });

for (const variant of ["toJSON", "Proxy"] as const)
  it(`native actual wire cannot follow a foreign ${variant} serialization hook`, async () => {
    const f = fixture(),
      window = await f.prepare();
    try {
      await f.audit(window);
      const data = { type: "clearinghouseState", user: f.sources[0].address };
      const payload =
        variant === "toJSON"
          ? Object.assign(
              Object.create({
                toJSON: () => ({ type: "userFunding", user: "foreign" }),
              }),
              data,
            )
          : new Proxy(data, {
              get: (target, key) =>
                key === "toJSON"
                  ? () => ({ type: "userFunding", user: "foreign" })
                  : Reflect.get(target, key),
            });
      await f.source(window, payload).catch(() => {});
      assert.ok(
        f.wires
          .slice(1)
          .every(
            (w) =>
              w.payload.type === "clearinghouseState" &&
              w.payload.user === f.sources[0].address,
          ),
      );
    } finally {
      await window.close();
      await f.reads.drainAccounts();
    }
  });

it("changed latest authority while the native guard awaits cannot dispatch a source request", async () => {
  const f = fixture(),
    window = await f.prepare();
  let release!: () => void;
  try {
    await f.audit(window);
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    f.barrier(barrier);
    const work = assert.rejects(f.source(window));
    await flush();
    assert.equal(f.calls(), 1);
    f.broader();
    release();
    await work;
    assert.equal(f.calls(), 1);
  } finally {
    release?.();
    await window.close();
    await f.reads.drainAccounts();
  }
});

it("a fresh equivalent opaque token preserves original pending UUID/FIRST after the A demand decreases", async () => {
  const f = fixture();
  f.pending(true);
  let pin!: object;
  try {
    await assert.rejects(f.prepare(), (error) => {
      pin = framePendingContinuation(error)!;
      return !!pin;
    });
    f.setPlan(164);
    f.pending(false);
    const window = await f.prepare(pin);
    try {
      assert.equal(f.begins.length, 2);
      assert.equal(f.begins[1].frame_id, f.begins[0].frame_id);
      assert.equal(f.begins[1].deadline_ms, f.begins[0].deadline_ms);
      assert.equal(f.begins[1].weight, 458);
      await f.audit(window);
      await f.source(window);
      assert.ok(window.nativeSourcePlan);
    } finally {
      await window.close();
    }
  } finally {
    await f.reads.drainAccounts();
  }
});

it("known higher S demand survives the native minimum instead of being clamped to34", async () => {
  const f = fixture();
  (f.budget as any).supplementHints.set(frameOwner, {
    at: f.time.at,
    source: 150,
    history: new Map(),
  });
  const window = await f.prepare();
  try {
    assert.equal(f.begins[0].weight, 184 + 150 + 240);
    await f.audit(window);
    await f.source(window);
  } finally {
    await window.close();
    await f.reads.drainAccounts();
  }
});

it("a serialized native token fails before booking and cannot leave a stale preparing-owner gate", async () => {
  const f = fixture();
  await assert.rejects(
    f.prepare(undefined, JSON.parse(JSON.stringify(f.native()))),
  );
  assert.equal(f.begins.length, 0);
  const window = await f.prepare();
  await window.close();
  await f.reads.drainAccounts();
});

it("the complete native S allowance is a hard pool bound and cannot borrow the unused A or H credits", async () => {
  const f = fixture(),
    window = await f.prepare();
  try {
    await f.audit(window);
    for (let n = 0; n < 17; n++) await f.source(window);
    assert.equal(f.bank().paid, 20 + 34);
    const before = f.calls();
    await assert.rejects(f.source(window), {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
    });
    assert.equal(
      f.calls(),
      before,
      "a full native pool cannot dispatch through unused A/H hold",
    );
    assert.equal(f.bank().paid, 54);
  } finally {
    await window.close();
    await f.reads.drainAccounts();
  }
});

for (const boundary of ["testnet URL", "account lane"] as const)
  it(`the native capability rejects a ${boundary} before any provider request`, async () => {
    const f = fixture(),
      window = await f.prepare();
    try {
      await f.audit(window);
      const before = f.calls();
      await assert.rejects(
        f.source(
          window,
          { type: "clearinghouseState", user: f.sources[0].address },
          boundary === "testnet URL"
            ? "https://api.hyperliquid-testnet.xyz/info"
            : url,
          boundary === "account lane" ? "account" : "source",
        ),
      );
      assert.equal(f.calls(), before);
    } finally {
      await window.close();
      await f.reads.drainAccounts();
    }
  });
