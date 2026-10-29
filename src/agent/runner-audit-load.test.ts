import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { it, type TestContext } from "node:test";
import type { SourceSnapshot, VenueAdapter } from "./adapter.js";
import { AgentError } from "./contracts.js";
import { now, recommend } from "./domain.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import { Cursor, MemoryRepository, type State } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";
import { SourceFeed } from "./source-feed.js";
import { VenueReads } from "./venue-reads.js";
import {
  VenueReadBudget,
  type BudgetTimers,
  type AccountReadReservation,
} from "./venue-read-budget.js";

async function flush() {
  for (let i = 0; i < 140; i++) await Promise.resolve();
}
class Clock {
  at = 0;
  private sequence = 0;
  private events = new Map<number, { at: number; run(): void }>();
  readonly timers: BudgetTimers = {
    setTimeout: (run, ms) => {
      const id = ++this.sequence;
      this.events.set(id, { at: this.at + ms, run });
      return id;
    },
    clearTimeout: (id) => {
      this.events.delete(id as number);
    },
  };
  constructor(
    t: TestContext,
    readonly base: number,
  ) {
    t.mock.method(Date, "now", () => base + this.at);
    t.mock.method(
      globalThis,
      "setTimeout",
      this.timers.setTimeout as typeof setTimeout,
    );
    t.mock.method(
      globalThis,
      "clearTimeout",
      this.timers.clearTimeout as typeof clearTimeout,
    );
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.timers.clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = this.timers.setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async advance(ms: number) {
    const target = this.at + ms;
    await flush();
    let fired = 0;
    for (;;) {
      const next = [...this.events]
        .filter(([, event]) => event.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(
        ++fired < 100000,
        "a scheduler regression must not spin on an elapsed deadline",
      );
      this.at = next[1].at;
      this.events.delete(next[0]);
      next[1].run();
      await flush();
    }
    this.at = target;
    await flush();
  }
}

const horizon = 360000,
  warmup = 120000,
  base = 1793200000000;
async function sustained(
  t: TestContext,
  finishBasedControl: boolean,
  borrowPolicy: "off" | "strict200" | "production" = "off",
  slowPhase = 0,
) {
  const time = new Clock(t, base),
    repository = new MemoryRepository(),
    fake = new FakeAdapter();
  const adapter: VenueAdapter = fake;
  const budget = new VenueReadBudget({
    clock: () => time.at,
    timers: time.timers,
  });
  const controlled = budget as unknown as {
    canBorrowPacingWeight?: (waiter: { cost: number }) => boolean;
  };
  const originalBorrow = controlled.canBorrowPacingWeight?.bind(budget);
  if (borrowPolicy === "off") controlled.canBorrowPacingWeight = () => false;
  else if (borrowPolicy === "strict200") {
    assert.ok(
      originalBorrow,
      "the strict source-share comparison needs the candidate policy",
    );
    controlled.canBorrowPacingWeight = (waiter) =>
      originalBorrow(waiter) &&
      (budget.snapshot() as { source_used: number }).source_used +
        waiter.cost <=
        200;
  }
  const stop = new AbortController(),
    sourceStop = new AbortController();
  const users = ["alice", "bob"],
    traders = [candidate(1), candidate(2)];
  const committed = new Map<string, State>(),
    financialTimes = new Set<number>();
  const sourceTimes = new Map(
    traders.map((trader) => [trader.id, new Set<number>()]),
  );
  const commits = new Map(
    users.map((user) => [user, [] as { at: number; observed: number }[]]),
  );
  const cursors = new Map(
    users.map((user) => [
      user,
      [] as { observed: number; committed: number }[],
    ]),
  );
  const provider: {
    at: number;
    weight: number;
    frame?: number;
    history?: number;
  }[] = [];
  const frames: {
    id: number;
    user: string;
    at: number;
    observed: number;
    complete: number;
  }[] = [];
  const deferrals: {
    user: string;
    at: number;
    retry: unknown;
    used: number;
    pacing: number;
    active: boolean;
  }[] = [];
  const activeTicks = new Map<string, number>(),
    maximumTicks = new Map<string, number>();
  const phaseSpans: {
    user: string;
    phase: string;
    start: number;
    end: number;
  }[] = [];
  const phaseCounts = new Map<string, number>();
  const tickSpans: { user: string; start: number; end?: number }[] = [];
  type HistoryWindow = {
    trader: string;
    start: number;
    end: number;
    called: number;
    completed?: number;
    wireAt?: number;
    before?: ReturnType<VenueReadBudget["snapshot"]>;
    admitted?: ReturnType<VenueReadBudget["snapshot"]>;
    after?: ReturnType<VenueReadBudget["snapshot"]>;
    sourceBefore?: number;
    sourceAtAdmission?: number;
    failed?: number;
    error?: string;
  };
  const unknownIds: string[] = [],
    fillWindows: HistoryWindow[] = [];
  const sourceUsed = () =>
    (budget.snapshot() as { source_used?: number }).source_used;
  const sourceContext = new AsyncLocalStorage<HistoryWindow>();
  const sourceCalls: {
    trader: string;
    called: number;
    completed?: number;
    observed?: number;
    failed?: number;
    error?: string;
  }[] = [];
  const errors: unknown[][] = [];
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", (...items: unknown[]) => errors.push(items));
  for (let i = 0; i < users.length; i++) {
    const p = fromPlan(
      recommend(
        {
          budget_usdc: "20",
          market: "perps",
          assets: [],
          allow_altcoins: true,
          loss_trigger_pct: 10,
          risk_tolerance: "medium",
          portfolio_kind: "single",
          basket_size: 1,
          copy_mode: "fixed",
          fixed_margin_usdc: "4",
        },
        [traders[i]],
      ),
    );
    p.account_id = `owned_${users[i]}`;
    p.venue_accounts = { perps: p.account_id };
    p.state = "active";
    p.initial_equity = "500";
    p.ledger_started_at = base - 60000;
    p.snapshot = {
      ...snapshot(),
      account_id: p.account_id,
      observed_at: base - 1000,
    };
    p.sleeves[0].reviewed_at = base;
    p.executions.push({
      id: `original_unknown_${users[i]}`,
      key: `perps:${traders[i].assets[0]}`,
      target_quantity: "0.2",
      allocations: {},
      revision: p.revision,
      fingerprint: "original_frozen",
      created_at: base - 1000,
      expires_at: base + horizon + 120000,
      status: "uncertain",
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "4",
      error: null,
    });
    await repository.transact(users[i], async (state) => {
      state.portfolios.push(p);
    });
    committed.set(users[i], await repository.read(users[i]));
  }
  repository.users = async () => users;
  let maximumAge = [0, 0],
    samples = 0,
    completedFrames = 0,
    frameSequence = 0;
  const maximumAt = [0, 0];
  const sample = () => {
    if (time.at < warmup || time.at > horizon) return;
    samples++;
    users.forEach((user, i) => {
      const observed = committed.get(user)!.portfolios[0].snapshot!.observed_at;
      if (now() - observed > maximumAge[i]) {
        maximumAge[i] = now() - observed;
        maximumAt[i] = time.at;
      }
    });
  };
  const transact = repository.transact.bind(repository);
  repository.transact = async (user, work) => {
    const count = phaseCounts.get(user) ?? 0;
    phaseCounts.set(user, count + 1);
    const start = time.at;
    const result = await transact(user, work);
    phaseSpans.push({
      user,
      phase: ["audit_control", "observe_plan", "durable_notify"][count % 3],
      start,
      end: time.at,
    });
    // MemoryRepository.read waits for its transaction tail. Capture only after
    // this transaction has committed and before the runner starts its next one.
    const state = await repository.read(user),
      p = state.portfolios[0];
    sample();
    const prior = committed.get(user)!.portfolios[0].snapshot!.observed_at;
    if (p.snapshot!.observed_at !== prior) {
      assert.ok(
        financialTimes.has(p.snapshot!.observed_at),
        "only an entire completed metered frame may be published",
      );
      commits
        .get(user)!
        .push({ at: time.at, observed: p.snapshot!.observed_at - base });
    }
    const cursor = p.sleeves[0].fixed_last_fill_at;
    if (cursor != null) {
      assert.ok(
        sourceTimes.get(p.sleeves[0].trader.id)!.has(cursor),
        "a cursor must retain a real source observation timestamp",
      );
      const history = cursors.get(user)!;
      assert.ok(
        !history.length || cursor >= history.at(-1)!.observed,
        "a source cursor may not move backwards",
      );
      if (history.at(-1)?.observed !== cursor)
        history.push({ observed: cursor, committed: time.at });
    }
    const observedSource = p.sleeves[0].last_source_at;
    if (observedSource != null)
      assert.ok(
        sourceTimes.get(p.sleeves[0].trader.id)!.has(observedSource),
        "display evidence cannot relabel a late DTO to completion time",
      );
    committed.set(user, state);
    return result;
  };

  async function wire(
    lane: "account" | "source",
    reserve: number,
    actual: number,
    signal: AbortSignal,
    ms: number,
    owner: string,
    observation?: AccountReadReservation,
    frame?: number,
    unknown = false,
  ) {
    const ticket = await budget.acquire(
      lane,
      reserve,
      owner,
      signal,
      unknown,
      observation,
    );
    try {
      if (signal.aborted) throw signal.reason;
      ticket.sent();
      const at = time.at;
      provider.push({ at, weight: actual, frame });
      assert.ok(
        budget.snapshot().used <= 1000,
        "every provider dispatch requires a complete reservation",
      );
      await time.sleep(ms, signal);
      ticket.settle(actual);
      return at;
    } finally {
      ticket.release();
    }
  }

  adapter.account = async (user, p) => {
    let reservation: AccountReadReservation;
    try {
      reservation = budget.beginObservation(`whole-frame:${user}`);
    } catch (error) {
      const state = budget.snapshot();
      deferrals.push({
        user,
        at: time.at,
        retry:
          error instanceof AgentError
            ? error.details?.retry_after_ms
            : undefined,
        used: state.used,
        pacing: state.observation_pacing_ms,
        active: state.observation_active,
      });
      throw error;
    }
    const controller = new AbortController();
    const id = ++frameSequence,
      started = time.at;
    const deadline = time.timers.setTimeout(
      () =>
        controller.abort(
          new AgentError(
            "VENUE_READ_DEADLINE",
            "fixture complete frame deadline",
            true,
            503,
          ),
        ),
      20000,
    );
    const read = (reserve: number, actual = reserve, unknown = false) =>
      wire(
        "account",
        reserve,
        actual,
        controller.signal,
        300,
        user,
        reservation,
        id,
        unknown,
      );
    let complete = false;
    try {
      await read(20); // Mode guard contributes cost, not a financial timestamp.
      const [financial] = await Promise.all([read(2), read(2)]);
      await read(20, 20, true); // Unknown funding must finish before bounded siblings.
      await Promise.all([read(120, 20), read(20)]);
      await Promise.all([read(20), read(20)]);
      await Promise.all([read(20), read(20)]);
      assert.equal(
        provider
          .filter((request) => request.frame === id)
          .reduce((n, request) => n + request.weight, 0),
        164,
      );
      assert.ok(time.at - started <= 20000);
      complete = true;
      completedFrames++;
      const observed = base + financial;
      financialTimes.add(observed);
      frames.push({
        id,
        user,
        at: started,
        observed: financial,
        complete: time.at,
      });
      return {
        ...snapshot(),
        account_id: p.account_id!,
        venue_accounts: p.venue_accounts,
        observed_at: observed,
      };
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally {
      time.timers.clearTimeout(deadline);
      reservation.close(complete);
    }
  };

  const sourceReads = new VenueReads(
    (async (_url, init) => {
      const payload = JSON.parse(String(init?.body)),
        detail = sourceContext.getStore();
      const at = time.at;
      if (detail) {
        detail.wireAt = at;
        detail.admitted = budget.snapshot();
        detail.sourceAtAdmission = sourceUsed();
      }
      provider.push({
        at,
        weight: payload.type === "userFillsByTime" ? 20 : 2,
        ...(detail ? { history: fillWindows.indexOf(detail) } : {}),
      });
      assert.ok(budget.snapshot().used <= 1000);
      await time.sleep(
        payload.type === "userFillsByTime" ? 80 : 100,
        init?.signal ?? undefined,
      );
      return new Response(
        JSON.stringify(
          payload.type === "userFillsByTime" ? [] : { dispatched_at: at },
        ),
      );
    }) as typeof fetch,
    now,
    2,
    {
      budget,
      timers: time.timers,
      signal: sourceStop.signal,
      report: () => {},
    },
  );
  async function callerWait<T>(work: Promise<T>): Promise<T> {
    let timer: unknown;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = time.timers.setTimeout(
        () =>
          reject(
            new AgentError(
              "EXECUTOR_UNAVAILABLE",
              "fixture original twenty-second caller deadline",
              true,
              503,
            ),
          ),
        20000,
      );
    });
    // A caller timeout never cancels the public SourceFeed's underlying work.
    try {
      return await Promise.race([work, expired]);
    } finally {
      time.timers.clearTimeout(timer);
    }
  }
  const fetches = new Map<string, number>(),
    slowFetches: number[] = [];
  const feed = new SourceFeed(
    async (id) => {
      const trader = traders.find((value) => value.id === id)!;
      const count =
        (fetches.get(id) ?? (id === traders[0].id ? slowPhase : 0)) + 1;
      fetches.set(id, count);
      const slow = id === traders[0].id && count % 3 === 0;
      if (slow) slowFetches.push(time.at);
      // The slow public operation queues before its actual provider read. The
      // resulting DTO keeps the real provider dispatch stamp, never its arrival.
      await time.sleep(slow ? 6400 : 50, sourceStop.signal);
      const state = (await sourceReads.read(
        "https://fixture.invalid/info",
        { type: "clearinghouseState", user: id },
        0,
        "source",
      )) as { dispatched_at: number };
      const observed = base + state.dispatched_at;
      sourceTimes.get(id)!.add(observed);
      const source: SourceSnapshot = {
        observed_at: observed,
        revision: `unchanged_position_${id}`,
        account_value_usdc: "1000",
        complete: true,
        positions: [
          {
            key: `perps:${trader.assets[0]}`,
            asset: trader.assets[0],
            market: "perps",
            quantity: "5",
            price: "100",
            source_entry_price: "100",
            source_leverage: 5,
            source_leverage_verified: true,
            observed_at: observed,
            source_revision: `unchanged_position_${id}`,
          },
        ],
      };
      return source;
    },
    {
      clock: () => now(),
      timers: {
        setInterval(run, ms) {
          const handle = {
            stopped: false,
            id: undefined as unknown,
            unref() {},
          };
          const repeat = () => {
            if (!handle.stopped) {
              run();
              handle.id = time.timers.setTimeout(repeat, ms);
            }
          };
          handle.id = time.timers.setTimeout(repeat, ms);
          return handle;
        },
        clearInterval(handle) {
          const value = handle as { stopped: boolean; id: unknown };
          value.stopped = true;
          time.timers.clearTimeout(value.id);
        },
      },
    },
  );
  adapter.source = async (trader) => {
    const call = {
      trader: trader.id,
      called: time.at,
    } as (typeof sourceCalls)[number];
    sourceCalls.push(call);
    try {
      const result = await callerWait(feed.read(trader.id));
      call.completed = time.at;
      call.observed = result.observed_at - base;
      return result;
    } catch (error) {
      call.failed = time.at;
      call.error = error instanceof AgentError ? error.code : "other";
      throw error;
    }
  };
  adapter.sourceFills = async (trader, start, end) => {
    const call = {
      trader: trader.id,
      start,
      end,
      called: time.at,
    } as (typeof fillWindows)[number];
    fillWindows.push(call);
    assert.ok(sourceTimes.get(trader.id)!.has(end));
    call.before = budget.snapshot();
    call.sourceBefore = sourceUsed();
    try {
      await callerWait(
        sourceContext.run(call, () =>
          sourceReads.read(
            "https://fixture.invalid/info",
            {
              type: "userFillsByTime",
              user: trader.id,
              startTime: start,
              endTime: end,
              aggregateByTime: false,
            },
            0,
            "source",
          ),
        ),
      );
      call.completed = time.at;
      call.after = budget.snapshot();
      return { fills: [], complete: true };
    } catch (error) {
      call.failed = time.at;
      call.error = error instanceof AgentError ? error.code : "other";
      call.after = budget.snapshot();
      throw error;
    }
  };
  adapter.execution = async (user, _p, execution) => {
    assert.equal(execution.id, `original_unknown_${user}`);
    unknownIds.push(execution.id);
    await time.sleep(user === users[0] ? 2700 : 2300);
    return { status: "uncertain", observed_quantity: null, settled: false };
  };
  const runner = new AgentRunner(
    new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("s".repeat(32)),
    ),
  );
  const tick = runner.tick.bind(runner);
  runner.tick = async (user) => {
    const span = { user, start: time.at } as (typeof tickSpans)[number];
    tickSpans.push(span);
    activeTicks.set(user, (activeTicks.get(user) ?? 0) + 1);
    maximumTicks.set(
      user,
      Math.max(maximumTicks.get(user) ?? 0, activeTicks.get(user)!),
    );
    try {
      await tick(user);
      if (finishBasedControl) {
        // Read the real runner's completed-tick hint without mutating it, so
        // this control changes cadence alone rather than duplicating evolving
        // account/source retry classification or bypassing either transaction.
        const retry =
          (
            runner as unknown as { venueRetryAt: Map<string, number> }
          ).venueRetryAt.get(user) ?? Infinity;
        const finish = now();
        const oldDue = Math.min(finish + 5000, Math.max(finish, retry));
        await time.sleep(oldDue - finish);
      }
    } finally {
      span.end = time.at;
      activeTicks.set(user, activeTicks.get(user)! - 1);
    }
  };
  const sampleAgain = () => {
    sample();
    if (time.at < horizon)
      time.timers.setTimeout(sampleAgain, Math.min(100, horizon - time.at));
  };
  time.timers.setTimeout(sampleAgain, 100);
  const running = runner.run(stop.signal);
  try {
    await time.advance(horizon);
    sample();
    stop.abort();
    feed.close();
    sourceStop.abort(new Error("fixture source shutdown"));
    await time.advance(30000);
    await running;
  } finally {
    stop.abort();
    feed.close();
    sourceStop.abort(new Error("fixture source shutdown"));
  }
  let providerMaximum = 0;
  for (const request of provider) {
    const weight = provider
      .filter(
        (value) => value.at > request.at - 60000 && value.at <= request.at,
      )
      .reduce((sum, value) => sum + value.weight, 0);
    providerMaximum = Math.max(providerMaximum, weight);
    assert.ok(
      weight <= 1000,
      "actual provider weight includes source histories and must fit the rolling cap",
    );
  }
  const steadyCommits = users.map((user) =>
    commits
      .get(user)!
      .filter((value) => value.at >= warmup && value.at <= horizon),
  );
  assert.ok(
    samples >= 2400,
    "published account ages must be sampled at least every 100ms through steady state",
  );
  assert.ok(
    steadyCommits.every((values) => values.length >= 5),
    "both owners must repeatedly publish complete audits",
  );
  assert.ok(
    frames.every(
      (frame) =>
        frame.complete - frame.at >= 1500 && frame.complete - frame.at <= 2000,
    ),
    "each completed account frame must retain the requested 1.5–2 second wire workload",
  );
  assert.ok(users.every((user) => maximumTicks.get(user) === 1));
  assert.equal(fake.submitCount, 0);
  assert.deepEqual(
    [...new Set(unknownIds)].sort(),
    users.map((user) => `original_unknown_${user}`).sort(),
  );
  for (const user of users) {
    assert.equal(committed.get(user)!.portfolios[0].executions.length, 1);
    assert.equal(
      committed.get(user)!.portfolios[0].executions[0].id,
      `original_unknown_${user}`,
    );
  }
  assert.equal(cursors.size, 2);
  if (borrowPolicy === "production")
    assert.ok([...cursors.values()].every((values) => values.length >= 3));
  assert.ok(
    fillWindows.length > 0 &&
      slowFetches.some((at) => at >= warmup && at <= horizon),
  );
  assert.equal(errors.length, 0);
  fillWindows.forEach((window, i) => {
    if (window.error && window.wireAt === undefined)
      assert.ok(
        provider.every((request) => request.history !== i),
        "a queued single-page timeout must not send or charge a provider request",
      );
    if (window.error) assert.ok(window.failed! - window.called <= 20000);
  });
  const steadyCursorTimes = [...cursors.values()].map((values) =>
    values
      .filter(
        (value) => value.committed >= warmup && value.committed <= horizon,
      )
      .map((value) => value.committed),
  );
  const cursorGaps = steadyCursorTimes.map((values) => {
    const bounds = [warmup, ...values, horizon];
    return Math.max(...bounds.slice(1).map((value, i) => value - bounds[i]));
  });
  const report = {
    finishBasedControl,
    borrowPolicy,
    slowPhase,
    maximumAge,
    providerMaximum,
    completedFrames,
    published: steadyCommits.map((values) => values.length),
    cursorUpdates: [...cursors.values()].map((values) => values.length),
    steadyCursorTimes,
    cursorGaps,
    cursorTailMs: steadyCursorTimes.map(
      (values) => horizon - (values.at(-1) ?? warmup),
    ),
    worstOwnerWindows: users.map((user, i) => ({
      user,
      at: maximumAt[i],
      ticks: tickSpans.filter(
        (value) =>
          value.user === user &&
          value.start >= maximumAt[i] - 45000 &&
          value.start <= maximumAt[i] + 5000,
      ),
      phases: phaseSpans.filter(
        (value) =>
          value.user === user &&
          value.start >= maximumAt[i] - 45000 &&
          value.start <= maximumAt[i] + 5000,
      ),
      deferrals: deferrals.filter(
        (value) =>
          value.user === user &&
          value.at >= maximumAt[i] - 45000 &&
          value.at <= maximumAt[i] + 5000,
      ),
      competingAudits: frames.filter(
        (value) =>
          value.at >= maximumAt[i] - 45000 && value.at <= maximumAt[i] + 5000,
      ),
      competingDeferrals: deferrals.filter(
        (value) =>
          value.at >= maximumAt[i] - 20000 && value.at <= maximumAt[i] + 2000,
      ),
    })),
    slowSources: slowFetches.length,
    samples,
    maximumTicks: [...maximumTicks.values()],
    maximumAt,
    historyFailures: fillWindows
      .filter((value) => value.error)
      .map((value) => ({
        called: value.called,
        failed: value.failed,
        wireAt: value.wireAt,
        error: value.error,
      })),
    sourceCallerFailures: sourceCalls
      .filter((value) => value.error)
      .map((value) => ({
        called: value.called,
        failed: value.failed,
        error: value.error,
      })),
    audits: users.map((user) => commits.get(user)),
    nearMaximum: deferrals.filter(
      (value) =>
        value.at >= maximumAt[0] - 45000 && value.at <= maximumAt[0] + 5000,
    ),
    sourceWaits: sourceCalls.filter(
      (value) =>
        value.called >= maximumAt[0] - 45000 &&
        value.called <= maximumAt[0] + 5000,
    ),
    historyWaits: fillWindows
      .filter(
        (value) =>
          value.called >= maximumAt[0] - 45000 &&
          value.called <= maximumAt[0] + 5000,
      )
      .map((value) => ({
        trader: value.trader,
        called: value.called,
        wireAt: value.wireAt,
        completed: value.completed,
        before: value.before,
        admitted: value.admitted,
        after: value.after,
        sourceBefore: value.sourceBefore,
        sourceAtAdmission: value.sourceAtAdmission,
        failed: value.failed,
        error: value.error,
      })),
  };
  t.diagnostic(JSON.stringify(report));
  return report;
}

it("records the no-loan control under the same original source deadlines and metered workload", async (t) => {
  await sustained(t, false, "off");
});

it("records the strict source-share control without imposing a freshness result", async (t) => {
  await sustained(t, false, "strict200");
});

for (const slowPhase of [0, 1, 2])
  it(`keeps complete audits fresh and Fixed cursors progressing under production source pacing with initial slow phase ${slowPhase}`, async (t) => {
    const report = await sustained(t, false, "production", slowPhase);
    assert.ok(
      report.maximumAge.every((age) => age < 30000),
      JSON.stringify(report),
    );
    assert.ok(
      report.steadyCursorTimes.every((values) => values.length >= 3),
      "source freshness cannot be achieved by permanently starving Fixed history: " +
        JSON.stringify(report),
    );
    assert.ok(
      report.cursorTailMs.every((age) => age <= 60000),
      "both source cursors must still advance in the final rolling-budget window: " +
        JSON.stringify(report),
    );
  });

it("records the old finish-plus-five cadence as a diagnostic control without imposing its result", async (t) => {
  await sustained(t, true);
});
