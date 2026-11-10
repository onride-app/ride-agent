import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import { submitObservationCancellation } from "./submit-observation-cancellation.js";
import {
  registerFreshSubmitReadCaller,
  registerFreshSubmitReadIssuer,
  revokeFreshSubmitReadCaller,
  issueFreshSubmitReadPurpose,
  attachFreshSubmitReadPurpose,
  bindFreshSubmitReadOwner,
  assertFreshSubmitReadPurpose,
  freshSubmitPacingPermit,
  assertFreshSubmitPacingPermit,
  revokeFreshSubmitReadPurpose,
} from "./fresh-submit-read-purpose.js";

function fixture() {
  let wall = 100000,
    mono = 1000,
    current = true,
    scopeAlive = true;
  const context = { issuer: {}, reader: {}, budget: {} },
    scope = {},
    interest = {};
  registerFreshSubmitReadIssuer(context);
  const controller = new AbortController();
  const caller = registerFreshSubmitReadCaller(
    { signal: controller.signal, deadlineMs: wall + 20000 },
    () => wall,
    () => mono,
  );
  const facts = {
    user: "user",
    portfolio: "portfolio",
    account: "account",
    revision: 1,
    control: "control",
    execution: "execution",
    fingerprint: "a".repeat(64),
    expiresAt: wall + 60000,
    currentBinding: "b".repeat(64),
  };
  const purpose = issueFreshSubmitReadPurpose(
    context,
    facts,
    caller,
    () => current,
  )!;
  const attach = () =>
    attachFreshSubmitReadPurpose(
      purpose,
      context.reader,
      context.budget,
      scope,
      caller.signal,
      caller.deadlineMs,
      () => scopeAlive,
    );
  const bind = () =>
    bindFreshSubmitReadOwner(
      purpose,
      context.reader,
      context.budget,
      scope,
      "c".repeat(64),
    );
  const permit = () =>
    freshSubmitPacingPermit(
      purpose,
      context.reader,
      context.budget,
      scope,
      "c".repeat(64),
      interest,
    );
  return {
    context,
    scope,
    interest,
    controller,
    caller,
    facts,
    purpose,
    attach,
    bind,
    permit,
    wall: (value: number) => {
      wall = value;
    },
    mono: (value: number) => {
      mono = value;
    },
    current: (value: boolean) => {
      current = value;
    },
    alive: (value: boolean) => {
      scopeAlive = value;
    },
  };
}
it("a registered original server caller is required; JSON and copied signal/deadline confer no purpose", () => {
  const f = fixture();
  assert.throws(() =>
    issueFreshSubmitReadPurpose(
      { ...f.context, issuer: {} },
      f.facts,
      f.caller,
      () => true,
    ),
  );
  assert.throws(() =>
    registerFreshSubmitReadIssuer({ ...f.context, issuer: {} }),
  );
  for (const caller of [
    { ...f.caller },
    JSON.parse(JSON.stringify(f.caller)),
    {},
  ])
    assert.equal(
      issueFreshSubmitReadPurpose(f.context, f.facts, caller, () => true),
      undefined,
    );
  assert.equal(Object.isFrozen(f.purpose), true);
  assert.equal(Object.getPrototypeOf(f.purpose), null);
  assert.deepEqual(Object.keys(f.purpose), []);
  assert.throws(() =>
    issueFreshSubmitReadPurpose(f.context, f.facts, f.caller, () => true),
  );
  for (const token of [
    {},
    { ...f.purpose },
    JSON.parse(JSON.stringify(f.purpose)),
  ])
    assert.throws(() =>
      attachFreshSubmitReadPurpose(
        token,
        f.context.reader,
        f.context.budget,
        f.scope,
        f.caller.signal,
        f.caller.deadlineMs,
        () => true,
      ),
    );
});
it("single observation and exact reader/budget/scope/owner/interest are runtime bound; wrong attempts do not consume the valid permit", () => {
  const f = fixture();
  for (const [reader, budget, scope, signal, deadline] of [
    [{}, f.context.budget, f.scope, f.caller.signal, f.caller.deadlineMs],
    [f.context.reader, {}, f.scope, f.caller.signal, f.caller.deadlineMs],
    [
      f.context.reader,
      f.context.budget,
      f.scope,
      new AbortController().signal,
      f.caller.deadlineMs,
    ],
    [
      f.context.reader,
      f.context.budget,
      f.scope,
      f.caller.signal,
      f.caller.deadlineMs + 1,
    ],
  ] as const)
    assert.throws(() =>
      attachFreshSubmitReadPurpose(
        f.purpose,
        reader,
        budget,
        scope,
        signal,
        deadline,
        () => true,
      ),
    );
  assert.equal(f.attach(), 20000);
  assert.throws(f.attach);
  f.bind();
  assert.throws(f.bind);
  assert.throws(() =>
    freshSubmitPacingPermit(
      f.purpose,
      f.context.reader,
      f.context.budget,
      {},
      "c".repeat(64),
      f.interest,
    ),
  );
  const permit = f.permit();
  for (const [token, budget, owner, interest] of [
    [{}, f.context.budget, "c".repeat(64), f.interest],
    [permit, {}, "c".repeat(64), f.interest],
    [permit, f.context.budget, "d".repeat(64), f.interest],
    [permit, f.context.budget, "c".repeat(64), {}],
  ] as const)
    assert.throws(() =>
      assertFreshSubmitPacingPermit(token, budget, owner, interest, true),
    );
  assertFreshSubmitPacingPermit(
    permit,
    f.context.budget,
    "c".repeat(64),
    f.interest,
    true,
  );
  assert.throws(() =>
    assertFreshSubmitPacingPermit(
      permit,
      f.context.budget,
      "c".repeat(64),
      f.interest,
      true,
    ),
  );
  assert.throws(f.permit);
  assertFreshSubmitReadPurpose(
    f.purpose,
    f.context.reader,
    f.context.budget,
    f.scope,
    "c".repeat(64),
  );
  revokeFreshSubmitReadPurpose(f.purpose);
  assert.throws(() =>
    assertFreshSubmitReadPurpose(
      f.purpose,
      f.context.reader,
      f.context.budget,
      f.scope,
      "c".repeat(64),
    ),
  );
});
for (const invalidation of [
  "wall",
  "mono",
  "caller-close",
  "abort",
  "binding",
  "scope",
  "caller-mutation",
] as const)
  it(`original ${invalidation} invalidation cannot resurrect a single-scope purpose`, () => {
    const f = fixture();
    f.attach();
    f.bind();
    const permit = f.permit();
    switch (invalidation) {
      case "wall":
        f.wall(120000);
        break;
      case "mono":
        f.wall(0);
        f.mono(21000);
        break;
      case "caller-close":
        revokeFreshSubmitReadCaller(f.caller);
        break;
      case "abort":
        f.controller.abort();
        break;
      case "binding":
        f.current(false);
        break;
      case "scope":
        f.alive(false);
        break;
      case "caller-mutation":
        f.caller.deadlineMs++;
        break;
    }
    assert.throws(() =>
      assertFreshSubmitPacingPermit(
        permit,
        f.context.budget,
        "c".repeat(64),
        f.interest,
      ),
    );
  });
