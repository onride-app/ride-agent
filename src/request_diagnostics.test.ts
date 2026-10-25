import assert from "node:assert/strict";
import { it } from "node:test";
import { once } from "node:events";
import express from "express";
import { requestDiagnostics } from "./request_diagnostics.js";

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
