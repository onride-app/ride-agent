import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  D,
  allocate,
  aggregate,
  risk,
  recommend,
  pnl,
  now,
  uid,
  type Candidate,
  type AccountSnapshot,
  type Portfolio,
} from "./domain.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { AgentService, fromPlan } from "./service.js";
import { AgentRunner } from "./runner.js";
import {
  internalCross,
  applyFill,
  applyFunding,
  reconcileQuantities,
} from "./ledger.js";
import type { VenueAdapter } from "./adapter.js";
import { inputs, publicResult, result } from "./contracts.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgentTools } from "./mcp.js";
import { compatibility } from "./conversational.js";

import { candidate, snapshot, FakeAdapter } from "./fixtures.js";
function service() {
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  return {
    repository,
    adapter,
    api: new AgentService(
      repository,
      adapter,
      "https://mcp.example",
      new Cursor("c".repeat(32)),
    ),
  };
}
const pref = {
  budget_usdc: "500",
  loss_trigger_pct: 20,
  market: "perps" as const,
  assets: ["BTC", "ETH"],
  allow_altcoins: false,
};
it("distinguishes unavailable source scores from budget minimums without requesting funding", async () => {
  const env = service();
  env.adapter.pool = [];
  const unavailable = await env.api.tool("alice", "recommend_traders", {
    preferences: pref,
  });
  assert.equal(unavailable.status, "stale");
  assert.equal(unavailable.error?.retryable, true);
  assert.equal(
    (unavailable.data.recommendation_diagnostics as any).blocker,
    "source_data_unavailable",
  );
  assert.equal(
    (unavailable.data.recommendation_diagnostics as any).funding_required,
    false,
  );
  env.adapter.pool = [1, 2, 3].map(candidate);
  const low = await env.api.tool("alice", "recommend_traders", {
    preferences: { ...pref, budget_usdc: "0.000001", basket_size: 3 },
  });
  assert.equal(
    (low.data.recommendation_diagnostics as any).blocker,
    "budget_minimums",
  );
  assert.equal(low.error?.retryable, false);
});
async function proposed() {
  const env = service();
  await env.api.tool("alice", "set_preferences", pref);
  const r = await env.api.tool("alice", "recommend_traders", {});
  const p = await env.api.tool("alice", "start_copy", {
    plan_id: (r.data.plan as any).id,
    compatibility_ack: compatibility(r.data.plan as any).fingerprint,
  });
  return { ...env, proposal: p.data.proposal as any };
}

