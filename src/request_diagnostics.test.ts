import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  recordMcpProtocolError,
  requestDiagnostics,
} from "./request_diagnostics.js";

async function fixture(configure: (app: ReturnType<typeof express>) => void) {
  const records: Record<string, unknown>[] = [];
  const app = express();
  app.use(express.json());
  app.use(requestDiagnostics("gateway", (record) => records.push(record)));
  configure(app);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("No port");
  return {
    records,
    url: `http://127.0.0.1:${addr.port}/mcp`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("distinguishes completed requests from disconnected responses without logging sensitive data", async () => {
  const records: Record<string, unknown>[] = [];
  const app = express();
  app.use(requestDiagnostics("gateway", (r) => records.push(r)));
  app.post("/mcp", (_req, res) => res.json({ ok: true }));
  app.post("/token", (_req, res) => res.destroy());
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("No port");
  try {
    const response = await fetch(
      `http://127.0.0.1:${addr.port}/mcp?secret=private-query`,
      {
        method: "POST",
        headers: { Authorization: "Bearer private-token" },
        body: "private-body",
      },
    );
    assert(response.headers.get("x-ride-request-id"));
    await response.text();
    await assert.rejects(
      fetch(`http://127.0.0.1:${addr.port}/token`, { method: "POST" }),
    );
    const finished = records.filter((r) => r.event === "ride_request_finished");
    assert.deepEqual(
      finished.map((r) => r.outcome),
      ["completed", "disconnected"],
    );
    assert.equal(finished[1].http_status, null);
    assert.equal(records.length, 4);
    assert(!JSON.stringify(records).includes("private"));
    assert.equal(records[0].request_id, records[1].request_id);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("captures an SDK direct HTTP 400 without relying on throw or its error callback", async () => {
  const f = await fixture((app) => {
    app.post("/mcp", async (req, res) => {
      const server = new McpServer({
        name: "diagnostics-fixture",
        version: "1",
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      // Deliberately do not call recordMcpProtocolError: the HTTP response itself
      // must expose a safe category even when the SDK directly ends the response.
      res.once("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  });
  try {
    const response = await fetch(f.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-01-26",
        authorization: "Bearer private-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "private-rpc-id",
        method: "ping",
      }),
    });
    assert.equal(response.status, 400);
    await response.text();
    const finished = f.records.find(
      (record) => record.event === "ride_request_finished",
    )!;
    assert.equal(finished.http_status, 400);
    assert.equal(finished.http_method, "POST");
    assert.equal(finished.rpc_method, "ping");
    assert.equal(finished.mcp_protocol_version, "2026-01-26");
    assert.equal(finished.mcp_protocol_supported, false);
    assert.equal(finished.accepts_json, true);
    assert.equal(finished.accepts_sse, true);
    assert.equal(finished.mcp_error_code, -32000);
    assert.equal(finished.mcp_error_category, "unsupported_protocol_version");
    assert.equal(
      finished.request_id,
      response.headers.get("x-ride-request-id"),
    );
    assert(!JSON.stringify(f.records).includes("private"));
  } finally {
    await f.close();
  }
});

it("classifies split write/end responses without logging sensitive RPC arguments, response data or headers", async () => {
  const f = await fixture((app) => {
    app.post("/mcp", (_req, res) => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: "private-response-id",
        error: {
          code: -32700,
          message: "Parse error: Invalid JSON-RPC message: private-error",
          data: { token: "private-response-token" },
        },
      });
      res.status(400).type("json");
      const midpoint = Math.floor(body.length / 2);
      res.write(Buffer.from(body.slice(0, midpoint)));
      res.end(new Uint8Array(Buffer.from(body.slice(midpoint))));
    });
  });
  try {
    await (
      await fetch(f.url + "?private-query=private-value", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer private-access-token",
          accept: "application/json, text/event-stream; private=private-value",
          "mcp-protocol-version": "private-version",
          "x-private-header": "private-secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "private-request-id",
          method: "tools/call",
          params: {
            name: "private-tool-name",
            arguments: {
              wallet: "private-wallet",
              token: "private-body-token",
            },
          },
        }),
      })
    ).text();
    const finished = f.records.find(
      (record) => record.event === "ride_request_finished",
    )!;
    assert.equal(finished.rpc_method, "tools/call");
    assert.equal(finished.mcp_protocol_version, "invalid");
    assert.equal(finished.mcp_error_code, -32700);
    assert.equal(finished.mcp_error_category, "invalid_jsonrpc");
    assert(!JSON.stringify(f.records).includes("private"));
  } finally {
    await f.close();
  }
});

it("restricts protocol metadata and SDK errors to fixed categories and known numeric codes", async () => {
  const f = await fixture((app) => {
    app.post("/mcp", (_req, res) => {
      recordMcpProtocolError(res, {
        code: 987654321,
        message: "private-original-error",
        stack: "private-stack",
        toJSON() {
          throw Error("Must not serialize errors");
        },
      });
      res.status(500).json({ error: "private-response" });
    });
  });
  try {
    for (const [method, version, expectedMethod, expectedVersion] of [
      ["initialize", "2025-11-25", "initialize", "2025-11-25"],
      ["private-rpc-method", "2026-02-30", "other", "invalid"],
    ]) {
      await (
        await fetch(f.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": version,
          },
          body: JSON.stringify({
            method,
            params: {
              protocolVersion: "private-init-version",
              arguments: "private-arguments",
            },
          }),
        })
      ).text();
      const finished = f.records
        .filter((record) => record.event === "ride_request_finished")
        .at(-1)!;
      assert.equal(finished.rpc_method, expectedMethod);
      assert.equal(finished.mcp_protocol_version, expectedVersion);
      if (method === "initialize")
        assert.equal(finished.initialize_protocol_version, "invalid");
      assert.equal(finished.mcp_error_code, undefined);
      assert.equal(finished.mcp_error_category, "transport_error");
    }
    const serialized = JSON.stringify(f.records);
    assert(!serialized.includes("private"));
    assert(!serialized.includes("987654321"));
  } finally {
    await f.close();
  }
});

it("combines a classified SDK callback with a direct response code while bounding response inspection", async () => {
  const f = await fixture((app) => {
    app.post("/mcp", (_req, res) => {
      recordMcpProtocolError(
        res,
        Error("Not Acceptable: private-accept-header"),
      );
      res
        .status(406)
        .type("json")
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "private-message" },
            id: null,
          }),
        );
    });
  });
  try {
    await (await fetch(f.url, { method: "POST" })).text();
    const finished = f.records.find(
      (record) => record.event === "ride_request_finished",
    )!;
    assert.equal(finished.mcp_error_code, -32000);
    assert.equal(finished.mcp_error_category, "not_acceptable");
    assert(!JSON.stringify(f.records).includes("private"));
  } finally {
    await f.close();
  }
});
