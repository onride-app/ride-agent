import assert from "node:assert/strict";
import { it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fingerprint, recommend, type Candidate } from "./domain.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import type { PlanReadEvidence } from "./read-evidence.js";
import { copyEvidenceOverlay, inspectPlanOrders } from "./order-precheck.js";
import { Cursor, MemoryRepository, PgRepository } from "./repository.js";
import { randomUUID } from "node:crypto";
import { AgentService } from "./service.js";
import { registerAgentTools } from "./mcp.js";
import type { VenueAdapter } from "./adapter.js";

function setup() {
  const assets = ["BTC", "ETH", "SOL", "HYPE"];
  const pool = assets.map(
    (asset, i) =>
      ({
        ...candidate(i + 1),
        assets: [asset],
        direction: "long",
      }) as Candidate,
  );
  const plan = recommend(
    {
      budget_usdc: "30",
      market: "perps",
      assets: [],
      allow_altcoins: true,
      loss_trigger_pct: 10,
      risk_tolerance: "medium",
      portfolio_kind: "basket",
      basket_size: 4,
    },
    pool,
  );
  const observed = Date.now();
  const evidence: PlanReadEvidence = {
    observed_at: observed,
    read_only: true,
    execution_authorized: false,
    sources: plan.allocations.map((a) => {
      const asset = a.trader.assets[0],
        key = `perps:${asset}`;
      return {
        trader_id: a.trader.id,
        status: "available",
        equity_basis: "standard_clearinghouse_account_value",
        equity_verified: true,
        account_mode: "standard",
        scope: "base_perps",
        coverage_complete: true,
        timestamp_basis: "read_completed_at",
        snapshot: {
          observed_at: observed,
          revision: `observed_${asset}`,
          account_value_usdc: "1000",
          complete: true,
          positions: [
            {
              key,
              asset,
              market: "perps",
              quantity: "20",
              price: "100",
              mark_price: "100",
              position_notional_usdc: "2000",
              position_notional_basis: "current_mark",
              source_entry_price: "100",
              source_leverage: 2,
              source_leverage_verified: true,
              observed_at: observed,
              source_revision: `observed_${asset}`,
            },
          ],
        },
      };
    }),
    market: {
      observed_at: observed,
      prices: Object.fromEntries(assets.map((a) => [`perps:${a}`, "100"])),
      max_leverages: Object.fromEntries(assets.map((a) => [`perps:${a}`, 8])),
      quantity_decimals: Object.fromEntries(
        assets.map((a) => [`perps:${a}`, 2]),
      ),
      min_notionals: Object.fromEntries(
        assets.map((a) => [`perps:${a}`, "10"]),
      ),
      coverage_complete: true,
      scope: "base_perps",
      product_planning_max_leverage: 40,
      legacy_candidate_venue_max_leverage_basis: "product_planning_envelope",
      reason_codes: [],
    },
  };
  return { plan, evidence };
}

it("inspects four saved 7.5-USDC allocations without equating collateral with order notional or promising execution", () => {
  const { plan, evidence } = setup(),
    before = structuredClone(plan),
    dataBefore = structuredClone(evidence);
  const result = inspectPlanOrders(plan, evidence, "en");
  assert.equal(result.status, "checked");
  assert.equal(result.plan_fingerprint, fingerprint(plan));
  assert.deepEqual(
    result.sleeves.map((s) => s.amount_usdc),
    ["7.500000", "7.500000", "7.500000", "7.500000"],
  );
  assert.deepEqual(
    result.orders.map((o) => o.target_quantity),
    ["0.15", "0.15", "0.15", "0.15"],
  );
  assert.deepEqual(
    result.orders.map((o) => o.order_notional_usdc),
    ["15.000000", "15.000000", "15.000000", "15.000000"],
  );
  assert(result.sleeves.every((s) => s.source_equity_usdc === "1000"));
  assert.equal(result.execution_authorized, false);
  assert.equal(result.account_conditions_verified, false);
  assert.equal(result.guarantee_of_fill, false);
  assert.equal(result.order_scope, "basket_net_from_flat_assumption");
  assert(result.not_checked.includes("available_collateral"));
  assert.deepEqual(plan, before);
  assert.deepEqual(evidence, dataBefore);
});

it("reports existing concentration rejection with the measured asset and limit without changing the plan", () => {
  const { plan, evidence } = setup();
  for (const s of evidence.sources.slice(1)) s.snapshot!.positions = [];
  const result = inspectPlanOrders(plan, evidence, "en");
  assert.equal(result.status, "blocked");
  assert.equal(result.risk_reason_code, "ASSET_CONCENTRATION");
  assert.equal(result.risk_reason!.concentration_pct, 100);
  assert.equal(result.risk_reason!.limit_pct, 60);
  assert.match(result.summary, /100%.*60%/);
  assert(result.orders.every((o) => o.status === "blocked"));
});

