import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";

const owner = "a".repeat(64);
const signal = () => new AbortController().signal;
type Call = { path: string; body: any; signal?: AbortSignal | null };

function fixture() {
  const time = { at: 1000 };
  const calls: Call[] = [];
  let grant = false;
  let unverifiedFailure = false;
  let mutate: (value: any) => any = (value) => value;
  let mutateEnd: (value: any) => any = (value) => value;
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body));
    calls.push({ path, body, signal: init?.signal });
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer fixture-core-token",
    );
    assert.equal(init?.redirect, "error");
    if (path.endsWith("_end"))
      return Response.json(
        mutateEnd({ state: "closed", frame_id: body.frame_id }),
      );
    if (unverifiedFailure) {
      unverifiedFailure = false;
      throw new Error("fixture transport interruption");
    }
    return Response.json(
      mutate({
        state: grant ? "granted" : "pending",
        frame_id: body.frame_id,
        expires_at: time.at + 20000,
        retry_after_ms: 1000,
        reserved_weight: grant ? body.weight : Math.min(250, body.weight),
        guaranteed_complete: body.mode !== "cold_trial",
      }),
    );
  };
  const coordinator = coreFrameCoordinator(
    "https://core.test/original-owner-path",
    "fixture-core-token",
    request,
    () => time.at,
  );
  return {
    time,
    calls,
    coordinator,
    grant: () => {
      grant = true;
    },
    fail: () => {
      unverifiedFailure = true;
    },
    mutate: (fn: typeof mutate) => {
      mutate = fn;
    },
    mutateEnd: (fn: typeof mutateEnd) => {
      mutateEnd = fn;
    },
  };
}

async function pending(work: Promise<unknown>, retry = 1000) {
  await assert.rejects(work, (error) => {
    assert.ok(error instanceof AgentError);
    assert.equal(error.code, "VENUE_READ_BUDGET_EXHAUSTED");
    assert.equal(error.details?.reason_code, "READ_FRAME_PENDING");
    assert.equal(error.details?.retry_after_ms, retry);
    return true;
  });
}

it("polls one stable FIFO frame without renewing its first queue deadline or ending it on a normal account-attempt abort", async () => {
  const f = fixture();
  const first = new AbortController();
  try {
    await pending(
      f.coordinator.begin(owner, 900, 101000, first.signal, "cold_trial"),
    );
    first.abort();
    assert.equal(
      f.calls.length,
      1,
      "a normal callback finally must not erase the funded queue head",
    );
    f.time.at += 5000;
    await pending(
      f.coordinator.begin(owner, 900, 106000, signal(), "cold_trial"),
    );
    assert.equal(
      f.calls.length,
      2,
      "one poll per retry, no internal busy loop",
    );
    assert.equal(f.calls[1].body.frame_id, f.calls[0].body.frame_id);
    assert.equal(f.calls[1].body.deadline_ms, 101000);
    assert.equal(f.calls[1].body.weight, 900);
    assert.equal(f.calls[1].body.mode, "cold_trial");
    f.time.at = 61000;
    f.grant();
    const lease = await f.coordinator.begin(
      owner,
      900,
      161000,
      signal(),
      "cold_trial",
    );
    assert.equal(lease.frame_id, f.calls[0].body.frame_id);
    assert.equal(lease.expires_at, 81000);
    await f.coordinator.end(lease.frame_id);
    const end = f.calls.at(-1)!;
    assert.ok(end.path.endsWith("_end"));
    assert.deepEqual(end.body, { frame_id: lease.frame_id, owner });
    await f.coordinator.end(lease.frame_id);
    assert.equal(
      f.calls.length,
      4,
      "ending an already released frame is idempotent locally",
    );
  } finally {
    await f.coordinator.close?.();
  }
});

it("retains an unknown admission request's client identity instead of allocating a second booking", async () => {
  const f = fixture();
  try {
    f.fail();
    await assert.rejects(
      f.coordinator.begin(owner, 200, 101000, signal(), "learned"),
    );
    await pending(f.coordinator.begin(owner, 200, 101000, signal(), "learned"));
    assert.equal(f.calls[0].body.frame_id, f.calls[1].body.frame_id);
  } finally {
    await f.coordinator.close?.();
  }
});

it("does not share an active lease with a concurrent account frame", async () => {
  const f = fixture();
  try {
    f.grant();
    const lease = await f.coordinator.begin(
      owner,
      200,
      101000,
      signal(),
      "learned",
    );
    await pending(
      f.coordinator.begin(owner, 200, 101000, signal(), "learned"),
      250,
    );
    assert.equal(f.calls.length, 1);
    await f.coordinator.end(lease.frame_id);
  } finally {
    await f.coordinator.close?.();
  }
});

