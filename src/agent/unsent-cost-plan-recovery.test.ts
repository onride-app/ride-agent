import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  ObservationPlanHint,
  ObservationPlanLease,
  ObservationPlanStore,
  ObservationCostPlan,
} from "./account-observation-plans.js";
import { AgentError } from "./contracts.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";
import { VenueReadBudget, type BudgetTimers } from "./venue-read-budget.js";
import { VenueReads, type PreparedAccountWindow } from "./venue-reads.js";
import {
  CoordinatedReadError,
  recordCoordinatedEvidence,
  type VenueReadFetcher,
} from "./venue-read-transport.js";

async function flush() {
  for (let n = 0; n < 160; n++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
class Time {
  at = 1700000000000;
  mono = this.at;
  clock = () => this.at;
  monotonic = () => this.mono;
  events = new Map<number, { at: number; run(): void }>();
  sequence = 0;
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
    const until = this.at + ms;
    await flush();
    for (;;) {
      const next = [...this.events]
        .filter(([, e]) => e.at <= until)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.mono += next[1].at - this.at;
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.mono += until - this.at;
    this.at = until;
    await flush();
  }
}
const owner = "a".repeat(64),
  frameOwner = "b".repeat(64),
  url = "https://api.hyperliquid.xyz/info";
const unsent = () =>
  new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", false, 1000);
class Plans implements ObservationPlanStore {
  generation = 1;
  plan: ObservationCostPlan = { demand: 184, peaks: [164] };
  dirty = false;
  begins: ObservationPlanLease[] = [];
  returns: ObservationPlanLease[] = [];
  completes: ObservationPlanLease[] = [];
  read = async (): Promise<ObservationPlanHint> => {
    assert.equal(this.dirty, false, "a peer cannot read a live dirty plan");
    return {
      owner,
      generation: String(this.generation),
      plan: structuredClone(this.plan),
      remainingTtlMs: 590000,
    };
  };
  begin = async (): Promise<ObservationPlanLease> => {
    assert.equal(this.dirty, false);
    this.dirty = true;
    const lease = {
      owner,
      generation: String(++this.generation),
      plan: structuredClone(this.plan),
      remainingTtlMs: 590000,
    };
    this.begins.push(lease);
    return lease;
  };
  complete = async (
    lease: ObservationPlanLease,
    plan: ObservationCostPlan,
  ): Promise<boolean> => {
    assert.equal(lease.generation, String(this.generation));
    assert.equal(this.dirty, true);
    this.dirty = false;
    this.plan = structuredClone(plan);
    this.completes.push(lease);
    return true;
  };
  returnUnsent = async (lease: ObservationPlanLease): Promise<boolean> => {
    assert.equal(this.dirty, true);
    assert.equal(lease.generation, String(this.generation));
    this.returns.push(lease);
    this.dirty = false;
    return true;
  };
}
function fixture(
  fetcher: VenueReadFetcher = async () => {
    throw unsent();
  },
  transport: "core_shared_info" | "official" = "core_shared_info",
) {
  const time = new Time(),
    plans = new Plans(),
    budget = new VenueReadBudget({ clock: time.clock, timers: time.timers });
  let calls = 0,
    ends = 0;
  let endBarrier: Promise<void> | undefined;
  const coordinator = coreFrameCoordinator(
    "http://127.0.0.1:1",
    "fixture-token",
    async (u, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(u).endsWith("_end")) {
        ends++;
        await endBarrier;
        return Response.json({ state: "closed", frame_id: body.frame_id });
      }
      return Response.json({
        state: "granted",
        frame_id: body.frame_id,
        expires_at: time.at + 20000,
        retry_after_ms: 0,
        reserved_weight: body.weight,
        capacity: 900,
        guaranteed_complete: false,
      });
    },
    time.clock,
  );
  const reads = new VenueReads(
    async (...args) => {
      calls++;
      return fetcher(...args);
    },
    time.clock,
    2,
    {
      transport,
      frameCoordinator:
        transport === "core_shared_info" ? coordinator : undefined,
      budget,
      observationPlans: plans,
      timers: time.timers,
      monotonicClock: time.monotonic,
      report: () => {},
    },
  );
  const read = async (type = "clearinghouseState") => {
    reads.bindAccountCostPlan(owner);
    return reads.read(url, { type, user: "anonymous-fixture" }, 0);
  };
  const prepare = () =>
    reads.prepareAccountWindow(owner, frameOwner, time.at + 100000);
  return {
    reads,
    budget,
    plans,
    time,
    read,
    prepare,
    calls: () => calls,
    ends: () => ends,
    deferEnd: (p: Promise<void>) => {
      endBarrier = p;
    },
  };
}

for (const prepared of [false, true])
  it(`${prepared ? "prepared" : "ordinary"} zero-send recovery waits for a genuinely deferred Core end and keeps the original failure`, async () => {
    const failure = unsent(),
      f = fixture(async () => {
        throw failure;
      }),
      ending = deferred<void>();
    f.deferEnd(ending.promise);
    let window: PreparedAccountWindow | undefined;
    try {
      if (prepared) {
        window = await f.prepare();
        await assert.rejects(window.read(f.read), (error) => error === failure);
        assert.equal(f.plans.returns.length, 0);
        await window.close();
      } else
        await assert.rejects(
          f.reads.observeAccount(f.read, owner),
          (error) => error === failure,
        );
      await flush();
      assert.equal(f.ends(), 1);
      assert.equal(f.plans.returns.length, 0);
      assert.equal(f.plans.dirty, true);
      ending.resolve();
      await flush();
      assert.equal(f.plans.returns.length, 1);
      assert.equal(f.plans.dirty, false);
      assert.equal(f.budget.snapshot().used, 0);
      assert.equal(f.plans.completes.length, 0);
      assert.equal(f.plans.generation, 2);
      await window?.close();
      await flush();
      assert.equal(f.plans.returns.length, 1);
    } finally {
      ending.resolve();
      await window?.close();
      await f.reads.drainAccounts();
    }
  });

it("A2 verified no-send restores only the hint freshly published by A1, after the whole parent is revoked", async () => {
  let second = false;
  const f = fixture(async () => {
    if (second) throw unsent();
    const response = Response.json({});
    recordCoordinatedEvidence(response, f.time.at);
    return response;
  });
  const window = await f.prepare();
  try {
    await window.read(f.read);
    const a1 = structuredClone(f.plans.plan);
    assert.equal(f.plans.completes.length, 1);
    assert.equal(f.budget.snapshot().used, 2);
    second = true;
    await assert.rejects(window.read(f.read), {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
    });
    assert.equal(f.plans.returns.length, 0);
    assert.equal(f.plans.dirty, true);
    await window.close();
    await flush();
    assert.equal(f.plans.returns.length, 1);
    assert.equal(f.plans.returns[0].generation, "3");
    assert.deepEqual(f.plans.returns[0].plan, a1);
    assert.deepEqual(f.plans.plan, a1);
    assert.equal(f.plans.generation, 3);
    assert.equal(f.budget.snapshot().used, 2);
    await assert.rejects(window.read(f.read), {
      code: "VENUE_COST_PLAN_UNAVAILABLE",
    });
  } finally {
    await window.close();
    await f.reads.drainAccounts();
  }
});

const unsafe: [string, () => Promise<Response>][] = [
  [
    "sent=true coordinated denial",
    async () => {
      throw new CoordinatedReadError("VENUE_READ_BUDGET_EXHAUSTED", true, 1000);
    },
  ],
  [
    "untyped reason marker",
    async () => {
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "fixture",
        true,
        503,
        { reason_code: "READ_LOCAL_BUDGET_UNSENT" },
      );
    },
  ],
  [
    "typed 429 despite sent=false",
    async () => {
      throw new CoordinatedReadError("VENUE_RATE_LIMITED", false, 1000);
    },
  ],
  [
    "capacity growth despite sent=false",
    async () => {
      const error = unsent();
      error.details!.reason_code = "READ_FRAME_CAPACITY";
      throw error;
    },
  ],
  ["real HTTP429", async () => new Response("", { status: 429 })],
  [
    "ambiguous transport",
    async () => {
      throw new Error("fixture lost response");
    },
  ],
  ["invalid JSON response", async () => new Response("{")],
  ["HTTP503 after send", async () => new Response("", { status: 503 })],
];
for (const [name, fetcher] of unsafe)
  it(`${name} cannot turn a dirty generation clean`, async () => {
    const f = fixture(fetcher);
    try {
      await assert.rejects(f.reads.observeAccount(f.read, owner));
      await flush();
      assert.equal(f.calls(), 1);
      assert.equal(f.plans.returns.length, 0);
      assert.equal(f.plans.dirty, true);
      assert.equal(f.plans.completes.length, 0);
    } finally {
      await f.reads.drainAccounts();
    }
  });

