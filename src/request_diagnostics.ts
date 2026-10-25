import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

export const requestContext = new AsyncLocalStorage<{ request_id: string }>();

/** Deliberately excludes URL queries, headers, IPs, accounts and request bodies. */
export function requestDiagnostics(
  service: "gateway" | "backend",
  write: (record: Record<string, unknown>) => void = (record) =>
    console.error(JSON.stringify(record)),
): RequestHandler {
  return (req, res, next) => {
    const route =
      req.path === "/mcp"
        ? "mcp"
        : req.path.startsWith("/agent/v1/")
          ? "agent"
          : req.path === "/token"
            ? "oauth_token"
            : req.path === "/auth/privy/approve"
              ? "oauth_approval"
              : undefined;
    if (!route) return next();
    const requestId = randomUUID(),
      started = performance.now();
    res.setHeader("X-Ride-Request-Id", requestId);
    write({
      event: "ride_request_started",
      service,
      route,
      request_id: requestId,
    });
    let logged = false;
    const finish = () => {
      if (logged) return;
      logged = true;
      write({
        event: "ride_request_finished",
        service,
        route,
        request_id: requestId,
        duration_ms: Math.round(performance.now() - started),
        outcome: res.writableFinished ? "completed" : "disconnected",
        http_status: res.headersSent ? res.statusCode : null,
      });
    };
    res.once("finish", finish);
    res.once("close", finish);
    requestContext.run({ request_id: requestId }, next);
  };
}
