import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { recommend, type Execution } from "./domain.js";
import { AgentError } from "./contracts.js";
import { candidate, FakeAdapter, snapshot } from "./fixtures.js";
import {
  runMonitorTrace,
  type MonitorTimingRecord,
} from "./monitor-diagnostics.js";
import { Cursor, PgRepository } from "./repository.js";
import { AgentRunner } from "./runner.js";
import { AgentService, fromPlan } from "./service.js";

test(
  "PostgreSQL exposes the committed audit while source planning retains its own row lock",
  {
    skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL,
    timeout: 15000,
  },
  async () => {
    const repository = new PgRepository(
      process.env.RIDE_AGENT_TEST_DATABASE_URL!,
    );
    const adapter = new FakeAdapter();
    let returnedAt = 0;
    const account = adapter.account.bind(adapter);
    adapter.account = async () => {
      const snapshot = await account();
      returnedAt = snapshot.observed_at;
      return snapshot;
    };
    const user = `audit_visibility_${randomUUID()}`;
    const trader = candidate(1);
    const p = fromPlan(
      recommend(
        {
          budget_usdc: "20",
          market: "perps",
          assets: [],
          allow_altcoins: true,
          loss_trigger_pct: 90,
          risk_tolerance: "medium",
          portfolio_kind: "single",
        },
        [trader],
      ),
    );
    p.account_id = adapter.snap.account_id;
    p.venue_accounts = { perps: p.account_id };
    p.state = "active";
    p.initial_equity = "500";
    p.ledger_started_at = Date.now() - 60000;
    p.sleeves[0].reviewed_at = Date.now();
    type FixtureSource = Awaited<ReturnType<FakeAdapter["source"]>>;
    let resolveSource!: (source: FixtureSource) => void;
    const source = new Promise<FixtureSource>((resolve) => {
      resolveSource = resolve;
    });
    let enterPlanning!: () => void;
    const planning = new Promise<void>((resolve) => {
      enterPlanning = resolve;
    });
    const originalSource = adapter.source.bind(adapter);
    adapter.source = async () => source;
    let work: Promise<void> | undefined;
    let completed = false;
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.portfolios.push(p);
      });
      const transact = repository.transact.bind(repository);
      let transactions = 0;
      repository.transact = (owner, callback) =>
        transact(owner, async (state) => {
          if (++transactions === 2) enterPlanning();
          return callback(state);
        });
      const runner = new AgentRunner(
        new AgentService(
          repository,
          adapter,
          "https://ride.test",
          new Cursor("s".repeat(32)),
        ),
      );
      work = runner.tick(user).then(() => {
        completed = true;
      });
      await Promise.race([
        planning,
        work.then(() => {
          throw new Error(
            "Tick finished before source planning acquired its transaction",
          );
        }),
      ]);
      // An ordinary MVCC read must see A's committed account and ledger while
      // B remains blocked on the public DTO with SELECT FOR UPDATE held.
      const committed = await repository.read(user);
      assert.equal(completed, false, "source planning must still be waiting");
      await assert.rejects(
        repository.pool.query(
          "SELECT 1 FROM ride_agent_state WHERE user_id=$1 FOR UPDATE NOWAIT",
          [user],
        ),
        { code: "55P03" },
      );
      assert.equal(committed.portfolios[0].snapshot?.observed_at, returnedAt);
      assert.equal(committed.portfolios[0].audit_verified_at, returnedAt);
      assert.equal(committed.portfolios[0].reconciliation, "complete");
      assert.equal(committed.portfolios[0].executions.length, 0);
      assert.equal(adapter.submitCount, 0);
    } finally {
      resolveSource(await originalSource(trader));
      await work?.catch(() => {});
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await repository.close();
    }
  },
);

