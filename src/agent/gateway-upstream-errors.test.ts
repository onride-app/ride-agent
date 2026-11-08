import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import ts from "typescript";
import express from "express";
import { createRideHttpApp } from "../http_security.js";
import { AgentError, failure, result } from "./contracts.js";
import { mountHumanConfirmation } from "./human.js";
import { invokeAgent } from "./mcp.js";

const marker = "upstream-private-fixture-never-expose";
const proxyError = {
  error: { code: "APP_AGENT_UNAVAILABLE", message: marker },
};
const brokenResponses: [string, () => Response][] = [
  ["proxy 503 JSON", () => Response.json(proxyError, { status: 503 })],
  [
    "proxy 502 HTML",
    () => new Response(`<html>${marker}</html>`, { status: 502 }),
  ],
  [
    "HTML with 200",
    () => new Response(`<html>${marker}</html>`, { status: 200 }),
  ],
  ["non-envelope JSON with 200", () => Response.json(proxyError)],
  ["truncated JSON", () => new Response('{"version":"3",', { status: 200 })],
  [
    "500 with success envelope",
    () => Response.json(result({}), { status: 500 }),
  ],
  [
    "response stream failure",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(marker));
          },
        }),
      ),
  ],
];

it("gateway Agent calls classify malformed/proxy replies as unavailable reads or original unknown-write/preview outcomes, without replay", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  for (const [scenario, makeResponse] of brokenResponses) {
    for (const operation of [
      "get_portfolio",
      "get_updates",
      "start_copy",
      "prepare_deposit",
      "recommend_traders",
      "recalculate_plan",
    ]) {
      let calls = 0;
      const request = invokeAgent(
        "https://fixture.invalid",
        "private-fixture-token",
        operation,
        {},
        (async () => {
          calls++;
          return makeResponse();
        }) as typeof fetch,
      );
      if (["get_portfolio", "get_updates"].includes(operation)) {
        await assert.rejects(
          request,
          (e: unknown) =>
            e instanceof AgentError &&
            e.code === "BACKEND_UNAVAILABLE" &&
            e.httpStatus === 503 &&
            e.retryable,
        );
      } else {
        const value = await request;
        const preview = ["recommend_traders", "recalculate_plan"].includes(
          operation,
        );
        assert.equal(
          value.error?.code,
          preview ? "PREVIEW_RESULT_UNKNOWN" : "REQUEST_RESULT_UNKNOWN",
          scenario + operation,
        );
        assert.equal(value.error?.retryable, false);
        assert.equal(JSON.stringify(value).includes(marker), false);
        if (preview)
          assert.equal(
            (value.data.recovery as any).replay_original_request,
            false,
          );
      }
      assert.equal(
        calls,
        1,
        `${scenario}: ${operation} must not retry an HTTP/body failure`,
      );
    }
  }
  assert.equal(JSON.stringify(logs).includes(marker), false);
  assert.equal(JSON.stringify(logs).includes("private-fixture-token"), false);
});

it("gateway preserves canonical business refusals and explicit auth status, including malformed auth bodies", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const status of [401, 403]) {
    for (const operation of [
      "get_portfolio",
      "start_copy",
      "recommend_traders",
    ]) {
      for (const body of [
        JSON.stringify(proxyError),
        "<html>auth denied</html>",
        '{"version":',
      ]) {
        const value = await invokeAgent(
          "https://fixture.invalid",
          "fixture",
          operation,
          {},
          (async () => new Response(body, { status })) as typeof fetch,
        );
        assert.equal(
          value.error?.code,
          status === 401 ? "AUTH_REQUIRED" : "ACCESS_DENIED",
        );
        assert.equal(value.error?.retryable, false);
        assert.equal(value.data.recovery, undefined);
      }
    }
  }
  for (const [status, code] of [
    [409, "FUNDING_PENDING"],
    [403, "READ_ONLY"],
    [503, "FUNDING_UNAVAILABLE"],
  ] as const) {
    const canonical = failure(
      new AgentError(code, "Canonical business refusal", false, status),
    );
    const value = await invokeAgent(
      "https://fixture.invalid",
      "fixture",
      "prepare_deposit",
      {},
      (async () => Response.json(canonical, { status })) as typeof fetch,
    );
    assert.deepEqual(value, canonical);
  }
  await assert.rejects(
    invokeAgent(
      "https://fixture.invalid",
      "fixture",
      "get_portfolio",
      {},
      (async () =>
        Response.json(
          result({ private_identity: "0x" + "a".repeat(40) }),
        )) as typeof fetch,
    ),
    { code: "PRIVATE_DATA" },
  );
});

