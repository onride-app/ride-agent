import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { recommend } from "./domain.js";
import { candidate, FakeAdapter } from "./fixtures.js";
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
