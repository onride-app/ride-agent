import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { it } from "node:test";
import express, { type Express } from "express";
import { BridgeAdapter } from "./adapter.js";
import { configAt } from "./analytics.js";
import { AgentError, failure } from "./contracts.js";
import { recommend } from "./domain.js";
import { candidate, snapshot } from "./fixtures.js";
import { fromPlan } from "./service.js";

async function loopback<T>(
  app: Express,
  work: (adapter: BridgeAdapter) => Promise<T>,
): Promise<T> {
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await work(
      new BridgeAdapter(`http://127.0.0.1:${port}`, "fixture-token"),
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function portfolio() {
  const p = fromPlan(
    recommend(
      {
        budget_usdc: "43",
        market: "perps",
        assets: [],
        allow_altcoins: true,
        loss_trigger_pct: 20,
        portfolio_kind: "basket",
        basket_size: 3,
      },
      [1, 2, 3].map(candidate),
    ),
  );
  p.account_id = "account_fixture_bound";
  p.venue_accounts = { perps: p.account_id };
  p.control_id = "control_fixture_frozen";
  p.state = "active";
  p.snapshot = snapshot();
  p.snapshot.positions["perps:BTC"] = "0.2";
  p.sleeves[0].lots["perps:BTC"] = {
    key: "perps:BTC",
    asset: "BTC",
    market: "perps",
    quantity: "0.2",
    cost: "20",
    realized: "0",
    fees: "0.1",
    funding: "-0.01",
  };
  p.sleeves[0].intents["perps:BTC"] = {
    key: "perps:BTC",
    asset: "BTC",
    market: "perps",
    quantity: "0.1",
    price: "100",
    source_entry_price: "100",
    source_leverage: 3,
    observed_at: Date.now(),
    source_revision: "source_fixture_frozen",
  };
  p.initial_equity = "500";
  p.ledger_started_at = Date.now() - 1000;
  p.reconciliation = "complete";
  p.executions = [
    {
      id: "execution_fixture_existing",
      key: "perps:BTC",
      target_quantity: "0.1",
      allocations: { [p.sleeves[0].copy_id]: "0.1" },
      revision: p.revision,
      fingerprint: "fixture-frozen-fingerprint",
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      status: "uncertain",
      task_id: "task_fixture_existing",
      observed_quantity: null,
      reserve_usdc: "10.000000",
      error: null,
    },
  ];
  return p;
}

it("omits only audit decisions on all portfolio wire calls so a >1 MiB history passes a real 1 MiB parser without mutating controls or history", async () => {
  const p = portfolio();
  p.decisions = Array.from({ length: 4000 }, (_, index) => ({
    at: Date.now() - index,
    copy_id: p.sleeves[0].copy_id,
    key: "perps:BTC",
    source_revision: `fixture_source_${index}`,
    source_quantity: "5",
    target_quantity: null,
    source_entry_price: "90",
    follower_mark: "100",
    reason: "ENTRY_DEVIATION_OR_MISSING_SOURCE_PRICE",
    config: configAt(p.sleeves[0]),
  }));
  const originalDecisions = p.decisions;
  const original = structuredClone(p);
  const originalBytes = Buffer.byteLength(
    JSON.stringify({ user_id: "fixture-user", portfolio: p }),
  );
  assert.ok(originalBytes > 1024 * 1024);
  const { decisions: _history, ...expectedPortfolio } = original;
  const received: { operation: string; bytes: number; body: any }[] = [];
  const app = express();
  let bytes = 0;
  app.use(
    express.json({
      limit: "1mb",
      verify: (_req, _res, buffer) => {
        bytes = buffer.byteLength;
      },
    }),
  );
  app.post("/internal/agent/:operation", (req, res) => {
    assert.equal(req.get("authorization"), "Bearer fixture-token");
    received.push({ operation: req.params.operation, bytes, body: req.body });
    if (req.params.operation === "submit")
      res.json({ task_id: "task_fixture_receipt" });
    else if (req.params.operation === "activation_check")
      res.json({ eligible: true, blockers: [], idempotent_existing: true });
    else res.json(snapshot());
  });
  await loopback(app, async (adapter) => {
    assert.equal((await adapter.account("fixture-user", p)).eligible, true);
    assert.equal(
      (await adapter.submit("fixture-user", p, p.executions[0])).task_id,
      "task_fixture_receipt",
    );
    assert.equal(
      (await adapter.activationCheck("fixture-user", p)).eligible,
      true,
    );
  });
  assert.deepEqual(
    received.map((r) => r.operation),
    ["account", "submit", "activation_check"],
  );
  for (const request of received) {
    assert.ok(request.bytes < 1024 * 1024);
    assert.equal(request.body.user_id, "fixture-user");
    assert.equal(Object.hasOwn(request.body.portfolio, "decisions"), false);
    assert.deepEqual(request.body.portfolio, expectedPortfolio);
  }
  assert.deepEqual(received[1].body.execution, original.executions[0]);
  assert.deepEqual(p, original);
  assert.equal(p.decisions, originalDecisions);
  assert.equal(p.decisions.length, 4000);
});

it("preserves null portfolios and calls that do not contain a portfolio", async () => {
  const bodies: any[] = [];
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/internal/agent/:operation", (req, res) => {
    bodies.push(req.body);
    res.json(req.params.operation === "candidates" ? [] : snapshot());
  });
  await loopback(app, async (adapter) => {
    await adapter.preflight("fixture-user", null);
    await adapter.candidates("perps");
  });
  assert.deepEqual(bodies, [
    { user_id: "fixture-user", portfolio: null },
    { market: "perps" },
  ]);
});

