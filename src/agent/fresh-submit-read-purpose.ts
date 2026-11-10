import { costPlanUnavailable } from "./account-observation-plans.js";

/** Runtime-only scheduling capabilities. None of these objects is wire data. */
export type FreshSubmitReadPurpose = Readonly<object>;
export type FreshSubmitPacingPermit = Readonly<object>;
export type FreshSubmitReadBinding = Readonly<{
  user: string;
  portfolio: string;
  account: string;
  revision: number;
  control: string;
  execution: string;
  fingerprint: string;
  expiresAt: number;
  currentBinding: string;
}>;
type Caller = { signal: AbortSignal; deadlineMs: number };
type CallerState = Caller & {
  clock(): number;
  monotonicClock(): number;
  monotonicUntil: number;
  purposeIssued: boolean;
};
type Context = { issuer: object; reader: object; budget: object };
type Purpose = Context & {
  binding: FreshSubmitReadBinding;
  caller: object;
  lifetime: CallerState;
  until: number;
  monotonicUntil: number;
  validate(): boolean;
  phase: "issued" | "active" | "admitted" | "closed";
  scope?: object;
  owner?: string;
  scopeAlive?: () => boolean;
};
const callers = new WeakMap<object, CallerState>();
const seenCallers = new WeakSet<object>();
const readers = new WeakMap<object, { issuer: object; budget: object }>();
const purposes = new WeakMap<object, Purpose>();
const permits = new WeakMap<
  object,
  {
    purpose: Purpose;
    scope: object;
    owner: string;
    interest: object;
    used: boolean;
  }
>();
export function registerFreshSubmitReadIssuer(context: Context): void {
  const prior = readers.get(context.reader);
  if (
    prior &&
    (prior.issuer !== context.issuer || prior.budget !== context.budget)
  )
    throw costPlanUnavailable();
  readers.set(context.reader, {
    issuer: context.issuer,
    budget: context.budget,
  });
}
function trustedContext(context: Context): void {
  const registered = readers.get(context.reader);
  if (
    !registered ||
    registered.issuer !== context.issuer ||
    registered.budget !== context.budget
  )
    throw costPlanUnavailable();
}

/** Called only where the existing server-owned 20s timer is created. */
export function registerFreshSubmitReadCaller<T extends Caller>(
  caller: T,
  clock: () => number,
  monotonicClock: () => number,
  started?: { wall: number; monotonic: number },
): T {
  if (seenCallers.has(caller)) return caller;
  seenCallers.add(caller);
  const remaining = caller.deadlineMs - (started?.wall ?? clock());
  if (
    !Number.isSafeInteger(caller.deadlineMs) ||
    remaining <= 0 ||
    remaining > 20000
  )
    return caller;
  const monotonicUntil = (started?.monotonic ?? monotonicClock()) + remaining;
  if (!Number.isFinite(monotonicUntil)) return caller;
  callers.set(caller, {
    signal: caller.signal,
    deadlineMs: caller.deadlineMs,
    clock,
    monotonicClock,
    monotonicUntil,
    purposeIssued: false,
  });
  return caller;
}
export function revokeFreshSubmitReadCaller(caller: object): void {
  callers.delete(caller);
}
export function hasFreshSubmitReadCaller(caller: object): boolean {
  return callers.has(caller);
}

