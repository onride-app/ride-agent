/** Fixed OAuth-store RPC: the lightweight MCP entry never receives App Redis credentials. */
import { timingSafeEqual } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  createRedisOAuthStateStore,
  deserializeAccessTokenRecord,
  deserializeAuthorizationCodeRecord,
  serializeAccessTokenRecord,
  serializeAuthorizationCodeRecord,
  type RideOAuthStateStore,
  type RideOAuthStats,
} from "./oauth.js";
import {
  redisHumanHandoffs,
  type HumanHandoffs,
  type HumanHandoff,
} from "./agent/human_handoffs.js";
import { createRideHttpApp, requestBodyErrorHandler } from "./http_security.js";

export const APP_SESSION_OPERATIONS = [
  "client_get", "client_register", "code_get", "code_set", "code_delete",
  "access_get", "access_set", "access_delete", "refresh_get", "refresh_set",
  "refresh_delete", "refresh_consume", "stats", "handoff_issue", "handoff_consume",
] as const;
type Operation = typeof APP_SESSION_OPERATIONS[number];
const operations = new Set<string>(APP_SESSION_OPERATIONS);
const PREFIX = "/internal/rider-session/";
const MAX_BYTES = 100 * 1024;

function validToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token))
    throw new Error("App session transport requires a dedicated service token");
}
function id(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || body.id.length === 0 || body.id.length > 4096)
    throw new Error("Invalid store identifier");
  return body.id;
}
function encoded(body: Record<string, unknown>): string {
  if (typeof body.record !== "string" || Buffer.byteLength(body.record) > 64 * 1024)
    throw new Error("Invalid encoded store record");
  return body.record;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid store envelope");
  return value as Record<string, unknown>;
}
function allowedAuth(value: string | undefined, token: string): boolean {
  const expected = Buffer.from("Bearer " + token);
  const actual = Buffer.from(value ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function appSessionStoreApp(options: {
  host?: string;
  token: string;
  store: RideOAuthStateStore;
  handoffs: HumanHandoffs;
}) {
  validToken(options.token);
  const app = createRideHttpApp(options.host ?? "127.0.0.1", 0);
  app.get("/health", (_req, res) => res.json({ service: "app-agent-session-store", ready: true }));
  app.post(PREFIX + ":operation", (req, res, next) => {
    if (!allowedAuth(req.headers.authorization, options.token)) {
      res.status(401).json({ error: "AUTH_REQUIRED" }); return;
    }
    next();
  }, express.json({ limit: MAX_BYTES }), async (req, res) => {
    const operation = req.params.operation;
    if (typeof operation !== "string" || !operations.has(operation)) { res.status(404).json({ error: "NOT_FOUND" }); return; }
    try {
      const b = object(req.body);
      let value: unknown;
      const store = options.store;
      switch (operation as Operation) {
        case "client_get": value = await store.clientsStore.getClient(id(b)); break;
        case "client_register": {
          const client = object(b.client);
          if (typeof client.client_id !== "string" || client.client_id.length > 4096)
            throw new Error("Invalid client record");
          value = await store.clientsStore.registerClient!(client as OAuthClientInformationFull);
          break;
        }
        case "code_get": {
          const record = await store.getAuthorizationCode(id(b));
          value = record ? serializeAuthorizationCodeRecord(record) : undefined; break;
        }
        case "code_set": await store.setAuthorizationCode(id(b), deserializeAuthorizationCodeRecord(encoded(b))); break;
        case "code_delete": await store.deleteAuthorizationCode(id(b)); break;
        case "access_get": {
          const record = await store.getAccessToken(id(b));
          value = record ? serializeAccessTokenRecord(record) : undefined; break;
        }
        case "access_set": await store.setAccessToken(id(b), deserializeAccessTokenRecord(encoded(b))); break;
        case "access_delete": await store.deleteAccessToken(id(b)); break;
        case "refresh_get": {
          const record = await store.getRefreshToken(id(b));
          value = record ? serializeAccessTokenRecord(record) : undefined; break;
        }
        case "refresh_set": await store.setRefreshToken(id(b), deserializeAccessTokenRecord(encoded(b))); break;
        case "refresh_delete": await store.deleteRefreshToken(id(b)); break;
        case "refresh_consume": value = await store.consumeRefreshToken(id(b), deserializeAccessTokenRecord(encoded(b))); break;
        case "stats": value = await store.getStats?.(); break;
        case "handoff_issue": {
          const record = object(b.value);
          if (typeof record.session !== "string" || typeof record.challenge !== "string" ||
              typeof record.expires_at !== "number" || !Number.isFinite(record.expires_at))
            throw new Error("Invalid handoff record");
          value = await options.handoffs.issue(record as HumanHandoff); break;
        }
        case "handoff_consume": value = await options.handoffs.consume(id(b)); break;
      }
      res.setHeader("Cache-Control", "no-store");
      res.json({ value: value ?? null });
    } catch {
      // Neither records, OAuth credentials, Redis errors nor request bodies enter logs.
      res.status(503).json({ error: "APP_SESSION_STORE_UNAVAILABLE" });
    }
  });
  app.use(requestBodyErrorHandler);
  return app;
}

export async function startAppSessionStore(options: {
  redisUrl: string;
  token: string;
  host?: string;
  port?: number;
}): Promise<{ server: Server; address: AddressInfo; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("App session store must bind loopback");
  validToken(options.token);
  const store = await createRedisOAuthStateStore({ url: options.redisUrl });
  let handoffs: HumanHandoffs;
  try { handoffs = await redisHumanHandoffs(options.redisUrl); }
  catch (error) { await store.close?.(); throw error; }
  const app = appSessionStoreApp({ host, token: options.token, store, handoffs });
  let server: Server;
  try {
    server = await new Promise<Server>((resolve, reject) => {
      const listener = app.listen(options.port ?? 3366, host, () => resolve(listener));
      listener.once("error", reject);
    });
  } catch (error) {
    await Promise.allSettled([store.close?.(), handoffs.close?.()]); throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    server,
    address: server.address() as AddressInfo,
    close() {
      return closing ??= (async () => {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await Promise.all([store.close?.(), handoffs.close?.()]);
      })();
    },
  };
}

function remoteCall(options: { url: string; token: string; timeoutMs?: number }) {
  validToken(options.token);
  const url = new URL(options.url);
  if (url.username || url.password || url.search || url.hash ||
      !["", "/"].includes(url.pathname) ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("App session store must use HTTPS or explicit loopback");
  const timeoutMs = options.timeoutMs ?? 5000;
  return async (operation: Operation, body: Record<string, unknown> = {}): Promise<any> => {
    try {
      const response = await fetch(new URL(PREFIX + operation, url), {
        method: "POST", redirect: "error",
        headers: { authorization: "Bearer " + options.token, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      const length = response.headers.get("content-length");
      if (!response.ok || (length && Number(length) > MAX_BYTES)) throw new Error("Unavailable");
      if (!response.body) throw new Error("Empty response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("Oversized response"); }
        chunks.push(chunk.value);
      }
      const data = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!("value" in data)) throw new Error("Invalid envelope");
      return data.value ?? undefined;
    } catch {
      // Fail closed; never fall back to process memory or the retired Redis.
      throw new Error("App session storage is temporarily unavailable");
    }
  };
}

export function remoteOAuthStateStore(options: { url: string; token: string; timeoutMs?: number }): RideOAuthStateStore {
  const call = remoteCall(options);
  const get = async (op: Operation, token: string, decode: (record: string) => any) => {
    const record = await call(op, { id: token });
    return record === undefined ? undefined : decode(record);
  };
  return {
    // The authoritative backing store remains Redis; only its transport changes.
    kind: "redis",
    clientsStore: {
      getClient: (clientId) => call("client_get", { id: clientId }),
      registerClient: (client) => call("client_register", { client }),
    },
    getAuthorizationCode: (token) => get("code_get", token, deserializeAuthorizationCodeRecord),
    setAuthorizationCode: async (token, record) => { await call("code_set", { id: token, record: serializeAuthorizationCodeRecord(record) }); },
    deleteAuthorizationCode: async (token) => { await call("code_delete", { id: token }); },
    getAccessToken: (token) => get("access_get", token, deserializeAccessTokenRecord),
    setAccessToken: async (token, record) => { await call("access_set", { id: token, record: serializeAccessTokenRecord(record) }); },
    deleteAccessToken: async (token) => { await call("access_delete", { id: token }); },
    getRefreshToken: (token) => get("refresh_get", token, deserializeAccessTokenRecord),
    setRefreshToken: async (token, record) => { await call("refresh_set", { id: token, record: serializeAccessTokenRecord(record) }); },
    deleteRefreshToken: async (token) => { await call("refresh_delete", { id: token }); },
    consumeRefreshToken: (token, record) => call("refresh_consume", { id: token, record: serializeAccessTokenRecord(record) }),
    getStats: () => call("stats") as Promise<RideOAuthStats>,
  };
}

export function remoteHumanHandoffs(options: { url: string; token: string; timeoutMs?: number }): HumanHandoffs {
  const call = remoteCall(options);
  return {
    issue: (value) => call("handoff_issue", { value }),
    consume: (ticket) => call("handoff_consume", { id: ticket }),
  };
}
