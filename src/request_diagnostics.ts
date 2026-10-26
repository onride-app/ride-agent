import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Request, RequestHandler, Response } from "express";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

export const requestContext = new AsyncLocalStorage<{ request_id: string }>();

const rpcMethods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
  "logging/setLevel",
  "completion/complete",
  "notifications/cancelled",
  "notifications/progress",
  "roots/list",
  "sampling/createMessage",
  "elicitation/create",
]);
const errorCodes = new Map<number, string>([
  [-32700, "parse_error"],
  [-32600, "invalid_request"],
  [-32601, "method_not_found"],
  [-32602, "invalid_params"],
  [-32603, "internal_error"],
  [-32000, "protocol_error"],
  [-32001, "session_not_found"],
]);
type SafeProtocolError = {
  mcp_error_category: string;
  mcp_error_code?: number;
};
const protocolErrors = new WeakMap<Response, SafeProtocolError>();

function safeProtocolError(error: unknown): SafeProtocolError {
  let code: unknown, message: unknown;
  try {
    ({ code, message } = (error ?? {}) as {
      code?: unknown;
      message?: unknown;
    });
  } catch {
    /* Never serialize an error object or invoke its toJSON. */
  }
  const numeric =
    typeof code === "number" && errorCodes.has(code) ? code : undefined;
  let category =
    numeric === undefined ? "transport_error" : errorCodes.get(numeric)!;
  if (typeof message === "string") {
    const known = [
      [
        "Bad Request: Unsupported protocol version:",
        "unsupported_protocol_version",
      ],
      ["Parse error: Invalid JSON-RPC message", "invalid_jsonrpc"],
      ["Parse error: Invalid JSON", "invalid_json"],
      ["Invalid Request: Batch must not exceed", "invalid_batch"],
      [
        "Invalid Request: Only one initialization request is allowed",
        "invalid_initialization",
      ],
      ["Invalid Request: Server already initialized", "already_initialized"],
      ["Not Acceptable:", "not_acceptable"],
      ["Unsupported Media Type:", "unsupported_media_type"],
      ["Bad Request: Server not initialized", "session_required"],
      ["Bad Request: Mcp-Session-Id header is required", "session_required"],
    ];
    const match = known.find(([prefix]) => message.startsWith(prefix));
    if (match) category = match[1];
  }
  return {
    mcp_error_category: category,
    ...(numeric === undefined ? {} : { mcp_error_code: numeric }),
  };
}

/** Accept only classified SDK errors; never log original messages, data or stacks. */
export function recordMcpProtocolError(res: Response, error: unknown): void {
  protocolErrors.set(res, safeProtocolError(error));
}

function protocolVersion(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value !== "string" || !/^202[4-9]-\d{2}-\d{2}$/.test(value))
    return "invalid";
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : "invalid";
}

function mcpMetadata(req: Request): Record<string, unknown> {
  const method = req.body?.method;
  const version = protocolVersion(req.get("mcp-protocol-version"));
  const accept = req.get("accept") ?? "";
  return {
    http_method: [
      "GET",
      "POST",
      "DELETE",
      "OPTIONS",
      "HEAD",
      "PUT",
      "PATCH",
    ].includes(req.method)
      ? req.method
      : "other",
    rpc_method: Array.isArray(req.body)
      ? "batch"
      : rpcMethods.has(method)
        ? method
        : method === undefined
          ? "absent"
          : "other",
    mcp_protocol_version: version,
    mcp_protocol_supported:
      version === "absent"
        ? null
        : SUPPORTED_PROTOCOL_VERSIONS.includes(version),
    ...(method === "initialize"
      ? {
          initialize_protocol_version: protocolVersion(
            req.body?.params?.protocolVersion,
          ),
        }
      : {}),
    accepts_json: accept.includes("application/json"),
    accepts_sse: accept.includes("text/event-stream"),
  };
}

/** Deliberately excludes URL queries, raw headers, IPs, accounts and request bodies. */
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
    const metadata = route === "mcp" ? mcpMetadata(req) : {};
    // SDK validation can return an HTTP error directly through write/end without
    // throwing or invoking onerror. Inspect only a bounded error response, then
    // retain its numeric JSON-RPC code and a fixed classification.
    let errorBody = "";
    if (route === "mcp") {
      const capture = (chunk: unknown) => {
        if (res.statusCode < 400 || errorBody.length >= 4096) return;
        const remaining = 4096 - errorBody.length;
        if (typeof chunk === "string") errorBody += chunk.slice(0, remaining);
        else if (chunk instanceof Uint8Array)
          errorBody += Buffer.from(
            chunk.buffer,
            chunk.byteOffset,
            Math.min(chunk.byteLength, remaining),
          ).toString("utf8");
      };
      const write = res.write.bind(res) as (...args: any[]) => boolean;
      const end = res.end.bind(res) as (...args: any[]) => Response;
      res.write = ((chunk: unknown, ...args: any[]) => {
        capture(chunk);
        return write(chunk, ...args);
      }) as Response["write"];
      res.end = ((chunk?: unknown, ...args: any[]) => {
        capture(chunk);
        return end(chunk, ...args);
      }) as Response["end"];
    }
    res.setHeader("X-Ride-Request-Id", requestId);
    write({
      event: "ride_request_started",
      service,
      route,
      request_id: requestId,
      ...metadata,
    });
    let logged = false;
    const finish = () => {
      if (logged) return;
      logged = true;
      let responseError: SafeProtocolError | undefined;
      if (errorBody) {
        try {
          const body = JSON.parse(errorBody);
          if (body?.jsonrpc === "2.0" && body.error)
            responseError = safeProtocolError(body.error);
        } catch {
          /* Incomplete or non-RPC error responses remain status-only. */
        }
      }
      errorBody = "";
      const observed = protocolErrors.get(res);
      protocolErrors.delete(res);
      const protocolError =
        observed?.mcp_error_category !== "transport_error" && observed
          ? { ...responseError, ...observed }
          : (responseError ?? observed);
      write({
        event: "ride_request_finished",
        service,
        route,
        request_id: requestId,
        duration_ms: Math.round(performance.now() - started),
        outcome: res.writableFinished ? "completed" : "disconnected",
        http_status: res.headersSent ? res.statusCode : null,
        ...metadata,
        ...protocolError,
      });
    };
    res.once("finish", finish);
    res.once("close", finish);
    requestContext.run({ request_id: requestId }, next);
  };
}
