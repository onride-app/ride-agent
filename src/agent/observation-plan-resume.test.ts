import assert from "node:assert/strict";
import { it } from "node:test";
import {
  validObservationCostPlan,
  type ObservationCostPlan,
  type ObservationPlanLease,
  type ObservationPlanStore,
} from "./account-observation-plans.js";
import { VenueReadBudget } from "./venue-read-budget.js";
import { VenueReads } from "./venue-reads.js";
import { CoordinatedReadError } from "./venue-read-transport.js";

const signal = () => new AbortController().signal;
const plan = { demand: 160, peaks: [140] };

it("restores only exact typed full cost plans, including their margin and bounded sample history", () => {
  assert.deepEqual(validObservationCostPlan(plan), plan);
  for (const invalid of [
    null,
    { demand: "160", peaks: [140] },
    { demand: 0, peaks: [140] },
    { demand: 1001, peaks: [140] },
    { demand: 140, peaks: [140] },
    { demand: 160, peaks: [] },
    { demand: 160, peaks: [140, 140, 140, 140] },
    { demand: 160, peaks: ["140"] },
    { demand: 160, peaks: [NaN] },
    { demand: 120, peaks: [0] },
  ])
    assert.equal(validObservationCostPlan(invalid), null);
});

it("empty storage retains the original full-window admission while a real learned plan survives a budget restart", async () => {
  let at = 0;
  const first = new VenueReadBudget({ clock: () => at });
  const observation = first.beginObservation("original-one");
  for (const [reserve, paid, unknown] of [
    [20, 20, false],
    [120, 20, false],
    [20, 20, true],
  ] as const) {
    const ticket = await first.acquire(
      "account",
      reserve,
      "original-one",
      signal(),
      unknown,
      observation,
    );
    ticket.sent();
    ticket.settle(paid);
    ticket.release();
  }
  observation.close(true);
  assert.deepEqual(observation.costPlan(), plan);
  const restarted = new VenueReadBudget({ clock: () => at });
  const source = await restarted.acquire("source", 2, "source-one", signal());
  source.sent();
  source.settle(2);
  source.release();
  assert.throws(() => restarted.beginObservation("empty-owner"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
  // This failed owner is a separate FIFO head. A second independent restart
  // models a clean loaded owner without changing the cold empty-store result.
  const restored = new VenueReadBudget({ clock: () => at });
  assert.equal(
    restored.restoreObservationPlan(
      "original-one",
      observation.costPlan(),
      600000,
    ),
    true,
  );
  const paidSource = await restored.acquire(
    "source",
    2,
    "source-one",
    signal(),
  );
  paidSource.sent();
  paidSource.settle(2);
  paidSource.release();
  const frame = restored.beginObservation("original-one");
  assert.equal(restored.snapshot().observation_reserved, 160);
  frame.close();
  at += 600001;
});

it("expired, corrupt, or competing restores cannot reset TTL or lower a live learned reservation", () => {
  let at = 0;
  const budget = new VenueReadBudget({ clock: () => at });
  assert.equal(budget.restoreObservationPlan("owner", plan, 0), false);
  assert.equal(budget.restoreObservationPlan("owner", plan, 600001), false);
  assert.equal(
    budget.restoreObservationPlan("owner", { demand: 100, peaks: [140] }, 100),
    false,
  );
  assert.equal(budget.restoreObservationPlan("owner", plan, 100), true);
  assert.equal(
    budget.restoreObservationPlan(
      "owner",
      { demand: 120, peaks: [20] },
      600000,
    ),
    false,
  );
  at = 101;
  const frame = budget.beginObservation("owner");
  assert.equal(budget.snapshot().observation_reserved, 1000);
  frame.close();
});

for (const issue of [
  "unknown",
  "unsent",
  "zero",
  "rejected",
  "failed",
] as const)
  it(`a ${issue} scope cannot publish a clean durable cost plan`, async () => {
    const budget = new VenueReadBudget();
    const frame = budget.beginObservation("owner");
    const ticket = await budget.acquire(
      "account",
      120,
      "owner",
      signal(),
      false,
      frame,
    );
    if (issue !== "unsent") ticket.sent();
    if (!["unknown", "unsent"].includes(issue))
      ticket.settle(issue === "zero" ? 0 : 20);
    ticket.release();
    if (issue === "rejected")
      await assert.rejects(
        budget.acquire("account", 0, "owner", signal(), false, frame),
      );
    frame.close(issue !== "failed");
    assert.equal(frame.costPlan(), null);
  });

it("natural reads claim durability before dispatch and persist only the exact completed metering plan", async () => {
  const events: string[] = [];
  const saved: ObservationCostPlan[] = [];
  const lease: ObservationPlanLease = {
    owner: "owner",
    generation: "1",
    plan: null,
    remainingTtlMs: 0,
  };
  const store: ObservationPlanStore = {
    read: async () => {
      events.push("load");
      return { ...lease, generation: null };
    },
    begin: async () => {
      events.push("dirty");
      return lease;
    },
    complete: async (_lease, value) => {
      events.push("clean");
      saved.push(value);
      return true;
    },
  };
  const reads = new VenueReads(
    (async () => {
      events.push("wire");
      return new Response("[]");
    }) as typeof fetch,
    Date.now,
    2,
    { budget: new VenueReadBudget(), observationPlans: store },
  );
  await reads.observeAccount(
    () =>
      reads.read("https://venue.test/info", {
        type: "userFillsByTime",
        user: "fixture",
        startTime: 1,
        endTime: 2,
      }),
    "owner",
  );
  await reads.drainAccounts();
  assert.deepEqual(events, ["load", "dirty", "wire", "clean"]);
  assert.deepEqual(saved, [{ demand: 140, peaks: [120] }]);
  assert.deepEqual(reads.diagnostics().cost_plans, {
    loaded_valid: 0,
    loaded_cold: 1,
    load_failed: 0,
    claimed: 1,
    restored_admitted: 0,
    claim_failed: 0,
    persisted: 1,
    persist_failed: 0,
    invalidated: 0,
  });
  const serialized = JSON.stringify(saved);
  for (const financial of [
    "balance",
    "positions",
    "orders",
    "prices",
    "observed_at",
    "charges",
    "nextAt",
  ])
    assert.equal(serialized.includes(financial), false);
});

it("a failed durable claim performs no venue read and does not bypass the original account deadline", async () => {
  let calls = 0;
  const reads = new VenueReads(
    (async () => {
      calls++;
      return new Response("[]");
    }) as typeof fetch,
    Date.now,
    2,
    {
      budget: new VenueReadBudget(),
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: null,
          plan: null,
          remainingTtlMs: 0,
        }),
        begin: async () => {
          throw new Error("fixture database unavailable");
        },
        complete: async () => assert.fail("No failed claim can become clean"),
      },
    },
  );
  await assert.rejects(
    reads.observeAccount(
      () => reads.read("https://venue.test/info", { type: "allMids" }),
      "owner",
    ),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
});

