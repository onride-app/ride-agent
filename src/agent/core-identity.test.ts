import assert from "node:assert/strict";
import { it } from "node:test";
import { validateCoreIdentity } from "./backend.js";
import { AgentError } from "./contracts.js";

const valid = {
  data: { me: { id: "fixture-user" }, copyTradeSummary: { totalConfigs: 0 } },
};

it("verifies an authenticated empty account without requiring holdings", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.equal(
        (init.headers as Record<string, string>).Authorization,
        "Bearer fixture-token",
      );
      assert.equal(init.redirect, "error");
      return Response.json(valid);
    },
  );
  assert.equal(
    await validateCoreIdentity("fixture-token", "https://core.example/graphql"),
    "fixture-user",
  );
});

for (const scenario of [
  {
    name: "HTTP 401",
    response: () => new Response("unauthorized", { status: 401 }),
    auth: true,
  },
  {
    name: "GraphQL UNAUTHENTICATED",
    response: () =>
      Response.json({ errors: [{ extensions: { code: "UNAUTHENTICATED" } }] }),
    auth: true,
  },
  {
    name: "GraphQL UNAUTHORIZED despite partial data",
    response: () =>
      Response.json({
        ...valid,
        errors: [{ extensions: { code: "UNAUTHORIZED" } }],
      }),
    auth: true,
  },
  {
    name: "HTTP 503 JSON",
    response: () =>
      Response.json({ error: "database unavailable" }, { status: 503 }),
  },
  {
    name: "HTTP 502 HTML",
    response: () => new Response("<html>Bad gateway</html>", { status: 502 }),
  },
  {
    name: "HTTP 429",
    response: () => new Response("rate limited", { status: 429 }),
  },
  {
    name: "GraphQL summary resolver failure",
    response: () =>
      Response.json({
        data: { me: { id: "fixture-user" } },
        errors: [
          {
            message: "private database detail",
            extensions: { code: "INTERNAL_SERVER_ERROR" },
          },
        ],
      }),
  },
  {
    name: "missing summary",
    response: () => Response.json({ data: { me: { id: "fixture-user" } } }),
  },
  {
    name: "missing identity",
    response: () => Response.json({ data: { copyTradeSummary: {} } }),
  },
  {
    name: "invalid identity type",
    response: () =>
      Response.json({ data: { me: { id: 42 }, copyTradeSummary: {} } }),
  },
  { name: "invalid JSON", response: () => new Response("invalid-json") },
  { name: "null payload", response: () => Response.json(null) },
  {
    name: "network failure",
    response: () => {
      throw new Error("private network detail");
    },
  },
]) {
  it(`classifies ${scenario.name} without leaking upstream details`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => scenario.response());
    await assert.rejects(
      validateCoreIdentity("fixture-token", "https://core.example/graphql"),
      (error: unknown) => {
        assert(error instanceof AgentError);
        assert.equal(
          error.code,
          scenario.auth ? "AUTH_REQUIRED" : "BACKEND_UNAVAILABLE",
        );
        assert.equal(error.httpStatus, scenario.auth ? 401 : 503);
        assert.equal(error.retryable, !scenario.auth);
        assert(!error.message.includes("private"));
        assert(!error.message.includes("fixture-token"));
        return true;
      },
    );
  });
}
