import assert from "node:assert/strict";
import { it } from "node:test";
import { registerPreparedPromotion, type PreparedPromotionRegistration } from "./prepared-promotion-arbiter.js";

async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
const unavailable = (error: any) => error?.code === "VENUE_COST_PLAN_UNAVAILABLE";
function fixture() {
  const bank = {}, state = { wall: 1_000_000, mono: 1000 }, entries: PreparedPromotionRegistration[] = [];
  const add = (offset: number, extra: Partial<Parameters<typeof registerPreparedPromotion>[1]> = {}, key = bank) => {
    const registration = registerPreparedPromotion(key, {
      firstDeadline: state.wall + offset, wallUntil: state.wall + 20000,
      monoUntil: state.mono + 20000, wallClock: () => state.wall,
      monoClock: () => state.mono, signal: new AbortController().signal,
      eligible: () => true, ...extra,
    });
    entries.push(registration); return registration;
  };
  return { bank, state, add, close: () => entries.forEach(entry => entry.close()) };
}

it("an older active validation blocks a faster younger peer without owning a turn", async () => {
  const f = fixture();
  try {
    const old = f.add(50000), young = f.add(60000); young.markValidated();
    let promoted = false;
    const younger = young.acquire().then(turn => { promoted = true; return turn; });
    await flush(); assert.equal(promoted, false);
    old.markValidated(); const first = await old.acquire();
    await flush(); assert.equal(first.live(), true); assert.equal(promoted, false);
    first.release(); const second = await younger; assert.equal(second.live(), true); second.release();
  } finally { f.close(); }
});

it("ineligible old metadata does not block and different physical bank objects are independent", async () => {
  const f = fixture();
  try {
    const old = f.add(40000, { eligible: () => false });
    const young = f.add(50000); young.markValidated(); const first = await young.acquire();
    old.markValidated(); await assert.rejects(old.acquire(), unavailable);
    const other = f.add(40000, {}, {}); other.markValidated();
    const second = await other.acquire(); assert.equal(first.live(), true); assert.equal(second.live(), true);
    first.release(); second.release();
  } finally { f.close(); }
});

it("a held turn remains live when its own Core polling changes pure eligibility", async () => {
  const f = fixture(); let ready = true;
  try {
    const old = f.add(40000, { eligible: () => ready }); old.markValidated(); const turn = await old.acquire();
    ready = false; assert.equal(turn.live(), true);
    const young = f.add(50000, { eligible: () => ready }); young.markValidated();
    await assert.rejects(young.acquire(), unavailable);
    assert.equal(turn.live(), true); turn.release(); assert.equal(turn.live(), false);
  } finally { f.close(); }
});

it("close revokes the exact turn and a late release cannot unlock its successor", async () => {
  const f = fixture();
  try {
    const old = f.add(40000), next = f.add(50000), last = f.add(60000);
    for (const entry of [old, next, last]) entry.markValidated();
    const first = await old.acquire(), waiting = next.acquire();
    old.close(); const second = await waiting;
    let thirdStarted = false; const thirdWork = last.acquire().then(turn => { thirdStarted = true; return turn; });
    first.release(); await flush();
    assert.equal(first.live(), false); assert.equal(second.live(), true); assert.equal(thirdStarted, false);
    second.release(); const third = await thirdWork; assert.equal(third.live(), true); third.release();
  } finally { f.close(); }
});

it("wall, monotonic and original FIRST expiry independently revoke late turns", async () => {
  for (const which of ["wall", "mono", "first"] as const) {
    const f = fixture();
    try {
      const old = f.add(which === "first" ? 10 : 40000, which === "wall" ? { wallUntil: f.state.wall + 10 } : which === "mono" ? { monoUntil: f.state.mono + 10 } : {});
      const next = f.add(50000); old.markValidated(); next.markValidated();
      const first = await old.acquire(), waiting = next.acquire();
      if (which === "mono") f.state.mono += 11; else f.state.wall += 11;
      assert.equal(first.live(), false); assert.equal(old.live(), false);
      const second = await waiting; first.release(); assert.equal(second.live(), true); second.release();
    } finally { f.close(); }
  }
});

it("abort and close reject waiting validation peers and release a live owner", async () => {
  const f = fixture(), stop = new AbortController();
  try {
    const old = f.add(40000), next = f.add(50000, { signal: stop.signal }); next.markValidated();
    const rejected = assert.rejects(next.acquire(), unavailable); stop.abort(); await rejected;
    old.close(); const ownerStop = new AbortController();
    const owner = f.add(60000, { signal: ownerStop.signal }); owner.markValidated(); const turn = await owner.acquire();
    ownerStop.abort(); assert.equal(turn.live(), false); assert.equal(owner.live(), false);
  } finally { f.close(); }
});

it("the active metadata cap is64 and expired entries are pruned before the next registration", () => {
  const f = fixture();
  try {
    for (let n = 0; n < 64; n++) f.add(50000, { eligible: () => false });
    assert.throws(() => f.add(50000), unavailable);
    f.state.wall += 20001; f.state.mono += 20001;
    const replacement = f.add(50000); assert.equal(replacement.live(), true);
  } finally { f.close(); }
});

it("the64th slot is reserved before reentrant clocks and failed registrations release it exactly", () => {
  for (const clock of ["wallClock", "monoClock"] as const) {
    const f = fixture();
    try {
      for (let n = 0; n < 63; n++) f.add(50000, { eligible: () => false });
      let attempted = false, innerRejected = false;
      const callback = () => {
        if (!attempted) {
          attempted = true;
          try { f.add(50000); } catch (error) { innerRejected = unavailable(error); }
        }
        return clock === "wallClock" ? f.state.wall : f.state.mono;
      };
      const outer = f.add(50000, { [clock]: callback });
      assert.equal(outer.live(), true); assert.equal(attempted, true); assert.equal(innerRejected, true);
      assert.throws(() => f.add(50000), unavailable);
      outer.close();
      const invalid = [
        { firstDeadline: Number.NaN },
        { signal: AbortSignal.abort() },
        { wallClock: () => { throw new Error("controlled clock failure"); } },
      ];
      for (const options of invalid) {
        assert.throws(() => f.add(50000, options), unavailable);
        const replacement = f.add(50000); assert.equal(replacement.live(), true); replacement.close();
      }
    } finally { f.close(); }
  }
});

it("eligibility exceptions fail closed without preventing another current candidate", async () => {
  const f = fixture();
  try {
    const broken = f.add(40000, { eligible: () => { throw new Error("local pure projection failed"); } });
    assert.equal(broken.live(), false);
    const next = f.add(50000); next.markValidated(); const turn = await next.acquire();
    assert.equal(turn.live(), true); turn.release();
  } finally { f.close(); }
});

it("native scope expiry wakes a waiter even before any VenueReads timer exists", async () => {
  const bank = {}, now = Date.now(), mono = performance.now(), signal = new AbortController().signal;
  const old = registerPreparedPromotion(bank, { firstDeadline: now + 1000, wallUntil: now + 35, monoUntil: mono + 35,
    wallClock: Date.now, monoClock: () => performance.now(), signal, eligible: () => true });
  const next = registerPreparedPromotion(bank, { firstDeadline: now + 2000, wallUntil: now + 2000, monoUntil: mono + 2000,
    wallClock: Date.now, monoClock: () => performance.now(), signal, eligible: () => true });
  try {
    next.markValidated(); const turn = await next.acquire();
    assert.equal(old.live(), false); assert.equal(turn.live(), true); turn.release();
  } finally { old.close(); next.close(); }
});