it("a typed false receipt outside the trusted Core transport is insufficient", async () => {
  const f = fixture(undefined, "official");
  try {
    await assert.rejects(f.reads.observeAccount(f.read, owner));
    await flush();
    assert.equal(f.plans.returns.length, 0);
    assert.equal(f.plans.dirty, true);
  } finally {
    await f.reads.drainAccounts();
  }
});

it("a proven local pre-dispatch admission failure can return a claimed hint without claiming a provider receipt", async (t) => {
  const f = fixture();
  t.mock.method(f.budget, "acquire", async () => {
    throw new AgentError(
      "VENUE_READ_BUDGET_EXHAUSTED",
      "local fixture admission",
      true,
      503,
    );
  });
  try {
    await assert.rejects(f.reads.observeAccount(f.read, owner), {
      code: "VENUE_READ_BUDGET_EXHAUSTED",
    });
    await flush();
    assert.equal(f.calls(), 0);
    assert.equal(f.plans.begins.length, 1);
    assert.equal(f.plans.returns.length, 1);
    assert.equal(f.budget.snapshot().used, 0);
    assert.equal(f.plans.completes.length, 0);
  } finally {
    await f.reads.drainAccounts();
  }
});

it("a partially successful scope stays dirty when its final read is verified unsent", async () => {
  let calls = 0;
  const f = fixture(async () => {
    if (++calls > 1) throw unsent();
    return Response.json({});
  });
  try {
    await assert.rejects(
      f.reads.observeAccount(async () => {
        f.reads.bindAccountCostPlan(owner);
        await f.reads.read(
          url,
          { type: "clearinghouseState", user: "fixture" },
          0,
        );
        await f.reads.read(
          url,
          { type: "spotClearinghouseState", user: "fixture" },
          0,
        );
      }, owner),
    );
    await flush();
    assert.equal(f.plans.returns.length, 0);
    assert.equal(f.plans.dirty, true);
    assert.equal(f.budget.snapshot().used, 2);
  } finally {
    await f.reads.drainAccounts();
  }
});