it("revoking a future local hint cannot erase the admitted scope's original high-water history", async () => {
  const budget = new VenueReadBudget();
  budget.restoreObservationPlan(
    "owner",
    { demand: 180, peaks: [160, 140] },
    600000,
  );
  const frame = budget.beginObservation("owner");
  budget.invalidateObservationPlan("owner");
  const ticket = await budget.acquire(
    "account",
    20,
    "owner",
    signal(),
    false,
    frame,
  );
  ticket.sent();
  ticket.settle(20);
  ticket.release();
  frame.close(true);
  assert.deepEqual(frame.costPlan(), { demand: 180, peaks: [160, 140, 20] });
});

it("dirty authoritative hints revoke existing local and queued small plans, and a newer clean generation can restore them", async () => {
  const budget = new VenueReadBudget();
  budget.restoreObservationPlan("owner", plan, 600000);
  const source = await budget.acquire("source", 2, "public", signal());
  source.sent();
  source.settle(2);
  source.release();
  let fresh = false,
    calls = 0;
  const reads = new VenueReads(
    (async () => {
      calls++;
      return new Response("[]");
    }) as typeof fetch,
    Date.now,
    2,
    {
      budget,
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: "2",
          plan: fresh ? plan : null,
          remainingTtlMs: fresh ? 600000 : 0,
        }),
        begin: async () => ({
          owner: "owner",
          generation: "3",
          plan,
          remainingTtlMs: 600000,
        }),
        complete: async () => true,
      },
    },
  );
  await assert.rejects(
    reads.observeAccount(
      () => reads.read("https://venue.test/info", { type: "userFillsByTime" }),
      "owner",
    ),
    { code: "VENUE_READ_BUDGET_EXHAUSTED" },
  );
  assert.equal(calls, 0);
  assert.equal((budget as any).observationQueue.get("owner").demand, 1000);
  fresh = true;
  await reads.observeAccount(
    () => reads.read("https://venue.test/info", { type: "userFillsByTime" }),
    "owner",
  );
  assert.equal(calls, 1);
  await reads.drainAccounts();
  assert.equal(reads.diagnostics().cost_plans.restored_admitted, 1);
  assert.equal(reads.diagnostics().cost_plans.loaded_cold, 1);
});

