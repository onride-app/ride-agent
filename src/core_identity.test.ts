import assert from "node:assert/strict";
import { it } from "node:test";
import { validateCoreIdentity } from "./core_identity.js";
import { requestContext } from "./request_diagnostics.js";
import { AgentError } from "./agent/contracts.js";

for (const [reason, response] of [
  ["CORE_HTTP_FAILURE", () => new Response("private-body", { status: 503 })],
  ["CORE_INVALID_JSON", () => new Response("private-not-json")],
  ["CORE_INVALID_RESPONSE", () => Response.json(null)],
  ["CORE_INVALID_ERRORS", () => Response.json({ errors: "private-invalid" })],
  [
    "CORE_GRAPHQL_ERROR",
    () =>
      Response.json({
        errors: [
          {
            message: "private-db",
            extensions: { code: "private-code" },
            path: ["private-field"],
          },
        ],
      }),
  ],
  [
    "CORE_SUMMARY_RESOLVER_ERROR",
    () =>
      Response.json({
        errors: [{ message: "private-db", path: ["copyTradeSummary"] }],
      }),
  ],
  [
    "CORE_IDENTITY_RESOLVER_ERROR",
    () => Response.json({ errors: [{ message: "private-db", path: ["me"] }] }),
  ],
  [
    "CORE_SUMMARY_MISSING",
    () => Response.json({ data: { me: { id: "private-owner" } } }),
  ],
  [
    "CORE_IDENTITY_MISSING",
    () => Response.json({ data: { copyTradeSummary: {} } }),
  ],
  [
    "ACCESS_TOKEN_EXPIRED",
    () =>
      Response.json({
        errors: [
          {
            message: "private-expired",
            extensions: { code: "ACCESS_TOKEN_EXPIRED" },
          },
        ],
      }),
  ],
] as const) {
  it(`correlates ${reason} using only safe fixed identity diagnostics`, async (t) => {
    const logs: string[] = [];
    const requestId = "8e613e23-b8fe-46a4-843e-cbb969b2ed77";
    t.mock.method(console, "error", (text: string) => logs.push(text));
    t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(
      requestContext.run({ request_id: requestId }, () =>
        validateCoreIdentity(
          "private-token",
          "https://private-url.invalid/graphql?secret=private-secret",
        ),
      ),
      (error: unknown) =>
        error instanceof AgentError && error.details?.reason_code === reason,
    );
    assert.equal(logs.length, 1);
    const log = JSON.parse(logs[0]);
    assert.equal(log.event, "core_identity_failure");
    assert.equal(log.request_id, requestId);
    assert.equal(log.reason_code, reason);
    assert(
      Object.keys(log).every((key) =>
        [
          "event",
          "request_id",
          "category",
          "reason_code",
          "error_code",
          "upstream_status",
        ].includes(key),
      ),
    );
    assert(!logs[0].includes("private"));
    assert(!logs[0].includes("AgentIdentity"));
  });
}

it("keeps network diagnostics fixed and does not let a failing logger replace the Core error", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("private network credential");
  });
  t.mock.method(console, "error", () => {
    throw new Error("logger failure");
  });
  await assert.rejects(
    validateCoreIdentity("private-token", "https://private.invalid"),
    (error: unknown) =>
      error instanceof AgentError &&
      error.code === "BACKEND_UNAVAILABLE" &&
      error.details?.reason_code === "CORE_NETWORK_UNAVAILABLE",
  );
});
