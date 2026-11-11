import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import {
  coreFrameCoordinator,
  frameReadinessOptions,
  FRAME_CONTROL_SEQ_MAX,
} from "./core-frame-coordinator.js";
import { framePendingContinuation } from "./core-frame-coordinator.js";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget } from "./venue-read-budget.js";

const epoch = "01234567-89ab-4cde-8fab-0123456789ab";
const owner = "a".repeat(64),
  other = "b".repeat(64);
const signal = () => new AbortController().signal;
async function pending(work: Promise<unknown>) {
  let error: any;
  try {
    await work;
    assert.fail("Expected pending");
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
  assert.equal(error.details?.reason_code, "READ_FRAME_PENDING");
  return error;
}
function fixture(t: TestContext, enabled = true) {
  const time = { at: 1794410000000 };
  const calls: { path: string; body: any }[] = [];
  const records = new Map<string, any>(),
    fences = new Map<string, any>();
  const state = {
    grant: false,
    remaining: 15000,
    disabled: false,
    old: false,
    mutate: (value: any) => value,
    hook: undefined as
      | undefined
      | ((
          call: { path: string; body: any },
          reply: any,
        ) => Response | Promise<Response> | undefined),
  };
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      body = JSON.parse(String(init?.body));
    const call = { path, body };
    calls.push(call);
    if (path.endsWith("_end")) {
      records.delete(body.frame_id);
      fences.set(body.frame_id, body);
      const reply = {
        state: "closed",
        frame_id: body.frame_id,
        ...(path.includes("_v2_")
          ? {
              protocol_version: 2,
              control_applied: true,
              deadline_ms: body.deadline_ms,
            }
          : {}),
      };
      return state.hook?.(call, reply) ?? Response.json(state.mutate(reply));
    }
    if (path.includes("_v2_") && state.old)
      return Response.json(
        {
          error: {
            code: "CORE_REJECTED",
            message: "Unknown private Agent operation",
          },
        },
        { status: 409 },
      );
    if (path.includes("_v2_") && state.disabled)
      return Response.json(
        { error: { code: "frame_v2_disabled", upstream_request_sent: false } },
        { status: 503 },
      );
    let r = records.get(body.frame_id);
    const fence = fences.get(body.frame_id);
    if (fence && path.includes("_v2_"))
      return Response.json({
        protocol_version: 2,
        state: "cancelled",
        frame_id: body.frame_id,
        deadline_ms: fence.deadline_ms,
        control_applied: false,
        queued: false,
        control_seq: 0,
        ready: false,
        fleet_epoch: epoch,
      });
    if (!r) {
      r = { ...body, state: "pending", held: 0 };
      records.set(body.frame_id, r);
    }
    let applied = true;
    if (body.protocol_version === 2) {
      if (
        body.control_seq < r.control_seq ||
        (body.control_seq === r.control_seq && body.ready !== r.ready)
      )
        applied = false;
      else if (
        r.state === "granted" &&
        (body.control_seq !== r.control_seq || body.ready !== r.ready)
      )
        applied = false;
      else {
        r.control_seq = body.control_seq;
        r.ready = body.ready;
      }
    }
    if (applied && r.state !== "granted") {
      if (body.protocol_version === 2 && !r.ready) r.held = 0;
      else if (state.grant) {
        r.state = "granted";
        r.held = body.weight;
        r.expires = time.at + state.remaining;
      } else r.held = Math.min(100, body.weight);
    }
    const reply = {
      state: r.state,
      frame_id: r.frame_id,
      reserved_weight: r.held,
      expires_at: r.expires ?? r.deadline_ms,
      retry_after_ms: r.state === "pending" ? 1000 : 0,
      capacity: 900,
      guaranteed_complete: false,
      ...(body.protocol_version === 2
        ? {
            protocol_version: 2,
            fleet_epoch: epoch,
            control_seq: r.control_seq,
            ready: r.ready,
            control_applied: applied,
            queued: r.state === "pending",
            deadline_ms: r.deadline_ms,
          }
        : {}),
    };
    return state.hook?.(call, reply) ?? Response.json(state.mutate(reply));
  };
  const coordinator = coreFrameCoordinator(
    "https://core.test",
    "fixture",
    request,
    () => time.at,
    enabled ? { readinessV2: { fleetEpoch: epoch } } : {},
  );
  t.after(() => coordinator.close?.());
  return {
    time,
    calls,
    state,
    coordinator,
    records,
    fences,
    first: time.at + 100000,
  };
}