it("Promise.all failure and Core end are not proof that a sibling raw fetch has stopped", async () => {
  const raw = deferred<Response>();
  const f = fixture(async (_u, init) =>
    JSON.parse(String(init.body)).type === "userAbstraction"
      ? raw.promise
      : Promise.reject(unsent()),
  );
  try {
    await assert.rejects(
      f.reads.observeAccount(async () => {
        f.reads.bindAccountCostPlan(owner);
        await Promise.all(
          ["userAbstraction", "clearinghouseState"].map((type) =>
            f.reads.read(url, { type, user: "fixture" }, 0),
          ),
        );
      }, owner),
    );
    await flush();
    assert.equal(f.calls(), 2);
    assert.equal(f.ends(), 1);
    assert.equal(f.plans.returns.length, 0);
    raw.resolve(Response.json("disabled"));
    await flush();
    assert.equal(f.plans.returns.length, 0);
    assert.equal(f.plans.dirty, true);
    assert.equal(f.budget.snapshot().used, 20);
  } finally {
    raw.resolve(Response.json("disabled"));
    await f.reads.drainAccounts();
  }
});

it("an aborted visible read waits for the actual raw fetch to confirm no send before returning metadata", async () => {
  const raw = deferred<Response>(),
    f = fixture(() => raw.promise),
    controller = new AbortController();
  try {
    const work = f.reads.observeAccount(f.read, owner, {
      signal: controller.signal,
    });
    const rejection = assert.rejects(work);
    await flush();
    assert.equal(f.calls(), 1);
    controller.abort(new Error("fixture cancellation"));
    await rejection;
    await flush();
    assert.equal(f.plans.returns.length, 0);
    raw.reject(unsent());
    await flush();
    assert.equal(f.plans.returns.length, 1);
    assert.equal(f.plans.dirty, false);
    assert.equal(f.budget.snapshot().used, 0);
  } finally {
    raw.reject(unsent());
    await f.reads.drainAccounts();
  }
});

