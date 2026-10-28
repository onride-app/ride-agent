import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";
import type { Request, Response } from "express";
import { createClient, type RedisClientType } from "redis";
import { AgentError } from "./agent/contracts.js";

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const RIDE_OAUTH_SCOPES = ["ride:read", "ride:trade"] as const;
export const DEFAULT_RIDE_OAUTH_SCOPES = ["ride:read"] as const;
export const RIDE_PRIVY_AUTH_PROVIDERS = ["GOOGLE", "APPLE"] as const;
export type RidePrivyAuthProvider = (typeof RIDE_PRIVY_AUTH_PROVIDERS)[number];

export function normalizePrivyAuthProvider(value: unknown): RidePrivyAuthProvider {
  if (value === undefined) return "GOOGLE";
  if (value === "GOOGLE" || value === "APPLE") return value;
  throw new InvalidRequestError("Choose Google or Apple to sign in to Rider.");
}

function validateSupportedScopes(scopes: string[]): string[] {
  const normalized = [...new Set(scopes)];
  const unsupported = normalized.filter(
    (scope) =>
      !RIDE_OAUTH_SCOPES.includes(
        scope as (typeof RIDE_OAUTH_SCOPES)[number],
      ),
  );
  if (unsupported.length) {
    throw new InvalidScopeError(
      `Unsupported OAuth scope: ${unsupported.join(" ")}`,
    );
  }
  return normalized;
}

function normalizeRequestedScopes(scope?: string): string[] {
  const requested = scope?.split(/\s+/).filter(Boolean) ?? [];
  return validateSupportedScopes(
    requested.length ? requested : [...DEFAULT_RIDE_OAUTH_SCOPES],
  );
}

export type RideTokenIdentity = {
  subject: string;
  displayName?: string;
};

export type RideOAuthProviderOptions = {
  validateRideToken: (token: string) => Promise<RideTokenIdentity>;
  exchangePrivyToken: (input: PrivyAuthorizationInput) => Promise<{
    rideAuthToken: string;
    identity: RideTokenIdentity;
  }>;
  authPage: RideAuthPageConfig;
  store?: RideOAuthStateStore;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
};

export type RideAuthPageConfig = {
  privyAppId: string;
  privyClientId: string;
  jsSdkUrl: string;
  manualTokenAuthEnabled: boolean;
};

export type PrivyAuthorizationInput = {
  privyId: string;
  privyAccessToken: string;
  email?: string;
  walletAddress?: string;
  privyWalletId?: string;
  authProvider?: string;
  accessCode?: string;
};

type AuthorizationCodeRecord = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  rideAuthToken: string;
  identity: RideTokenIdentity;
  expiresAt: number;
};

type AccessTokenRecord = {
  clientId: string;
  scopes: string[];
  rideAuthToken: string;
  identity: RideTokenIdentity;
  expiresAt: number;
  resource?: URL;
};

type RefreshTokenRecord = AccessTokenRecord;

export type RideOAuthStats = {
  store: "memory" | "redis";
  registeredClients: number;
  pendingAuthorizationCodes: number;
  activeAccessTokens: number;
  activeAccessTokenSubjects: number;
  activeRefreshTokens: number;
  activeRefreshTokenSubjects: number;
  activeRefreshTokenClientSubjectPairs: number;
  countedAt: string;
};

export type RideOAuthStateStore = {
  kind: "memory" | "redis";
  clientsStore: OAuthRegisteredClientsStore;
  getAuthorizationCode: (code: string) => Promise<AuthorizationCodeRecord | undefined>;
  setAuthorizationCode: (code: string, record: AuthorizationCodeRecord) => Promise<void>;
  deleteAuthorizationCode: (code: string) => Promise<void>;
  getAccessToken: (token: string) => Promise<AccessTokenRecord | undefined>;
  setAccessToken: (token: string, record: AccessTokenRecord) => Promise<void>;
  deleteAccessToken: (token: string) => Promise<void>;
  getRefreshToken: (token: string) => Promise<RefreshTokenRecord | undefined>;
  setRefreshToken: (token: string, record: RefreshTokenRecord) => Promise<void>;
  deleteRefreshToken: (token: string) => Promise<void>;
  getStats?: () => Promise<RideOAuthStats>;
};

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    this.clients.set(client.client_id, client);
    return client;
  }

  size(): number {
    return this.clients.size;
  }
}

export class InMemoryOAuthStateStore implements RideOAuthStateStore {
  readonly kind = "memory";
  readonly clientsStore = new InMemoryClientsStore();

  private readonly authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();

