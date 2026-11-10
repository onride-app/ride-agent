import assert from "node:assert/strict";
import { it } from "node:test";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import {
  coreFrameCoordinator,
  framePendingContinuation,
} from "./core-frame-coordinator.js";
import { readCost, responseCost } from "./venue-read-cost.js";
import { recordCoordinatedEvidence } from "./venue-read-transport.js";

async function flush() {
  for (let n = 0; n < 100; n++) await Promise.resolve();
}
function fixture() {
  let at = 1700000000000,
    sequence = 0,
    demand = 184,
    generation = 1,
    grant = false,
    dirty = false,
    held = 0,
    paid = 356;
  const owner = "a".repeat(64),
    frameOwner = "b".repeat(64),
    first = at + 100000,
    timers = new Map<number, { at: number; run(): void }>(),
    begins: any[] = [],
    ends: any[] = [],
    wires: any[] = [],
    claims: any[] = [];
  const clock = () => at;
  const timerApi: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++sequence;
      timers.set(id, { at: at + ms, run });
      return id;
    },
    clearTimeout: (id) => timers.delete(id as number),
  };
  const budget = new VenueReadBudget({
    clock,
    timers: timerApi,
  });
  let beginBarrier: Promise<void> | undefined;
  const coordinator = coreFrameCoordinator(
    "http://127.0.0.1:9999",
    "fixture-token",
    (async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("_end")) {
        ends.push(body);
        held = 0;
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      begins.push(body);
      if (beginBarrier) await beginBarrier;
      if (grant) {
        assert.ok(paid + body.weight <= 900);
        held = body.weight;
      }
      return Response.json({
        state: grant ? "granted" : "pending",
        frame_id: body.frame_id,
        reserved_weight: grant ? body.weight : 0,
        expires_at: grant ? at + 20000 : body.deadline_ms,
        retry_after_ms: grant ? 0 : 1000,
        capacity: 900,
        guaranteed_complete: false,
      });
    }) as typeof fetch,
    clock,
  );
  const reads = new VenueReads(
    async (_url, init, context) => {
      const payload = JSON.parse(String(init.body)),
        cost = readCost(payload);
      assert.ok(context?.frame_id);
      assert.equal(context.frame_id, begins.at(-1).frame_id);
      assert.ok(held >= cost.reserve);
      held -= cost.reserve;
      paid += cost.reserve;
      const value = payload.type === "userFillsByTime" ? [] : {},
        actual = responseCost(cost, value);
      held += cost.reserve - actual;
      paid += actual - cost.reserve;
      wires.push({ payload, context, at, actual });
      const response = Response.json(value);
      recordCoordinatedEvidence(response, at);
      return response;
    },
    clock,
    2,
    {
      transport: "core_shared_info",
      frameCoordinator: coordinator,
      budget,
      timers: timerApi,
      monotonicClock: clock,
      report: () => {},
      observationPlans: {
        read: async () => {
          if (dirty) throw new Error("fixture dirty");
          return {
            owner,
            generation: String(generation),
            plan: demand ? { demand, peaks: [demand - 20] } : null,
            remainingTtlMs: demand ? 600000 : 0,
          };
        },
        begin: async (_owner, _signal, expected) => {
          assert.equal(expected!.generation, String(generation));
          assert.equal(dirty, false);
          claims.push(expected);
          dirty = true;
          return { ...expected!, generation: String(++generation) };
        },
        complete: async (lease, _plan, signal) => {
          assert.equal(lease.generation, String(generation));
          if (signal.aborted) return false;
          dirty = false;
          return true;
        },
      },
    },
  );
  const options = {
    purpose: "audit_source" as const,
    historySources: ["fixed-source"],
  };
  const prepare = (pin?: object) =>
    reads.prepareAccountWindow(
      owner,
      frameOwner,
      first,
      pin,
      undefined,
      options,
    );
  const pending = async (pin?: object) => {
    let error: unknown;
    await assert.rejects(prepare(pin), (value) => {
      error = value;
      return !!framePendingContinuation(value);
    });
    return framePendingContinuation(error)!;
  };
  const advance = async (ms: number) => {
    const end = at + ms;
    for (;;) {
      const next = [...timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      at = next[1].at;
      timers.delete(next[0]);
      next[1].run();
      await flush();
    }
    at = end;
    await flush();
  };
  return {
    reads,
    budget,
    coordinator,
    owner,
    frameOwner,
    first,
    options,
    begins,
    ends,
    wires,
    claims,
    prepare,
    pending,
    advance,
    clock,
    setDemand: (value: number) => {
      demand = value;
      generation++;
    },
    setDirty: () => {
      dirty = true;
    },
    setPaid: (value: number) => {
      paid = value;
    },
    supplementHint: (source: number, history = 240) => {
      // Operational-only hint fixture; actual snapshots/branding still come
      // from the real Budget, and no fee credit or successful read is forged.
      (budget as any).supplementHints.set(frameOwner, {
        at,
        source,
        history: new Map([["fixed-source", history]]),
      });
    },
    grant: () => {
      grant = true;
    },
    barrier: (value?: Promise<void>) => {
      beginBarrier = value;
    },
    bank: () => ({ held, paid, dirty }),
  };
}