it("rounds down and reports a below-minimum opening without increasing an allocation or quantity", () => {
  const { plan, evidence } = setup();
  evidence.sources[0].snapshot!.positions[0].quantity = "12.123";
  const result = inspectPlanOrders(plan, evidence, "en");
  const first = result.orders.find(
    (o) => o.key === evidence.sources[0].snapshot!.positions[0].key,
  )!;
  assert.equal(first.target_quantity, "0.09");
  assert.equal(first.order_notional_usdc, "9.000000");
  assert.equal(first.reason_code, "BELOW_MINIMUM_NOTIONAL");
  assert.equal(plan.allocations[0].amount_usdc, "7.500000");
});

it("nets opposite sleeves before the new portfolio opening minimum and labels a zero net order", () => {
  const { plan, evidence } = setup();
  for (let i = 0; i < 4; i++) {
    const p = evidence.sources[i].snapshot!.positions[0];
    p.asset = i < 2 ? "BTC" : "ETH";
    p.key = `perps:${p.asset}`;
    p.quantity = i % 2 ? "-20" : "20";
  }
  const result = inspectPlanOrders(plan, evidence, "en");
  assert.equal(result.status, "checked");
  assert.equal(result.orders.length, 2);
  assert(
    result.orders.every(
      (o) =>
        o.target_quantity === "0" &&
        o.order_notional_usdc === "0.000000" &&
        o.status === "flat",
    ),
  );
  assert(result.sleeves.every((s) => s.status === "flat"));
});

it("retains the historical per-sleeve minimum for a plan without portfolio_kind", () => {
  const { plan, evidence } = setup();
  delete plan.preferences.portfolio_kind;
  for (let i = 0; i < 4; i++) {
    const p = evidence.sources[i].snapshot!.positions[0];
    p.asset = "BTC";
    p.key = "perps:BTC";
    p.quantity = "8";
  }
  const result = inspectPlanOrders(plan, evidence, "en");
  assert.equal(result.status, "blocked");
  assert.equal(result.orders.length, 0);
  assert(
    result.sleeves.every((s) => s.reason_code === "BELOW_MINIMUM_NOTIONAL"),
  );
});

it("keeps all basket checks incomplete for a missing, stale or unverified source and does not fabricate fixed-mode openings", () => {
  for (const kind of [
    "missing",
    "stale",
    "unified",
    "contradictory_unified",
    "fixed",
  ] as const) {
    const { plan, evidence } = setup();
    if (kind === "missing") evidence.sources[0].snapshot = null;
    if (kind === "stale") evidence.sources[0].snapshot!.observed_at -= 60_000;
    if (kind === "unified") {
      evidence.sources[0].status = "partial";
      evidence.sources[0].coverage_complete = false;
      evidence.sources[0].snapshot!.complete = false;
    }
    if (kind === "contradictory_unified") {
      evidence.sources[0].account_mode = "unified";
      evidence.sources[0].equity_basis = "unified_spot_usdc_total";
    }
    if (kind === "fixed") {
      plan.allocations[0].copy_mode = "fixed";
      plan.allocations[0].fixed_margin_usdc = "2";
    }
    const result = inspectPlanOrders(plan, evidence, "en"),
      overlay = copyEvidenceOverlay(result);
    assert.equal(result.status, "incomplete");
    assert.equal(result.orders.length, 0);
    assert(
      result.sleeves
        .slice(1)
        .every(
          (s) =>
            s.status === "incomplete" &&
            s.reason_code === "BASKET_EVIDENCE_INCOMPLETE",
        ),
    );
    assert(
      Object.values(overlay).every(
        (v) => v.next_order_size.status !== "checked",
      ),
    );
    if (kind !== "fixed")
      assert.equal(result.sleeves[0].source_equity_usdc, null);
  }
});

