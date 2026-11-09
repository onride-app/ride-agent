import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { submitObservationCancellation } from "./submit-observation-cancellation.js";

function fixture() {
  const req = Object.assign(new EventEmitter(), {
    aborted: false,
    body: { deadline_ms: Number.MAX_SAFE_INTEGER },
  });
  const res = Object.assign(new EventEmitter(), { writableEnded: false });
  let timer: (() => void) | undefined, delay: number | undefined;
  const call = submitObservationCancellation(
    req as unknown as Request,
    res as unknown as Response,
    () => 1700000000000,
    {
      setTimeout(run, ms) {
        timer = run;
        delay = ms;
        return 1;
      },
      clearTimeout() {
        timer = undefined;
      },
    },
  );
  return {
    req,
    res,
    call,
    delay,
    fire() {
      timer?.();
    },
    hasTimer: () => !!timer,
  };
}

it("uses a trusted20s cutoff rather than client data and does not cancel a normally received body", () => {
  const f = fixture();
  assert.equal(f.call.deadlineMs, 1700000020000);
  assert.equal(f.delay, 20000);
  f.req.emit("end");
  f.req.emit("close");
  assert.equal(f.call.signal.aborted, false);
  f.fire();
  assert.equal(f.call.signal.aborted, true);
  assert.equal(f.call.deadlineMs, 1700000020000);
  f.call.close();
});

it("cancels fresh read wait on request abort or unfinished response close", () => {
  for (const kind of ["aborted", "close"]) {
    const f = fixture();
    (kind === "aborted" ? f.req : f.res).emit(kind);
    assert.equal(f.call.signal.aborted, true);
    f.call.close();
    assert.equal(f.req.listenerCount("aborted"), 0);
    assert.equal(f.res.listenerCount("close"), 0);
    assert.equal(f.hasTimer(), false);
  }
});

it("a completed response and route cleanup do not cancel or retain timers", () => {
  const f = fixture();
  f.res.writableEnded = true;
  f.res.emit("close");
  assert.equal(f.call.signal.aborted, false);
  f.call.close();
  f.req.emit("aborted");
  f.fire();
  assert.equal(f.call.signal.aborted, false);
  assert.equal(f.hasTimer(), false);
});