  async getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    return this.authorizationCodes.get(code);
  }

  async setAuthorizationCode(code: string, record: AuthorizationCodeRecord): Promise<void> {
    this.authorizationCodes.set(code, record);
  }

  async deleteAuthorizationCode(code: string): Promise<void> {
    this.authorizationCodes.delete(code);
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    return this.accessTokens.get(token);
  }

  async setAccessToken(token: string, record: AccessTokenRecord): Promise<void> {
    this.accessTokens.set(token, record);
  }

  async deleteAccessToken(token: string): Promise<void> {
    this.accessTokens.delete(token);
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    return this.refreshTokens.get(token);
  }

  async setRefreshToken(token: string, record: RefreshTokenRecord): Promise<void> {
    this.refreshTokens.set(token, record);
  }

  async deleteRefreshToken(token: string): Promise<void> {
    this.refreshTokens.delete(token);
  }

  async getStats(): Promise<RideOAuthStats> {
    const now = Date.now();
    const accessRecords = [...this.accessTokens.values()].filter(
      (record) => record.expiresAt > now,
    );
    const refreshRecords = [...this.refreshTokens.values()].filter(
      (record) => record.expiresAt > now,
    );
    return buildOAuthStats({
      store: this.kind,
      registeredClients: (this.clientsStore as InMemoryClientsStore).size(),
      pendingAuthorizationCodes: [...this.authorizationCodes.values()].filter(
        (record) => record.expiresAt > now,
      ).length,
      accessRecords,
      refreshRecords,
    });
  }

}

class RedisClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly client: RedisClientType,
    private readonly keyPrefix: string,
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const value = await this.client.get(`${this.keyPrefix}:client:${clientId}`);
    return value ? (JSON.parse(value) as OAuthClientInformationFull) : undefined;
  }

  async registerClient(client: OAuthClientInformationFull): Promise<OAuthClientInformationFull> {
    await this.client.set(`${this.keyPrefix}:client:${client.client_id}`, JSON.stringify(client));
    return client;
  }
}

class RedisOAuthStateStore implements RideOAuthStateStore {
  readonly kind = "redis";
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly client: RedisClientType,
    private readonly keyPrefix: string,
  ) {
    this.clientsStore = new RedisClientsStore(client, keyPrefix);
  }

  async getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const value = await this.client.get(this.key("authorization-code", code));
    return value ? deserializeAuthorizationCodeRecord(value) : undefined;
  }

  async setAuthorizationCode(code: string, record: AuthorizationCodeRecord): Promise<void> {
    await this.setExpiring(this.key("authorization-code", code), serializeAuthorizationCodeRecord(record), record.expiresAt);
  }

  async deleteAuthorizationCode(code: string): Promise<void> {
    await this.client.del(this.key("authorization-code", code));
  }

  async getAccessToken(token: string): Promise<AccessTokenRecord | undefined> {
    const value = await this.client.get(this.key("access-token", token));
    return value ? deserializeAccessTokenRecord(value) : undefined;
  }

  async setAccessToken(token: string, record: AccessTokenRecord): Promise<void> {
    await this.setExpiring(this.key("access-token", token), serializeAccessTokenRecord(record), record.expiresAt);
  }

  async deleteAccessToken(token: string): Promise<void> {
    await this.client.del(this.key("access-token", token));
  }

  async getRefreshToken(token: string): Promise<RefreshTokenRecord | undefined> {
    const value = await this.client.get(this.key("refresh-token", token));
    return value ? deserializeAccessTokenRecord(value) : undefined;
  }

  async setRefreshToken(token: string, record: RefreshTokenRecord): Promise<void> {
    await this.setExpiring(this.key("refresh-token", token), serializeAccessTokenRecord(record), record.expiresAt);
  }

  async deleteRefreshToken(token: string): Promise<void> {
    await this.client.del(this.key("refresh-token", token));
  }

  async getStats(): Promise<RideOAuthStats> {
    const [
      registeredClients,
      pendingAuthorizationCodes,
      accessRecords,
      refreshRecords,
    ] = await Promise.all([
      this.countKeys(`${this.keyPrefix}:client:*`),
      this.countKeys(`${this.keyPrefix}:authorization-code:*`),
      this.readAccessRecords(`${this.keyPrefix}:access-token:*`),
      this.readAccessRecords(`${this.keyPrefix}:refresh-token:*`),
    ]);

    return buildOAuthStats({
      store: this.kind,
      registeredClients,
      pendingAuthorizationCodes,
      accessRecords,
      refreshRecords,
    });
  }

  private key(type: string, id: string): string {
    return `${this.keyPrefix}:${type}:${id}`;
  }

  private async setExpiring(key: string, value: string, expiresAt: number): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
    await this.client.setEx(key, ttlSeconds, value);
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    const iterator = (this.client as unknown as {
      scanIterator: (options: { MATCH: string; COUNT: number }) => AsyncIterable<string | string[]>;
    }).scanIterator({ MATCH: pattern, COUNT: 100 });

    for await (const item of iterator) {
      if (Array.isArray(item)) {
        keys.push(...item);
      } else {
        keys.push(item);
      }
    }

    return keys;
  }

  private async countKeys(pattern: string): Promise<number> {
    return (await this.scanKeys(pattern)).length;
  }

  private async readAccessRecords(pattern: string): Promise<AccessTokenRecord[]> {
    const keys = await this.scanKeys(pattern);
    const records: AccessTokenRecord[] = [];
    for (const key of keys) {
      const value = await this.client.get(key);
      if (!value) continue;
      try {
        const record = deserializeAccessTokenRecord(value);
        if (record.expiresAt > Date.now()) {
          records.push(record);
        }
      } catch {
        // Ignore malformed legacy records; stats must not break auth.
      }
    }
    return records;
  }
}

