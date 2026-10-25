import assert from "node:assert/strict";
import { it } from "node:test";
import { invokeAgent } from "./mcp.js";
import { AgentService } from "./service.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter, candidate } from "./fixtures.js";

it("recovers a saved preview after losing its response without re-running recommendations or submitting trades", async () => {
  const adapter = new FakeAdapter();
  adapter.pool = [candidate(1), candidate(2)];
  const api = new AgentService(
    new MemoryRepository(),
    adapter,
    "https://ride.test",
    new Cursor("c".repeat(32)),
  );
  let calls = 0;
  let saved: any;
  const interrupted = (async (_url: unknown, init: RequestInit) => {
    calls++;
    saved = (
      await api.tool(
        "recovery-user",
        "recommend_traders",
        JSON.parse(init.body as string),
      )
    ).data;
    throw new Error("fixture response interrupted");
  }) as typeof fetch;
  const response = await invokeAgent(
    "https://backend.test",
    "fixture-token",
    "recommend_traders",
    {
      preferences: {
        budget_usdc: "600",
        risk_tolerance: "medium",
        market: "perps",
        basket_size: 2,
        loss_trigger_pct: 10,
      },
    },
    interrupted,
  );
  assert.equal(response.error?.code, "PREVIEW_RESULT_UNKNOWN");
  assert.equal(response.error?.retryable, false);
  assert.equal((response.data.recovery as any).replay_original_request, false);
  assert.equal(calls, 1);
  const recovered: any = (await api.tool("recovery-user", "get_portfolio", {}))
    .data;
  assert.equal(recovered.plan.id, saved.plan.id);
  assert.equal(recovered.recovery.read_only, true);
  assert.deepEqual(
    recovered.recommended_portfolio,
    saved.recommended_portfolio,
  );
  assert.deepEqual(
    recovered.recommended_trader_comparison,
    saved.recommended_trader_comparison,
  );
  assert.match(
    recovered.final_review.risk_setting_explanation,
    /60\.000000 USDC/,
  );
  assert.equal(recovered.final_review.risk_setting_source, "user");
  assert.equal(recovered.final_review.execution_authorized, false);
  assert.equal(adapter.submitCount, 0);
  const foreign = await api.tool("another-user", "get_portfolio", {});
  assert.equal(foreign.data.plan, undefined);
});

it("preserves actual authentication errors instead of suggesting preview recovery", async () => {
  const response = await invokeAgent(
    "https://backend.test",
    "fixture-token",
    "recommend_traders",
    {},
    (async () =>
      Response.json(
        {
          version: "3",
          status: "failed",
          data: {},
          warnings: [],
          as_of: new Date().toISOString(),
          error: {
            code: "AUTH_REQUIRED",
            message: "expired",
            retryable: false,
          },
        },
        { status: 401 },
      )) as typeof fetch,
  );
  assert.equal(response.error?.code, "AUTH_REQUIRED");
  assert.equal(response.data.recovery, undefined);
});