test(
  "PostgreSQL commits failed audit and current durable state without an empty planning rewrite",
  {
    skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL,
    timeout: 15000,
  },
  async () => {
    const repository = new PgRepository(
        process.env.RIDE_AGENT_TEST_DATABASE_URL!,
      ),
      external = new PgRepository(process.env.RIDE_AGENT_TEST_DATABASE_URL!),
      adapter = new FakeAdapter(),
      user = `noop_visibility_${randomUUID()}`;
    const p = fromPlan(
      recommend(
        {
          budget_usdc: "20",
          market: "perps",
          assets: [],
          allow_altcoins: true,
          loss_trigger_pct: 90,
          risk_tolerance: "medium",
          portfolio_kind: "single",
        },
        [candidate(1)],
      ),
    );
    p.account_id = adapter.snap.account_id;
    p.state = "active";
    p.initial_equity = "500";
    p.ledger_started_at = Date.now() - 60000;
    p.snapshot = snapshot();
    p.sleeves[0].reviewed_at = Date.now();
    p.executions.push({
      id: "original_pg_unknown",
      key: "perps:BTC",
      target_quantity: "0.1",
      allocations: {},
      revision: p.revision,
      fingerprint: "frozen_original",
      created_at: Date.now(),
      expires_at: Date.now() + 120000,
      status: "uncertain",
      task_id: null,
      observed_quantity: null,
      reserve_usdc: "2",
      error: null,
    });
    let finishDurable!: () => void,
      enterDurable!: () => void,
      finishSource!: () => void;
    const durable = new Promise<void>((resolve) => {
        finishDurable = resolve;
      }),
      entered = new Promise<void>((resolve) => {
        enterDurable = resolve;
      }),
      source = new Promise<void>((resolve) => {
        finishSource = resolve;
      });
    let accountCalls = 0,
      sourceCalls = 0;
    const ids: string[] = [],
      records: MonitorTimingRecord[] = [];
    adapter.account = async () => {
      accountCalls++;
      throw new AgentError(
        "VENUE_READ_BUDGET_EXHAUSTED",
        "PG account pacing",
        true,
        503,
        { retry_after_ms: 10000 },
      );
    };
    adapter.source = async () => {
      sourceCalls++;
      await source;
      return {
        observed_at: Date.now(),
        revision: "flat",
        account_value_usdc: "1000",
        complete: true,
        positions: [],
      };
    };
    adapter.execution = async (
      _user?: string,
      _portfolio?: unknown,
      execution?: Execution,
    ) => {
      assert.ok(execution);
      ids.push(execution.id);
      enterDurable();
      await durable;
      return {
        status: "uncertain" as const,
        observed_quantity: "0.125",
        settled: false,
      };
    };
    adapter.profile = async () => {
      throw new Error("unaudited state must not be planned");
    };
    const runner = new AgentRunner(
      new AgentService(
        repository,
        adapter,
        "https://ride.test",
        new Cursor("s".repeat(32)),
      ),
    );
    let work: Promise<void> | undefined;
    try {
      await repository.migrate();
      await repository.transact(user, async (state) => {
        state.portfolios.push(p);
      });
      const transact = repository.transact.bind(repository);
      let changed = false;
      repository.transact = async (owner, callback) => {
        const result = await transact(owner, callback);
        if (!changed) {
          changed = true;
          await external.transact(owner, async (state) => {
            state.selected_trader_ids = ["concurrent_pg_choice"];
            state.portfolios[0].sleeves[0].fixed_last_fill_at = 1234;
            const added = structuredClone(p);
            added.id = "unaudited_concurrent_pg";
            added.executions = [];
            state.portfolios.push(added);
          });
        }
        return result;
      };
      work = runMonitorTrace(() => runner.tick(user), {
        thresholdMs: 0,
        report: (record) => records.push(record),
      });
      await Promise.race([
        entered,
        work.then(() => {
          throw new Error("durable reconciliation did not run");
        }),
      ]);
      const expected = await external.read(user);
      assert.equal(
        expected.portfolios[0].last_error?.code,
        "VENUE_READ_BUDGET_EXHAUSTED",
      );
      assert.equal(expected.performance?.length, 1);
      assert.deepEqual(expected.selected_trader_ids, ["concurrent_pg_choice"]);
      await assert.rejects(
        external.pool.query(
          "SELECT 1 FROM ride_agent_state WHERE user_id=$1 FOR UPDATE NOWAIT",
          [user],
        ),
        { code: "55P03" },
      );
      expected.portfolios[0].executions[0].observed_quantity = "0.125";
      for (const update of expected.updates) update.notification = "delivered";
      finishDurable();
      await work;
      await runner.notificationsIdle();
      assert.deepEqual(
        await external.read(user),
        expected,
        "entire current state is preserved, including audit events/performance, concurrent configuration, original unknown payload and ACK",
      );
      assert.deepEqual(
        records
          .filter(
            (r) =>
              r.kind === "phase" &&
              ["audit_control", "observe_plan", "durable_notify"].includes(
                r.phase,
              ),
          )
          .map((r) => r.phase),
        ["audit_control", "durable_notify"],
      );
      assert.deepEqual(ids, ["original_pg_unknown"]);
      assert.equal(accountCalls, 1);
      assert.equal(sourceCalls, 1);
      assert.equal(adapter.submitCount, 0);
      finishSource();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        await external.read(user),
        expected,
        "late public collection cannot mutate committed history",
      );
    } finally {
      finishSource();
      finishDurable();
      await work?.catch(() => {});
      await runner.closeNotifications();
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await Promise.all([repository.close(), external.close()]);
    }
  },
);
