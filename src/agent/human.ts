import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Express } from "express";
import { z } from "zod";
import { AgentError, failure, publicResult, output } from "./contracts.js";
import type { PrivyAuthorizationInput, RideAuthPageConfig } from "../oauth.js";
import { MemoryHumanHandoffs, type HumanHandoffs } from "./human_handoffs.js";
import { claudeCardDomain } from "./card_hosts.js";

export function mountHumanConfirmation(
  app: Express,
  options: {
    backend: string;
    base: string;
    cookieKey: string;
    auth: RideAuthPageConfig;
    handoffs?: HumanHandoffs;
    frameAncestors?: string[];
    exchange: (
      input: PrivyAuthorizationInput,
    ) => Promise<{ rideAuthToken: string }>;
  },
): void {
  if (options.cookieKey.length < 32)
    throw new Error(
      "Human session cookie key must contain at least 32 characters",
    );
  const key = createHash("sha256").update(options.cookieKey).digest(),
    origin = new URL(options.base).origin,
    handoffs = options.handoffs ?? new MemoryHumanHandoffs();
  const proposalId = z.string().regex(/^proposal_[a-zA-Z0-9_-]{8,100}$/);
  const depositId = z.string().regex(/^deposit_[a-f0-9]{32}$/);
  const handoffSubject = {
    proposal_id: proposalId.optional(),
    deposit_id: depositId.optional(),
    challenge: z.string().regex(/^[a-f0-9]{64}$/),
  };
  const singleSubject = (v: { proposal_id?: string; deposit_id?: string }) =>
    !!v.proposal_id !== !!v.deposit_id;
  const browserCookie = "ride_agent_human",
    embedCookie = "ride_agent_embedded";
  const requireOrigin = (req: import("express").Request) => {
    if (req.get("origin") !== origin)
      throw new AgentError(
        "ORIGIN_REQUIRED",
        "Rider browser origin is required.",
        false,
        403,
      );
  };
  const cookies = (req: import("express").Request) =>
    Object.fromEntries(
      (req.headers.cookie ?? "").split(";").map((x) => x.trim().split("=")),
    );
  const seal = (v: unknown) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, iv),
      body = Buffer.concat([cipher.update(JSON.stringify(v)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  };
  const unseal = (v: string) => {
    try {
      const b = Buffer.from(v, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      decipher.setAuthTag(b.subarray(12, 28));
      const s = JSON.parse(
        Buffer.concat([
          decipher.update(b.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (
        typeof s.token !== "string" ||
        !s.token ||
        typeof s.csrf !== "string" ||
        !Number.isFinite(s.expires_at) ||
        s.expires_at <= Date.now()
      )
        throw 0;
      return s as {
        token: string;
        csrf: string;
        expires_at: number;
        embedded?: boolean;
        deposit_id?: string;
      };
    } catch {
      throw new AgentError(
        "AUTH_REQUIRED",
        "Sign in to Ride to confirm.",
        false,
        401,
      );
    }
  };
  const sessionFor = (req: import("express").Request) => {
    const embedded = req.get("x-ride-embedded") === "1";
    const raw = cookies(req)[embedded ? embedCookie : browserCookie] ?? "";
    const session = unseal(raw);
    if (!!session.embedded !== embedded)
      throw new AgentError("AUTH_REQUIRED", "Sign in to Ride.", false, 401);
    return { session, raw };
  };
  const checkCsrf = (req: import("express").Request, csrf: string) => {
    const given = Buffer.from(req.get("x-ride-csrf") ?? ""),
      expected = Buffer.from(csrf);
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new AgentError(
        "CSRF_REQUIRED",
        "Refresh the Ride sign-in session.",
        false,
        403,
      );
  };
  // A same-origin read restores the anti-CSRF token without exposing the Core JWT
  // or renewing the original 15-minute human session.
  app.post("/agent/human/session", (req, res) => {
    try {
      requireOrigin(req);
      const { session } = sessionFor(req);
      res
        .set("Cache-Control", "no-store")
        .json({ csrf: session.csrf, expires_at: session.expires_at });
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 400).json(failure(e));
    }
  });
  app.post("/agent/human/embed-ticket", async (req, res) => {
    try {
      requireOrigin(req);
      if (req.get("x-ride-embedded"))
        throw new AgentError("AUTH_REQUIRED", "Open Ride sign-in.", false, 401);
      const { session, raw } = sessionFor(req);
      checkCsrf(req, session.csrf);
      const input = z
        .object({
          ...handoffSubject,
        })
        .strict()
        .refine(singleSubject, "Choose one confirmation subject")
        .parse(req.body);
      const ticket = await handoffs.issue({
        ...input,
        session: raw,
        expires_at: Math.min(session.expires_at, Date.now() + 60_000),
      });
      res.set("Cache-Control", "no-store").json({ ticket });
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 400).json(failure(e));
    }
  });
  app.post("/agent/human/embed-session", async (req, res) => {
    try {
      requireOrigin(req);
      const input = z
        .object({
          ticket: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
          ...handoffSubject,
        })
        .strict()
        .refine(singleSubject, "Choose one confirmation subject")
        .parse(req.body);
      const handoff = await handoffs.consume(input.ticket);
      if (
        !handoff ||
        handoff.challenge !== input.challenge ||
        handoff.proposal_id !== input.proposal_id ||
        handoff.deposit_id !== input.deposit_id
      )
        throw new AgentError(
          "AUTH_REQUIRED",
          "Rider sign-in handoff expired. Reopen sign-in.",
          false,
          401,
        );
      const session = unseal(handoff.session);
      const embedded = {
        ...session,
        embedded: true,
        deposit_id: input.deposit_id,
        csrf: randomBytes(32).toString("base64url"),
      };
      res.cookie(embedCookie, seal(embedded), {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        partitioned: true,
        path: "/agent",
        maxAge: Math.max(0, session.expires_at - Date.now()),
      });
      res
        .set("Cache-Control", "no-store")
        .json({ csrf: embedded.csrf, expires_at: embedded.expires_at });
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 400).json(failure(e));
    }
  });
  app.get(
    [
      "/agent/card/:proposalId",
      "/agent/card-demo",
      "/agent/fund-card/:depositId",
    ],
    async (req, res) => {
      const demo = req.path === "/agent/card-demo";
      const funding = req.path.startsWith("/agent/fund-card/");
      if (
        !demo &&
        !(
          funding
            ? depositId.safeParse(req.params.depositId)
            : proposalId.safeParse(req.params.proposalId)
        ).success
      ) {
        res.status(404).end();
        return;
      }
      const template = await readFile(
        fileURLToPath(
          new URL(
            funding ? "../../public/fund.html" : "../../public/confirm.html",
            import.meta.url,
          ),
        ),
        "utf8",
      );
      const ancestors = options.frameAncestors ?? [
        "'self'",
        "https://chatgpt.com",
        "https://*.chatgpt.com",
        "https://*.oaiusercontent.com",
        "codex-sandbox://*.web-sandbox.oaiusercontent.com",
        "https://claude.ai",
        // Claude assigns each MCP endpoint its own sandbox origin. Allow only
        // this server's origin, rather than every connector hosted by Claude.
        `https://${claudeCardDomain(options.base)}`,
      ];
      if (ancestors.some((x) => /[;\r\n]/.test(x)))
        throw Error("Invalid card frame ancestor");
      // Only dedicated card routes can be framed. Standalone confirmation,
      // OAuth, funding, App and API routes retain DENY.
      res.removeHeader("X-Frame-Options");
      res.set(
        "Content-Security-Policy",
        `base-uri 'self'; frame-ancestors ${ancestors.join(" ")}; object-src 'none'`,
      );
      res
        .set("Cache-Control", "no-store")
        .type("html")
        .send(
          template.replace(
            "/*CONFIG*/{}",
            JSON.stringify({
              proposal_id: req.params.proposalId,
              ...(funding ? { deposit_id: req.params.depositId } : {}),
              embedded: true,
              demo,
              privy_app_id: options.auth.privyAppId,
              privy_client_id: options.auth.privyClientId,
              privy_sdk: options.auth.jsSdkUrl,
            }).replaceAll("<", "\\u003c"),
          ),
        );
    },
  );
  app.get("/agent/confirm/:proposalId", async (req, res) => {
    if (!/^proposal_[a-zA-Z0-9_-]{8,100}$/.test(req.params.proposalId)) {
      res.status(404).end();
      return;
    }
    const template = await readFile(
      fileURLToPath(new URL("../../public/confirm.html", import.meta.url)),
      "utf8",
    );
    const config = {
      proposal_id: req.params.proposalId,
      privy_app_id: options.auth.privyAppId,
      privy_client_id: options.auth.privyClientId,
      privy_sdk: options.auth.jsSdkUrl,
    };
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        template.replace(
          "/*CONFIG*/{}",
          JSON.stringify(config).replaceAll("<", "\\u003c"),
        ),
      );
  });
  app.get("/agent/fund/:depositId", async (req, res) => {
    if (!/^deposit_[a-f0-9]{32}$/.test(req.params.depositId)) {
      res.status(404).end();
      return;
    }
    const template = await readFile(
      fileURLToPath(new URL("../../public/fund.html", import.meta.url)),
      "utf8",
    );
    const config = {
      deposit_id: req.params.depositId,
      privy_app_id: options.auth.privyAppId,
      privy_client_id: options.auth.privyClientId,
      privy_sdk: options.auth.jsSdkUrl,
    };
    res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        template.replace(
          "/*CONFIG*/{}",
          JSON.stringify(config).replaceAll("<", "\\u003c"),
        ),
      );
  });
  app.post("/agent/human/login", async (req, res) => {
    try {
      if (req.get("origin") !== origin)
        throw new AgentError(
          "ORIGIN_REQUIRED",
          "Rider browser origin is required.",
          false,
          403,
        );
      const input = z
        .object({
          privyId: z.string().min(1),
          privyAccessToken: z.string().min(1),
          email: z.string().optional(),
          walletAddress: z.string().optional(),
          privyWalletId: z.string().optional(),
          authProvider: z.string().optional(),
          accessCode: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const exchanged = await options.exchange(input),
        csrf = randomBytes(32).toString("base64url");
      res.cookie(
        browserCookie,
        seal({
          token: exchanged.rideAuthToken,
          csrf,
          expires_at: Date.now() + 15 * 60_000,
        }),
        {
          httpOnly: true,
          secure: new URL(origin).protocol === "https:",
          sameSite: "strict",
          path: "/agent",
          maxAge: 15 * 60_000,
        },
      );
      res.set("Cache-Control", "no-store").json({ csrf });
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 400).json(failure(e));
    }
  });
  const allowed = new Set([
    "funding",
    "funding_prepare",
    "funding_confirm",
    "funding_activation_quote",
    "funding_activate",
    "funding_status",
    "proposal",
    "confirm",
    "reject",
    "authorize",
    "revoke",
    "portfolio",
    "updates",
    "update",
  ]);
  app.post("/agent/human/:operation", async (req, res) => {
    try {
      if (!allowed.has(req.params.operation))
        throw new AgentError(
          "NOT_FOUND",
          "Unknown human operation.",
          false,
          404,
        );
      let token: string;
      const authorization = req.get("authorization");
      if (authorization) {
        // Native Ride sends its Core JWT. The backend validates it against
        // authenticated Core identity; MCP's opaque OAuth tokens fail there.
        if (!authorization.startsWith("Bearer ") || !authorization.slice(7))
          throw new AgentError("AUTH_REQUIRED", "Sign in to Ride.", false, 401);
        token = authorization.slice(7);
      } else {
        if (req.get("origin") !== origin)
          throw new AgentError(
            "ORIGIN_REQUIRED",
            "Rider browser origin is required.",
            false,
            403,
          );
        const { session } = sessionFor(req);
        checkCsrf(req, session.csrf);
        if (session.embedded) {
          const operations = session.deposit_id
            ? [
                "funding",
                "funding_prepare",
                "funding_confirm",
                "funding_status",
                "funding_activation_quote",
                "funding_activate",
              ]
            : ["proposal", "confirm", "reject"];
          if (
            !operations.includes(req.params.operation) ||
            (session.deposit_id && req.body?.deposit_id !== session.deposit_id)
          )
            throw new AgentError(
              "NOT_FOUND",
              "This operation is unavailable in this confirmation card.",
              false,
              404,
            );
        }
        token = session.token;
      }
      const response = await fetch(
        new URL(`/agent/human/${req.params.operation}`, options.backend),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(
            req.params.operation.startsWith("funding") ? 120000 : 25000,
          ),
          redirect: "error",
        },
      );
      const body = await response.json();
      // Verified signing challenges belong only to this authenticated human
      // page; MCP routes continue to reject raw trading identities.
      const value = req.params.operation.startsWith("funding")
        ? output.parse(body)
        : publicResult(body);
      res.status(response.status).set("Cache-Control", "no-store").json(value);
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 503).json(failure(e));
    }
  });
}