it("readiness requires explicit operator epoch; default and legacy paths preserve the old packet", async (t) => {
  assert.deepEqual(frameReadinessOptions({}), {});
  assert.throws(() =>
    frameReadinessOptions({ RIDE_AGENT_INFO_FRAME_V2_ENABLED: "true" }),
  );
  assert.throws(() =>
    frameReadinessOptions({
      RIDE_AGENT_INFO_FRAME_V2_ENABLED: "true",
      RIDE_AGENT_INFO_FRAME_V2_FLEET_EPOCH: epoch.toUpperCase(),
    }),
  );
  assert.deepEqual(
    frameReadinessOptions({
      RIDE_AGENT_INFO_FRAME_V2_ENABLED: "true",
      RIDE_AGENT_INFO_FRAME_V2_FLEET_EPOCH: epoch,
    }),
    { readinessV2: { fleetEpoch: epoch } },
  );
  const f = fixture(t, false);
  f.state.grant = true;
  const lease = await f.coordinator.begin(
    owner,
    184,
    f.first,
    signal(),
    "learned",
    undefined,
    false,
  );
  assert.equal(f.calls[0].path, "/internal/agent-core/perps_info_frame_begin");
  assert.deepEqual(Object.keys(f.calls[0].body).sort(), [
    "deadline_ms",
    "frame_id",
    "mode",
    "owner",
    "weight",
  ]);
  assert.equal(lease.expires_at, f.time.at + 15000);
  assert.equal(await f.coordinator.parkPending?.(owner, signal()), false);
});

it("strict park ACK releases only readiness, retains UUID/FIRST, and resume uses actual lease expiry", async (t) => {
  const f = fixture(t);
  const error = await pending(
    f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
  );
  const original = f.calls[0].body;
  assert.equal(
    await f.coordinator.parkPending!(
      owner,
      signal(),
      framePendingContinuation(error),
    ),
    true,
  );
  assert.equal(f.calls[1].body.control_seq, 2);
  assert.equal(f.calls[1].body.ready, false);
  const n = f.calls.length;
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  assert.equal(
    f.calls.length,
    n,
    "positive same-intent park remains operationally acknowledged",
  );
  f.time.at += 5000;
  f.state.grant = true;
  const lease = await f.coordinator.begin(
    owner,
    184,
    f.time.at + 100000,
    signal(),
    "learned",
  );
  assert.equal(f.calls.at(-1)!.body.control_seq, 3);
  assert.equal(f.calls.at(-1)!.body.ready, true);
  assert.equal(f.calls.at(-1)!.body.frame_id, original.frame_id);
  assert.equal(f.calls.at(-1)!.body.deadline_ms, f.first);
  assert.equal(lease.expires_at, f.time.at + 15000);
  assert.equal(await f.coordinator.parkPending!(owner, signal()), false);
  f.time.at = lease.expires_at;
  await assert.rejects(f.coordinator.parkPending!(owner, signal()), {
    code: "VENUE_READ_DEADLINE",
  });
  assert.equal(
    f.calls.at(-1)!.path,
    "/internal/agent-core/perps_info_frame_v2_end",
  );
  assert.equal(f.calls.at(-1)!.body.deadline_ms, f.first);
});

for (const field of [
  "fleet_epoch",
  "control_seq",
  "control_applied",
  "queued",
  "reserved_weight",
] as const)
  it(`a mismatched ${field} cannot authorize parking or changing the unknown intent`, async (t) => {
    const f = fixture(t);
    await pending(
      f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    );
    f.state.mutate = (value) => ({
      ...value,
      [field]:
        field === "fleet_epoch"
          ? "ffffffff-ffff-4fff-8fff-ffffffffffff"
          : field === "control_seq"
            ? 99
            : field === "control_applied"
              ? false
              : field === "queued"
                ? false
                : 1,
    });
    await pending(f.coordinator.parkPending!(owner, signal()));
    assert.equal(f.calls.at(-1)!.body.control_seq, 2);
    f.state.mutate = (value) => value;
    assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
    assert.equal(
      f.calls.at(-1)!.body.control_seq,
      2,
      "retry resolves exactly the same false intent",
    );
  });