it("a lower clean A demand keeps the actual factory's original544 UUID and FIRST while local pools reserve only524", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  const pin = await f.pending(),
    original = f.begins[0];
  f.setDemand(164);
  await f.advance(1000);
  assert.equal(await f.pending(pin), pin);
  assert.deepEqual(f.begins[1], original);
  assert.equal(f.ends.length, 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.wires.length, 0);
  f.grant();
  const window = await f.prepare(pin);
  assert.equal(f.begins[2].weight, 544);
  assert.equal(f.begins[2].frame_id, original.frame_id);
  assert.equal(f.begins[2].deadline_ms, original.deadline_ms);
  assert.equal(f.bank().paid + f.bank().held, 900);
  assert.equal(f.budget.snapshot().observation_reserved, 524);
  assert.equal(f.bank().held, 544);
  await window.read(async () => {
    f.reads.bindAccountCostPlan(f.owner);
    await f.reads.read(
      "https://api.hyperliquid.xyz/info",
      { type: "clearinghouseState", user: "account" },
      0,
    );
  });
  assert.equal(f.claims.length, 1);
  assert.equal(f.claims[0].plan.demand, 164);
  assert.equal(f.wires[0].at, f.clock());
  assert.equal(f.bank().dirty, false);
  await window.close();
  await f.reads.drainAccounts();
  assert.equal(f.ends.length, 1);
  assert.equal(f.bank().held, 0);
  assert.equal(f.bank().paid, 358);
});

it("each decreasing A/S/H pool keeps the original conservative booking without transferring its surplus", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  f.supplementHint(140, 260);
  const pin = await f.pending(),
    original = f.begins[0];
  assert.equal(original.weight, 584);
  f.setDemand(164);
  f.supplementHint(120, 240);
  assert.equal(await f.pending(pin), pin);
  f.setPaid(316);
  f.grant();
  const window = await f.prepare(pin);
  assert.deepEqual(f.begins.at(-1), original);
  assert.equal(f.budget.snapshot().observation_reserved, 524);
  assert.equal(f.bank().held, 584);
  assert.equal(f.bank().held + f.bank().paid, 900);
  await window.close();
});

for (const pool of ["A", "S", "H"] as const)
  it(`${pool} regrowth rejects even below the original booking and never renews FIRST`, async (t) => {
    const f = fixture();
    t.after(() => f.reads.drainAccounts());
    f.supplementHint(140, 260);
    const pin = await f.pending();
    f.setDemand(164);
    f.supplementHint(120, 240);
    assert.equal(await f.pending(pin), pin);
    if (pool === "A") f.setDemand(174);
    if (pool === "S") f.supplementHint(130, 240);
    if (pool === "H") f.supplementHint(120, 250);
    await assert.rejects(f.prepare(pin), {
      code: "VENUE_COST_PLAN_UNAVAILABLE",
    });
    assert.equal(f.begins.length, 2);
    assert.equal(f.wires.length, 0);
    assert.equal(f.claims.length, 0);
    await f.reads.cancelPreparedPending(pin);
    assert.equal(f.ends.length, 1);
  });

it("a lower total cannot compensate for even one growing source pool", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  const pin = await f.pending();
  f.setDemand(164);
  f.supplementHint(121);
  await assert.rejects(f.prepare(pin), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 1);
  assert.equal(f.claims.length, 0);
  assert.equal(f.wires.length, 0);
});

