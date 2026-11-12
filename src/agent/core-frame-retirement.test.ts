import assert from "node:assert/strict";
import { it } from "node:test";
import { coreFrameCoordinator } from "./core-frame-coordinator.js";

const owner = "a".repeat(64), signal = () => new AbortController().signal;
const grant = (body: any, now = 1000) => Response.json({ state: "granted", frame_id: body.frame_id,
  reserved_weight: body.weight, expires_at: now + 20000, guaranteed_complete: false });
const closed = (body: any) => Response.json({ state: "closed", frame_id: body.frame_id });
function barrier<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 80; i++) await Promise.resolve(); }

it("only the exact live HTTP200 v1 grant lease may opt into retirement", async () => {
  for (const status of [200, 201]) {
    let now = 1000;
    const c = coreFrameCoordinator("https://core.fixture", "local", async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("_end")) return closed(body);
      const response = grant(body, now);
      return new Response(await response.text(), { status });
    }, () => now);
    const lease = await c.begin(owner, 184, 101000, signal(), "learned");
    assert.equal(c.retainGrantedLease?.({ ...lease }), false, "clone is not a capability");
    const id = lease.frame_id; lease.frame_id = "changed";
    assert.equal(c.retainGrantedLease?.(lease), false); lease.frame_id = id;
    assert.equal(c.retainGrantedLease?.(lease), status === 200);
    now = lease.expires_at;
    assert.equal(c.retainGrantedLease?.(lease), false, "expired lease cannot opt in");
    await c.end(id);
    assert.equal(c.retainGrantedLease?.(lease), false, "closed lease cannot brand a new frame");
    await c.close?.();
  }
});

it("one actual timed-out END stays retiring through FIRST, concurrent retry and a late old response", async () => {
  let now = 1000;
  const old = barrier<Response>(), calls: { end: boolean; body: any }[] = [];
  let endCount = 0;
  const c = coreFrameCoordinator("https://core.fixture", "local", async (url, init) => {
    const body = JSON.parse(String(init?.body)), end = String(url).endsWith("_end"); calls.push({ end, body });
    if (!end) return grant(body, now);
    if (++endCount === 1) return old.promise;
    return closed(body);
  }, () => now);
  const lease = await c.begin(owner, 184, 101000, signal(), "learned");
  assert.equal(c.retainGrantedLease?.(lease), true);
  const ending = c.end(lease.frame_id), duplicate = c.end(lease.frame_id);
  const keepAlive = setTimeout(() => {}, 2500); // AbortSignal.timeout is unref'ed.
  try { await Promise.all([assert.rejects(ending), assert.rejects(duplicate)]); }
  finally { clearTimeout(keepAlive); }
  assert.equal(endCount, 1, "concurrent callers share one bounded local END attempt");
  now = 150000;
  const next = await c.begin(owner, 184, 250000, signal(), "learned");
  assert.equal(calls[2].end, true); assert.deepEqual(calls[2].body, calls[1].body);
  assert.equal(calls[0].body.deadline_ms, 101000);
  assert.notEqual(next.frame_id, lease.frame_id, "only positive original END permits an independent episode");
  old.resolve(closed(calls[1].body)); await flush();
  await c.end(next.frame_id);
  assert.equal(calls.at(-1)!.body.frame_id, next.frame_id, "late old ACK cannot delete its successor");
  await c.close?.();
});

for (const failure of ["transport", "json", "abort"] as const)
  it(`a ${failure} unknown BEGIN cannot acquire a retirement brand after a later positive same-ID grant`, async () => {
    const first = barrier<Response>(), bodies: any[] = [];
    let attempt = 0;
    const c = coreFrameCoordinator("https://core.fixture", "local", async (url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body);
      if (String(url).endsWith("_end")) return closed(body);
      if (++attempt === 1) {
        if (failure === "transport") throw new Error("Controlled unknown BEGIN");
        if (failure === "json") return new Response("not-json");
        return first.promise;
      }
      return grant(body);
    }, () => 1000);
    const caller = new AbortController();
    const pending = assert.rejects(c.begin(owner, 184, 101000, caller.signal, "learned"));
    if (failure === "abort") { await flush(); caller.abort(new Error("caller ended")); }
    await pending;
    const lease = await c.begin(owner, 184, 101000, signal(), "learned");
    assert.equal(bodies[1].frame_id, bodies[0].frame_id); assert.equal(bodies[1].deadline_ms, bodies[0].deadline_ms);
    assert.equal(c.retainGrantedLease?.(lease), false);
    first.resolve(grant(bodies[0])); await flush();
    assert.equal(bodies.length, 2, "late old grant cannot mint a new END or BEGIN");
    await c.close?.();
  });

it("64 failed v1 ENDs remain bounded without V2, reject new owners, and close retries exact IDs once without a busy loop", async () => {
  const begins: any[] = [], ends: any[] = [];
  let fail = true;
  const c = coreFrameCoordinator("https://core.fixture", "local", async (url, init) => {
    const body = JSON.parse(String(init?.body));
    if (!String(url).endsWith("_end")) { begins.push(body); return grant(body); }
    ends.push(body); if (fail) throw new Error("Controlled END unknown"); return closed(body);
  }, () => 1000);
  for (let n = 0; n < 64; n++) {
    const lease = await c.begin(n.toString(16).padStart(64, "0"), 184, 101000, signal(), "learned");
    assert.equal(c.retainGrantedLease?.(lease), true); await assert.rejects(c.end(lease.frame_id));
  }
  await assert.rejects(c.begin(owner, 184, 101000, signal(), "learned"), (e: any) => e.details?.reason_code === "READ_FRAME_QUEUE_FULL");
  assert.equal(begins.length, 64);
  await c.close?.(); assert.equal(ends.length, 128, "one exact retry per retiring frame, not an endless drain");
  assert.equal(new Set(ends.map(b => b.frame_id)).size, 64);
  await assert.rejects(c.begin(owner, 184, 101000, signal(), "learned"));
  fail = false; await c.close?.(); assert.equal(ends.length, 192, "later explicit cleanup can still confirm every original ID");
});

it("verified partial pending can later opt into its original granted lease without changing FIRST", async () => {
  const bodies: any[] = []; let pending = true;
  const c = coreFrameCoordinator("https://core.fixture", "local", async (url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body);
    if (String(url).endsWith("_end")) return closed(body);
    return pending ? Response.json({ state: "pending", frame_id: body.frame_id, reserved_weight: 71,
      expires_at: body.deadline_ms, retry_after_ms: 1000 }) : grant(body);
  }, () => 1000);
  await assert.rejects(c.begin(owner, 184, 101000, signal(), "learned")); pending = false;
  const lease = await c.begin(owner, 184, 101000, signal(), "learned");
  assert.equal(bodies[0].frame_id, bodies[1].frame_id); assert.equal(bodies[0].deadline_ms, bodies[1].deadline_ms);
  assert.equal(c.retainGrantedLease?.(lease), true); await c.end(lease.frame_id); await c.close?.();
});
