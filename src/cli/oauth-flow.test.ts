import { it } from "node:test";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { AgentService } from "../agent/service.js";
import { MemoryRepository, Cursor } from "../agent/repository.js";
import { FakeAdapter, candidate } from "../agent/fixtures.js";
import { backendApp } from "../agent/backend.js";
import { mountAgentProxy } from "../agent/http.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { RideOAuthProvider, createRideOAuthApprovalRouter } from "../oauth.js";
import { createRideHttpApp } from "../http_security.js";
import { login, loadSession, accessToken, saveSession } from "./session.js";
it("completes SDK OAuth PKCE through the loopback callback and refreshes without browser access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ride-oauth-"));
  const old = process.env.RIDE_CONFIG_DIR;
  process.env.RIDE_CONFIG_DIR = dir;
  const app = createRideHttpApp("127.0.0.1");
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const addr = listener.address();
  if (!addr || typeof addr === "string") throw Error("No port");
  const base = new URL(`http://127.0.0.1:${addr.port}`);
  const provider = new RideOAuthProvider({
    validateRideToken: async (token) => ({ subject: token }),
    exchangePrivyToken: async (input) => ({
      rideAuthToken: "core-test-session",
      identity: { subject: input.privyId },
    }),
    authPage: {
      privyAppId: "test",
      privyClientId: "test",
      jsSdkUrl: "https://example.invalid/privy.js",
      manualTokenAuthEnabled: false,
    },
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      baseUrl: base,
      resourceServerUrl: new URL("/mcp", base),
      scopesSupported: ["ride:read", "ride:trade"],
    }),
  );
  app.use(createRideOAuthApprovalRouter(provider));
  app.post("/mcp", (_req, res) =>
    res
      .status(401)
      .set(
        "WWW-Authenticate",
        `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(new URL("/mcp", base))}"`,
      )
      .json({ error: "auth_required" }),
  );
  const venue = new FakeAdapter();
  venue.pool = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const service = new AgentService(
    new MemoryRepository(),
    venue,
    base.href,
    new Cursor("c".repeat(32)),
  );
  const backend = backendApp(service, async (token) => {
    assert.equal(token, "core-test-session");
    return "alice";
  }).listen(0, "127.0.0.1");
  await once(backend, "listening");
  const backendAddr = backend.address();
  if (!backendAddr || typeof backendAddr === "string")
    throw Error("No backend port");
  mountAgentProxy(
    app,
    requireBearerAuth({ verifier: provider }),
    `http://127.0.0.1:${backendAddr.port}`,
  );
  try {
    await login(new URL("/mcp", base).href, true, async (url) => {
      const q = new URL(url).searchParams;
      assert.equal(
        (await provider.clientsStore.getClient(q.get("client_id")!))
          ?.client_name,
        "Rider",
      );
      assert.equal(q.get("code_challenge_method"), "S256");
      assert(q.get("state"));
      const request = {
        client_id: q.get("client_id"),
        redirect_uri: q.get("redirect_uri"),
        code_challenge: q.get("code_challenge"),
        scope: q.get("scope"),
        resource: q.get("resource"),
        state: q.get("state"),
        privy_id: "alice",
        privy_access_token: "privy-test",
        wallet_address: "0x" + "1".repeat(40),
        privy_wallet_id: "wallet-test",
        auth_provider: "GOOGLE",
      };
      const response = await fetch(new URL("/auth/privy/approve", base), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 200);
      const { redirectUrl } = (await response.json()) as any;
      const invalid = new URL(redirectUrl);
      invalid.searchParams.set("state", "wrong");
      assert.equal((await fetch(invalid)).status, 400);
      assert.equal((await fetch(redirectUrl)).status, 200);
    });
    const session = (await loadSession())!;
    assert.equal(session.server, new URL("/mcp", base).href);
    assert(session.tokens?.access_token);
    assert(session.tokens?.scope?.includes("ride:trade"));
    assert.equal((await stat(join(dir, "session.json"))).mode & 0o777, 0o600);
    // Real OAuth, HTTP gateway and backend; only external identity/venue are fixtures.
    const call = async (operation: string, body = {}) => {
      const response = await fetch(new URL(`/agent/v1/${operation}`, base), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken(session)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as any;
    };
    let preferences = await call("get_preferences");
    assert.deepEqual(preferences.data.preference_collection.missing_fields, [
      "budget_usdc",
      "risk_tolerance",
    ]);
    assert.equal(
      (await call("recommend_traders")).status,
      "requires_preferences",
    );
    await call("set_preferences", { budget_usdc: "600" });
    preferences = await call("get_preferences");
    assert.deepEqual(preferences.data.preference_collection.missing_fields, [
      "risk_tolerance",
    ]);
    await call("set_preferences", { risk_tolerance: "medium" });
    const recommendation = await call("recommend_traders");
    assert.equal(recommendation.status, "ok");
    assert(recommendation.data.recommended_portfolio.length > 0);
    assert.deepEqual(
      recommendation.data.recommended_portfolio.map((r: any) => r.trader_id),
      recommendation.data.recommended_trader_comparison.map(
        (r: any) => r.trader_id,
      ),
    );
    assert.equal(recommendation.data.final_review.execution_authorized, false);
    assert.equal(recommendation.data.plan.preferences.budget_usdc, "600");
    assert.equal(recommendation.data.plan.preferences.asset_category, "any");
    assert.equal(venue.submitCount, 0);
    const first = session.tokens!.access_token;
    session.expires_at = 0;
    await saveSession(session);
    const refreshed = await accessToken(session);
    assert.notEqual(refreshed, first);
    assert.deepEqual((await provider.verifyAccessToken(refreshed)).scopes, [
      "ride:read",
      "ride:trade",
    ]);
  } finally {
    backend.close();
    listener.close();
    if (old === undefined) delete process.env.RIDE_CONFIG_DIR;
    else process.env.RIDE_CONFIG_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