for (const change of [
  "dirty",
  "cold",
  "foreign",
  "purpose",
  "history",
  "first",
] as const)
  it(`${change} metadata cannot adopt the saved learned pending booking`, async (t) => {
    const f = fixture();
    t.after(() => f.reads.drainAccounts());
    const pin = await f.pending();
    f.setDemand(164);
    if (change === "dirty") f.setDirty();
    if (change === "cold") f.setDemand(0);
    const work =
      change === "foreign"
        ? f.prepare({})
        : change === "purpose" || change === "history" || change === "first"
          ? f.reads.prepareAccountWindow(
              f.owner,
              f.frameOwner,
              change === "first" ? f.first + 1 : f.first,
              pin,
              undefined,
              change === "purpose"
                ? { purpose: "audit_submit" }
                : {
                    ...f.options,
                    historySources:
                      change === "history"
                        ? ["other-source"]
                        : f.options.historySources,
                  },
            )
          : f.prepare(pin);
    await assert.rejects(work);
    assert.equal(f.begins.length, 1);
    assert.equal(f.claims.length, 0);
    assert.equal(f.wires.length, 0);
  });

it("a granted smaller A cannot spend the extra Core hold to cross its current pool limit", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  const pin = await f.pending();
  f.setDemand(164);
  f.grant();
  const window = await f.prepare(pin);
  await assert.rejects(
    window.read(async () => {
      f.reads.bindAccountCostPlan(f.owner);
      for (let n = 0; n < 9; n++)
        await f.reads.read(
          "https://api.hyperliquid.xyz/info",
          { type: "meta", index: n },
          0,
        );
    }),
    { code: "VENUE_READ_BUDGET_EXHAUSTED" },
  );
  assert.equal(f.wires.length, 8);
  assert.equal(f.bank().paid, 516);
  assert.equal(f.bank().held, 384);
  assert.equal(f.budget.snapshot().used, 160);
  await window.close();
  await f.reads.drainAccounts();
  assert.equal(f.bank().paid, 516);
  assert.equal(f.bank().held, 0);
});

it("a hint changed while the original grant is in flight still fails the existing exact local admission", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  const pin = await f.pending();
  f.setDemand(164);
  let release!: () => void;
  f.barrier(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  f.grant();
  const work = f.prepare(pin);
  await flush();
  f.budget.refreshObservationPlan(
    f.owner,
    { demand: 174, peaks: [154] },
    600000,
  );
  release();
  await assert.rejects(work, { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  await f.reads.drainAccounts();
  assert.equal(f.wires.length, 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.ends.length, 1);
});

it("original FIRST expiry prevents a lower-cost callback from creating a replacement or refreshing evidence", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  const pin = await f.pending();
  f.setDemand(164);
  await f.advance(100001);
  await assert.rejects(f.prepare(pin));
  assert.equal(f.begins.length, 1);
  assert.equal(f.wires.length, 0);
  assert.equal(f.claims.length, 0);
});

it("overlapping initial preparation cannot adopt a peer polling pin or change the original frame", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  let release!: () => void;
  f.barrier(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const first = f.pending();
  await flush();
  assert.equal(f.begins.length, 1);
  f.setDemand(164);
  await assert.rejects(f.prepare(), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  release();
  const pin = await first;
  f.barrier();
  assert.equal(await f.pending(pin), pin);
  assert.deepEqual(f.begins[1], f.begins[0]);
  assert.equal(f.ends.length, 0);
  assert.equal(f.claims.length, 0);
  assert.equal(f.wires.length, 0);
});

it("cancelled pending metadata cannot be reused to book another UUID", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  const pin = await f.pending();
  await f.reads.cancelPreparedPending(pin);
  f.setDemand(164);
  await assert.rejects(f.prepare(pin), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 1);
  assert.equal(f.ends.length, 1);
  assert.equal(f.wires.length, 0);
});

it("an external peer's local POLLING continuation cannot establish a VenueReads booking", async (t) => {
  const f = fixture();
  t.after(() => f.reads.drainAccounts());
  let release!: () => void;
  f.barrier(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let peerError: unknown;
  const peer = f.coordinator
    .begin(f.frameOwner, 544, f.first, new AbortController().signal, "learned")
    .catch((error) => {
      peerError = error;
    });
  await flush();
  await assert.rejects(f.prepare(), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 1);
  assert.equal(f.ends.length, 0);
  release();
  await peer;
  const pin = framePendingContinuation(peerError);
  assert.ok(pin);
  await assert.rejects(f.prepare(pin), { code: "VENUE_COST_PLAN_UNAVAILABLE" });
  assert.equal(f.begins.length, 1);
  assert.equal(f.wires.length, 0);
});