it("parent close cannot restore A2 while an earlier source task still executes outside its abort race", async () => {
  const source = deferred<void>(),
    started = deferred<void>();
  let second = false;
  const f = fixture(async () => {
    if (second) throw unsent();
    return Response.json({});
  });
  const window = await f.prepare();
  try {
    await window.read(f.read);
    const background = window
      .readSource(async () => {
        started.resolve();
        await source.promise;
      })
      .catch(() => {});
    await started.promise;
    second = true;
    await assert.rejects(window.read(f.read));
    await window.close();
    await background;
    await flush();
    assert.equal(f.plans.returns.length, 0);
    source.resolve();
    await flush();
    assert.equal(f.plans.returns.length, 1);
    assert.equal(f.budget.snapshot().used, 2);
  } finally {
    source.resolve();
    await window.close();
    await f.reads.drainAccounts();
  }
});

it("a wire timeout remains unknown after its ignored raw fetch eventually reports no send", async () => {
  const raw = deferred<Response>(),
    f = fixture(() => raw.promise);
  try {
    const work = assert.rejects(f.reads.observeAccount(f.read, owner), {
      code: "VENUE_READ_DEADLINE",
    });
    await flush();
    assert.equal(f.calls(), 1);
    await f.time.advance(12000);
    await work;
    assert.equal(f.plans.returns.length, 0);
    raw.reject(unsent());
    await flush();
    assert.equal(f.plans.returns.length, 0);
    assert.equal(f.plans.dirty, true);
    assert.equal(f.budget.snapshot().used, 2);
  } finally {
    raw.reject(unsent());
    await f.reads.drainAccounts();
  }
});

for (const jump of ["wall", "monotonic"] as const)
  it(`original ${jump} deadline cannot be renewed by deferred cleanup`, async () => {
    const f = fixture(),
      end = deferred<void>();
    f.deferEnd(end.promise);
    try {
      await assert.rejects(f.reads.observeAccount(f.read, owner));
      if (jump === "wall") f.time.at += 20001;
      else f.time.mono += 20001;
      end.resolve();
      await flush();
      assert.equal(f.plans.returns.length, 0);
      assert.equal(f.plans.dirty, true);
    } finally {
      end.resolve();
      await f.reads.drainAccounts();
    }
  });

it("cleanup failure preserves the original business error and never retries or publishes a cost plan", async () => {
  const failure = unsent(),
    f = fixture(async () => {
      throw failure;
    });
  let cleanup = 0;
  f.plans.returnUnsent = async () => {
    cleanup++;
    throw new Error("fixture metadata connection lost");
  };
  try {
    await assert.rejects(
      f.reads.observeAccount(f.read, owner),
      (error) => error === failure,
    );
    await flush();
    await f.reads.drainAccounts();
    assert.equal(cleanup, 1);
    assert.equal(f.plans.dirty, true);
    assert.equal(f.plans.completes.length, 0);
  } finally {
    await f.reads.drainAccounts();
  }
});
