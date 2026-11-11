import { costPlanUnavailable } from "./account-observation-plans.js";

export type PreparedPromotionTurn = Readonly<{
  live(): boolean;
  release(): void;
}>;
export type PreparedPromotionRegistration = Readonly<{
  live(): boolean;
  markValidated(): void;
  acquire(): Promise<PreparedPromotionTurn>;
  close(): void;
}>;
type Options = {
  firstDeadline: number;
  wallUntil: number;
  monoUntil: number;
  wallClock(): number;
  monoClock(): number;
  signal: AbortSignal;
  eligible(): boolean;
};
type Waiter = {
  resolve(turn: PreparedPromotionTurn): void;
  reject(error: Error): void;
};
type Entry = {
  options: Options;
  order: number;
  closed: boolean;
  validated: boolean;
  acquired: boolean;
  waiter?: Waiter;
  abort(): void;
};
type Turn = { entry: Entry; revoked: boolean };
type Bank = {
  entries: Set<Entry>;
  creating: number;
  order: number;
  current?: Turn;
  timer?: ReturnType<typeof setTimeout>;
  pumping: boolean;
};
const banks = new WeakMap<object, Bank>();

function remaining(entry: Entry): number {
  const o = entry.options;
  if (entry.closed || o.signal.aborted) return 0;
  try {
    const wall = o.wallClock(), mono = o.monoClock();
    if (!Number.isFinite(wall) || !Number.isFinite(mono)) return 0;
    return Math.min(o.firstDeadline - wall, o.wallUntil - wall, o.monoUntil - mono);
  } catch { return 0; }
}
function remove(bank: Bank, entry: Entry): void {
  if (entry.closed) return;
  entry.closed = true;
  bank.entries.delete(entry);
  entry.options.signal.removeEventListener("abort", entry.abort);
  if (bank.current?.entry === entry) {
    bank.current.revoked = true;
    bank.current = undefined;
  }
  const waiter = entry.waiter;
  entry.waiter = undefined;
  waiter?.reject(costPlanUnavailable());
}
function eligible(bank: Bank, entry: Entry): boolean {
  try { return entry.options.eligible() === true; }
  catch { remove(bank, entry); return false; }
}
function pump(bank: Bank): void {
  if (bank.pumping) return;
  bank.pumping = true;
  if (bank.timer !== undefined) clearTimeout(bank.timer);
  bank.timer = undefined;
  try {
    for (const entry of bank.entries) if (remaining(entry) <= 0) remove(bank, entry);
    for (const entry of bank.entries) {
      if (entry.waiter && !eligible(bank, entry)) {
        const waiter = entry.waiter;
        entry.waiter = undefined;
        waiter?.reject(costPlanUnavailable());
      }
    }
    if (!bank.current) {
      const candidates = [...bank.entries]
        .filter(entry => !entry.acquired && eligible(bank, entry))
        .sort((a, b) => a.options.firstDeadline - b.options.firstDeadline || a.order - b.order);
      const head = candidates[0];
      // An active older metadata check has no authority to promote yet, but
      // its faster younger peer cannot overtake it inside this local attempt.
      if (head?.validated && head.waiter && !head.closed) {
        const waiter = head.waiter;
        head.waiter = undefined;
        head.acquired = true;
        const turn: Turn = { entry: head, revoked: false };
        bank.current = turn;
        waiter.resolve(Object.freeze({
          live: () => {
            if (turn.revoked || bank.current !== turn) return false;
            if (remaining(head) > 0) return true;
            remove(bank, head);
            pump(bank);
            return false;
          },
          release: () => {
            if (turn.revoked || bank.current !== turn) return;
            turn.revoked = true;
            bank.current = undefined;
            pump(bank);
          },
        }));
      }
    }
    if (bank.entries.size) {
      // Original wall/monotonic/FIRST bounds apply even before VenueReads has
      // installed its own timer. Polling only rechecks scheduling metadata.
      const next = Math.min(1000, ...[...bank.entries].map(remaining));
      bank.timer = setTimeout(() => pump(bank), Math.max(1, Math.ceil(next)));
    }
  } finally { bank.pumping = false; }
}

/** Private scheduling metadata only: no budget interest, credit or Core call. */
export function registerPreparedPromotion(bankKey: object, options: Options): PreparedPromotionRegistration {
  if (!bankKey || (typeof bankKey !== "object" && typeof bankKey !== "function")) throw costPlanUnavailable();
  let bank = banks.get(bankKey);
  if (!bank) {
    bank = { entries: new Set(), creating: 0, order: 0, pumping: false };
    banks.set(bankKey, bank);
  }
  pump(bank);
  if (bank.entries.size + bank.creating >= 64) throw costPlanUnavailable();
  // Reserve before copying options or invoking the new clocks: either can
  // synchronously re-enter registration on this same physical bank.
  bank.creating++;
  let reserved = true;
  const state = bank;
  let entry: Entry | undefined;
  try {
    const saved = { ...options };
    if (!Number.isSafeInteger(saved.firstDeadline) || !Number.isFinite(saved.wallUntil) ||
      !Number.isFinite(saved.monoUntil)) throw costPlanUnavailable();
    const active: Entry = entry = {
      options: saved, order: ++state.order, closed: false,
      validated: false, acquired: false, abort: () => {},
    };
    if (remaining(active) <= 0) throw costPlanUnavailable();
    // Synchronous transfer: no callback can observe a free slot in between.
    state.creating--; reserved = false;
    state.entries.add(active);
    active.abort = () => { remove(state, active); pump(state); };
    saved.signal.addEventListener("abort", active.abort, { once: true });
    pump(state);
    return registration(state, active);
  } catch (error) {
    if (entry && state.entries.has(entry)) { remove(state, entry); pump(state); }
    throw error;
  } finally { if (reserved) state.creating--; }
}

function registration(state: Bank, entry: Entry): PreparedPromotionRegistration {
  return Object.freeze({
    live: () => {
      if (remaining(entry) > 0) return true;
      remove(state, entry); pump(state); return false;
    },
    markValidated: () => {
      if (remaining(entry) <= 0) { remove(state, entry); pump(state); throw costPlanUnavailable(); }
      entry.validated = true;
      pump(state);
    },
    acquire: () => {
      pump(state);
      if (remaining(entry) <= 0 || entry.acquired || entry.waiter || !entry.validated || !eligible(state, entry))
        return Promise.reject(costPlanUnavailable());
      return new Promise<PreparedPromotionTurn>((resolve, reject) => {
        entry.waiter = { resolve, reject };
        pump(state);
      });
    },
    close: () => { remove(state, entry); pump(state); },
  });
}