it("lost park ACK and late old ready response cannot authorize downgrade, new UUID or unpark", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  let late!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => {
    late = resolve;
  });
  let oldReply: any;
  f.state.hook = (call, reply) => {
    if (call.body.ready === false) {
      oldReply = reply;
      return waiting;
    }
  };
  const abort = new AbortController();
  const parking = f.coordinator.parkPending!(owner, abort.signal);
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  await pending(parking);
  const failed = f.calls.at(-1)!.body;
  f.state.hook = undefined;
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  assert.equal(f.calls.at(-1)!.body.control_seq, failed.control_seq);
  assert.equal(f.calls.at(-1)!.body.frame_id, failed.frame_id);
  late(
    Response.json({
      ...oldReply,
      ready: true,
      control_seq: 1,
      state: "granted",
      queued: false,
      reserved_weight: 184,
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  const n = f.calls.length;
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  assert.equal(f.calls.length, n);
});

it("an unknown resume stays the same ready intent and cannot be replaced by a newer park", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  f.state.hook = (call) => {
    if (call.body.ready === true) throw Error("lost resume");
    return undefined;
  };
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const n = f.calls.length;
  assert.equal(await f.coordinator.parkPending!(owner, signal()), false);
  assert.equal(f.calls.length, n);
  f.state.hook = undefined;
  f.state.grant = true;
  const lease = await f.coordinator.begin(
    owner,
    184,
    f.first,
    signal(),
    "learned",
  );
  assert.equal(f.calls.at(-1)!.body.control_seq, 3);
  assert.equal(lease.expires_at, f.time.at + 15000);
});

it("only explicit no-Redis old-Core replies can choose legacy, for this exact entire episode", async (t) => {
  for (const old of [true, false]) {
    const f = fixture(t);
    f.state.old = old;
    f.state.disabled = !old;
    await pending(
      f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    );
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].body.frame_id, f.calls[1].body.frame_id);
    assert.equal(f.calls[1].body.deadline_ms, f.first);
    assert.equal(
      f.calls[1].path,
      "/internal/agent-core/perps_info_frame_begin",
    );
    assert.equal(await f.coordinator.parkPending!(owner, signal()), false);
    await pending(
      f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    );
    assert.equal(
      f.calls.at(-1)!.path,
      "/internal/agent-core/perps_info_frame_begin",
    );
  }
});

it("disabled after an ambiguous v2 request cannot downgrade; END cleanup needs no epoch", async (t) => {
  const f = fixture(t);
  f.state.hook = (call) => {
    if (call.path.endsWith("_begin")) throw Error("unknown v2");
    return undefined;
  };
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const original = f.calls[0].body;
  f.state.hook = undefined;
  f.state.disabled = true;
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  assert.equal(f.calls.at(-1)!.body.frame_id, original.frame_id);
  assert.equal(
    f.calls.at(-1)!.path,
    "/internal/agent-core/perps_info_frame_v2_begin",
  );
  await f.coordinator.end(original.frame_id);
  assert.equal(f.calls.at(-1)!.body.deadline_ms, f.first);
});

it("failed END retains the exact resource until a positive fence ACK before another UUID", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const original = f.calls[0].body;
  f.state.mutate = (value) =>
    value.state === "closed" ? { ...value, deadline_ms: f.first + 1 } : value;
  await assert.rejects(f.coordinator.end(original.frame_id));
  let finish!: (response: Response) => void;
  f.state.mutate = (value) => value;
  f.state.hook = (call, reply) =>
    call.path.endsWith("_end")
      ? new Promise((resolve) => {
          finish = () => resolve(Response.json(reply));
        })
      : undefined;
  const next = f.coordinator.begin(owner, 184, f.first, signal(), "learned");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.calls.filter((c) => c.path.endsWith("_begin")).length, 1);
  f.state.hook = undefined;
  finish(undefined as any);
  await pending(next);
  assert.notEqual(f.calls.at(-1)!.body.frame_id, original.frame_id);
});

