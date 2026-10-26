import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";

import {
  createHealthPayload,
  createRideHttpApp,
  trustedProxyHopsFromEnv,
  MAX_HTTP_BODY_BYTES,
  requestBodyErrorHandler,
} from "./http_security.js";

describe("Ride MCP HTTP hardening", () => {
  const servers: Array<ReturnType<ReturnType<typeof createRideHttpApp>["listen"]>> =
    [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  async function startServer() {
    const app = createRideHttpApp("127.0.0.1");
    app.get("/health", (_req, res) => {
      res.set("Cache-Control", "no-store").json(
        createHealthPayload({
          oauthEnabled: true,
          publicSubmissionMode: false,
          chatgptCardsEnabled: true,
        }),
      );
    });
    app.post("/mcp", (_req, res) => res.json({ ok: true }));
    app.use(requestBodyErrorHandler);

    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("returns only public health status and required feature flags", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: "ride-mcp",
      oauthEnabled: true,
      publicSubmissionMode: false,
      chatgptCardsEnabled: true,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-powered-by"), null);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'none'/,
    );
  });

  it("rejects declared request bodies over the global limit", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "content-length": String(MAX_HTTP_BODY_BYTES + 1),
      },
      body: "x".repeat(MAX_HTTP_BODY_BYTES + 1),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "payload_too_large" });
  });

  it("normalizes JSON parser limit errors without leaking details", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(MAX_HTTP_BODY_BYTES + 1) }),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "payload_too_large" });
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  it("keeps MCP JSON requests above the OAuth limit working", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(33 * 1024) }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});


describe("proxy-aware rate limit identity", () => {
  it("trusts one Railway ingress hop and fails closed elsewhere", () => {
    assert.equal(trustedProxyHopsFromEnv({}), 0);
    assert.equal(trustedProxyHopsFromEnv({ RAILWAY_ENVIRONMENT_ID: "test" }), 1);
    assert.equal(trustedProxyHopsFromEnv({ RAILWAY_ENVIRONMENT_ID: "test", HTTP_TRUST_PROXY_HOPS: "0" }), 0);
    for (const value of ["true", "-1", "4", "1.0", "", " 1"]) {
      assert.throws(() => trustedProxyHopsFromEnv({ HTTP_TRUST_PROXY_HOPS: value }));
    }
  });

  it("uses the nearest forwarded client and ignores spoofed prefixes", async () => {
    const app = createRideHttpApp("127.0.0.1", 1);
    assert.equal(app.get("trust proxy"), 1);
    app.get("/ip", (req, res) => res.json({ ip: req.ip }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { "X-Forwarded-For": "192.0.2.1, 198.51.100.22" } });
      assert.deepEqual(await response.json(), { ip: "198.51.100.22" });
      const second = await fetch(`http://127.0.0.1:${port}/ip`, { headers: { "X-Forwarded-For": "192.0.2.99, 198.51.100.22" } });
      assert.deepEqual(await second.json(), { ip: "198.51.100.22" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