it("a raced claim sends no request and never increments actual restored admission", async () => {
  let calls = 0;
  const reads = new VenueReads(
    (async () => {
      calls++;
      return new Response("[]");
    }) as typeof fetch,
    Date.now,
    2,
    {
      budget: new VenueReadBudget(),
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: "1",
          plan,
          remainingTtlMs: 600000,
        }),
        begin: async () => {
          throw new Error("fixture generation changed before claim");
        },
        complete: async () => assert.fail("A raced claim never writes clean"),
      },
    },
  );
  await assert.rejects(
    reads.observeAccount(
      () => reads.read("https://venue.test/info", { type: "allMids" }),
      "owner",
    ),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  assert.equal(calls, 0);
  assert.deepEqual(reads.diagnostics().cost_plans, {
    loaded_valid: 1,
    loaded_cold: 0,
    load_failed: 0,
    claimed: 0,
    restored_admitted: 0,
    claim_failed: 1,
    persisted: 0,
    persist_failed: 0,
    invalidated: 1,
  });
});

it("wall clock rollback during plan I/O cannot renew TTL or the original monotonic lease deadline", async () => {
  let wall = 100000,
    mono = 0,
    calls = 0,
    leaseBudget = 0;
  const budget = new VenueReadBudget({ clock: () => mono });
  const reads = new VenueReads(
    (async () => {
      calls++;
      return new Response("[]");
    }) as typeof fetch,
    () => wall,
    2,
    {
      budget,
      monotonicClock: () => mono,
      observationPlans: {
        read: async () => {
          wall -= 5000;
          mono += 1500;
          return {
            owner: "owner",
            generation: "1",
            plan,
            remainingTtlMs: 1000,
          };
        },
        begin: async (_owner, _signal, _hint, maximum) => {
          leaseBudget = maximum!;
          assert.equal(
            budget.snapshot().observation_reserved,
            1000,
            "Elapsed metadata lifetime was not refreshed by wall-clock rollback",
          );
          throw new Error("fixture hint expired before claim");
        },
        complete: async () => assert.fail("Expired metadata is never clean"),
      },
    },
  );
  await assert.rejects(
    reads.observeAccount(
      () => reads.read("https://venue.test/info", { type: "allMids" }),
      "owner",
    ),
    { code: "VENUE_COST_PLAN_UNAVAILABLE" },
  );
  assert.equal(leaseBudget, 18500);
  assert.equal(calls, 0);
  assert.equal(reads.diagnostics().cost_plans.restored_admitted, 0);
});

it("a failed clean CAS revokes the local hint instead of silently using it again", async () => {
  const budget = new VenueReadBudget();
  const reads = new VenueReads(
    (async () => new Response("[]")) as typeof fetch,
    Date.now,
    2,
    {
      budget,
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: "1",
          plan,
          remainingTtlMs: 600000,
        }),
        begin: async () => ({
          owner: "owner",
          generation: "2",
          plan,
          remainingTtlMs: 600000,
        }),
        complete: async () => false,
      },
    },
  );
  await reads.observeAccount(
    () => reads.read("https://venue.test/info", { type: "userFillsByTime" }),
    "owner",
  );
  await reads.drainAccounts();
  assert.throws(() => budget.beginObservation("owner"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
});

