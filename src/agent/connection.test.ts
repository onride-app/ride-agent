import assert from "node:assert/strict";
import { it } from "node:test";
import { fetchAgentResponse } from "./connection.js";
import { invokeAgent } from "./mcp.js";

const socketError = () =>
  new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
it("recovers one transient read connection with the original deadline", async () => {
  let calls = 0;
  const signal = AbortSignal.timeout(1000);
  const result = await fetchAgentResponse(
    (async (_url, init) => {
      assert.equal(init?.signal, signal);
      if (++calls === 1) throw socketError();
      return Response.json({ ok: true });
    }) as typeof fetch,
    new URL("https://ride.test"),
    { signal },
    "get_preferences",
  );
  assert.equal(calls, 2);
  assert.equal(result.status, 200);
});
it("bounds failures and never retries HTTP errors, deadlines or writes", async () => {
  for (const operation of [
    "recommend_traders",
    "recalculate_plan",
    "start_copy",
    "prepare_deposit",
    "set_preferences",
    "get_daily_checkin",
    "unknown",
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchAgentResponse(
        (async () => {
          calls++;
          throw socketError();
        }) as typeof fetch,
        new URL("https://ride.test"),
        {},
        operation,
      ),
    );
    assert.equal(calls, 1, operation);
  }
  let calls = 0;
  await assert.rejects(
    fetchAgentResponse(
      (async () => {
        calls++;
        throw socketError();
      }) as typeof fetch,
      new URL("https://ride.test"),
      {},
      "get_preferences",
    ),
  );
  assert.equal(calls, 2);
  for (const status of [401, 403, 429, 503]) {
    calls = 0;
    await fetchAgentResponse(
      (async () => {
        calls++;
        return new Response("error", { status });
      }) as typeof fetch,
      new URL("https://ride.test"),
      {},
      "get_preferences",
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(
    fetchAgentResponse(
      (async () => {
        calls++;
        throw new DOMException("timeout", "TimeoutError");
      }) as typeof fetch,
      new URL("https://ride.test"),
      {},
      "get_preferences",
    ),
  );
  assert.equal(calls, 1);
});
it("uncertain writes are not advertised as retryable or as a login failure", async () => {
  let calls = 0;
  const result = await invokeAgent(
    "https://ride.test",
    "fixture",
    "start_copy",
    {},
    (async () => {
      calls++;
      throw socketError();
    }) as typeof fetch,
  );
  assert.equal(calls, 1);
  assert.equal(result.error?.code, "REQUEST_RESULT_UNKNOWN");
  assert.equal(result.error?.retryable, false);
});
