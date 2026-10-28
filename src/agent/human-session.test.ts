import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { it } from "node:test";
import express from "express";
import { createRideHttpApp } from "../http_security.js";
import { mountHumanConfirmation } from "./human.js";
import { MemoryHumanHandoffs } from "./human_handoffs.js";

const proposal = "proposal_fixture_12345678";
async function fixture() {
  let exchanges = 0,
    writes = 0;
  const providers: Array<string | undefined> = [];
  const downstream = express();
  downstream.use(express.json());
  downstream.post("/agent/human/:operation", (req, res) => {
    if (req.get("authorization") !== "Bearer fixture-core") {
      res.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      return;
    }
    if (["confirm", "reject", "authorize"].includes(req.params.operation))
      writes++;
    if (req.params.operation === "funding") {
      const owned = req.body.deposit_id === "deposit_" + "a".repeat(32);
      res.status(owned ? 200 : 404).json({
        version: "3",
        status: owned ? "requires_confirmation" : "failed",
        data: owned ? { funding: { deposit_id: req.body.deposit_id } } : {},
        warnings: [],
        as_of: new Date().toISOString(),
      });
      return;
    }
    res.json({
      version: "3",
      status: "ok",
      data: { operation: req.params.operation },
      warnings: [],
      as_of: new Date().toISOString(),
    });
  });
  const backend = downstream.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const app = createRideHttpApp("127.0.0.1"),
    handoffs = new MemoryHumanHandoffs();
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const base = `http://127.0.0.1:${(listener.address() as any).port}`;
  mountHumanConfirmation(app, {
    base,
    backend: `http://127.0.0.1:${(backend.address() as any).port}`,
    cookieKey: "fixture-secret-".repeat(4),
    handoffs,
    auth: {
      privyAppId: "fixture",
      privyClientId: "",
      jsSdkUrl: `${base}/fixture-sdk.js`,
      manualTokenAuthEnabled: false,
    },
    exchange: async (input) => {
      exchanges++;
      providers.push(input.authProvider);
      return { rideAuthToken: "fixture-core" };
    },
  });
  const post = (
    operation: string,
    body = {},
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/agent/human/${operation}`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const login = async () => {
    const r = await post("login", {
      privyId: "fixture",
      privyAccessToken: "fixture-privy",
    });
    assert.equal(r.status, 200);
    return {
      csrf: (await r.json()).csrf as string,
      cookie: r.headers.get("set-cookie")!.split(";")[0],
    };
  };
  return {
    base,
    post,
    login,
    handoffs,
    counts: () => ({ exchanges, writes }),
    providers: () => [...providers],
    close: () => {
      listener.close();
      listener.closeAllConnections();
      backend.close();
      backend.closeAllConnections();
    },
  };
}
it("restores an existing human cookie on multiple proposals without login, extending expiry, exposing Core JWTs, or writing", async () => {
  const f = await fixture();
  try {
    const session = await f.login();
    const restored = [];
    for (let i = 0; i < 2; i++) {
      const r = await f.post("session", {}, { Cookie: session.cookie });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("set-cookie"), null);
      const value = await r.json();
      assert.equal(value.csrf, session.csrf);
      assert(!JSON.stringify(value).includes("fixture-core"));
      restored.push(value.expires_at);
      assert.equal(
        (
          await f.post(
            "proposal",
            { proposal_id: proposal },
            { Cookie: session.cookie, "X-Ride-CSRF": value.csrf },
          )
        ).status,
        200,
      );
    }
    assert.equal(restored[0], restored[1]);
    assert.deepEqual(f.counts(), { exchanges: 1, writes: 0 });
  } finally {
    f.close();
  }
});
it("inline login verifies deposit ownership before issuing a scoped partitioned session; origin, scope and CSRF remain enforced", async () => {
  const f = await fixture();
  try {
    const deposit_id = "deposit_" + "a".repeat(32);
    const body = {
      deposit_id,
      privyId: "fixture",
      privyAccessToken: "fixture-privy",
      authProvider: "GOOGLE",
    };
    const login = (patch = {}, headers = {}) =>
      f.post(
        "embedded-login",
        { ...body, ...patch },
        { "X-Ride-Embedded": "1", ...headers },
      );
    const foreign = await login({}, { Origin: "https://foreign.test" });
    assert.equal(foreign.status, 403);
    assert.equal(f.counts().exchanges, 0);
    const other = await login({ deposit_id: "deposit_" + "b".repeat(32) });
    assert.equal(other.status, 404);
    assert.equal(other.headers.get("set-cookie"), null);
    const response = await login();
    assert.equal(response.status, 200);
    const cookieHeader = response.headers.get("set-cookie")!;
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /Partitioned/);
    const session = await response.json();
    assert(!JSON.stringify(session).includes("fixture-core"));
    const headers = {
      Cookie: cookieHeader.split(";")[0],
      "X-Ride-Embedded": "1",
      "X-Ride-CSRF": session.csrf,
    };
    assert.equal(
      (await f.post("funding", { deposit_id }, headers)).status,
      200,
    );
    assert.equal(
      (
        await f.post(
          "funding",
          { deposit_id: "deposit_" + "b".repeat(32) },
          headers,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.post("confirm", { proposal_id: proposal }, headers)).status,
      404,
    );
    assert.equal(
      (
        await f.post(
          "funding_confirm",
          { deposit_id },
          { ...headers, "X-Ride-CSRF": "wrong" },
        )
      ).status,
      403,
    );
    assert.equal(f.counts().writes, 0);
  } finally {
    f.close();
  }
});
it("session restoration rejects foreign origins, missing/tampered/expired cookies, and machine tokens; writes still require CSRF", async () => {
  const f = await fixture();
  try {
    const session = await f.login();
    for (const headers of [
      {},
      { Cookie: "ride_agent_human=invalid" },
      { Authorization: "Bearer ride_at_machine" },
    ] as Record<string, string>[])
      assert.equal((await f.post("session", {}, headers)).status, 401);
    assert.equal(
      (
        await f.post(
          "session",
          {},
          { Origin: "https://evil.test", Cookie: session.cookie },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.post("confirm", {}, { Cookie: session.cookie })).status,
      403,
    );
    const original = Date.now;
    try {
      Date.now = () => original() + 16 * 60_000;
      assert.equal(
        (await f.post("session", {}, { Cookie: session.cookie })).status,
        401,
      );
    } finally {
      Date.now = original;
    }
    assert.deepEqual(f.counts(), { exchanges: 1, writes: 0 });
  } finally {
    f.close();
  }
});
it("hands off a human session once to the same challenge/proposal and confines embedded cookies to proposal confirmation", async () => {
  const f = await fixture();
  try {
    const session = await f.login(),
      challenge = "a".repeat(64);
    assert.equal(
      (
        await f.post(
          "embed-ticket",
          { proposal_id: proposal, challenge },
          { Cookie: session.cookie },
        )
      ).status,
      403,
    );
    const r = await f.post(
      "embed-ticket",
      { proposal_id: proposal, challenge },
      { Cookie: session.cookie, "X-Ride-CSRF": session.csrf },
    );
    const { ticket } = await r.json();
    assert(ticket);
    const accepted = await f.post("embed-session", {
      ticket,
      challenge,
      proposal_id: proposal,
    });
    assert.equal(accepted.status, 200);
    const embedded = await accepted.json(),
      cookieHeader = accepted.headers.get("set-cookie")!;
    for (const attribute of [
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Partitioned",
    ])
      assert(cookieHeader.includes(attribute));
    const cookie = cookieHeader.split(";")[0];
    assert.equal(
      (
        await f.post("embed-session", {
          ticket,
          challenge,
          proposal_id: proposal,
        })
      ).status,
      401,
    );
    assert.equal((await f.post("session", {}, { Cookie: cookie })).status, 401);
    assert.equal(
      (await f.post("session", {}, { Cookie: cookie, "X-Ride-Embedded": "1" }))
        .status,
      200,
    );
    const headers = {
      Cookie: cookie,
      "X-Ride-Embedded": "1",
      "X-Ride-CSRF": embedded.csrf,
    };
    assert.equal(
      (await f.post("proposal", { proposal_id: proposal }, headers)).status,
      200,
    );
    assert.equal((await f.post("authorize", {}, headers)).status, 404);
    assert.equal((await f.post("funding_confirm", {}, headers)).status, 404);
    assert.deepEqual(f.counts(), { exchanges: 1, writes: 0 });
    const expiredTicket = await f.handoffs.issue({
      session: "unused",
      challenge,
      proposal_id: proposal,
      expires_at: Date.now() - 1,
    });
    const expiredHandoff = await f.post("embed-session", {
      ticket: expiredTicket,
      challenge,
      proposal_id: proposal,
    });
    assert.equal(expiredHandoff.status, 401);
    const expiredError = (await expiredHandoff.json()) as any;
    assert.equal(
      expiredError.error.message,
      "Rider sign-in handoff expired. Reopen sign-in.",
    );
    assert.doesNotMatch(expiredError.error.message, /[\u3400-\u9fff]/);
  } finally {
    f.close();
  }
});
it("compact sign-in is confined to embedded proposal cards", async () => {
  const f = await fixture();
  try {
    for (const [path, compact] of [
      [`/agent/card/${proposal}`, true],
      ["/agent/card-demo", true],
      [`/agent/confirm/${proposal}`, false],
      [`/agent/fund-card/deposit_${"a".repeat(32)}`, false],
      ["/agent/fund-demo", false],
    ] as const) {
      const response = await fetch(f.base + path);
      assert.equal(response.status, 200);
      assert.equal(
        (await response.text()).includes(
          '<body class="review-page embedded-confirmation">',
        ),
        compact,
      );
    }
    assert.deepEqual(f.counts(), { exchanges: 0, writes: 0 });
  } finally {
    f.close();
  }
});
it("only the dedicated card routes can be framed and demo rendering never calls a backend", async () => {
  const f = await fixture();
  try {
    for (const path of [
      `/agent/confirm/${proposal}`,
      "/agent/fund/deposit_" + "a".repeat(32),
    ]) {
      const r = await fetch(f.base + path);
      assert.equal(r.headers.get("x-frame-options"), "DENY");
      assert(
        r.headers
          .get("content-security-policy")!
          .includes("frame-ancestors 'none'"),
      );
    }
    const card = await fetch(`${f.base}/agent/card/${proposal}`);
    assert.equal(card.status, 200);
    assert.equal(card.headers.get("x-frame-options"), null);
    assert(
      card.headers
        .get("content-security-policy")!
        .includes("codex-sandbox://*.web-sandbox.oaiusercontent.com"),
    );
    const csp = card.headers.get("content-security-policy")!;
    const claudeSandbox = `https://${createHash("sha256")
      .update(`${f.base}/mcp`)
      .digest("hex")
      .slice(0, 32)}.claudemcpcontent.com`;
    assert(csp.includes("https://claude.ai "));
    assert(csp.includes(claudeSandbox));
    assert(!csp.includes("https://*.claudemcpcontent.com"));
    const fundingCard = await fetch(
      `${f.base}/agent/fund-card/deposit_${"a".repeat(32)}`,
    );
    assert.equal(fundingCard.status, 200);
    assert.equal(fundingCard.headers.get("x-frame-options"), null);
    assert.equal(fundingCard.headers.get("content-security-policy"), csp);
    assert((await fundingCard.text()).includes('"embedded":true'));
    // Framing permission must not become permission to call a human endpoint.
    for (const origin of ["https://claude.ai", claudeSandbox]) {
      const read = await f.post("session", {}, { Origin: origin });
      assert.equal(read.status, 403);
      assert.equal((await read.json()).error.code, "ORIGIN_REQUIRED");
    }
    const demo = await fetch(`${f.base}/agent/card-demo`);
    assert((await demo.text()).includes('"demo":true'));
    assert.deepEqual(f.counts(), { exchanges: 0, writes: 0 });
  } finally {
    f.close();
  }
});

it("funding handoffs are single-use, deposit-bound and cannot confirm proposals or grant authority", async () => {
  const f = await fixture();
  try {
    const session = await f.login(),
      challenge = "f".repeat(64),
      deposit_id = "deposit_" + "a".repeat(32);
    const browserHeaders = {
      Cookie: session.cookie,
      "X-Ride-CSRF": session.csrf,
    };
    assert.equal(
      (
        await f.post(
          "embed-ticket",
          { deposit_id, proposal_id: proposal, challenge },
          browserHeaders,
        )
      ).status,
      400,
    );
    const issued = await f.post(
      "embed-ticket",
      { deposit_id, challenge },
      browserHeaders,
    );
    const { ticket } = await issued.json();
    const accepted = await f.post("embed-session", {
      deposit_id,
      challenge,
      ticket,
    });
    assert.equal(accepted.status, 200);
    const embedded = await accepted.json();
    const headers = {
      Cookie: accepted.headers.get("set-cookie")!.split(";")[0],
      "X-Ride-Embedded": "1",
      "X-Ride-CSRF": embedded.csrf,
    };
    assert.equal(
      (await f.post("embed-session", { deposit_id, challenge, ticket })).status,
      401,
    );
    for (const operation of [
      "funding",
      "funding_prepare",
      "funding_confirm",
      "funding_status",
      "funding_activation_quote",
      "funding_activate",
    ])
      assert.equal(
        (await f.post(operation, { deposit_id }, headers)).status,
        200,
        operation,
      );
    for (const body of [{}, { deposit_id: "deposit_" + "b".repeat(32) }])
      assert.equal(
        (await f.post("funding_confirm", body, headers)).status,
        404,
      );
    for (const operation of [
      "proposal",
      "confirm",
      "reject",
      "authorize",
      "revoke",
      "portfolio",
    ])
      assert.equal(
        (
          await f.post(
            operation,
            { deposit_id, proposal_id: proposal },
            headers,
          )
        ).status,
        404,
      );
    assert.equal(
      (
        await f.post(
          "funding_confirm",
          { deposit_id },
          { ...headers, "X-Ride-CSRF": "wrong" },
        )
      ).status,
      403,
    );
    assert.deepEqual(f.counts(), { exchanges: 1, writes: 0 });
  } finally {
    f.close();
  }
});

it("accepts Apple and Google human sessions while preserving legacy defaults and rejecting unknown providers", async () => {
  const f = await fixture();
  try {
    for (const operation of ["login", "embedded-login"]) {
      const payload = {
        privyId: "fixture",
        privyAccessToken: "fixture-token",
        ...(operation === "embedded-login"
          ? { deposit_id: "deposit_" + "a".repeat(32) }
          : {}),
      };
      const headers: Record<string, string> =
        operation === "embedded-login" ? { "X-Ride-Embedded": "1" } : {};
      for (const provider of [undefined, "GOOGLE", "APPLE"]) {
        const response = await f.post(
          operation,
          { ...payload, authProvider: provider },
          headers,
        );
        assert.equal(response.status, 200);
        assert.equal(f.providers().at(-1), provider ?? "GOOGLE");
      }
      for (const provider of ["GITHUB", "apple", null, 1]) {
        const before = f.counts().exchanges;
        const response = await f.post(
          operation,
          { ...payload, authProvider: provider },
          headers,
        );
        assert.equal(response.status, 400);
        assert.equal(f.counts().exchanges, before);
        assert.equal(response.headers.get("set-cookie"), null);
      }
    }
    assert.equal(f.counts().writes, 0);
  } finally {
    f.close();
  }
});