it("an old finalizer cannot revoke a newer generation's restored local hint", async () => {
  let at = 0,
    release!: () => void,
    claims = 0;
  const old = new Promise<boolean>((resolve) => {
    release = () => resolve(false);
  });
  const budget = new VenueReadBudget({ clock: () => at });
  const reads = new VenueReads(
    (async () => new Response("[]")) as typeof fetch,
    () => 100000 + at,
    2,
    {
      budget,
      monotonicClock: () => at,
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: String(claims + 1),
          plan,
          remainingTtlMs: 600000,
        }),
        begin: async () => ({
          owner: "owner",
          generation: String(++claims),
          plan,
          remainingTtlMs: 600000,
        }),
        complete: async (lease) => (lease.generation === "1" ? old : true),
      },
    },
  );
  const request = () =>
    reads.observeAccount(
      () => reads.read("https://venue.test/info", { type: "userFillsByTime" }),
      "owner",
    );
  await request();
  at = 21000;
  await request();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const current = structuredClone(
    (budget as any).observationPlans.get("owner"),
  );
  assert.ok(current?.demand < 1000);
  release();
  await reads.drainAccounts();
  assert.deepEqual((budget as any).observationPlans.get("owner"), current);
});

it("operational finalization retains the original timer and drain waits for its timeout without extending it", async () => {
  let at = 0,
    sequence = 0;
  const timers = new Map<number, { at: number; run(): void }>();
  const budget = new VenueReadBudget({ clock: () => at });
  const reads = new VenueReads(
    (async () => new Response("[]")) as typeof fetch,
    () => 100000 + at,
    2,
    {
      budget,
      monotonicClock: () => at,
      timers: {
        setTimeout(run, ms) {
          const id = ++sequence;
          timers.set(id, { at: at + ms, run });
          return id;
        },
        clearTimeout(id) {
          timers.delete(id as number);
        },
      },
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: null,
          plan: null,
          remainingTtlMs: 0,
        }),
        begin: async () => ({
          owner: "owner",
          generation: "1",
          plan: null,
          remainingTtlMs: 0,
        }),
        complete: async (_lease, _plan, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(false), {
              once: true,
            }),
          ),
      },
    },
  );
  await reads.observeAccount(
    () => reads.read("https://venue.test/info", { type: "userFillsByTime" }),
    "owner",
  );
  assert.equal(reads.diagnostics().cost_plans.persisted, 0);
  const active = [...timers.values()];
  assert.equal(active.length, 1);
  assert.equal(active[0].at, 20000);
  let drained = false;
  const ending = reads.drainAccounts().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  at = 20000;
  active[0].run();
  await ending;
  assert.equal(timers.size, 0);
  assert.equal(reads.diagnostics().cost_plans.persist_failed, 1);
  assert.equal(reads.diagnostics().cost_plans.persisted, 0);
  assert.throws(() => budget.beginObservation("owner"), {
    code: "VENUE_READ_BUDGET_EXHAUSTED",
  });
});

it("a swallowed proven no-upstream zero-cost hop cannot publish a cost plan or become a successful persistence counter", async () => {
  let calls = 0,
    cleaned = 0;
  const reads = new VenueReads(
    (async () => {
      if (++calls === 1)
        throw new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", false);
      return new Response("[]");
    }) as typeof fetch,
    Date.now,
    2,
    {
      budget: new VenueReadBudget(),
      observationPlans: {
        read: async () => ({
          owner: "owner",
          generation: null,
          plan: null,
          remainingTtlMs: 0,
        }),
        begin: async () => ({
          owner: "owner",
          generation: "1",
          plan: null,
          remainingTtlMs: 0,
        }),
        complete: async () => {
          cleaned++;
          return true;
        },
      },
    },
  );
  await reads.observeAccount(async () => {
    await reads
      .read("https://venue.test/info", { type: "userFillsByTime" })
      .catch(() => {});
    return reads.read("https://venue.test/info", { type: "allMids" });
  }, "owner");
  await reads.drainAccounts();
  assert.equal(cleaned, 0);
  assert.equal(reads.diagnostics().cost_plans.persisted, 0);
  assert.equal(reads.diagnostics().cost_plans.restored_admitted, 0);
});