it("the actual cancellation helper preserves original fields/timer/listeners and closes trust without cancelling accepted work", () => {
  const req = Object.assign(new EventEmitter(), { aborted: false }),
    res = Object.assign(new EventEmitter(), { writableEnded: false });
  const timers = new Map<object, () => void>();
  let delay = 0;
  const caller = submitObservationCancellation(
    req as any,
    res as any,
    () => 100000,
    {
      setTimeout(run, ms) {
        delay = ms;
        const token = {};
        timers.set(token, run);
        return token;
      },
      clearTimeout(token) {
        timers.delete(token as object);
      },
    },
    () => 1000,
  );
  assert.equal(delay, 20000);
  assert.deepEqual(Object.keys(caller).sort(), [
    "close",
    "deadlineMs",
    "signal",
  ]);
  assert.equal(req.listenerCount("aborted"), 1);
  assert.equal(res.listenerCount("close"), 1);
  caller.close();
  assert.equal(caller.signal.aborted, false);
  assert.equal(timers.size, 0);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
  const f = fixture();
  assert.equal(
    issueFreshSubmitReadPurpose(f.context, f.facts, caller, () => true),
    undefined,
  );
});
it("wall rollback during caller creation and already expired registration do not break existing outbox callers or leak listeners", () => {
  let at = 100000,
    reads = 0;
  const req = Object.assign(new EventEmitter(), { aborted: false }),
    res = Object.assign(new EventEmitter(), { writableEnded: false }),
    timers = new Set<object>();
  const caller = submitObservationCancellation(
    req as any,
    res as any,
    () => {
      reads++;
      return reads === 1 ? at : at - 1;
    },
    {
      setTimeout(_run, ms) {
        assert.equal(ms, 20000);
        const token = {};
        timers.add(token);
        return token;
      },
      clearTimeout(token) {
        timers.delete(token as object);
      },
    },
    () => 1000,
  );
  assert.equal(caller.deadlineMs, 120000);
  assert.equal(caller.signal.aborted, false);
  const f = fixture();
  const expired = { signal: new AbortController().signal, deadlineMs: 1 };
  assert.equal(
    registerFreshSubmitReadCaller(
      expired,
      () => 100000,
      () => 1000,
    ),
    expired,
  );
  assert.equal(
    issueFreshSubmitReadPurpose(f.context, f.facts, expired, () => true),
    undefined,
  );
  at = 200000;
  // A saved outbox response never consumes a fresh-read purpose. Closing the
  // old HTTP lifetime only removes its hooks; it does not abort that action.
  caller.close();
  assert.equal(caller.signal.aborted, false);
  assert.equal(timers.size, 0);
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(res.listenerCount("close"), 0);
});
it("caller registration is single-use, including after close; registering again cannot renew the original monotonic deadline", () => {
  const f = fixture();
  f.mono(21000);
  f.wall(0);
  registerFreshSubmitReadCaller(
    f.caller,
    () => 0,
    () => 0,
  );
  assert.throws(f.attach);
  revokeFreshSubmitReadCaller(f.caller);
  registerFreshSubmitReadCaller(
    f.caller,
    () => 100000,
    () => 1000,
  );
  assert.equal(
    issueFreshSubmitReadPurpose(f.context, f.facts, f.caller, () => true),
    undefined,
  );
});