it("returns safe typed errors for HTML rejection, unavailable responses and invalid successful account payloads", async () => {
  const secret = "fixture-private-upstream-content";
  const cases = [
    {
      status: 413,
      contentType: "text/html",
      body: `<h1>${secret}</h1>`,
      code: "EXECUTOR_REQUEST_TOO_LARGE",
      httpStatus: 413,
      retryable: false,
    },
    {
      status: 502,
      contentType: "text/html",
      body: `<h1>${secret}</h1>`,
      code: "EXECUTOR_UNAVAILABLE",
      httpStatus: 502,
      retryable: true,
    },
    ...["not-json", "null", JSON.stringify(secret), "[]", "{}"].map((body) => ({
      status: 200,
      contentType: "application/json",
      body,
      code: "EXECUTOR_RESPONSE_INVALID",
      httpStatus: 502,
      retryable: true,
    })),
    {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ account_id: "fixture", token: secret }),
      code: "EXECUTOR_RESPONSE_INVALID",
      httpStatus: 502,
      retryable: true,
    },
    {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: secret, message: secret } }),
      code: "EXECUTOR_RESPONSE_INVALID",
      httpStatus: 502,
      retryable: true,
    },
  ];
  let index = 0;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post("/internal/agent/account", (_req, res) => {
    const fixture = cases[index++];
    res.status(fixture.status).type(fixture.contentType).send(fixture.body);
  });
  await loopback(app, async (adapter) => {
    for (const fixture of cases)
      await assert.rejects(
        adapter.account("fixture-user", portfolio()),
        (error) => {
          assert.ok(error instanceof AgentError);
          assert.equal(error.code, fixture.code);
          assert.equal(error.httpStatus, fixture.httpStatus);
          assert.equal(error.retryable, fixture.retryable);
          assert.doesNotMatch(
            [String(error), error.stack, JSON.stringify(failure(error))].join(
              "\n",
            ),
            new RegExp(secret),
          );
          return true;
        },
      );
  });
});

it("preserves typed JSON failure codes and validated Core details", async () => {
  const details = {
    operation: "perps_account",
    grpc_code: "UNAVAILABLE",
    reason_code: "CORE_BACKEND_UNAVAILABLE",
    retry_after_ms: 1000,
  };
  const app = express();
  app.use(express.json());
  app.post("/internal/agent/account", (_req, res) => {
    res.status(503).json({
      error: {
        code: "CORE_REJECTED",
        message: "Account observations are temporarily unavailable.",
        retryable: true,
        details,
      },
    });
  });
  await loopback(app, async (adapter) => {
    await assert.rejects(
      adapter.account("fixture-user", portfolio()),
      (error) => {
        assert.ok(error instanceof AgentError);
        assert.equal(error.code, "CORE_REJECTED");
        assert.equal(
          error.message,
          "Account observations are temporarily unavailable.",
        );
        assert.equal(error.httpStatus, 503);
        assert.equal(error.retryable, true);
        assert.deepEqual(error.details, details);
        return true;
      },
    );
  });
});