it("terminal fence is not a park ACK and is cleaned using the original deadline", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const original = f.calls[0].body;
  f.records.delete(original.frame_id);
  f.fences.set(original.frame_id, { deadline_ms: f.first });
  await assert.rejects(
    f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    { code: "VENUE_READ_DEADLINE" },
  );
  assert.equal(
    f.calls.at(-1)!.path,
    "/internal/agent-core/perps_info_frame_v2_end",
  );
  assert.equal(f.calls.at(-1)!.body.deadline_ms, f.first);
});

it("a non-200 park ACK stays unknown, even when its JSON claims success", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  f.state.hook = (call, reply) =>
    call.body.ready === false
      ? Response.json(reply, { status: 201 })
      : undefined;
  await pending(f.coordinator.parkPending!(owner, signal()));
  f.state.hook = undefined;
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  assert.equal(f.calls.at(-1)!.body.control_seq, 2);
});

it("malformed pending and granted retry fields cannot acknowledge a v2 intent", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  f.state.mutate = value => ({ ...value, retry_after_ms: 0 });
  await pending(f.coordinator.parkPending!(owner, signal()));
  f.state.mutate = value => value;
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  assert.equal(f.calls.at(-1)!.body.control_seq, 2);
  f.state.grant = true;
  f.state.mutate = value => ({ ...value, retry_after_ms: 1 });
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  f.state.mutate = value => value;
  const lease = await f.coordinator.begin(owner, 184, f.first, signal(), "learned");
  assert.equal(f.calls.at(-1)!.body.control_seq, 3);
  assert.equal(lease.expires_at, f.time.at + 15000);
});

it("a grant racing park cannot be reclaimed or turned into a fresh twenty seconds", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const r = f.records.values().next().value;
  r.state = "granted";
  r.held = 184;
  r.expires = f.time.at + 5000;
  await pending(f.coordinator.parkPending!(owner, signal()));
  const n = f.calls.length;
  await assert.rejects(
    f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    (e: any) => e.details?.reason_code === "READ_FRAME_IN_USE",
  );
  assert.equal(f.calls.length, n);
  f.time.at += 5000;
  await assert.rejects(f.coordinator.parkPending!(owner, signal()), {
    code: "VENUE_READ_DEADLINE",
  });
});

it("an END retry completing after caller abort cannot dispatch a later new begin", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const original = f.calls[0].body;
  f.state.mutate = (value) =>
    value.state === "closed" ? { ...value, control_applied: false } : value;
  await assert.rejects(f.coordinator.end(original.frame_id));
  f.state.mutate = (value) => value;
  let finish!: () => void;
  f.state.hook = (call, reply) =>
    call.path.endsWith("_end")
      ? new Promise((resolve) => {
          finish = () => resolve(Response.json(reply));
        })
      : undefined;
  const abort = new AbortController();
  const next = f.coordinator.begin(
    owner,
    184,
    f.first,
    abort.signal,
    "learned",
  );
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  finish();
  await assert.rejects(next);
  assert.equal(f.calls.filter((c) => c.path.endsWith("_begin")).length, 1);
});

it("new v2 tickets may start parked; strict pending proof never creates a financial lease", async (t) => {
  const f = fixture(t);
  f.state.grant = true;
  await pending(
    f.coordinator.begin(
      owner,
      184,
      f.first,
      signal(),
      "learned",
      undefined,
      false,
    ),
  );
  assert.equal(f.calls[0].body.ready, false);
  assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
  assert.equal(f.records.values().next().value.held, 0);
  await assert.rejects(f.coordinator.parkPending!(owner, AbortSignal.abort()));
  assert.equal(await f.coordinator.parkPending!(other, signal()), false);
});

it("an HTTP201 END preserves Gold's legacy rejection and cannot acknowledge a v2 fence", async (t) => {
  for (const enabled of [false, true]) {
    const f = fixture(t, enabled);
    await pending(
      f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    );
    f.state.hook = (call, reply) =>
      call.path.endsWith("_end")
        ? Response.json(reply, { status: 201 })
        : undefined;
    await assert.rejects(f.coordinator.end(f.calls[0].body.frame_id));
    f.state.hook = undefined;
  }
});