describe("financial invariants", () => {
  it("conserves every micro-USDC and rejects imprecise inputs", () => {
    const pieces = allocate("999.999999", 6);
    assert.equal(
      pieces.reduce((n, x) => n.plus(x), D(0)).toFixed(6),
      "999.999999",
    );
    assert.throws(() =>
      inputs.set_preferences.parse({ ...pref, budget_usdc: "0.0000001" }),
    );
  });
  it("refuses stale and insufficient-budget candidates while both allows either market", () => {
    assert.throws(() =>
      recommend({ ...pref, budget_usdc: "20" }, [1, 2, 3].map(candidate)),
    );
    assert.equal(
      recommend({ ...pref, market: "both" }, [1, 2, 3, 4].map(candidate))
        .allocations.length,
      4,
    );
    assert.throws(() =>
      recommend(
        pref,
        [1, 2, 3, 4].map((i) => ({ ...candidate(i), expires_at: 0 })),
      ),
    );
  });
  it("checks gross concentration even when longs and shorts net to zero", () => {
    const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
    p.sleeves.forEach((s, i) => {
      const key = i < 3 ? "perps:BTC" : "perps:ETH";
      s.intents[key] = {
        key,
        asset: i < 3 ? "BTC" : "ETH",
        market: "perps",
        quantity: i === 1 ? "-1" : "1",
        price: "100",
        source_entry_price: "100",
        source_leverage: 5,
        source_revision: "v1",
        observed_at: now(),
      };
    });
    assert.equal(
      aggregate(p, snapshot().prices)[0].concentration_pct,
      "75.000000",
    );
    assert.throws(() => risk(p, snapshot().prices), /60%/);
  });
  it("caps suggested leverage by historical drawdown and excludes unverifiable risk", () => {
    const pool = [1, 2, 3, 4].map(candidate);
    pool[0].source_drawdown_pct = 6;
    const risky = { ...candidate(5), score: 100, source_drawdown_pct: 25 };
    const unknown = { ...candidate(6), score: 100, source_drawdown_pct: null };
    const plan = recommend(pref, [...pool, risky, unknown]);
    assert.ok(
      plan.allocations.some(
        (a) => a.trader.id === pool[0].id && a.leverage_cap === 3,
      ),
    );
    assert.ok(
      plan.allocations.every(
        (a) =>
          a.trader.source_drawdown_pct! * (a.leverage_cap ?? 1) <=
          pref.loss_trigger_pct,
      ),
    );
    assert.ok(
      plan.allocations.every(
        (a) => a.trader.id !== risky.id && a.trader.id !== unknown.id,
      ),
    );
    assert.throws(() => recommend({ ...pref, loss_trigger_pct: 1 }, pool));
  });
  it("does not net distinct prediction outcome tokens", () => {
    const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
    p.sleeves.slice(0, 2).forEach((s, i) => {
      const key = `prediction:outcome_${i}`;
      s.intents[key] = {
        key,
        asset: "EVENT",
        market: "prediction",
        quantity: "10",
        price: "0.5",
        source_entry_price: "0.5",
        source_leverage: 1,
        source_revision: "v1",
        observed_at: now(),
      };
    });
    assert.equal(
      aggregate(p, {
        "prediction:outcome_0": ".5",
        "prediction:outcome_1": ".5",
      }).length,
      2,
    );
  });
  it("conserves internal crosses and attributes partial fills, fees and funding once", () => {
    const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
    const key = "perps:BTC";
    for (const [i, q] of ["5", "-3"].entries()) {
      p.sleeves[i].intents[key] = {
        key,
        asset: "BTC",
        market: "perps",
        quantity: q,
        price: "100",
        source_entry_price: "100",
        source_leverage: 5,
        source_revision: "v1",
        observed_at: now(),
      };
    }
    const allocations = internalCross(p, key, "100");
    assert.equal(
      Object.values(allocations)
        .reduce((n, q) => n.plus(q), D(0))
        .toString(),
      "2",
    );
    p.executions.push({
      id: uid("execution"),
      key,
      target_quantity: "2",
      allocations,
      status: "submitted",
      revision: 0,
      fingerprint: "f",
      created_at: now(),
      expires_at: now() + 1000,
      task_id: "task_test",
      observed_quantity: null,
      reserve_usdc: "40",
      error: null,
    });
    const f = {
      id: "fill_1",
      order_id: "order_1",
      task_id: "task_test",
      key,
      quantity: "1",
      price: "100",
      fee_usdc: ".1",
      at: now(),
    };
    applyFill(p, f);
    applyFill(p, f);
    assert.equal(p.seen_fills.length, 1);
    applyFill(p, { ...f, id: "fill_2" });
    applyFunding(
      p,
      { id: "funding_1", key, amount_usdc: "-.2", at: now() },
      { [p.sleeves[0].copy_id]: "5", [p.sleeves[1].copy_id]: "-3" },
    );
    p.snapshot = {
      ...snapshot(),
      positions: { [key]: "2" },
      account_value_usdc: "499.6",
    };
    p.initial_equity = "500";
    p.reconciliation = "complete";
    assert.equal(reconcileQuantities(p), true);
    assert.equal(pnl(p).net_usdc, "-0.400000");
    assert.equal(
      pnl(p)
        .sleeves.reduce((n, s) => n.plus(s.net_usdc ?? 0), D(0))
        .toFixed(6),
      "-0.400000",
    );
  });
  it("shows incomplete account attribution as unavailable", () => {
    const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
    p.snapshot = snapshot();
    p.initial_equity = "490";
    p.reconciliation = "complete";
    assert.equal(pnl(p).net_usdc, null);
  });
  it("preserves every micro-USDC when fractional sleeve fees and funding are displayed", () => {
    const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
    let fee = D(".1"),
      funding = D("-.2");
    p.sleeves.slice(0, 3).forEach((s, i) => {
      const feeShare = i === 2 ? fee : D(".1").div(3);
      const fundingShare = i === 2 ? funding : D("-.2").div(3);
      fee = fee.minus(feeShare);
      funding = funding.minus(fundingShare);
      s.lots["perps:BTC"] = {
        key: "perps:BTC",
        asset: "BTC",
        market: "perps",
        quantity: "0",
        cost: "0",
        realized: "0",
        fees: feeShare.toString(),
        funding: fundingShare.toString(),
      };
    });
    p.snapshot = { ...snapshot(), account_value_usdc: "499.7" };
    p.initial_equity = "500";
    p.reconciliation = "complete";
    const profit = pnl(p);
    assert.equal(profit.net_usdc, "-0.300000");
    assert.equal(
      profit.sleeves.reduce((n, s) => n.plus(s.net_usdc!), D(0)).toFixed(6),
      profit.net_usdc,
    );
    assert.ok(profit.sleeves.every((s) => s.net_usdc !== "-0.000000"));
    assert.equal(profit.sleeves[3].net_usdc, "0.000000");
  });
  it("conserves exact exchange quantities across non-divisible partial fills without over-allocating an owner", () => {
    for (const [quantities, fills, decimals] of [
      [["-0.1", "-0.2", "-0.3"], ["-0.1", "-0.5"], 8],
      [["0.02", "0.02", "0.01"], ["0.04", "0.01"], 2],
    ] as const) {
      const p = fromPlan(recommend(pref, [1, 2, 3, 4].map(candidate)));
      const key = "perps:BTC";
      const owners = p.sleeves.slice(0, 3);
      owners.forEach((s, i) => {
        s.intents[key] = {
          key,
          asset: "BTC",
          market: "perps",
          quantity: quantities[i],
          price: "100",
          source_entry_price: "100",
          source_leverage: 5,
          source_revision: "v1",
          observed_at: now(),
        };
      });
      const e = {
        id: uid("execution"),
        key,
        target_quantity: quantities
          .reduce((n, q) => n.plus(q), D(0))
          .toString(),
        allocations: Object.fromEntries(
          owners.map((s, i) => [s.copy_id, quantities[i]]),
        ),
        status: "submitted" as const,
        revision: 0,
        fingerprint: "f",
        created_at: now(),
        expires_at: now() + 1000,
        task_id: "partial_task",
        observed_quantity: null,
        reserve_usdc: "1",
        error: null,
      };
      p.executions.push(e);
      p.snapshot = { ...snapshot(), quantity_decimals: { [key]: decimals } };
      let observed = D(0);
      fills.forEach((q, i) => {
        applyFill(p, {
          id: "partial_" + i,
          order_id: "order",
          task_id: e.task_id,
          key,
          quantity: q,
          price: "100",
          fee_usdc: ".01",
          at: now(),
        });
        observed = observed.plus(q);
        p.snapshot!.positions[key] = observed.toString();
        assert.equal(reconcileQuantities(p), true);
        owners.forEach((s, j) => {
          assert.ok(D(s.lots[key].quantity).abs().lte(D(quantities[j]).abs()));
          assert.ok(D(s.lots[key].quantity).decimalPlaces() <= decimals);
        });
      });
      assert.ok(Object.values(e.allocations).every((q) => D(q).isZero()));
      assert.equal(
        owners.reduce((n, s) => n.plus(s.lots[key].fees), D(0)).toFixed(6),
        "0.020000",
      );
    }
  });
});
describe("approval and ownership", () => {
  it("creates one portfolio under eight concurrent confirmations", async () => {
    const { api, repository, proposal } = await proposed();
    assert.equal(proposal.status, "requires_confirmation");
    await Promise.all(
      Array.from({ length: 8 }, () =>
        api.confirm("alice", proposal.id, proposal.preview_hash),
      ),
    );
    await repository.transact("alice", async (s) => {
      assert.equal(s.portfolios.length, 1);
      assert.equal(s.portfolios[0].revision, 1);
      assert.equal(
        s.updates.filter((x) => x.kind === "proposal_confirmed").length,
        1,
      );
    });
  });
  it("rejects cross-user access, edited previews, expired proposals and changed balances", async () => {
    const { api, repository, adapter, proposal } = await proposed();
    await assert.rejects(api.proposal("bob", proposal.id), /not found/);
    await assert.rejects(
      api.confirm("alice", proposal.id, "f".repeat(64)),
      /displayed/,
    );
    adapter.snap.available_usdc = "499";
    await assert.rejects(
      api.confirm("alice", proposal.id, proposal.preview_hash),
      /Available funds/,
    );
    adapter.snap.available_usdc = "500";
    await repository.transact("alice", async (s) => {
      s.proposals[0].expires_at = 0;
    });
    await assert.rejects(
      api.confirm("alice", proposal.id, proposal.preview_hash),
      /fresh proposal/,
    );
  });
  it("binds cursors to users and rejects leaked addresses", () => {
    const cursor = new Cursor("x".repeat(32));
    const t = cursor.encode("alice", 5, "u");
    assert.deepEqual(cursor.decode("alice", t), { at: 5, id: "u" });
    assert.throws(() => cursor.decode("bob", t));
    assert.throws(() =>
      publicResult(result({ trader: "0x" + "a".repeat(40) })),
    );
  });
  it("never retries an unresolved submission under a new identifier", async () => {
    const { api, repository, adapter, proposal } = await proposed();
    await api.confirm("alice", proposal.id, proposal.preview_hash);
    adapter.unknown = true;
    const runner = new AgentRunner(api);
    await runner.tick("alice");
    await runner.tick("alice");
    assert.equal(adapter.submitCount, 0);
    /* Fully offset basket is settled internally. */ await repository.transact(
      "alice",
      async (s) => {
        for (const sleeve of s.portfolios[0].sleeves) {
          sleeve.trader.direction = "long";
          sleeve.source_revision = null;
        }
      },
    );
    adapter.sourceRevision = "source_v2";
    await runner.tick("alice");
    const count = adapter.submitCount;
    assert(count > 0);
    await runner.tick("alice");
    assert.equal(adapter.submitCount, count);
  });
});
it("exposes serializable tools and a read-only directory subset", async () => {
  for (const readOnly of [false, true]) {
    const server = new McpServer({ name: "test", version: "1" });
    registerAgentTools(server, async () => result({}), readOnly);
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, readOnly ? 13 : 24);
    assert(tools.tools.every((t) => t.inputSchema.type === "object"));
    for (const name of [
      "get_preferences",
      "set_preferences",
      "recommend_traders",
      "browse_traders",
      "get_portfolio",
    ])
      assert.equal(
        tools.tools.find((t) => t.name === name)?._meta?.[
          "openai/outputTemplate"
        ],
        undefined,
      );
    if (!readOnly)
      assert.ok(
        tools.tools.find((t) => t.name === "start_copy")?._meta?.[
          "openai/outputTemplate"
        ],
      );
    await client.close();
    await server.close();
  }
});
