import assert from "node:assert/strict";
import { it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  registerAgentTools,
  registerAppAccountRead,
  type McpOAuthContext,
} from "./mcp.js";
import {
  AgentError,
  failure,
  mutationTools,
  result,
  type Result,
} from "./contracts.js";

const oauth = {
  resourceMetadataUrl:
    "https://mcp.onride.me/.well-known/oauth-protected-resource/mcp",
};

async function withClient(
  invoke: () => Promise<Result>,
  check: (client: Client) => Promise<void>,
  auth: McpOAuthContext | undefined = oauth,
) {
  const server = new McpServer({ name: "auth-fixture", version: "1" });
  registerAgentTools(
    server,
    invoke,
    false,
    {
      base: "https://mcp.onride.me",
      readProposal: invoke,
    },
    auth,
  );
  registerAppAccountRead(server, invoke, auth);
  const client = new Client({ name: "auth-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    await check(client);
  } finally {
    await client.close();
    await server.close();
  }
}

it("publishes the exact OAuth scope for every hosted account tool, including cards", async () => {
  await withClient(
    async () => result({}),
    async (client) => {
      const tools = (await client.listTools()).tools;
      for (const tool of tools) {
        const scope = mutationTools.has(tool.name as any)
          ? "ride:trade"
          : "ride:read";
        assert.deepEqual(
          tool._meta?.securitySchemes,
          [{ type: "oauth2", scopes: [scope] }],
          tool.name,
        );
      }
      assert.equal(tools.length, 26);
    },
  );
});

for (const returned of [false, true]) {
  it(`signals ChatGPT reauthentication for ${returned ? "returned" : "thrown"} expired-session failures`, async () => {
    const error = new AgentError(
      "AUTH_REQUIRED",
      "Ride login expired",
      false,
      401,
    );
    await withClient(
      async () => {
        if (returned) return failure(error);
        throw error;
      },
      async (client) => {
        for (const name of ["get_preferences", "get_my_copies", "start_copy"]) {
          const response = await client.callTool({
            name,
            arguments:
              name === "start_copy" ? { plan_id: "plan_fixture_00000000" } : {},
          });
          assert.equal(response.isError, true);
          assert.equal(
            (response.structuredContent as any).error.code,
            "AUTH_REQUIRED",
          );
          const challenge = (
            response._meta?.["mcp/www_authenticate"] as string[]
          )[0];
          assert.match(challenge, /^Bearer /);
          assert.ok(
            challenge.includes(
              `resource_metadata="${oauth.resourceMetadataUrl}"`,
            ),
          );
          assert.ok(challenge.includes('error="invalid_token"'));
          assert.ok(
            challenge.includes(
              'error_description="Your Ride session has expired.',
            ),
          );
          assert.ok(
            challenge.includes(
              `scope="${name === "start_copy" ? "ride:trade" : "ride:read"}"`,
            ),
          );
          assert(!challenge.includes(error.message));
        }
      },
    );
  });
}

it("signals consent for missing scope and preserves the card resource metadata", async () => {
  await withClient(
    async () => {
      throw new AgentError("SCOPE_REQUIRED", "Missing ride:trade", false, 403);
    },
    async (client) => {
      const response = await client.callTool({
        name: "start_copy",
        arguments: { plan_id: "plan_fixture_00000000" },
      });
      assert.match(JSON.stringify(response._meta), /insufficient_scope/);
      const tools = (await client.listTools()).tools;
      assert.ok(
        tools.find((t) => t.name === "start_copy")?._meta?.[
          "openai/outputTemplate"
        ],
      );
      const card = await client.callTool({
        name: "show_confirmation_card",
        arguments: { mode: "demo" },
      });
      assert.match(JSON.stringify(card._meta), /insufficient_scope/);
    },
  );
});

it("does not prompt login for successful reads or non-auth failures", async () => {
  for (const value of [
    result({}),
    failure(new AgentError("BACKEND_UNAVAILABLE", "Retry later", true, 503)),
  ]) {
    await withClient(
      async () => value,
      async (client) => {
        const response = await client.callTool({
          name: "get_preferences",
          arguments: {},
        });
        assert.equal(response._meta?.["mcp/www_authenticate"], undefined);
        assert.equal(response.isError, !!value.error);
      },
    );
  }
});

it("keeps CLI stdio authentication separate from hosted OAuth linking", async () => {
  // Pass an explicit absent context without the helper's default parameter.
  const server = new McpServer({ name: "stdio-fixture", version: "1" });
  registerAgentTools(server, async () => {
    throw new AgentError("AUTH_REQUIRED", "Run ride login first", false, 401);
  });
  const client = new Client({ name: "stdio-client", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const tools = (await client.listTools()).tools;
    assert.ok(tools.every((t) => t._meta?.securitySchemes === undefined));
    const response = await client.callTool({
      name: "get_preferences",
      arguments: {},
    });
    assert.equal(response.isError, true);
    assert.equal(response._meta?.["mcp/www_authenticate"], undefined);
  } finally {
    await client.close();
    await server.close();
  }
});
