import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { RideOAuthProvider } from "../oauth.js";
import { AgentError, failure, result } from "./contracts.js";
import { invokeAgent, registerAgentTools } from "./mcp.js";

it("keeps transport OAuth protection and returns a linking challenge when the upstream Ride login expires", async () => {
  let expired = true;
  const backend = express();
  backend.use(express.json());
  backend.post("/agent/v1/get_preferences", (req, res) => {
    assert.equal(
      req.headers.authorization,
      "Bearer fixture-private-ride-token",
    );
    if (expired)
      res
        .status(401)
        .json(
          failure(
            new AgentError("AUTH_REQUIRED", "Ride token expired", false, 401),
          ),
        );
    else
      res.json(
        result({
          preferences: { budget_usdc: "600", risk_tolerance: "medium" },
        }),
      );
  });
  const backendListener = backend.listen(0, "127.0.0.1");
  await once(backendListener, "listening");
  const backendUrl = `http://127.0.0.1:${(backendListener.address() as any).port}`;
  const provider = new RideOAuthProvider({
    validateRideToken: async () => ({ subject: "fixture-account" }),
    exchangePrivyToken: async () => {
      throw new Error("unused");
    },
    authPage: {
      privyAppId: "fixture",
      privyClientId: "fixture",
      jsSdkUrl: "https://example.invalid/privy.js",
      manualTokenAuthEnabled: false,
    },
  });
  const oauthClient = {
    client_id: "fixture-chat-client",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none" as const,
  };
  await provider.clientsStore.registerClient!(oauthClient);
  const code = await provider.completeAuthorization({
    clientId: oauthClient.client_id,
    redirectUri: oauthClient.redirect_uris[0],
    codeChallenge: "fixture-challenge",
    scope: "ride:read",
    rideAuthToken: "fixture-private-ride-token",
  });
  const tokens = await provider.exchangeAuthorizationCode(oauthClient, code);
  const oauth = {
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(
      new URL("https://ride.example/mcp"),
    ),
  };
  const app = express();
  app.use(express.json());
  app.post(
    "/mcp",
    requireBearerAuth({ verifier: provider, ...oauth }),
    async (req, res) => {
      const server = new McpServer({
        name: "hosted-auth-fixture",
        version: "1",
      });
      registerAgentTools(
        server,
        async (name, args, extra) => {
          if (!extra.authInfo?.scopes.includes("ride:read"))
            throw new AgentError(
              "SCOPE_REQUIRED",
              "Missing read permission",
              false,
              403,
            );
          return invokeAgent(
            backendUrl,
            extra.authInfo.extra.rideAuthToken,
            name,
            args,
          );
        },
        false,
        undefined,
        oauth,
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
    },
  );
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const url = new URL(
    `http://127.0.0.1:${(listener.address() as any).port}/mcp`,
  );
  const client = new Client({ name: "chat-fixture", version: "1" });
  try {
    for (const token of [undefined, "invalid-fixture-token"]) {
      const response = await fetch(url, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      assert.equal(response.status, 401);
      assert.ok(
        response.headers
          .get("www-authenticate")
          ?.includes(oauth.resourceMetadataUrl),
      );
    }
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    const rejected = await client.callTool({
      name: "get_preferences",
      arguments: {},
    });
    assert.equal(rejected.isError, true);
    const challenge = (rejected._meta?.["mcp/www_authenticate"] as string[])[0];
    assert.ok(challenge.includes(oauth.resourceMetadataUrl));
    assert.ok(challenge.includes('error="invalid_token"'));
    assert(!JSON.stringify(rejected).includes("fixture-private-ride-token"));
    // A recovered upstream identity resumes the original account read.
    expired = false;
    const recovered = await client.callTool({
      name: "get_preferences",
      arguments: {},
    });
    assert.equal(recovered.isError, false);
    assert.equal(recovered._meta?.["mcp/www_authenticate"], undefined);
    assert.deepEqual((recovered.structuredContent as any).data.preferences, {
      budget_usdc: "600",
      risk_tolerance: "medium",
    });
  } finally {
    await client.close();
    listener.close();
    listener.closeAllConnections();
    backendListener.close();
    backendListener.closeAllConnections();
  }
});