for (const kind of [
  "foreign-frame",
  "invalid-owner-state",
  "missing-state",
] as const)
  it(`does not claim a release from a ${kind} HTTP200 receipt`, async () => {
    const f = fixture();
    f.grant();
    try {
      const lease = await f.coordinator.begin(
        owner,
        200,
        101000,
        signal(),
        "learned",
      );
      f.mutateEnd((body) => {
        if (kind === "foreign-frame") body.frame_id = "b".repeat(36);
        if (kind === "invalid-owner-state") body.state = "invalid";
        if (kind === "missing-state") delete body.state;
        return body;
      });
      await assert.rejects(
        f.coordinator.end(lease.frame_id),
        (error) =>
          error instanceof AgentError &&
          error.code === "VENUE_COST_PLAN_UNAVAILABLE",
      );
      assert.equal(
        f.calls.filter((call) => call.path.endsWith("_end")).length,
        1,
        "an unverified release never authorizes trying a different owner or token",
      );
    } finally {
      await f.coordinator.close?.();
    }
  });

it("reports the original queue deadline instead of silently renewing a pending episode", async () => {
  const f = fixture();
  try {
    await pending(
      f.coordinator.begin(owner, 900, 101000, signal(), "cold_trial"),
    );
    f.time.at = 101000;
    await assert.rejects(
      f.coordinator.begin(owner, 900, 201000, signal(), "cold_trial"),
      (error) =>
        error instanceof AgentError && error.code === "VENUE_READ_DEADLINE",
    );
    assert.equal(
      f.calls.filter((call) => call.path.endsWith("_begin")).length,
      1,
    );
    assert.equal(
      f.calls.filter((call) => call.path.endsWith("_end")).length,
      1,
    );
  } finally {
    await f.coordinator.close?.();
  }
});

it("treats an existing-owner busy receipt as a bounded retry without claiming a grant", async () => {
  const f = fixture();
  f.mutate((body) => ({
    ...body,
    state: "busy",
    retry_after_ms: 10,
    reserved_weight: 0,
  }));
  try {
    await pending(
      f.coordinator.begin(owner, 900, 101000, signal(), "cold_trial"),
      250,
    );
  } finally {
    await f.coordinator.close?.();
  }
});

it("retires a cancelled Core frame instead of polling a tombstoned identifier forever", async () => {
  const f = fixture();
  f.mutate((body) => ({ ...body, state: "cancelled", reserved_weight: 0 }));
  try {
    await assert.rejects(
      f.coordinator.begin(owner, 900, 101000, signal(), "cold_trial"),
      (error) =>
        error instanceof AgentError && error.code === "VENUE_READ_DEADLINE",
    );
    f.mutate((body) => body);
    await pending(
      f.coordinator.begin(owner, 900, 101000, signal(), "cold_trial"),
    );
    assert.notEqual(f.calls[0].body.frame_id, f.calls[1].body.frame_id);
  } finally {
    await f.coordinator.close?.();
  }
});

for (const kind of [
  "foreign-id",
  "short-reservation",
  "trial-guarantee",
  "expired",
  "renewed-active-ttl",
] as const)
  it(`rejects an unverified ${kind} grant without treating it as fresh evidence`, async () => {
    const f = fixture();
    f.grant();
    f.mutate((body) => {
      if (kind === "foreign-id") body.frame_id = "b".repeat(36);
      if (kind === "short-reservation") body.reserved_weight--;
      if (kind === "trial-guarantee") body.guaranteed_complete = true;
      if (kind === "expired") body.expires_at = f.time.at;
      if (kind === "renewed-active-ttl") body.expires_at = f.time.at + 20001;
      return body;
    });
    try {
      await assert.rejects(
        f.coordinator.begin(owner, 900, 101000, signal(), "cold_trial"),
        (error) =>
          error instanceof AgentError &&
          error.code === "VENUE_COST_PLAN_UNAVAILABLE",
      );
    } finally {
      await f.coordinator.close?.();
    }
  });

it("bounds queued owners and drains pending reservations without retaining user payloads", async () => {
  const f = fixture();
  try {
    for (let n = 1; n <= 64; n++)
      await pending(
        f.coordinator.begin(
          n.toString(16).padStart(64, "0"),
          900,
          101000,
          signal(),
          "cold_trial",
        ),
      );
    await pending(
      f.coordinator.begin("f".repeat(64), 900, 101000, signal(), "cold_trial"),
    );
    assert.equal(f.calls.length, 64);
    await f.coordinator.close?.();
    assert.equal(
      f.calls.filter((call) => call.path.endsWith("_end")).length,
      64,
    );
    await assert.rejects(
      f.coordinator.begin(owner, 900, 101000, signal(), "cold_trial"),
    );
  } finally {
    await f.coordinator.close?.();
  }
});
