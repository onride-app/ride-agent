import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import express from "express";
import type {
  ErrorRequestHandler,
  Express,
  RequestHandler,
  Response,
} from "express";

export const MAX_HTTP_BODY_BYTES = 100 * 1024;
export const MAX_OAUTH_BODY_BYTES = 32 * 1024;

const OAUTH_BODY_PATHS = [
  "/authorize",
  "/token",
  "/register",
  "/revoke",
  "/auth",
];

export type HealthFeatureFlags = {
  oauthEnabled: boolean;
  publicSubmissionMode: boolean;
  chatgptCardsEnabled: boolean;
};

export function createHealthPayload(flags: HealthFeatureFlags) {
  return {
    ok: true,
    service: "ride-mcp",
    ...flags,
  } as const;
}

export function setSecurityHeaders(res: Response): void {
  res.removeHeader("X-Powered-By");
  res.set({
    "Content-Security-Policy":
      "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
    "Permissions-Policy":
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
}

export const securityHeaders: RequestHandler = (_req, res, next) => {
  setSecurityHeaders(res);
  next();
};

export function trustedProxyHopsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.HTTP_TRUST_PROXY_HOPS;
  if (raw === undefined) return env.RAILWAY_ENVIRONMENT_ID ? 1 : 0;
  if (!/^[0-3]$/.test(raw)) {
    throw new Error("HTTP_TRUST_PROXY_HOPS must be an integer from 0 to 3");
  }
  return Number(raw);
}

/**
 * Builds the production HTTP app with OAuth parsers mounted before the general
 * MCP JSON parser. This ordering is security-sensitive: mounting the SDK's
 * default JSON parser first would cause a later 32 KiB OAuth parser to skip an
 * already-parsed request body.
 */
export function createRideHttpApp(
  host: string,
  trustedProxyHops = trustedProxyHopsFromEnv(process.env),
): Express {
  const app = express();
  // Railway public HTTP ingress supplies the client address. Trust only the
  // nearest configured hops, never an arbitrary leftmost forwarded address.
  app.set("trust proxy", trustedProxyHops === 0 ? false : trustedProxyHops);
  app.disable("x-powered-by");
  app.use(securityHeaders);
  app.use(rejectOversizedDeclaredBody);

  if (["127.0.0.1", "localhost", "::1"].includes(host)) {
    app.use(localhostHostValidation());
  }

  app.use(
    OAUTH_BODY_PATHS,
    express.json({ limit: MAX_OAUTH_BODY_BYTES }),
    express.urlencoded({ extended: false, limit: MAX_OAUTH_BODY_BYTES }),
  );
  app.use(express.json({ limit: MAX_HTTP_BODY_BYTES }));

  return app;
}

export const rejectOversizedDeclaredBody: RequestHandler = (req, res, next) => {
  const header = req.headers["content-length"];
  const contentLength = Array.isArray(header) ? header[0] : header;

  if (
    contentLength &&
    /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_HTTP_BODY_BYTES
  ) {
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  next();
};

export const requestBodyErrorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  next,
) => {
  const bodyError =
    typeof error === "object" && error !== null
      ? (error as {
          status?: number;
          type?: string;
          body?: unknown;
        })
      : {};

  if (bodyError.status === 413 || bodyError.type === "entity.too.large") {
    setSecurityHeaders(res);
    res.status(413).json({ error: "payload_too_large" });
    return;
  }

  if (
    bodyError.status === 400 &&
    (bodyError.type === "entity.parse.failed" || "body" in bodyError)
  ) {
    setSecurityHeaders(res);
    res.status(400).json({ error: "invalid_request_body" });
    return;
  }

  next(error);
};