/** The reader must first check this issuer is its actual bridge instance. */
export function issueFreshSubmitReadPurpose(
  context: Context,
  binding: FreshSubmitReadBinding,
  caller: object,
  validate: () => boolean,
): FreshSubmitReadPurpose | undefined {
  trustedContext(context);
  const lifetime = callers.get(caller);
  // Unbranded internal callers retain the original scheduling policy.
  if (!lifetime) return undefined;
  if (lifetime.purposeIssued) throw costPlanUnavailable();
  const input = caller as Caller;
  if (
    input.signal !== lifetime.signal ||
    input.deadlineMs !== lifetime.deadlineMs
  )
    throw costPlanUnavailable();
  if (
    ![
      binding.user,
      binding.portfolio,
      binding.account,
      binding.execution,
    ].every((value) => typeof value === "string" && value.length > 0) ||
    typeof binding.control !== "string" ||
    !Number.isSafeInteger(binding.revision) ||
    !Number.isSafeInteger(binding.expiresAt) ||
    !/^[0-9a-f]{64}$/.test(binding.fingerprint) ||
    !/^[0-9a-f]{64}$/.test(binding.currentBinding)
  )
    throw costPlanUnavailable();
  const token = Object.freeze(Object.create(null)) as object;
  const until = Math.min(binding.expiresAt, lifetime.deadlineMs);
  const state: Purpose = {
    ...context,
    binding: Object.freeze({ ...binding }),
    caller,
    lifetime,
    until,
    monotonicUntil: Math.min(
      lifetime.monotonicUntil,
      lifetime.monotonicClock() + Math.max(0, until - lifetime.clock()),
    ),
    validate,
    phase: "issued",
  };
  // One original HTTP caller may authorize one A observation, not an issuer
  // loop that mints fresh scheduling capabilities until its timer expires.
  lifetime.purposeIssued = true;
  purposes.set(token, state);
  live(state);
  return token;
}
function live(state: Purpose): number {
  const { lifetime } = state;
  if (
    state.phase === "closed" ||
    callers.get(state.caller) !== lifetime ||
    (state.caller as Caller).signal !== lifetime.signal ||
    (state.caller as Caller).deadlineMs !== lifetime.deadlineMs ||
    lifetime.signal.aborted ||
    state.validate() !== true ||
    (state.scopeAlive && !state.scopeAlive())
  )
    throw costPlanUnavailable();
  const remaining = Math.min(
    state.until - lifetime.clock(),
    state.monotonicUntil - lifetime.monotonicClock(),
  );
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw costPlanUnavailable();
  return remaining;
}
function matching(token: object, reader: object, budget: object): Purpose {
  const state = purposes.get(token);
  if (!state || state.reader !== reader || state.budget !== budget)
    throw costPlanUnavailable();
  trustedContext(state);
  live(state);
  return state;
}
export function attachFreshSubmitReadPurpose(
  token: FreshSubmitReadPurpose,
  reader: object,
  budget: object,
  scope: object,
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
  scopeAlive: () => boolean,
): number {
  const state = matching(token, reader, budget);
  if (
    state.phase !== "issued" ||
    state.scope ||
    signal !== state.lifetime.signal ||
    deadlineMs !== state.until
  )
    throw costPlanUnavailable();
  const remaining = live(state);
  state.phase = "active";
  state.scope = scope;
  state.scopeAlive = scopeAlive;
  return remaining;
}
export function bindFreshSubmitReadOwner(
  token: FreshSubmitReadPurpose,
  reader: object,
  budget: object,
  scope: object,
  owner: string,
): void {
  const state = matching(token, reader, budget);
  if (
    state.phase !== "active" ||
    state.scope !== scope ||
    state.owner ||
    !/^[0-9a-f]{64}$/.test(owner)
  )
    throw costPlanUnavailable();
  state.owner = owner;
}
export function assertFreshSubmitReadPurpose(
  token: FreshSubmitReadPurpose,
  reader: object,
  budget: object,
  scope: object,
  owner: string,
): void {
  const state = matching(token, reader, budget);
  if (
    (state.phase !== "active" && state.phase !== "admitted") ||
    state.scope !== scope ||
    state.owner !== owner
  )
    throw costPlanUnavailable();
}
export function freshSubmitPacingPermit(
  token: FreshSubmitReadPurpose,
  reader: object,
  budget: object,
  scope: object,
  owner: string,
  interest: object,
): FreshSubmitPacingPermit {
  assertFreshSubmitReadPurpose(token, reader, budget, scope, owner);
  const state = purposes.get(token)!;
  if (state.phase !== "active") throw costPlanUnavailable();
  const permit = Object.freeze(Object.create(null)) as object;
  permits.set(permit, { purpose: state, scope, owner, interest, used: false });
  return permit;
}
export function assertFreshSubmitPacingPermit(
  token: FreshSubmitPacingPermit,
  budget: object,
  owner: string,
  interest: object | undefined,
  consume = false,
): void {
  const permit = permits.get(token);
  if (
    !permit ||
    permit.used ||
    permit.purpose.phase !== "active" ||
    permit.purpose.budget !== budget ||
    permit.owner !== owner ||
    permit.interest !== interest ||
    permit.scope !== permit.purpose.scope
  )
    throw costPlanUnavailable();
  trustedContext(permit.purpose);
  live(permit.purpose);
  if (consume) {
    permit.used = true;
    permit.purpose.phase = "admitted";
  }
}
export function revokeFreshSubmitReadPurpose(
  token: FreshSubmitReadPurpose,
): void {
  const state = purposes.get(token);
  if (state) state.phase = "closed";
}