function buildOAuthStats(input: {
  store: "memory" | "redis";
  registeredClients: number;
  pendingAuthorizationCodes: number;
  accessRecords: AccessTokenRecord[];
  refreshRecords: RefreshTokenRecord[];
}): RideOAuthStats {
  const accessSubjects = new Set(
    input.accessRecords.map((record) => record.identity.subject),
  );
  const refreshSubjects = new Set(
    input.refreshRecords.map((record) => record.identity.subject),
  );
  const refreshClientSubjectPairs = new Set(
    input.refreshRecords.map(
      (record) => `${record.clientId}:${record.identity.subject}`,
    ),
  );

  return {
    store: input.store,
    registeredClients: input.registeredClients,
    pendingAuthorizationCodes: input.pendingAuthorizationCodes,
    activeAccessTokens: input.accessRecords.length,
    activeAccessTokenSubjects: accessSubjects.size,
    activeRefreshTokens: input.refreshRecords.length,
    activeRefreshTokenSubjects: refreshSubjects.size,
    activeRefreshTokenClientSubjectPairs: refreshClientSubjectPairs.size,
    countedAt: new Date().toISOString(),
  };
}

export async function createRedisOAuthStateStore(options: {
  url: string;
  keyPrefix?: string;
}): Promise<RideOAuthStateStore> {
  const client = createClient({ url: options.url });
  client.on("error", (error) => {
    console.error("Rider OAuth Redis error:", error);
  });
  await client.connect();
  return new RedisOAuthStateStore(client as RedisClientType, options.keyPrefix ?? "ride:mcp:oauth");
}

function serializeAuthorizationCodeRecord(record: AuthorizationCodeRecord): string {
  return JSON.stringify({
    ...record,
    params: serializeAuthorizationParams(record.params),
  });
}

function deserializeAuthorizationCodeRecord(value: string): AuthorizationCodeRecord {
  const parsed = JSON.parse(value) as Omit<AuthorizationCodeRecord, "params"> & {
    params: ReturnType<typeof serializeAuthorizationParams>;
  };
  return {
    ...parsed,
    params: deserializeAuthorizationParams(parsed.params),
  };
}

function serializeAccessTokenRecord(record: AccessTokenRecord): string {
  return JSON.stringify({
    ...record,
    resource: record.resource?.toString(),
  });
}

function deserializeAccessTokenRecord(value: string): AccessTokenRecord {
  const parsed = JSON.parse(value) as Omit<AccessTokenRecord, "resource"> & {
    resource?: string;
  };
  return {
    ...parsed,
    resource: parsed.resource ? new URL(parsed.resource) : undefined,
  };
}

function serializeAuthorizationParams(params: AuthorizationParams): Omit<AuthorizationParams, "resource"> & {
  resource?: string;
} {
  return {
    ...params,
    resource: params.resource?.toString(),
  };
}

function deserializeAuthorizationParams(
  params: Omit<AuthorizationParams, "resource"> & { resource?: string },
): AuthorizationParams {
  return {
    ...params,
    resource: params.resource ? new URL(params.resource) : undefined,
  };
}

