import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgentTools, RESOURCE_URI } from "./mcp.js";
import { AgentError, result } from "./contracts.js";
import { claudeCardDomain } from "./card_hosts.js";

it("read-only card tool renders a no-execution demo or owned proposal and never exposes human approval tools", async () => {
  let calls = 0,
    reads = 0;
  const app = express();
  app.use(express.json());
  app.post("/mcp", async (req, res) => {
    req.auth = {
      token: "fixture-mcp",
      clientId: "fixture",
      scopes: ["ride:read"],
      extra: { rideAuthToken: "never-expose-core" },
    };
    const server = new McpServer({
      name: "confirmation-fixture",
      version: "1",
    });
    registerAgentTools(
      server,
      async () => {
        calls++;
        return result({});
      },
      false,
      {
        base: "https://ride.test",
        readProposal: async (id, extra) => {
          assert.equal(extra.authInfo.extra.rideAuthToken, "never-expose-core");
          reads++;
          if (id !== "proposal_owned_fixture_00000000")
            throw new AgentError("NOT_FOUND", "Not found", false, 404);
          return result({ proposal: { id, status: "confirmed" } });
        },
      },
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const client = new Client({ name: "card-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(listener.address() as any).port}/mcp`),
      ),
    );
    const tools = (await client.listTools()).tools;
    const card = tools.find((t) => t.name === "show_confirmation_card")!;
    assert.equal(card.annotations?.readOnlyHint, true);
    assert.equal((card._meta?.ui as any).resourceUri, RESOURCE_URI);
    assert.deepEqual((card._meta?.["openai/ui"] as any).entrypoints, [
      { type: "thread" },
    ]);
    assert(
      tools.every(
        (t) => !["confirm", "authorize", "revoke", "reject"].includes(t.name),
      ),
    );
    const demo = await client.callTool({
      name: card.name,
      arguments: { mode: "demo" },
    });
    assert.equal((demo.structuredContent as any).data.confirmation_demo, true);
    assert.equal((demo.structuredContent as any).data.funding_demo, true);
    assert.equal(
      (demo.structuredContent as any).data.proposal.confirmation_url,
      "https://ride.test/agent/card-demo",
    );
    assert(!JSON.stringify(demo).includes("never-expose-core"));
    assert.equal(calls, 0);
    assert.equal(reads, 0);
    const owned = await client.callTool({
      name: card.name,
      arguments: {
        mode: "proposal",
        proposal_id: "proposal_owned_fixture_00000000",
      },
    });
    assert.equal(
      (owned.structuredContent as any).data.proposal.status,
      "confirmed",
    );
    const other = await client.callTool({
      name: card.name,
      arguments: {
        mode: "proposal",
        proposal_id: "proposal_other_fixture_00000000",
      },
    });
    assert.equal(other.isError, true);
    const resource = await client.readResource({ uri: RESOURCE_URI });
    const item = resource.contents[0];
    assert.deepEqual((item._meta?.ui as any).csp.frameDomains, [
      "https://ride.test",
    ]);
    assert.equal(
      (item._meta?.ui as any).domain,
      claudeCardDomain("https://ride.test"),
    );
    assert(
      "text" in item &&
        item.text.includes('"confirmation_origin":"https://ride.test"'),
    );
    for (const uri of [
      "ui://ride/agent-v9-confirmation.html",
      "ui://ride/agent-v8-confirmation.html",
      "ui://ride/agent-v7-confirmation.html",
      "ui://ride/agent-v6-confirmation.html",
      "ui://ride/agent-v5-confirmation.html",
      "ui://ride/agent-v4-confirmation.html",
      "ui://ride/agent-v3.html",
    ]) {
      const legacy = (await client.readResource({ uri })).contents[0];
      assert.equal(legacy.mimeType, item.mimeType);
      assert.equal((legacy as any).text, (item as any).text);
      assert.deepEqual(legacy._meta, item._meta);
    }
    assert.equal(calls, 0);
    assert.equal(reads, 2);
  } finally {
    await client.close();
    listener.close();
    listener.closeAllConnections();
  }
});
