import assert from "node:assert/strict";
import { it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentService } from "./service.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter, candidate } from "./fixtures.js";
import { registerAgentTools } from "./mcp.js";
import { copyRule } from "./conversation-presentation.js";

async function fixture() {
  const repo = new MemoryRepository(),
    adapter = new FakeAdapter();
  adapter.pool = Array.from({ length: 12 }, (_, i) => candidate(i + 1));
  const api = new AgentService(
    repo,
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  const call = async (
    name: Parameters<AgentService["tool"]>[1],
    args = {},
    user = "alice",
  ) => (await api.tool(user, name, args)).data as any;
  const initial = await call("recommend_traders", {
    preferences: {
      budget_usdc: "30",
      risk_tolerance: "medium",
      market: "perps",
    },
  });
  const state = () => repo.transact("alice", async (s) => structuredClone(s));
  return { repo, adapter, api, call, initial, state };
}
const ids = (p: any) => p.allocations.map((a: any) => a.trader.id);
const savedState = ({ discovery, ...saved }: any) => saved;

it("explains an empty live source without inventing alternatives or changing the saved plan", async () => {
  const { call, initial, adapter, repo, state } = await fixture();
  adapter.pool = [];
  await repo.transact("alice", async (s) => {
    s.discovery!.expires_at = 0;
  });
  const before = savedState(await state());
  const d = await call("browse_traders", {
    plan_id: initial.plan.id,
    exclude_selected: true,
  });
  assert.equal(d.candidate_availability.status, "source_empty");
  assert.equal(d.candidate_availability.source_count, null);
  assert.equal(d.plan_unchanged, true);
  assert.match(d.conversation_display.markdown, /来源暂未返回可用/);
  assert.doesNotMatch(d.conversation_display.markdown, /\| Trader \||两人方案/);
  assert.deepEqual(savedState(await state()), before);
  assert.equal(adapter.submitCount, 0);
});

it("browses and pages alternatives without replacing a four-trader plan, preferences or pinned selection", async () => {
  const { call, initial, state, adapter } = await fixture();
  const before = await state();
  const action = initial.conversation_display.next_actions.find(
    (a: any) => a.id === "browse_alternatives",
  );
  assert.equal(action.tool, "browse_traders");
  const first = await call("browse_traders", { ...action.arguments, limit: 2 });
  const second = await call("browse_traders", {
    ...action.arguments,
    limit: 2,
    cursor: first.candidates_meta.next_cursor,
  });
  for (const d of [first, second]) {
    assert.equal(d.plan_unchanged, true);
    assert.equal(d.base_plan_id, initial.plan.id);
    assert.equal(d.candidates_meta.total, 8);
    assert(d.candidates.every((c: any) => !ids(initial.plan).includes(c.id)));
    assert.match(d.conversation_display.markdown, /原 4 人方案.*保持不变/);
  }
  assert(
    !first.candidates.some((a: any) =>
      second.candidates.some((b: any) => a.id === b.id),
    ),
  );
  assert.deepEqual(savedState(await state()), savedState(before));
  assert.equal(adapter.submitCount, 0);
});

it("refreshes expired alternative discovery directly without generating a plan or changing saved preferences", async () => {
  const { call, initial, repo, state, adapter } = await fixture();
  await repo.transact("alice", async (s) => {
    s.discovery!.expires_at = 0;
  });
  const before = await state();
  const d = await call("browse_traders", {
    plan_id: initial.plan.id,
    exclude_selected: true,
  });
  assert.equal(d.plan_unchanged, true);
  const after = await state();
  assert.deepEqual(after.plans, before.plans);
  assert.deepEqual(after.preferences, before.preferences);
  assert.deepEqual(after.selected_trader_ids, before.selected_trader_ids);
  assert.notEqual(after.discovery!.id, before.discovery!.id);
  assert.equal(adapter.submitCount, 0);
  await assert.rejects(
    call(
      "browse_traders",
      { plan_id: initial.plan.id, exclude_selected: true },
      "bob",
    ),
    /not found/,
  );
});

it("one-for-one replacements preserve slot amounts, count, risk, copy mode and custom leverage while keeping the original immutable", async () => {
  const { call, initial, state, adapter } = await fixture();
  const configured = (
    await call("recalculate_plan", {
      plan_id: initial.plan.id,
      allocations: initial.plan.allocations.map((a: any, i: number) => ({
        trader_id: a.trader.id,
        amount_usdc: a.amount_usdc,
        leverage_cap: i === 0 ? 3 : null,
        stop_loss_pct: 18,
        copy_mode: "fixed",
        fixed_margin_usdc: "2",
        loss_policy: "pause_then_exit",
        emergency_exit_pct: 70,
      })),
    })
  ).plan;
  const fresh = adapter.pool.filter((c) => !ids(configured).includes(c.id));
  const d = await call("recalculate_plan", {
    plan_id: configured.id,
    replacements: [
      {
        outgoing_trader_id: configured.allocations[0].trader.id,
        incoming_trader_id: fresh[0].id,
      },
      {
        outgoing_trader_id: configured.allocations[2].trader.id,
        incoming_trader_id: fresh[1].id,
      },
    ],
  });
  assert.equal(d.plan.allocations.length, 4);
  assert.deepEqual(d.plan.preferences, configured.preferences);
  for (let i = 0; i < 4; i++) {
    for (const field of [
      "amount_usdc",
      "leverage_cap",
      "leverage_mode",
      "stop_loss_pct",
      "copy_mode",
      "fixed_margin_usdc",
      "loss_policy",
      "emergency_exit_pct",
    ])
      assert.equal(
        d.plan.allocations[i][field],
        configured.allocations[i][field],
        `${i}: ${field}`,
      );
  }
  assert.deepEqual(ids(d.plan), [
    fresh[0].id,
    ids(configured)[1],
    fresh[1].id,
    ids(configured)[3],
  ]);
  assert.equal(d.edit_kind, "one_for_one_replacement");
  assert.equal(d.plan_change.before_count, 4);
  assert.equal(d.plan_change.after_count, 4);
  assert.equal(d.plan_change.measured_portfolio_risk_improvement, null);
  assert.deepEqual(
    (await state()).plans.find((p) => p.id === configured.id),
    configured,
  );
  assert.equal(adapter.submitCount, 0);
});

it("rejects ambiguous, duplicate, non-owned and ineligible swaps atomically", async () => {
  const { call, initial, state, adapter } = await fixture();
  const out = ids(initial.plan)[0],
    incoming = adapter.pool.find((c) => !ids(initial.plan).includes(c.id))!.id;
  const replacement = { outgoing_trader_id: out, incoming_trader_id: incoming };
  const before = await state();
  for (const args of [
    { replacements: [replacement, replacement] },
    {
      replacements: [{ ...replacement, outgoing_trader_id: "trader_missing" }],
    },
    {
      replacements: [
        { ...replacement, incoming_trader_id: ids(initial.plan)[1] },
      ],
    },
    { replacements: [replacement], preferences: { basket_size: 2 } },
    { replacements: [replacement], allocations: [] },
  ])
    await assert.rejects(
      call("recalculate_plan", { plan_id: initial.plan.id, ...args }),
    );
  adapter.pool.find((c) => c.id === incoming)!.eligibility = "REJECT";
  await assert.rejects(
    call("recalculate_plan", {
      plan_id: initial.plan.id,
      replacements: [replacement],
    }),
  );
  assert.deepEqual(savedState(await state()), savedState(before));
  assert.equal(adapter.submitCount, 0);
});

it("changes trader count only through an explicit allocation edit and reports capital concentration without a risk-improvement claim", async () => {
  const { call, initial } = await fixture();
  const d = await call("recalculate_plan", {
    plan_id: initial.plan.id,
    allocations: initial.plan.allocations
      .slice(0, 2)
      .map((a: any) => ({ trader_id: a.trader.id, amount_usdc: "15" })),
  });
  assert.equal(d.plan.allocations.length, 2);
  assert.equal(d.edit_kind, "explicit_edit");
  assert.equal(
    d.plan_change.capital_concentration.before_max_weight_pct,
    "25.000000",
  );
  assert.equal(
    d.plan_change.capital_concentration.after_max_weight_pct,
    "50.000000",
  );
  assert.equal(d.plan_change.measured_portfolio_risk_improvement, null);
  assert.match(d.conversation_display.markdown, /4 人 → 2 人/);
  assert.doesNotMatch(
    d.conversation_display.markdown,
    /risk.focused|风险已降低|更安全/,
  );
});

it("reads brief/detailed explanations of an exact immutable plan even after a newer plan exists, without regenerating either", async () => {
  const { call, initial, state } = await fixture();
  const newer = await call("recalculate_plan", {
    plan_id: initial.plan.id,
    preferences: { budget_usdc: "40" },
  });
  const before = await state();
  const detailed = await call("get_portfolio", {
    plan_id: initial.plan.id,
    detail: "detailed",
  });
  assert.equal(detailed.conversation_display.plan_id, initial.plan.id);
  assert.equal(detailed.plan.preferences.budget_usdc, "30");
  assert.doesNotMatch(JSON.stringify(detailed), /目标数量 = 源仓位数量/);
  assert.equal(detailed.conversation_display.analysis_depth, "summary");
  const calculation = await call("get_portfolio", {
    plan_id: initial.plan.id,
    detail: "detailed",
    include_calculations: true,
  });
  assert.match(
    calculation.conversation_display.markdown,
    /目标数量 = 源仓位数量/,
  );
  const brief = await call("get_portfolio", { plan_id: newer.plan.id });
  assert.equal(brief.conversation_display.detail, "brief");
  assert.match(brief.conversation_display.markdown, /原方案保留/);
  assert.equal(brief.plan_change.base_plan_id, initial.plan.id);
  assert.deepEqual(savedState(await state()), savedState(before));
  await assert.rejects(
    call("get_portfolio", { plan_id: initial.plan.id }, "bob"),
    /not found/,
  );
});

it("keeps default output short with every selected trader, concrete copy rules and expandable details", async () => {
  const { initial } = await fixture();
  const d = initial.conversation_display;
  assert.equal(d.detail, "brief");
  assert.equal((d.markdown.match(/\| Trader \|/g) ?? []).length, 1);
  for (const a of initial.plan.allocations)
    assert(d.markdown.includes(a.trader.handle));
  assert(d.markdown.length < 1300);
  assert.match(d.markdown, /分配资金与源账户权益的比例/);
  assert.match(d.markdown, /不足最小下单额则跳过/);
  assert.match(d.markdown, /分析这组 trader/);
  assert.doesNotMatch(d.markdown, /目标数量 =|2.Trader Alternative|两人替代/);
  for (const row of initial.final_review.traders) {
    assert.equal(row.copy_rule.allocated_usdc, "7.500000");
    assert.equal(row.copy_rule.next_order_size, null);
    assert.equal(
      row.copy_rule.sizing_basis,
      "allocation_over_verified_source_equity",
    );
  }
  const fixed = copyRule({
    ...initial.plan.allocations[0],
    copy_mode: "fixed",
    fixed_margin_usdc: "2",
  });
  const proportional = copyRule({
    ...initial.plan.allocations[0],
    copy_mode: "proportional",
    proportional_multiplier: 1.5,
  });
  assert.match(fixed.summary, /经核实的源开仓使用 2 USDC/);
  assert.match(proportional.summary, /1.5 倍/);
});

it("exposes additive parameters and serializable brief display through the MCP boundary", async () => {
  const { api, initial, state } = await fixture();
  const server = new McpServer({ name: "alternative-test", version: "1" });
  registerAgentTools(server, (name, args) => api.tool("alice", name, args));
  const client = new Client({ name: "alternative-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = (await client.listTools()).tools;
    assert(
      (
        tools.find((t) => t.name === "browse_traders")!.inputSchema
          .properties as any
      ).exclude_selected,
    );
    assert(
      (
        tools.find((t) => t.name === "recalculate_plan")!.inputSchema
          .properties as any
      ).replacements,
    );
    const before = await state();
    const r = await client.callTool({
      name: "browse_traders",
      arguments: { plan_id: initial.plan.id, exclude_selected: true },
    });
    assert.equal(r.isError, false);
    const data = (r.structuredContent as any).data;
    assert.equal(data.conversation_display.detail, "brief");
    assert.equal(data.base_plan_id, initial.plan.id);
    assert.equal(
      JSON.parse((r as any).content[0].text).data.conversation_display.markdown,
      data.conversation_display.markdown,
    );
    assert.deepEqual(savedState(await state()), savedState(before));
  } finally {
    await client.close();
    await server.close();
  }
});