export class RideOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  private readonly store: RideOAuthStateStore;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;

  constructor(private readonly options: RideOAuthProviderOptions) {
    this.store = options.store ?? new InMemoryOAuthStateStore();
    this.clientsStore = this.store.clientsStore;
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 60 * 60;
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    params.scopes = validateSupportedScopes(params.scopes ?? [...DEFAULT_RIDE_OAUTH_SCOPES]);
    res.status(200).type("html").send(renderAuthorizePage(client, params, this.options.authPage));
  }

  async completeAuthorization(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scope?: string;
    resource?: string;
    rideAuthToken: string;
  }): Promise<string> {
    const client = await this.clientsStore.getClient(input.clientId);
    if (!client) {
      throw new InvalidRequestError("Unknown OAuth client.");
    }
    await this.validateAuthorizationRedirect(input.clientId, input.redirectUri);
    const scopes = normalizeRequestedScopes(input.scope);

    const identity = await this.options.validateRideToken(input.rideAuthToken);
    const code = randomUUID();
    await this.store.setAuthorizationCode(code, {
      client,
      params: {
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        state: input.state,
        scopes,
        resource: input.resource ? new URL(input.resource) : undefined,
      },
      rideAuthToken: input.rideAuthToken,
      identity,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return code;
  }

  async completePrivyAuthorization(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    state?: string;
    scope?: string;
    resource?: string;
    privy: PrivyAuthorizationInput;
  }): Promise<string> {
    const client = await this.clientsStore.getClient(input.clientId);
    if (!client) {
      throw new InvalidRequestError("Unknown OAuth client.");
    }
    await this.validateAuthorizationRedirect(input.clientId, input.redirectUri);
    const scopes = normalizeRequestedScopes(input.scope);

    const exchanged = await this.options.exchangePrivyToken({
      ...input.privy,
      authProvider: normalizePrivyAuthProvider(input.privy.authProvider),
    });
    const code = randomUUID();
    await this.store.setAuthorizationCode(code, {
      client,
      params: {
        codeChallenge: input.codeChallenge,
        redirectUri: input.redirectUri,
        state: input.state,
        scopes,
        resource: input.resource ? new URL(input.resource) : undefined,
      },
      rideAuthToken: exchanged.rideAuthToken,
      identity: exchanged.identity,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    return code;
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await this.store.getAuthorizationCode(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.store.getAuthorizationCode(authorizationCode);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired authorization code.");
    }
    if (record.client.client_id !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to a different client.");
    }
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request.");
    }
    if (resource && record.params.resource?.toString() !== resource.toString()) {
      throw new InvalidGrantError("resource does not match the authorization request.");
    }

    await this.store.deleteAuthorizationCode(authorizationCode);
    return this.issueTokens({
      clientId: client.client_id,
      scopes: record.params.scopes ?? [...DEFAULT_RIDE_OAUTH_SCOPES],
      rideAuthToken: record.rideAuthToken,
      identity: record.identity,
      resource: record.params.resource,
    });
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = await this.store.getRefreshToken(refreshToken);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidGrantError("Invalid or expired refresh token.");
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh token was issued to a different client.");
    }
    if (resource && record.resource?.toString() !== resource.toString()) {
      throw new InvalidGrantError("resource does not match the refresh token.");
    }

    const requestedScopes = scopes?.length
      ? validateSupportedScopes(scopes)
      : record.scopes;
    const expandedScopes = requestedScopes.filter(
      (scope) => !record.scopes.includes(scope),
    );
    if (expandedScopes.length) {
      throw new InvalidScopeError(
        `Refresh token cannot add scope: ${expandedScopes.join(" ")}`,
      );
    }

    await this.store.deleteRefreshToken(refreshToken);
    return this.issueTokens({
      ...record,
      scopes: requestedScopes,
      resource: resource ?? record.resource,
    });
  }

  async validateAuthorizationRedirect(
    clientId: string,
    redirectUri: string,
  ): Promise<URL> {
    const client = await this.clientsStore.getClient(clientId);
    if (!client) {
      throw new InvalidRequestError("Unknown OAuth client.");
    }
    if (!redirectUriAllowed(redirectUri, client.redirect_uris)) {
      throw new InvalidRequestError("Unregistered redirect_uri.");
    }
    return new URL(redirectUri);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.getAccessToken(token);
    if (!record || record.expiresAt < Date.now()) {
      throw new InvalidTokenError("Invalid or expired access token.");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource,
      extra: {
        rideAuthToken: record.rideAuthToken,
        subject: record.identity.subject,
        displayName: record.identity.displayName,
      },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    await this.store.deleteAccessToken(request.token);
    await this.store.deleteRefreshToken(request.token);
  }

  private async issueTokens(input: Omit<AccessTokenRecord, "expiresAt">): Promise<OAuthTokens> {
    const accessToken = `ride_at_${randomUUID()}`;
    const refreshToken = `ride_rt_${randomUUID()}`;
    const accessRecord: AccessTokenRecord = {
      ...input,
      expiresAt: Date.now() + this.accessTokenTtlSeconds * 1000,
    };
    const refreshRecord: RefreshTokenRecord = {
      ...input,
      expiresAt: Date.now() + this.refreshTokenTtlSeconds * 1000,
    };

    await this.store.setAccessToken(accessToken, accessRecord);
    await this.store.setRefreshToken(refreshToken, refreshRecord);

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: input.scopes.join(" "),
    };
  }
}

