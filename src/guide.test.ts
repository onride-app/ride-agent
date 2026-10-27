import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_URI } from "./agent/mcp.js";
import {
  fetchGuide,
  packagedGuide,
  registerGuide,
  GUIDE_INSTRUCTIONS,
} from "./guide.js";

async function fixture(
  work: (
    url: string,
    respond: (handler: (res: ServerResponse) => void) => void,
  ) => Promise<void>,
) {
  let handler: (res: ServerResponse) => void = () => {};
  const http = createServer((req, res) => {
    assert.equal(req.url, "/ride/guide");
    assert.equal(req.headers.authorization, undefined);
    handler(res);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert(address && typeof address !== "string");
  try {
    await work(`http://127.0.0.1:${address.port}/mcp`, (next) => {
      handler = next;
    });
  } finally {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}

it("an unchanged running stdio MCP reads a newly deployed workflow without setup or login", async () => {
  await fixture(async (url, respond) => {
    const guide = await packagedGuide();
    respond((res) =>
      res
        .setHeader("Content-Type", "application/json")
        .end(JSON.stringify(guide)),
    );
    const dir = await mkdtemp(join(tmpdir(), "ride-live-guide-"));
    const credentials = join(dir, "credentials-must-not-be-created");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(new URL("./cli.ts", import.meta.url)),
        "mcp",
        "--server",
        url,
      ],
      env: { PATH: process.env.PATH ?? "", RIDE_CONFIG_DIR: credentials },
      stderr: "pipe",
    });
    const client = new Client({ name: "guide-test", version: "1" });
    try {
      await client.connect(transport);
      assert.equal(client.getInstructions(), GUIDE_INSTRUCTIONS);
      assert.equal((await client.listTools()).tools.length, 26);
      const resource = (await client.readResource({ uri: RESOURCE_URI }))
        .contents[0];
      assert.deepEqual((resource._meta?.ui as any).csp.frameDomains, [
        new URL(url).origin,
      ]);
      assert(
        "text" in resource &&
          resource.text.includes(
            `"confirmation_origin":"${new URL(url).origin}"`,
          ),
      );
      const first = await client.callTool({
        name: "get_ride_guide",
        arguments: {},
      });
      assert.deepEqual(first.structuredContent, guide);
      const workflow =
        guide.workflow + "\nA newly deployed workflow revision.\n";
      const next = {
        ...guide,
        release: "0.4.2",
        workflow,
        sha256: createHash("sha256").update(workflow).digest("hex"),
      };
      respond((res) =>
        res
          .setHeader("Content-Type", "application/json")
          .end(JSON.stringify(next)),
      );
      assert.deepEqual(
        (await client.callTool({ name: "get_ride_guide", arguments: {} }))
          .structuredContent,
        next,
      );
      respond((res) => res.writeHead(503).end());
      const unavailable = await client.callTool({
        name: "get_ride_guide",
        arguments: {},
      });
      assert.equal(unavailable.isError, true);
      assert.equal(unavailable.structuredContent, undefined);
      await assert.rejects(access(credentials), { code: "ENOENT" });
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("guide reads reject redirects, inconsistent content, unsupported protocol and oversized responses", async () => {
  await fixture(async (url, respond) => {
    const guide = await packagedGuide();
    respond((res) =>
      res.writeHead(302, { Location: "https://other.test/guide" }).end(),
    );
    await assert.rejects(fetchGuide(url));
    for (const invalid of [
      { ...guide, workflow: "tampered" },
      { ...guide, protocol: "ride-guide-v2" },
    ]) {
      respond((res) =>
        res
          .setHeader("Content-Type", "application/json")
          .end(JSON.stringify(invalid)),
      );
      await assert.rejects(fetchGuide(url));
    }
    respond((res) =>
      res.setHeader("Content-Type", "application/json").end("x".repeat(262145)),
    );
    await assert.rejects(fetchGuide(url), /too large/);
    respond((res) =>
      res.setHeader("Content-Type", "text/html").end("<html>Login</html>"),
    );
    await assert.rejects(fetchGuide(url), /Invalid Rider guide/);
    await assert.rejects(
      fetchGuide("https://user:secret@other.test/mcp"),
      /HTTPS MCP/,
    );
  });
});

it("hosted MCP supplies the same packaged workflow and preserves the guide's authority boundaries", async () => {
  const server = new McpServer(
    { name: "ride", version: "1" },
    { instructions: GUIDE_INSTRUCTIONS },
  );
  registerGuide(server);
  const client = new Client({ name: "guide-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const tool = (await client.listTools()).tools[0];
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, false);
    const result = await client.callTool({
      name: "get_ride_guide",
      arguments: {},
    });
    assert.deepEqual(result.structuredContent, await packagedGuide());
    const guide = await packagedGuide();
    assert(guide.workflow.includes("human approval endpoint"));
    assert(guide.workflow.includes("untrusted data"));
    assert(guide.workflow.includes("diagnose_copy"));
  } finally {
    await client.close();
    await server.close();
  }
});