async function humanFixture() {
  type Reply = {
    status: number;
    body: unknown;
    html?: boolean;
    truncate?: boolean;
  };
  let reply: Reply = { status: 503, body: proxyError },
    calls = 0;
  const upstream = express();
  upstream.use(express.json());
  upstream.post("/agent/human/:operation", (_req, res) => {
    calls++;
    res.status(reply.status);
    if (reply.truncate) res.type("json").end('{"version":"3",');
    else if (reply.html) res.type("html").end(String(reply.body));
    else res.json(reply.body);
  });
  const backend = upstream.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const app = createRideHttpApp("127.0.0.1"),
    gateway = app.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const base = `http://127.0.0.1:${(gateway.address() as any).port}`;
  mountHumanConfirmation(app, {
    base,
    backend: `http://127.0.0.1:${(backend.address() as any).port}`,
    cookieKey: "offline-fixture-cookie-key-".repeat(3),
    auth: {
      privyAppId: "fixture",
      privyClientId: "",
      jsSdkUrl: base + "/fixture-sdk",
      manualTokenAuthEnabled: false,
    },
    exchange: async () => ({ rideAuthToken: "offline-fixture-core-token" }),
  });
  return {
    set(value: Reply) {
      reply = value;
    },
    calls: () => calls,
    post(
      operation: string,
      body: unknown = {},
      headers: Record<string, string> = {
        Authorization: "Bearer offline-fixture-core-token",
      },
    ) {
      return fetch(`${base}/agent/human/${operation}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: base,
          ...headers,
        },
        body: JSON.stringify(body),
      });
    },
    close() {
      gateway.closeAllConnections();
      gateway.close();
      backend.closeAllConnections();
      backend.close();
    },
  };
}

it("human gateway fails malformed/proxy replies with typed503 and funding recovery guidance without replay or false invalid-input", async () => {
  const f = await humanFixture();
  try {
    for (const reply of [
      { status: 503, body: proxyError },
      { status: 502, body: `<html>${marker}</html>`, html: true },
      { status: 200, body: proxyError },
      { status: 200, body: null },
      { status: 200, body: null, truncate: true },
      { status: 500, body: result({}) },
    ]) {
      f.set(reply);
      for (const operation of [
        "portfolio",
        "updates",
        "funding",
        "funding_status",
        "confirm",
        "authorize",
        "funding_prepare",
        "funding_confirm",
        "funding_activate",
        "funding_activation_quote",
      ]) {
        const before = f.calls();
        const response = await f.post(operation);
        assert.equal(response.status, 503, operation);
        const value = await response.json();
        const read = [
          "portfolio",
          "updates",
          "funding",
          "funding_status",
        ].includes(operation);
        assert.equal(
          value.error.code,
          read ? "BACKEND_UNAVAILABLE" : "REQUEST_RESULT_UNKNOWN",
        );
        assert.equal(value.error.retryable, read);
        assert.equal(JSON.stringify(value).includes(marker), false);
        if (operation.startsWith("funding")) {
          assert.match(value.error.message, /未确认/);
          assert.match(value.error.message, /funding_status/);
          assert.match(value.error.message, /不要重复提交或签名/);
        }
        assert.equal(
          f.calls() - before,
          1,
          "human gateway never retries a possibly submitted request",
        );
      }
    }
  } finally {
    f.close();
  }
});

it("human auth remains authoritative and canonical business failures stay unchanged; unavailable embedded ownership reads never mint cookies", async () => {
  const f = await humanFixture();
  try {
    for (const status of [401, 403]) {
      for (const reply of [
        { status, body: proxyError },
        { status, body: "<html>denied</html>", html: true },
        { status, body: null, truncate: true },
      ]) {
        f.set(reply);
        const response = await f.post("funding_confirm");
        assert.equal(response.status, status);
        assert.equal(
          (await response.json()).error.code,
          status === 401 ? "AUTH_REQUIRED" : "ACCESS_DENIED",
        );
      }
    }
    for (const [status, code] of [
      [409, "FUNDING_PENDING"],
      [403, "READ_ONLY"],
      [503, "FUNDING_UNAVAILABLE"],
    ] as const) {
      const canonical = failure(
        new AgentError(code, "Canonical business refusal", false, status),
      );
      f.set({ status, body: canonical });
      const response = await f.post("funding_confirm");
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), canonical);
    }
    const deposit_id = "deposit_" + "a".repeat(32),
      login = {
        deposit_id,
        privyId: "fixture",
        privyAccessToken: "fixture",
        authProvider: "GOOGLE",
      };
    for (const status of [503, 401, 403]) {
      f.set({ status, body: proxyError });
      const response = await f.post("embedded-login", login, {
        "X-Ride-Embedded": "1",
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(
        (await response.json()).error.code,
        status === 503
          ? "BACKEND_UNAVAILABLE"
          : status === 401
            ? "AUTH_REQUIRED"
            : "ACCESS_DENIED",
      );
    }
  } finally {
    f.close();
  }
});

it("App business runtime does not import either gateway boundary module", async () => {
  const directory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const visited = new Set<string>();
  async function walk(file: string): Promise<void> {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    source.forEachChild((node) => {
      if (
        (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
        ts.isExportDeclaration(node)
      ) {
        const module = node.moduleSpecifier;
        if (module && ts.isStringLiteral(module) && module.text.startsWith("."))
          imports.push(module.text);
      }
    });
    for (const specifier of imports)
      await walk(
        path.resolve(path.dirname(file), specifier.replace(/\.js$/, ".ts")),
      );
  }
  await walk(path.join(directory, "app_runtime.ts"));
  assert.equal(visited.has(path.join(directory, "agent/mcp.ts")), false);
  assert.equal(visited.has(path.join(directory, "agent/human.ts")), false);
});