export function createRideOAuthApprovalRouter(provider: RideOAuthProvider): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));
  router.use(express.urlencoded({ extended: false, limit: "32kb" }));

  router.get("/auth/privy/oauth/callback", (_req: Request, res: Response) => {
    res.status(200).type("html").send(renderPrivyOAuthCallbackPage());
  });

  router.post("/auth/privy/approve", async (req: Request, res: Response) => {
    try {
      const code = await provider.completePrivyAuthorization({
        clientId: requiredField(req.body.client_id, "client_id"),
        redirectUri: requiredField(req.body.redirect_uri, "redirect_uri"),
        codeChallenge: requiredField(req.body.code_challenge, "code_challenge"),
        state: stringField(req.body.state),
        scope: stringField(req.body.scope),
        resource: stringField(req.body.resource),
        privy: {
          privyId: requiredField(req.body.privy_id, "privy_id"),
          privyAccessToken: requiredField(req.body.privy_access_token, "privy_access_token"),
          email: stringField(req.body.email),
          walletAddress: stringField(req.body.wallet_address),
          privyWalletId: stringField(req.body.privy_wallet_id),
          authProvider: normalizePrivyAuthProvider(req.body.auth_provider),
          accessCode: stringField(req.body.access_code),
        },
      });

      const target = new URL(requiredField(req.body.redirect_uri, "redirect_uri"));
      target.searchParams.set("code", code);
      const state = stringField(req.body.state);
      if (state) target.searchParams.set("state", state);
      res.json({ redirectUrl: target.toString() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Authorization failed.";
      res.status(error instanceof AgentError ? error.httpStatus : 400).json({
        error: "authorization_failed",
        message,
        ...(error instanceof AgentError ? {code: error.code, retryable: error.retryable} : {}),
      });
    }
  });

  router.post("/auth/approve", async (req: Request, res: Response) => {
    let validatedRedirect: URL | undefined;
    try {
      const action = stringField(req.body.action);
      const clientId = requiredField(req.body.client_id, "client_id");
      const redirectUri = requiredField(req.body.redirect_uri, "redirect_uri");
      const state = stringField(req.body.state);
      validatedRedirect = await provider.validateAuthorizationRedirect(
        clientId,
        redirectUri,
      );

      if (action === "deny") {
        redirectWithOAuthError(
          res,
          validatedRedirect,
          "access_denied",
          "Authorization was denied.",
          state,
        );
        return;
      }

      const code = await provider.completeAuthorization({
        clientId,
        redirectUri,
        codeChallenge: requiredField(req.body.code_challenge, "code_challenge"),
        state,
        scope: stringField(req.body.scope),
        resource: stringField(req.body.resource),
        rideAuthToken: requiredField(req.body.ride_token, "ride_token"),
      });

      const target = new URL(validatedRedirect);
      target.searchParams.set("code", code);
      if (state) target.searchParams.set("state", state);
      res.redirect(302, target.toString());
    } catch (error) {
      if (validatedRedirect) {
        const description = error instanceof Error ? error.message : "Authorization failed.";
        redirectWithOAuthError(
          res,
          validatedRedirect,
          "invalid_request",
          description,
          stringField(req.body.state),
        );
        return;
      }
      res.status(400).send("Invalid authorization request.");
    }
  });

  return router;
}

function requiredField(value: unknown, name: string): string {
  const parsed = stringField(value);
  if (!parsed) {
    throw new InvalidRequestError(`${name} is required.`);
  }
  return parsed;
}

function stringField(value: unknown): string | undefined {
  if (Array.isArray(value)) return stringField(value[0]);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function redirectWithOAuthError(
  res: Response,
  redirectUri: URL,
  error: string,
  description: string,
  state?: string,
): void {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  res.redirect(302, target.toString());
}

function redirectUriAllowed(redirectUri: string, registeredUris: string[]): boolean {
  return registeredUris.some((registered) => {
    if (redirectUri === registered) return true;
    try {
      const requestedUrl = new URL(redirectUri);
      const registeredUrl = new URL(registered);
      const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
      return (
        loopbackHosts.has(requestedUrl.hostname) &&
        loopbackHosts.has(registeredUrl.hostname) &&
        requestedUrl.protocol === registeredUrl.protocol &&
        requestedUrl.hostname === registeredUrl.hostname &&
        requestedUrl.pathname === registeredUrl.pathname &&
        requestedUrl.search === registeredUrl.search
      );
    } catch {
      return false;
    }
  });
}

const appAuthCss = readFileSync(new URL("../public/app-auth.css", import.meta.url), "utf8");

function renderAuthorizePage(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  config: RideAuthPageConfig,
): string {
  const clientName = client.client_name || "MCP Client";
  const scopes = params.scopes || [...DEFAULT_RIDE_OAUTH_SCOPES];
  const scope = scopes.join(" ");
  const fields = {
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    state: params.state,
    scope,
    resource: params.resource?.toString(),
  };
  const hiddenInputs = Object.entries(fields)
    .map(([name, value]) =>
      value
        ? `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
        : "",
    )
    .join("\n      ");
  const oauthPayload = JSON.stringify(fields).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Rider</title>
  <style>${appAuthCss}</style>
</head>
<body class="app-auth-page">
  <main class="app-auth oauth-auth">
    <div class="app-auth-visual" aria-hidden="true"></div>
    <div class="app-auth-brand"><div class="app-auth-wordmark">Rider</div><div class="app-auth-tagline">Follow top traders' bets.<br>Make smarter predictions.</div></div>
    <div class="app-auth-intro"><h1 id="auth-heading">Connect your Rider account</h1><p>${escapeHtml(clientName)} wants to connect to your Rider account.</p></div>

    <form id="sign-in-form">
      <div id="auth-entry" class="auth-actions">
        <button id="log-in" class="auth-primary" type="button">Log in</button>
        <button id="sign-up" type="button">Sign up</button>
      </div>
      <div id="auth-providers" class="auth-actions" hidden>
        <button id="google-login" class="google" type="button">
          Continue with Google
        </button>
        <button id="apple-login" class="apple" type="button">Continue with Apple</button>
        <button id="wallet-setup-retry" class="google" type="button" hidden>Retry wallet setup</button>
        <button id="auth-back" class="auth-back" type="button">Back</button>
      </div>
      <div id="status" class="status" aria-live="polite"></div>
    </form>

    <p class="app-auth-policy">By continuing, you agree to the <a href="https://docs.fiammalabs.io/terms-and-privacy-policy-ride/terms-of-service-ride" target="_blank" rel="noreferrer">Terms</a> and <a href="https://docs.fiammalabs.io/terms-and-privacy-policy-ride/privacy-policy-ride" target="_blank" rel="noreferrer">Privacy Policy</a>.</p>

    ${
      config.manualTokenAuthEnabled
        ? `<details class="fallback">
      <summary>Developer fallback: paste Ride access token</summary>
      <form method="post" action="/auth/approve">
      ${hiddenInputs}
      <div class="field">
        <label for="ride_token">Ride API bearer token</label>
        <textarea id="ride_token" name="ride_token" autocomplete="off" spellcheck="false" required></textarea>
      </div>
      <div class="actions">
        <button type="submit" name="action" value="approve">Authorize</button>
        <button type="submit" name="action" value="deny">Deny</button>
      </div>
      </form>
    </details>`
        : ""
    }
  </main>
  <script type="module">
    async function loadPrivySdk() {
      try {
        return await import('${escapeJs(config.jsSdkUrl)}');
      } catch {
        throw new Error('Could not load Rider sign-in. Check your connection and try again.');
      }
    }

    const config = {
      privyAppId: '${escapeJs(config.privyAppId)}',
      privyClientId: '${escapeJs(config.privyClientId)}',
      oauth: ${oauthPayload}
    };

    const AUTH_PROVIDER_KEY = 'ride:auth:provider';
    const statusEl = document.getElementById('status');
    const authEntry = document.getElementById('auth-entry');
    const authProviders = document.getElementById('auth-providers');
    const authHeading = document.getElementById('auth-heading');
    const googleLoginButton = document.getElementById('google-login');
    const appleLoginButton = document.getElementById('apple-login');
    const walletRetryButton = document.getElementById('wallet-setup-retry');

    let privy;
    let privyInitialization;
    let walletContext;
    let walletInitialization;

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.classList.toggle('error', isError);
    }

    function formatAuthError(error) {
      const message = error?.message || String(error);
      if (error?.code?.startsWith('WALLET_SETUP')) return message;
      if (message.includes('Redirect URL is not allowed')) {
        return 'Redirect URL is not allowed. Add ' + window.location.origin + '/auth/privy/oauth/callback in Privy Advanced -> Allowed OAuth redirect URLs.';
      }
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /aborted|timed? ?out/i.test(message)) {
        return 'The connection to Privy timed out. Check your network or proxy, then retry signing in. Your account has not been changed.';
      }
      return message;
    }

    function showAuthError(error) {
      walletRetryButton.hidden = !error?.code?.startsWith('WALLET_SETUP');
      setStatus(formatAuthError(error), true);
    }

    function setBusy(button, busy) {
      button.disabled = busy;
      button.style.opacity = busy ? '0.65' : '1';
    }

    async function initPrivy() {
      if (privy) return privy;
      if (privyInitialization) return privyInitialization;
      if (!config.privyAppId) {
        throw new Error('Rider is missing Privy configuration.');
      }
      privyInitialization = (async () => {
        const { default: Privy, LocalStorage } = await loadPrivySdk();
        const options = {
          appId: config.privyAppId,
          storage: new LocalStorage()
        };
        if (config.privyClientId) {
          options.clientId = config.privyClientId;
        }
        const client = new Privy(options);
        await client.initialize();
        privy = client;
        return client;
      })().catch((error) => {
        privyInitialization = undefined;
        throw error;
      });
      return privyInitialization;
    }

    function linkedAccounts(user) {
      const camel = Array.isArray(user?.linkedAccounts) ? user.linkedAccounts : [];
      const snake = Array.isArray(user?.linked_accounts) ? user.linked_accounts : [];
      return camel.length ? camel : snake;
    }

    function accountValue(account, camelKey, snakeKey) {
      return account?.[camelKey] ?? account?.[snakeKey];
    }

    function getEmailFromUser(user) {
      if (typeof user?.email === 'string') return user.email;
      if (typeof user?.email?.address === 'string') return user.email.address;
      if (typeof user?.emailAddress === 'string') return user.emailAddress;
      const accounts = linkedAccounts(user);
      const emailAccount = accounts.find((account) =>
        account?.email || account?.emailAddress || account?.email_address ||
        (account?.type === 'email' && account?.address)
      );
      return emailAccount?.email || emailAccount?.emailAddress || emailAccount?.email_address ||
        (emailAccount?.type === 'email' ? emailAccount.address : undefined);
    }

    function getEmbeddedEthereumWallet(user) {
      const accounts = linkedAccounts(user);
      const wallets = accounts.filter((account) => {
        const chainType = accountValue(account, 'chainType', 'chain_type');
        return (
          account?.type === 'wallet' &&
          chainType === 'ethereum' &&
          (
            ['privy', 'privy-v2'].includes(accountValue(account, 'walletClientType', 'wallet_client_type')) ||
            accountValue(account, 'connectorType', 'connector_type') === 'embedded'
          )
        );
      });
      wallets.sort((a, b) => {
        const left = accountValue(a, 'walletIndex', 'wallet_index') ?? 0;
        const right = accountValue(b, 'walletIndex', 'wallet_index') ?? 0;
        return Number(left) - Number(right);
      });
      return wallets[0];
    }

    function walletSetupError(message, code = 'WALLET_SETUP_INCOMPLETE') {
      return Object.assign(new Error(message), {code});
    }

    async function walletSession(client, expectedId) {
      const current = (await client.user.get()).user;
      const token = await client.getAccessToken();
      if (!current?.id || current.id !== expectedId || !token) {
        walletContext?.dispose();
        walletContext = walletInitialization = undefined;
        throw walletSetupError('Your Ride account changed during wallet setup. Sign in again.', 'ACCOUNT_CHANGED');
      }
      // A refreshed access token retains its session ID. Tokens stay in memory.
      let sessionId = token;
      try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.sid) sessionId = payload.sid;
      } catch { /* Older clients may return an opaque token. */ }
      const scope = expectedId + ':' + sessionId;
      if (walletContext && walletContext.scope !== scope) {
        walletContext.dispose();
        walletContext = walletInitialization = undefined;
      }
      return {user: current, scope, token};
    }

    async function prepareWalletContext(client, scope) {
      if (walletContext?.scope === scope) return walletContext.ready;
      walletContext?.dispose();
      const iframe = document.createElement('iframe');
      iframe.hidden = true;
      iframe.loading = 'eager';
      iframe.title = 'Privy secure wallet';
      const url = new URL(client.embeddedWallet.getURL());
      if (url.protocol !== 'https:') throw new Error('Secure wallet origin unavailable.');
      let timer;
      let rejectLoad;
      const loaded = new Promise((resolve, reject) => {
        rejectLoad = reject;
        iframe.addEventListener('load', resolve, {once: true});
        timer = setTimeout(() => reject(new Error('Secure wallet load timed out.')), 15000);
      });
      const onMessage = (event) => {
        if (event.source !== iframe.contentWindow || event.origin !== url.origin) return;
        try {
          Promise.resolve(client.embeddedWallet.onMessage(typeof event.data === 'string' ? JSON.parse(event.data) : event.data)).catch(() => {});
        } catch { /* Ignore unrelated frame messages. */ }
      };
      const context = {
        scope,
        dispose() {
          clearTimeout(timer);
          rejectLoad(new Error('Secure wallet context closed.'));
          window.removeEventListener('message', onMessage);
          iframe.remove();
        },
        ready: loaded.then(async () => {
          clearTimeout(timer);
          if (!(await client.embeddedWallet.ping(10000))) throw new Error('Secure wallet did not respond.');
        })
      };
      walletContext = context;
      context.ready.catch(() => {});
      try {
        client.setMessagePoster({
          postMessage: (message, _origin, transfer) => iframe.contentWindow?.postMessage(message, url.origin, transfer),
          reload: () => { iframe.src = client.embeddedWallet.getURL(); }
        });
        window.addEventListener('message', onMessage);
        iframe.src = url.href;
        document.body.append(iframe);
        await context.ready;
      } catch (error) {
        context.dispose();
        if (walletContext === context) walletContext = undefined;
        throw error;
      }
    }

    async function ensureEmbeddedEthereumWallet(client, user) {
      const state = await walletSession(client, user.id);
      const existing = getEmbeddedEthereumWallet(state.user);
      const reuse = (currentUser, wallet) => {
        if (!/^0x[0-9a-fA-F]{40}$/.test(wallet?.address || ''))
          throw walletSetupError('Your Ride wallet details could not be verified. Retry wallet setup to check this same wallet. Wallet setup does not transfer funds.');
        return {user: currentUser, wallet, scope: state.scope};
      };
      if (existing) return reuse(state.user, existing);
      if (walletInitialization?.scope === state.scope) return walletInitialization.promise;
      const setup = {scope: state.scope, promise: undefined};
      walletInitialization = setup;
      setup.promise = (async () => {
        try {
          setStatus('Creating Ride wallet...');
          await prepareWalletContext(client, state.scope);
          const before = await walletSession(client, user.id);
          if (before.scope !== state.scope) throw walletSetupError('Your Ride sign-in session changed during wallet setup. Sign in again.', 'ACCOUNT_CHANGED');
          const found = getEmbeddedEthereumWallet(before.user);
          if (found) return reuse(before.user, found);
          const solana = linkedAccounts(before.user).find((account) =>
            account?.type === 'wallet' && accountValue(account, 'chainType', 'chain_type') === 'solana' &&
            (['privy', 'privy-v2'].includes(accountValue(account, 'walletClientType', 'wallet_client_type')) ||
              accountValue(account, 'connectorType', 'connector_type') === 'embedded')
          );
          // Reuse this key after unknown responses, reloads and renewed sessions.
          const creation = client.embeddedWallet.create({
            idempotencyKey: 'ride_embedded_ethereum_' + user.id,
            ...(solana ? {solanaAccount: solana} : {})
          });
          let timer;
          const result = await Promise.race([
            creation,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Wallet setup timed out.')), 45000); })
          ]).finally(() => clearTimeout(timer));
          const after = await walletSession(client, user.id);
          if (after.scope !== state.scope || (result?.user?.id && result.user.id !== user.id))
            throw walletSetupError('Your Ride account changed during wallet setup. Sign in again.', 'ACCOUNT_CHANGED');
          const refreshedUser = getEmbeddedEthereumWallet(after.user) ? after.user : result?.user;
          const wallet = getEmbeddedEthereumWallet(refreshedUser);
          if (!/^0x[0-9a-fA-F]{40}$/.test(wallet?.address || ''))
            throw new Error('Privy did not return an embedded Ethereum wallet address.');
          return {user: refreshedUser, wallet, scope: state.scope};
        } catch (error) {
          if (error?.code === 'ACCOUNT_CHANGED') throw error;
          throw walletSetupError('Ride sign-in succeeded, but wallet setup could not be verified. Retry wallet setup to check the same wallet. Wallet setup does not transfer funds.');
        } finally {
          if (walletInitialization === setup) walletInitialization = undefined;
        }
      })();
      return setup.promise;
    }

    async function approveWithPrivy(user, privyAccessToken, wallet, authProvider) {
      const response = await fetch('/auth/privy/approve', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          ...config.oauth,
          privy_id: user.id,
          privy_access_token: privyAccessToken,
          email: getEmailFromUser(user),
          wallet_address: wallet?.address,
          privy_wallet_id: wallet?.id,
          auth_provider: authProvider
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || 'Rider authorization failed.');
      }
      window.location.assign(payload.redirectUrl);
    }

    async function finishPrivySession(session, authProvider) {
      const client = await initPrivy();
      let user = session?.user || (await client.user.get()).user;
      if (!user?.id) throw new Error('Privy login did not return a user.');
      const walletResult = await ensureEmbeddedEthereumWallet(client, user);
      user = walletResult.user;
      setStatus('Getting Rider authorization...');
      const authorization = await walletSession(client, user.id);
      if (authorization.scope !== walletResult.scope)
        throw walletSetupError('Your Ride sign-in session changed during wallet setup. Sign in again.', 'ACCOUNT_CHANGED');
      await approveWithPrivy(user, authorization.token, walletResult.wallet, authProvider);
    }

    function loginProvider() {
      const stored = sessionStorage.getItem(AUTH_PROVIDER_KEY);
      if (stored == null || stored === 'GOOGLE') return 'GOOGLE';
      if (stored === 'APPLE') return 'APPLE';
      throw new Error('Choose Google or Apple to restart sign-in.');
    }

    async function handleOAuthCallback() {
      const url = new URL(window.location.href);
      const authorizationCode = url.searchParams.get('privy_oauth_code');
      const stateCode = url.searchParams.get('privy_oauth_state');
      if (!authorizationCode && !stateCode) return;
      showAuthProviders('login');
      if (!authorizationCode || !stateCode) {
        throw new Error('Sign-in returned incomplete OAuth credentials.');
      }
      const provider = loginProvider();
      setStatus('Completing ' + (provider === 'APPLE' ? 'Apple' : 'Google') + ' sign-in...');
      const client = await initPrivy();
      const session = await client.auth.oauth.loginWithCode(
        authorizationCode,
        stateCode,
        provider.toLowerCase()
      );
      await finishPrivySession(session, provider);
    }

    async function startOAuthLogin(provider, button) {
      try {
        setBusy(googleLoginButton, true);
        setBusy(appleLoginButton, true);
        const label = provider === 'APPLE' ? 'Apple' : 'Google';
        setStatus('Starting ' + label + ' sign-in...');
        sessionStorage.setItem(AUTH_PROVIDER_KEY, provider);
        sessionStorage.setItem('ride:mcp:oauth_authorize_url', window.location.href);
        const client = await initPrivy();
        const response = await client.auth.oauth.generateURL(
          provider.toLowerCase(),
          window.location.origin + '/auth/privy/oauth/callback'
        );
        if (!response?.url) throw new Error(label + ' sign-in URL was not returned.');
        window.location.assign(response.url);
      } catch (error) {
        showAuthError(error);
        setBusy(googleLoginButton, false);
        setBusy(appleLoginButton, false);
      }
    }

    function showAuthProviders(intent) {
      authEntry.hidden = true;
      authProviders.hidden = false;
      authHeading.textContent = intent === 'signup' ? 'Create your Rider account' : 'Log in to Rider';
      setStatus('');
    }
    document.getElementById('log-in').addEventListener('click', () => showAuthProviders('login'));
    document.getElementById('sign-up').addEventListener('click', () => showAuthProviders('signup'));
    document.getElementById('auth-back').addEventListener('click', () => {
      authEntry.hidden = false;
      authProviders.hidden = true;
      authHeading.textContent = 'Connect your Rider account';
      setStatus('');
    });
    googleLoginButton.addEventListener('click', () => startOAuthLogin('GOOGLE', googleLoginButton));
    appleLoginButton.addEventListener('click', () => startOAuthLogin('APPLE', appleLoginButton));
    walletRetryButton.addEventListener('click', async () => {
      setBusy(walletRetryButton, true);
      try {
        await finishPrivySession(undefined, loginProvider());
      } catch (error) {
        showAuthError(error);
      } finally {
        setBusy(walletRetryButton, false);
      }
    });

    handleOAuthCallback().catch((error) => {
      showAuthError(error);
    });
  </script>
</body>
</html>`;
}

function renderPrivyOAuthCallbackPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Completing Rider Login</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2933;
      background: #fcfbf8;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(100%, 440px);
      background: #ffffff;
      border: 1px solid #dde3ea;
      border-radius: 20px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 22px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: #52616f;
      line-height: 1.55;
    }
    .error {
      color: #b42318;
    }
  </style>
</head>
<body>
  <main>
    <h1>Completing Rider Login</h1>
    <p id="status">Returning to Rider authorization...</p>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    const originalAuthorizeUrl = sessionStorage.getItem('ride:mcp:oauth_authorize_url');
    if (!originalAuthorizeUrl) {
      statusEl.textContent = 'Missing original Rider authorization request. Please restart authorization from your AI client.';
      statusEl.classList.add('error');
    } else {
      const currentUrl = new URL(window.location.href);
      const target = new URL(originalAuthorizeUrl);
      for (const key of ['privy_oauth_code', 'privy_oauth_state', 'error', 'error_description']) {
        const value = currentUrl.searchParams.get(key);
        if (value) target.searchParams.set(key, value);
      }
      window.location.replace(target.toString());
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJs(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n");
}