it("keeps expired plans immutable and matches English/Chinese numeric results", () => {
  const { plan, evidence } = setup();
  plan.expires_at = Date.now() - 1;
  const before = structuredClone(plan),
    en = inspectPlanOrders(plan, evidence, "en"),
    zh = inspectPlanOrders(plan, evidence, "zh");
  assert.equal(en.plan_status, "expired");
  assert.equal(zh.plan_status, "expired");
  assert.deepEqual(
    en.orders.map(({ reason, ...o }) => o),
    zh.orders.map(({ reason, ...o }) => o),
  );
  assert.deepEqual(
    en.sleeves.map(({ reason, positions, ...s }) => ({
      ...s,
      positions: positions.map(({ reason, ...p }) => p),
    })),
    zh.sleeves.map(({ reason, positions, ...s }) => ({
      ...s,
      positions: positions.map(({ reason, ...p }) => p),
    })),
  );
  assert.doesNotMatch(en.summary, /[\u4e00-\u9fff]/);
  assert.match(zh.summary, /只读|核对/);
  assert.deepEqual(plan, before);
});

it("rejects duplicate, scoped and non-finite positions even when called directly with contradictory verified flags", () => {
  for (const kind of ["duplicate", "scoped", "nan"] as const) {
    const { plan, evidence } = setup(),
      source = evidence.sources[0];
    if (kind === "duplicate")
      source.snapshot!.positions.push(
        structuredClone(source.snapshot!.positions[0]),
      );
    if (kind === "scoped") {
      source.snapshot!.positions[0].asset = "xyz:TSLA";
      source.snapshot!.positions[0].key = "perps:xyz:TSLA";
    }
    if (kind === "nan") source.snapshot!.positions[0].quantity = "NaN";
    const result = inspectPlanOrders(plan, evidence, "en");
    assert.equal(result.status, "incomplete");
    assert.equal(
      result.sleeves[0].reason_code,
      "SOURCE_POSITION_EVIDENCE_INCOMPLETE",
    );
    assert.equal(result.orders.length, 0);
  }
});

async function readService() {
  const { plan, evidence } = setup();
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  await repo.transact("alice", async (s) => {
    s.plans.push(plan);
    s.preferences = structuredClone(plan.preferences);
  });
  let writes = 0,
    unsafe = 0;
  repo.transact = async () => {
    writes++;
    throw Error("Inspection must use a repository read");
  };
  for (const method of [
    "preflight",
    "bind",
    "account",
    "source",
    "submit",
    "execution",
    "fence",
    "cancelIncreasing",
    "release",
    "notify",
    "fundingOperation",
    "activationCheck",
  ])
    (adapter as any)[method] = async () => {
      unsafe++;
      throw Error(`Unexpected ${method}`);
    };
  (adapter as VenueAdapter).readPlanEvidence = async () =>
    structuredClone(evidence);
  return {
    plan,
    evidence,
    repo,
    adapter,
    service: new AgentService(
      repo,
      adapter,
      "https://ride.test",
      new Cursor("p".repeat(32)),
    ),
    assertReadOnly() {
      assert.equal(writes, 0);
      assert.equal(unsafe, 0);
      assert.equal(adapter.submitCount, 0);
    },
  };
}

it("uses true account-scoped repository reads for prechecks and localized saved-plan views, with no unsafe adapter calls", async () => {
  const f = await readService(),
    before = await f.repo.read("alice");
  const [en, zh] = await Promise.all([
    f.service.tool("alice", "get_portfolio", {
      plan_id: f.plan.id,
      locale: "en",
    }),
    f.service.tool("alice", "get_portfolio", {
      plan_id: f.plan.id,
      locale: "zh",
    }),
  ]);
  assert.deepEqual(en.data.plan, f.plan);
  assert.deepEqual(zh.data.plan, f.plan);
  assert.doesNotMatch(
    (en.data.conversation_display as any).markdown,
    /[\u4e00-\u9fff]/,
  );
  assert.match(
    (zh.data.conversation_display as any).markdown,
    /组合|方案|交易员/,
  );
  assert.deepEqual(
    (en.data.order_precheck as any).orders.map(
      (o: any) => o.order_notional_usdc,
    ),
    ["15.000000", "15.000000", "15.000000", "15.000000"],
  );
  await assert.rejects(
    f.service.tool("bob", "preview_copy_orders", {
      plan_id: f.plan.id,
      locale: "en",
    }),
    /not found/,
  );
  assert.deepEqual(await f.repo.read("alice"), before);
  assert.deepEqual((await f.repo.read("bob")).plans, []);
  f.assertReadOnly();
});

