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
  const downstream = express();
  downstream.use(express.json());
  downstream.post("/agent/human/:operation", (req, res) => {
    if (req.get("authorization") !== "Bearer fixture-core") {
      res.status(401).json({ error: { code: "AUTH_REQUIRED" } });
      return;
    }
    if (["confirm", "reject", "authorize"].includes(req.params.operation))
      writes++;
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
    exchange: async () => {
      exchanges++;
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
    assert.equal(
      (
        await f.post("embed-session", {
          ticket: expiredTicket,
          challenge,
          proposal_id: proposal,
        })
      ).status,
      401,
    );
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