it("an existing ordinary pending ticket needs a park ACK before pre-PG local deferral", async (t) => {
  const f = fixture(t);
  await pending(f.coordinator.begin(owner, 184, f.first, signal(), "learned"));
  const budget = new VenueReadBudget({ clock: () => f.time.at });
  (budget as any).nextObservationAt = f.time.at + 17000;
  let loads = 0,
    wires = 0;
  const reads = new VenueReads(
    async () => {
      wires++;
      throw Error("no wire");
    },
    () => f.time.at,
    2,
    {
      budget,
      frameCoordinator: f.coordinator,
      transport: "core_shared_info",
      monotonicClock: () => f.time.at,
      observationPlans: {
        read: async () => {
          loads++;
          throw Error("preflight should precede PG");
        },
      } as any,
      report: () => {},
    },
  );
  t.after(() => reads.drainAccounts());
  await assert.rejects(
    reads.observeAccount(async () => {
      reads.bindAccountCostPlan(owner);
      await reads.read("https://api.hyperliquid.xyz/info", {
        type: "userAbstraction",
        user: "synthetic",
      });
    }, owner),
    (e: any) => e.details?.reason_code === "READ_LOCAL_PACING",
  );
  assert.equal(loads, 0);
  assert.equal(wires, 0);
  assert.equal(f.calls.at(-1)!.body.ready, false);
  assert.equal((budget as any).observationInterests.size, 0);
});

for (const seq of [0, FRAME_CONTROL_SEQ_MAX + 1, 1.5])
  it(`a wire sequence ${seq} cannot acknowledge a park`, async (t) => {
    const f = fixture(t);
    await pending(
      f.coordinator.begin(owner, 184, f.first, signal(), "learned"),
    );
    f.state.mutate = (value) => ({ ...value, control_seq: seq });
    await pending(f.coordinator.parkPending!(owner, signal()));
    f.state.mutate = (value) => value;
    assert.equal(await f.coordinator.parkPending!(owner, signal()), true);
    assert.equal(f.calls.at(-1)!.body.control_seq, 2);
  });

it("known readonly prepared pending parks only its bound pin; foreign pins cannot change it", async (t) => {
  const f = fixture(t);
  const budget = new VenueReadBudget({ clock: () => f.time.at });
  const plan = { demand: 184, peaks: [164] };
  budget.refreshObservationPlan(owner, plan, 600000);
  const reads = new VenueReads(
    async () => {
      throw Error("no provider");
    },
    () => f.time.at,
    2,
    {
      transport: "core_shared_info",
      budget,
      frameCoordinator: f.coordinator,
      monotonicClock: () => f.time.at,
      report: () => {},
      observationPlans: {
        read: async () => ({
          owner,
          generation: "1",
          remainingTtlMs: 600000,
          plan,
        }),
      } as any,
    },
  );
  t.after(() => reads.drainAccounts());
  const options = { purpose: "audit_source" as const };
  const error = await pending(
    reads.prepareAccountWindow(
      owner,
      other,
      f.first,
      undefined,
      signal(),
      options,
    ),
  );
  const pin = framePendingContinuation(error)!;
  budget.refreshObservationPlan("prior", plan, 600000);
  const active = budget.beginObservation("prior");
  const n = f.calls.length;
  await assert.rejects(
    reads.prepareAccountWindow(owner, other, f.first, {}, signal(), options),
  );
  assert.equal(f.calls.length, n);
  try {
    await assert.rejects(
      reads.prepareAccountWindow(owner, other, f.first, pin, signal(), options),
      (e: any) => e.details?.reason_code === "READ_LOCAL_BUSY",
    );
    assert.equal(f.calls.at(-1)!.body.control_seq, 2);
    assert.equal(f.calls.at(-1)!.body.ready, false);
    assert.equal(f.calls.at(-1)!.body.frame_id, f.calls[0].body.frame_id);
    assert.equal(f.calls.at(-1)!.body.deadline_ms, f.first);
  } finally {
    active.close(false);
  }
});