it("returns source leverage and actual venue limits separately from the legacy planning cap, and localizes missing questions without writes", async () => {
  const f = await readService(),
    before = await f.repo.read("alice");
  f.adapter.profile = async () => ({
    ...structuredClone(f.plan.allocations[0].trader),
    venue_max_leverage: 40,
  });
  (f.adapter as VenueAdapter).readPlanEvidence = async (traders) => ({
    ...structuredClone(f.evidence),
    sources: structuredClone(
      f.evidence.sources.filter((s) =>
        traders.some((t) => t.id === s.trader_id),
      ),
    ),
  });
  const response = await f.service.tool("alice", "get_trader_profile", {
    trader_id: f.plan.allocations[0].trader.id,
    locale: "en",
  });
  const context = response.data.leverage_context as any;
  assert.equal((response.data.trader as any).venue_max_leverage, 40);
  assert.equal(
    context.legacy_venue_max_leverage_basis,
    "product_planning_envelope",
  );
  assert.equal(context.product_planning_max_leverage, 40);
  assert.equal(
    Object.values(context.actual_per_asset_venue_max_leverage)[0],
    8,
  );
  assert.equal(context.current_source_positions[0].source_leverage, 2);
  for (const locale of ["en", "zh"] as const) {
    const value = await f.service.tool("missing_user", "get_preferences", {
      locale,
    });
    const questions = (value.data.preference_collection as any).questions;
    assert.equal(questions.length, 2);
    if (locale === "en")
      assert.doesNotMatch(JSON.stringify(questions), /[\u4e00-\u9fff]/);
    else assert.match(questions[0].question, /投入/);
  }
  assert.deepEqual(await f.repo.users(), ["alice"]);
  assert.deepEqual(await f.repo.read("alice"), before);
  f.assertReadOnly();
});

it("exposes a read-only MCP inspection in both languages without changing the selected plan or invoking execution", async () => {
  const f = await readService(),
    before = await f.repo.read("alice");
  const server = new McpServer({
    name: "readonly-evidence-test",
    version: "1",
  });
  registerAgentTools(server, (name, args) =>
    f.service.tool("alice", name, args),
  );
  const client = new Client({ name: "readonly-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "preview_copy_orders",
    )!;
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    for (const locale of ["en", "zh"]) {
      const r = await client.callTool({
        name: "preview_copy_orders",
        arguments: { plan_id: f.plan.id, locale },
      });
      const value = r.structuredContent as any;
      assert.equal(value.data.order_precheck.execution_authorized, false);
      assert.equal(
        value.data.order_precheck.plan_fingerprint,
        fingerprint(f.plan),
      );
      assert.match(value.data.conversation_display.markdown, /15\.000000/);
      assert.match(value.data.conversation_display.markdown, /\|\n\| perps:/);
      if (locale === "en")
        assert.doesNotMatch(
          value.data.conversation_display.markdown,
          /[\u4e00-\u9fff]/,
        );
      else assert.match(value.data.conversation_display.markdown, /只读/);
    }
    assert.deepEqual(await f.repo.read("alice"), before);
    f.assertReadOnly();
  } finally {
    await client.close();
    await server.close();
  }
});

it(
  "leaves actual PostgreSQL rows and updated_at untouched and does not create a missing account during inspection",
  {
    skip: !process.env.RIDE_AGENT_TEST_DATABASE_URL,
  },
  async () => {
    const repository = new PgRepository(
      process.env.RIDE_AGENT_TEST_DATABASE_URL!,
    );
    const user = `readonly_${randomUUID()}`,
      missing = `missing_${randomUUID()}`;
    const { plan, evidence } = setup();
    const adapter = new FakeAdapter();
    (adapter as VenueAdapter).readPlanEvidence = async () =>
      structuredClone(evidence);
    const service = new AgentService(
      repository,
      adapter,
      "https://ride.test",
      new Cursor("q".repeat(32)),
    );
    await repository.migrate();
    try {
      await repository.transact(user, async (s) => {
        s.plans.push(plan);
      });
      const readRow = () =>
        repository.pool.query(
          "SELECT state, updated_at, xmin::text AS row_version FROM ride_agent_state WHERE user_id=$1",
          [user],
        );
      const before = (await readRow()).rows;
      await service.tool(user, "preview_copy_orders", {
        plan_id: plan.id,
        locale: "en",
      });
      await service.tool(user, "get_portfolio", {
        plan_id: plan.id,
        locale: "zh",
      });
      await assert.rejects(
        service.tool(missing, "preview_copy_orders", { plan_id: plan.id }),
        /not found/,
      );
      assert.deepEqual((await readRow()).rows, before);
      assert.equal(
        (
          await repository.pool.query(
            "SELECT user_id FROM ride_agent_state WHERE user_id=$1",
            [missing],
          )
        ).rowCount,
        0,
      );
      assert.equal(adapter.submitCount, 0);
    } finally {
      await repository.pool.query(
        "DELETE FROM ride_agent_state WHERE user_id=$1",
        [user],
      );
      await repository.close();
    }
  },
);
