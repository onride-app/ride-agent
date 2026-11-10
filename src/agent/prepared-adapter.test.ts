import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import express from "express";
import { BridgeAdapter } from "./adapter.js";
import { AgentError, failure } from "./contracts.js";
import { candidate, snapshot } from "./fixtures.js";
import { fingerprint, now, recommend, type Execution } from "./domain.js";
import { fromPlan } from "./service.js";
import {
  preparedPortfolioInput,
  preparedOperationalBinding,
} from "./prepared-portfolio.js";

const handle = "fixture_private_capability_0123456789abcdef";
function fixturePortfolio() {
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "100",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 20,
        portfolio_kind: "single",
        basket_size: 1,
      },
      [candidate(1)],
    ),
  );
  p.account_id = snapshot().account_id;
  p.venue_accounts = { perps: p.account_id };
  p.ledger_started_at = now() - 60000;
  p.initial_equity = "500";
  p.state = "active";
  p.snapshot = snapshot();
  p.sleeves[0].initialized = true;
  p.sleeves[0].state = "active";
  return p;
}
function execution(p: ReturnType<typeof fixturePortfolio>): Execution {
  const frozen = {
    id: "execution_original_fixture",
    key: "perps:BTC",
    target_quantity: "0.1",
    allocations: {},
    revision: p.revision,
    created_at: now(),
    expires_at: now() + 60000,
  };
  return {
    ...frozen,
    fingerprint: fingerprint(frozen),
    status: "queued",
    task_id: null,
    observed_quantity: null,
    reserve_usdc: "2",
    error: null,
  };
}
type Call = {
  operation: string;
  header: string | undefined;
  sourceGraph: string | undefined;
  raw: string;
  body: any;
};
async function transport(
  prepare: () => any,
  work: (adapter: BridgeAdapter, calls: Call[]) => Promise<void>,
  options: {
    finish?: () => unknown | Promise<unknown>;
    cancel?: () => unknown;
    monotonicClock?: () => number;
  } = {},
) {
  const app = express(),
    calls: Call[] = [];
  app.use(express.text({ type: "application/json", limit: "2mb" }));
  app.post("/internal/agent/:operation", async (req, res) => {
    const operation = req.params.operation as string;
    calls.push({
      operation,
      header: req.get("x-ride-read-window"),
      sourceGraph: req.get("x-ride-source-read-graph"),
      raw: req.body,
      body: JSON.parse(req.body),
    });
    if (operation === "prepare_portfolio") {
      const value = prepare();
      if (value instanceof AgentError)
        res.status(value.httpStatus).json(failure(value));
      else res.json(value);
    } else if (operation === "finish_portfolio" && options.finish) {
      const value = await options.finish();
      if (value instanceof AgentError)
        res.status(value.httpStatus).json(failure(value));
      else res.json(value);
    } else if (operation === "cancel_prepared_portfolio" && options.cancel)
      res.json(options.cancel());
    else if (operation === "prepare_execution") res.json({ ready: true });
    else if (operation === "account") res.json(snapshot());
    else if (operation === "source")
      res.json({
        observed_at: now(),
        revision: "fixture",
        account_value_usdc: "1000",
        complete: true,
        positions: [],
      });
    else if (operation === "submit")
      res.json({ task_id: "task_original_fixture" });
    else if (operation === "source_fills")
      res.json({ fills: [], complete: true });
    else res.json({ ok: true });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await work(
      new BridgeAdapter(
        `http://127.0.0.1:${port}`,
        "fixture-service-token",
        undefined,
        options.monotonicClock,
      ),
      calls,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
const ready = (mode: "cold" | "warm" = "warm") => ({
  state: "ready",
  handle,
  mode,
  expires_at: now() + 20000,
});
const readonlyReady = () => ({
  ...ready(),
  purpose: "audit_source",
  execution_eligible: false,
});

it("Runner readonly preparation and cancellation carry only the private graph header, with unchanged JSON", async () => {
  await transport(
    readonlyReady,
    async (adapter, calls) => {
      const p = fixturePortfolio(),
        input = preparedPortfolioInput(p, "audit_source");
      const result = await adapter.withPreparedPortfolio(
        "user",
        input,
        async () => "read-only-result",
      );
      assert.equal(result.state, "complete");
      await adapter.cancelPreparedPortfolio("user", input);
      await adapter.account("user", p);
      for (const operation of [
        "prepare_portfolio",
        "cancel_prepared_portfolio",
      ]) {
        const call = calls.find((item) => item.operation === operation)!;
        assert.equal(call.sourceGraph, "readonly-runner-native-v1");
        assert.equal(call.header, undefined);
        assert.deepEqual(
          call.body,
          JSON.parse(JSON.stringify({ user_id: "user", portfolio: input })),
        );
      }
      for (const call of calls.filter(
        (item) =>
          !["prepare_portfolio", "cancel_prepared_portfolio"].includes(
            item.operation,
          ),
      ))
        assert.equal(call.sourceGraph, undefined);
    },
    { cancel: () => ({ ok: true, pending_cancelled: true }) },
  );
});

it("ordinary financial preparation preserves the generic bridge graph and existing JSON", async () => {
  await transport(ready, async (adapter, calls) => {
    const p = fixturePortfolio(),
      input = preparedPortfolioInput(p);
    await adapter.withPreparedPortfolio("user", input, async () => undefined);
    await adapter.cancelPreparedPortfolio("user", input);
    assert.ok(calls.length >= 3);
    assert.ok(calls.every((call) => call.sourceGraph === undefined));
    assert.deepEqual(
      calls.find((call) => call.operation === "prepare_portfolio")!.body,
      JSON.parse(JSON.stringify({ user_id: "user", portfolio: input })),
    );
  });
});

it("a private graph hint cannot be attached to other operations, purposes or unknown graph versions", async () => {
  await transport(readonlyReady, async (adapter, calls) => {
    const p = fixturePortfolio();
    const invoke = (
      adapter as unknown as { call(...args: unknown[]): Promise<unknown> }
    ).call.bind(adapter);
    for (const [operation, input, graph] of [
      [
        "account",
        { user_id: "user", portfolio: p },
        "readonly-runner-native-v1",
      ],
      [
        "prepare_portfolio",
        { user_id: "user", portfolio: preparedPortfolioInput(p) },
        "readonly-runner-native-v1",
      ],
      [
        "prepare_portfolio",
        {
          user_id: "user",
          portfolio: preparedPortfolioInput(p, "audit_source"),
        },
        "unknown-version",
      ],
    ] as const)
      await assert.rejects(
        invoke(operation, input, undefined, undefined, graph),
        { code: "SOURCE_SCOPE_UNAVAILABLE" },
      );
    assert.equal(calls.length, 0);
  });
});

it("requires explicit readonly purpose echo and never treats an old warm reply as financial authority", async () => {
  for (const reply of [
    ready(),
    { ...readonlyReady(), execution_eligible: true },
    { state: "pending", retry_after_ms: 1000 },
  ]) {
    await transport(
      () => reply,
      async (adapter, calls) => {
        const p = fixturePortfolio();
        let entered = false;
        await assert.rejects(
          adapter.withPreparedPortfolio(
            "user",
            preparedPortfolioInput(p, "audit_source"),
            async () => {
              entered = true;
            },
          ),
          { code: "EXECUTOR_RESPONSE_INVALID" },
        );
        assert.equal(entered, false);
        assert.equal(
          calls.filter((c) =>
            ["account", "prepare_execution", "submit"].includes(c.operation),
          ).length,
          0,
        );
        if (reply.state === "ready")
          assert.equal(
            calls.filter((c) => c.operation === "finish_portfolio").length,
            1,
          );
      },
    );
  }
});

it("readonly release in flight blocks same-scope financial RPCs until a strict success acknowledgment", async () => {
  let release!: (value: unknown) => void, seen!: () => void;
  const gate = new Promise<unknown>((r) => {
      release = r;
    }),
    received = new Promise<void>((r) => {
      seen = r;
    });
  await transport(
    readonlyReady,
    async (adapter, calls) => {
      const p = fixturePortfolio(),
        e = execution(p);
      await adapter.withPreparedPortfolio(
        "user",
        preparedPortfolioInput(p, "audit_source"),
        async (window) => {
          assert.equal(window.mode, "warm");
          assert.equal(window.purpose, "audit_source");
          assert.equal(window.execution_eligible, false);
          const finishing = window.release!();
          await received;
          await assert.rejects(adapter.submit("user", p, e), {
            code: "EXECUTION_REJECTED",
          });
          await assert.rejects(adapter.bind("user", p), {
            code: "EXECUTION_REJECTED",
          });
          await assert.rejects(adapter.prepareExecution("user", p, e), {
            code: "EXECUTION_REJECTED",
          });
          assert.equal(
            calls.filter((c) =>
              ["submit", "bind", "prepare_execution"].includes(c.operation),
            ).length,
            0,
          );
          release({ ok: true });
          await finishing;
          await adapter.submit("user", p, e);
          assert.equal(calls.filter((c) => c.operation === "submit").length, 1);
          assert.equal(
            calls.find((c) => c.operation === "submit")!.header,
            undefined,
          );
        },
      );
    },
    {
      finish: () => {
        seen();
        return gate;
      },
    },
  );
});

it("false missing and failed readonly release ACKs keep the local financial barrier without blocking unrelated scope", async () => {
  for (const reply of [
    { ok: false },
    {},
    new AgentError("EXECUTOR_UNAVAILABLE", "fixture", true, 503),
  ]) {
    await transport(
      readonlyReady,
      async (adapter, calls) => {
        const p = fixturePortfolio(),
          e = execution(p);
        await adapter.withPreparedPortfolio(
          "user",
          preparedPortfolioInput(p, "audit_source"),
          async (window) => {
            await assert.rejects(window.release!());
            await assert.rejects(adapter.submit("user", p, e), {
              code: "EXECUTION_REJECTED",
            });
            await assert.rejects(adapter.bind("user", p), {
              code: "EXECUTION_REJECTED",
            });
            await assert.rejects(adapter.prepareExecution("user", p, e), {
              code: "EXECUTION_REJECTED",
            });
            assert.equal(
              calls.filter((c) =>
                ["submit", "bind", "prepare_execution"].includes(c.operation),
              ).length,
              0,
            );
            const foreign = {
              ...p,
              id: p.id + "_other",
              account_id: "different_account",
              venue_accounts: { perps: "different_account" },
            };
            await adapter.submit("other_user", foreign, e);
            assert.equal(
              calls.find((c) => c.operation === "submit")!.header,
              undefined,
            );
          },
        );
      },
      { finish: () => reply },
    );
  }
});

it("readonly Fixed history uses the exact selected cursor and private header while legacy metadata hashes stay unchanged", async () => {
  await transport(readonlyReady, async (adapter, calls) => {
    const p = fixturePortfolio();
    p.sleeves[0].copy_mode = "fixed";
    p.sleeves[0].fixed_last_fill_at = now() - 1000;
    const legacy = preparedPortfolioInput(p),
      explicitLegacy = preparedPortfolioInput(p, "audit_submit"),
      ro = preparedPortfolioInput(p, "audit_source");
    assert.deepEqual(legacy, explicitLegacy);
    assert.equal(Object.hasOwn(legacy, "purpose"), false);
    assert.equal(Object.hasOwn(legacy.sleeves[0], "fixed_last_fill_at"), false);
    assert.equal(
      ro.sleeves[0].fixed_last_fill_at,
      p.sleeves[0].fixed_last_fill_at,
    );
    assert.notEqual(
      preparedOperationalBinding(legacy),
      preparedOperationalBinding(ro),
    );
    await adapter.withPreparedPortfolio("user", ro, async () => {
      await adapter.account("user", p);
      await adapter.sourceFills(
        p.sleeves[0].trader,
        p.sleeves[0].fixed_last_fill_at!,
        now(),
      );
      const history = calls.filter((c) => c.operation === "source_fills");
      assert.equal(history.length, 1);
      assert.equal(history[0].header, handle);
      await assert.rejects(
        adapter.sourceFills(
          p.sleeves[0].trader,
          p.sleeves[0].fixed_last_fill_at! - 1,
          now(),
        ),
        { code: "SOURCE_SCOPE_UNAVAILABLE" },
      );
      await assert.rejects(
        adapter.sourceFills(
          { ...p.sleeves[0].trader, id: "foreign_source" },
          p.sleeves[0].fixed_last_fill_at!,
          now(),
        ),
        { code: "SOURCE_SCOPE_UNAVAILABLE" },
      );
      assert.equal(
        calls.filter((c) => c.operation === "source_fills").length,
        1,
      );
    });
  });
});

it("readonly local assertLive preserves the original monotonic lifetime through a wall clock rollback", async (t) => {
  let wall = 1793200000000,
    mono = 0;
  t.mock.method(Date, "now", () => wall);
  await transport(
    readonlyReady,
    async (adapter, calls) => {
      const p = fixturePortfolio();
      await adapter.withPreparedPortfolio(
        "user",
        preparedPortfolioInput(p, "audit_source"),
        async (window) => {
          mono = 20001;
          wall -= 60000;
          assert.throws(() => window.assertLive!(), {
            code: "VENUE_READ_DEADLINE",
          });
          await assert.rejects(adapter.account("user", p), {
            code: "VENUE_READ_DEADLINE",
          });
          assert.equal(
            calls.filter((c) => c.operation === "account").length,
            0,
          );
        },
      );
    },
    { monotonicClock: () => mono },
  );
});

it("keeps the prepared capability in private headers and preserves exact financial request bytes", async () => {
  await transport(
    () => ready(),
    async (adapter, calls) => {
      const p = fixturePortfolio(),
        e = execution(p);
      (e as any).first_submission_failure = {
        code: "OTHER",
        reason_code: "OTHER",
        retryable: false,
        at: 1,
        elapsed_ms: 0,
      };
      p.executions = Array.from({ length: 100 }, (_, i) => ({
        ...e,
        id: `execution_legacy_${i}`,
        status: "failed" as const,
      }));
      await adapter.submit("user_fixture", p, e);
      const originalWire = calls.at(-1)!.raw;
      const result = await adapter.withPreparedPortfolio(
        "user_fixture",
        preparedPortfolioInput(p),
        async (window) => {
          await adapter.account("user_fixture", p);
          await adapter.source(p.sleeves[0].trader);
          await adapter.source(candidate(2));
          await adapter.cancelPreparedPortfolio(
            "user_fixture",
            preparedPortfolioInput(p),
          );
          const prepared = await adapter.prepareExecution("user_fixture", p, e);
          assert.ok(prepared);
          prepared.bind(e);
          await adapter.submit("user_fixture", p, e);
          await window.release!();
          await adapter.notify("user_fixture", {
            id: "notice",
            kind: "fixture",
            message: "fixture",
            portfolio_id: p.id,
          });
        },
      );
      assert.equal(result.state, "complete");
      const submits = calls.filter((c) => c.operation === "submit");
      assert.equal(submits.length, 2);
      assert.equal(submits[0].header, undefined);
      assert.equal(submits[1].header, handle);
      assert.equal(submits[1].raw, originalWire);
      assert.equal(
        calls.find((c) => c.operation === "account")!.header,
        handle,
      );
      const sources = calls.filter((c) => c.operation === "source");
      assert.equal(sources[0].header, handle);
      assert.equal(sources[1].header, undefined);
      assert.equal(
        calls.filter((c) => c.operation === "finish_portfolio").length,
        1,
      );
      assert.equal(
        calls.find((c) => c.operation === "notify")!.header,
        undefined,
      );
      assert.equal(
        calls.find((c) => c.operation === "cancel_prepared_portfolio")!.header,
        undefined,
      );
      for (const call of calls) assert.equal(call.raw.includes(handle), false);
      for (const call of calls.filter((c) =>
        ["prepare_portfolio", "prepare_execution"].includes(c.operation),
      )) {
        for (const field of [
          "executions",
          "snapshot",
          "decisions",
          "seen_fills",
          "funding_receipts",
        ])
          assert.equal(Object.hasOwn(call.body.portfolio, field), false);
      }
      assert.equal(Object.hasOwn(e, "first_submission_failure"), true);
    },
  );
});

it("does not enter a pending or unsupported callback and negotiates only the exact old-bridge response", async () => {
  for (const value of [
    { state: "pending", retry_after_ms: 1000 },
    { state: "unsupported" },
    new AgentError(
      "NOT_FOUND",
      "Unknown private adapter operation.",
      false,
      404,
    ),
  ]) {
    await transport(
      () => value,
      async (adapter, calls) => {
        let entered = false;
        const result = await adapter.withPreparedPortfolio(
          "user",
          preparedPortfolioInput(fixturePortfolio()),
          async () => {
            entered = true;
          },
        );
        assert.equal(entered, false);
        assert.equal(
          result.state,
          value instanceof AgentError ? "unsupported" : value.state,
        );
        assert.deepEqual(
          calls.map((c) => c.operation),
          ["prepare_portfolio"],
        );
      },
    );
  }
  await transport(
    () => new AgentError("EXECUTOR_UNAVAILABLE", "fixture", true, 503),
    async (adapter) => {
      await assert.rejects(
        adapter.withPreparedPortfolio(
          "user",
          preparedPortfolioInput(fixturePortfolio()),
          async () => {},
        ),
        (error) =>
          error instanceof AgentError && error.code === "EXECUTOR_UNAVAILABLE",
      );
    },
  );
});

it("rejects an unbound, foreign or doubly bound prepared execution and always releases failed callbacks", async () => {
  await transport(
    () => ready(),
    async (adapter, calls) => {
      const p = fixturePortfolio(),
        e = execution(p);
      await assert.rejects(
        adapter.withPreparedPortfolio(
          "user",
          preparedPortfolioInput(p),
          async () => {
            await assert.rejects(
              adapter.submit("user", p, e),
              /identity changed/,
            );
            await assert.rejects(
              adapter.prepareExecution("other_user", p, e),
              /authority changed/,
            );
            const preparation = await adapter.prepareExecution("user", p, e);
            assert.ok(preparation);
            preparation.bind(e);
            assert.throws(() => preparation.bind(e), /identity changed/);
            await assert.rejects(
              adapter.prepareExecution("user", p, e),
              /authority changed/,
            );
            throw new Error("fixture callback failure");
          },
        ),
        /fixture callback failure/,
      );
      assert.equal(calls.filter((c) => c.operation === "submit").length, 0);
      assert.equal(
        calls.filter((c) => c.operation === "prepare_execution").length,
        1,
      );
      assert.equal(
        calls.filter((c) => c.operation === "finish_portfolio").length,
        1,
      );
    },
  );
});

it("cold mode cannot claim a new execution and expiration never renews a prepared window", async (t) => {
  let clock = 1794268800000;
  t.mock.method(Date, "now", () => clock);
  await transport(
    () => ready("cold"),
    async (adapter, calls) => {
      const p = fixturePortfolio();
      await adapter.withPreparedPortfolio(
        "user",
        preparedPortfolioInput(p),
        async () => {
          assert.equal(
            await adapter.prepareExecution("user", p, execution(p)),
            null,
          );
          await adapter.account("user", p);
          clock += 20001;
          await assert.rejects(
            adapter.account("user", p),
            (error) =>
              error instanceof AgentError &&
              error.code === "VENUE_READ_DEADLINE",
          );
        },
      );
      assert.equal(
        calls.filter((c) => c.operation === "prepare_portfolio").length,
        1,
      );
      assert.equal(calls.filter((c) => c.operation === "account").length, 1);
      assert.equal(
        calls.filter((c) => c.operation === "prepare_execution").length,
        0,
      );
      assert.equal(
        calls.filter((c) => c.operation === "finish_portfolio").length,
        1,
      );
    },
  );
});
