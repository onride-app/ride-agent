#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GUIDE_INSTRUCTIONS, packagedGuide, registerGuide } from "./guide.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  RideOAuthProvider,
  InMemoryOAuthStateStore,
  createRedisOAuthStateStore,
  createRideOAuthApprovalRouter,
  RIDE_OAUTH_SCOPES,
  type PrivyAuthorizationInput,
} from "./oauth.js";
import { createRideHttpApp, requestBodyErrorHandler } from "./http_security.js";
import {
  registerAgentTools,
  registerAppAccountRead,
  invokeAgent,
} from "./agent/mcp.js";
import { invokeAccountRead } from "./account_reads.js";
import { mountAgentProxy } from "./agent/http.js";
import { mountHumanConfirmation } from "./agent/human.js";
import { redisHumanHandoffs } from "./agent/human_handoffs.js";
import { validateCoreIdentity } from "./agent/backend.js";
import { AgentError, mutationTools } from "./agent/contracts.js";
import { VERSION } from "./version.js";
import { requestDiagnostics } from "./request_diagnostics.js";
import { exchangePrivyForRide } from "./auth_exchange.js";

async function main(): Promise<void> {
  const required = (key: string) => {
    const v = process.env[key];
    if (!v) throw new Error(`${key} is required`);
    return v;
  };
  const host = process.env.HOST ?? "127.0.0.1",
    port = Number(process.env.PORT ?? 3333),
    base = new URL(required("PUBLIC_BASE_URL")),
    backend = required("RIDE_AGENT_BACKEND_URL"),
    graphql = required("RIDE_GRAPHQL_URL");
  if (
    base.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(base.hostname)
  )
    throw new Error("Public issuer must use HTTPS");
  if (
    !process.env.REDIS_URL &&
    !["127.0.0.1", "localhost"].includes(base.hostname)
  )
    throw new Error("Hosted OAuth requires Redis");
  const store = process.env.REDIS_URL
    ? await createRedisOAuthStateStore({ url: process.env.REDIS_URL })
    : new InMemoryOAuthStateStore();
  const config = {
    privyAppId: required("PRIVY_APP_ID"),
    privyClientId: process.env.PRIVY_CLIENT_ID ?? "",
    jsSdkUrl:
      process.env.PRIVY_JS_SDK_URL ??
      "https://esm.sh/@privy-io/js-sdk-core@0.67.0",
    manualTokenAuthEnabled: false,
  };
  const exchange = (input: PrivyAuthorizationInput) =>
    exchangePrivyForRide(input, graphql);
  const provider = new RideOAuthProvider({
    store,
    validateRideToken: async (token) => ({
      subject: await validateCoreIdentity(token, graphql),
    }),
    exchangePrivyToken: exchange,
    authPage: config,
  });
  const app = createRideHttpApp(host),
    resource = new URL("/mcp", base),
    oauth = {
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
    },
    auth = requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: oauth.resourceMetadataUrl,
    }),
    readOnly = process.env.RIDE_PUBLIC_SUBMISSION_MODE === "true";
  app.use(requestDiagnostics("gateway"));
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      baseUrl: base,
      resourceServerUrl: resource,
      scopesSupported: [...RIDE_OAUTH_SCOPES],
      resourceName: "Rider",
    }),
  );
  app.use(createRideOAuthApprovalRouter(provider));
  const accountRead = (
    name: "get_portfolio" | "get_my_copies",
    args: unknown,
    token: string,
  ) =>
    invokeAccountRead(name, args, token, graphql, () =>
      invokeAgent(backend, token, "get_portfolio", args),
    );
  mountAgentProxy(app, auth, backend, readOnly, accountRead);
  if (!readOnly) {
    mountHumanConfirmation(app, {
      backend,
      base: base.href,
      cookieKey: required("RIDE_AGENT_HUMAN_COOKIE_KEY"),
      auth: config,
      exchange,
      handoffs: process.env.REDIS_URL
        ? await redisHumanHandoffs(process.env.REDIS_URL)
        : undefined,
    });
  }
  app.get("/health", (_req, res) =>
    res.json({
      service: "ride-agent-mcp",
      version: "3",
      release: VERSION,
      public_submission_mode: readOnly,
    }),
  );
  app.post("/mcp", auth, async (req, res) => {
    const server = new McpServer(
      { name: "Rider", title: "Rider", version: VERSION },
      { instructions: GUIDE_INSTRUCTIONS },
    );
    registerGuide(server);
    registerAgentTools(
      server,
      async (name, args, extra) => {
        if (
          !extra.authInfo?.scopes?.includes(
            mutationTools.has(name) ? "ride:trade" : "ride:read",
          )
        )
          throw new AgentError(
            "SCOPE_REQUIRED",
            "Rider OAuth scope is missing.",
            false,
            403,
          );
        const token = extra.authInfo?.extra?.rideAuthToken;
        if (name === "get_portfolio" && typeof token === "string")
          return accountRead(name, args, token);
        return invokeAgent(
          backend,
          typeof token === "string" ? token : undefined,
          name,
          args,
        );
      },
      readOnly,
      {
        base: base.href,
        readProposal: (id, extra) =>
          invokeAgent(
            backend,
            extra.authInfo?.extra?.rideAuthToken,
            "proposal",
            { proposal_id: id },
          ),
      },
      oauth,
    );
    registerAppAccountRead(
      server,
      async (args, extra) => {
        if (!extra.authInfo?.scopes?.includes("ride:read"))
          throw new AgentError(
            "SCOPE_REQUIRED",
            "Missing ride:read permission.",
            false,
            403,
          );
        const token = extra.authInfo?.extra?.rideAuthToken;
        if (typeof token !== "string")
          throw new AgentError(
            "AUTH_REQUIRED",
            "A Ride OAuth session is required.",
            false,
            401,
          );
        return accountRead("get_my_copies", args, token);
      },
      oauth,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ error: "mcp_request_failed" });
    }
  });
  app.get("/mcp", (_req, res) =>
    res.status(405).json({ error: "method_not_allowed" }),
  );
  app.get("/ride/guide", async (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await packagedGuide());
    } catch {
      res.status(503).json({ error: "guide_unavailable" });
    }
  });
  app.use(requestBodyErrorHandler);
  app.listen(port, host, () =>
    console.error(`Rider listening on ${base.origin}/mcp`),
  );
}
main().catch(() => {
  console.error(
    "Rider startup failed. Check required OAuth and backend configuration.",
  );
  process.exitCode = 1;
});
