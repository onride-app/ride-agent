import { randomUUID } from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import { createClient, type RedisClientType } from "redis";

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

    const exchanged = await this.options.exchangePrivyToken(input.privy);
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
          authProvider: stringField(req.body.auth_provider),
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
      res.status(400).json({ error: "authorization_failed", message });
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

function renderAuthorizePage(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
  config: RideAuthPageConfig,
): string {
  const clientName = client.client_name || "MCP Client";
  const scope = (params.scopes || [...DEFAULT_RIDE_OAUTH_SCOPES]).join(" ");
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
      value ? `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">` : "",
    )
    .join("\n      ");
  const oauthPayload = JSON.stringify(fields).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Rider</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2933;
      background: #f6f7f9;
    }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main {
      width: min(100%, 460px);
      background: #ffffff;
      border: 1px solid #dde3ea;
      border-radius: 8px;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.12);
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 18px;
      color: #52616f;
      line-height: 1.55;
    }
    .scope {
      margin: 18px 0;
      padding: 12px;
      border: 1px solid #dde3ea;
      border-radius: 6px;
      background: #f9fafb;
      font-size: 13px;
      color: #394b59;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 650;
      margin-bottom: 8px;
    }
    input, textarea {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #c7d0d9;
      border-radius: 6px;
      padding: 10px 12px;
      font: 14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2933;
      min-height: 42px;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 18px;
    }
    button {
      appearance: none;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      min-height: 42px;
    }
    button[type="submit"], button.primary {
      flex: 1;
      background: #1677ff;
      color: #ffffff;
    }
    button.secondary, button[name="action"][value="deny"] {
      background: #ffffff;
      border-color: #c7d0d9;
      color: #394b59;
    }
    button.google {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: #ffffff;
      border-color: #c7d0d9;
      color: #1f2933;
      font-weight: 700;
    }
    .google-mark {
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 1px solid #dde3ea;
      font-weight: 800;
      font-size: 13px;
      color: #1677ff;
    }
    .field {
      margin-top: 14px;
    }
    .status {
      min-height: 20px;
      margin-top: 14px;
      font-size: 13px;
      color: #52616f;
      line-height: 1.45;
    }
    .status.error {
      color: #b42318;
    }
    .hidden {
      display: none;
    }
    .fallback {
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid #dde3ea;
    }
    .fallback summary {
      cursor: pointer;
      color: #52616f;
      font-size: 13px;
      font-weight: 650;
    }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Rider</h1>
    <p>${escapeHtml(clientName)} wants access to your Ride account for Auto-Ride tools.</p>
    <div class="scope">Scopes: ${escapeHtml(scope)}</div>

    <form id="google-form">
      <div class="field">
        <label for="access-code">Access code, if this is a new Ride account</label>
        <input id="access-code" name="access-code" type="text" autocomplete="off">
      </div>
      <div class="actions">
        <button id="google-login" class="google" type="button">
          <span class="google-mark">G</span>
          Continue with Google
        </button>
      </div>
      <div id="status" class="status">Continue with Google to connect your Ride account.</div>
    </form>

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
    import Privy, {LocalStorage} from '${escapeJs(config.jsSdkUrl)}';

    const config = {
      privyAppId: '${escapeJs(config.privyAppId)}',
      privyClientId: '${escapeJs(config.privyClientId)}',
      oauth: ${oauthPayload}
    };

    const ACCESS_CODE_KEY = 'ride:mcp:oauth_access_code';
    const statusEl = document.getElementById('status');
    const googleLoginButton = document.getElementById('google-login');
    const accessCodeInput = document.getElementById('access-code');

    let privy;
    let privyInitialization;

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.classList.toggle('error', isError);
    }

    function formatAuthError(error) {
      const message = error?.message || String(error);
      if (message.includes('Redirect URL is not allowed')) {
        return 'Redirect URL is not allowed. Add ' + window.location.origin + '/auth/privy/oauth/callback in Privy Advanced -> Allowed OAuth redirect URLs.';
      }
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || /aborted|timed? ?out/i.test(message)) {
        return 'The connection to Privy timed out. Check your network or proxy, then retry Continue with Google. Your account has not been changed.';
      }
      return message;
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
      const options = {
        appId: config.privyAppId,
        storage: new LocalStorage()
      };
      if (config.privyClientId) {
        options.clientId = config.privyClientId;
      }
      privyInitialization = (async () => {
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
        account?.email || account?.address || account?.emailAddress || account?.email_address
      );
      return emailAccount?.email || emailAccount?.address || emailAccount?.emailAddress || emailAccount?.email_address || undefined;
    }

    function getEmbeddedEthereumWallet(user) {
      const accounts = linkedAccounts(user);
      const wallets = accounts.filter((account) => {
        const chainType = accountValue(account, 'chainType', 'chain_type');
        return (
          account?.type === 'wallet' &&
          chainType === 'ethereum' &&
          account?.address &&
          (
            accountValue(account, 'walletClientType', 'wallet_client_type') === 'privy' ||
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

    async function ensureEmbeddedEthereumWallet(client, user) {
      let wallet = getEmbeddedEthereumWallet(user);
      if (wallet) return {user, wallet};

      if (!client.embeddedWallet?.add) {
        throw new Error('Privy login did not return an embedded wallet.');
      }

      setStatus('Creating Ride wallet...');
      const result = await client.embeddedWallet.add({chainType: 'ethereum'});
      const refreshedUser = result?.user || (await client.user.get()).user || user;
      wallet = getEmbeddedEthereumWallet(refreshedUser);
      if (!wallet?.address) {
        throw new Error('Privy did not return an embedded wallet address.');
      }
      return {user: refreshedUser, wallet};
    }

    function getStoredAccessCode() {
      return accessCodeInput.value.trim() || sessionStorage.getItem(ACCESS_CODE_KEY) || undefined;
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
          auth_provider: authProvider,
          access_code: getStoredAccessCode()
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || 'Rider authorization failed.');
      }
      sessionStorage.removeItem(ACCESS_CODE_KEY);
      window.location.assign(payload.redirectUrl);
    }

    async function finishPrivySession(session, authProvider) {
      const client = await initPrivy();
      let user = session?.user || (await client.user.get()).user;
      if (!user?.id) throw new Error('Privy login did not return a user.');
      const walletResult = await ensureEmbeddedEthereumWallet(client, user);
      user = walletResult.user;
      setStatus('Getting Rider authorization...');
      const privyAccessToken = await client.getAccessToken();
      if (!privyAccessToken) throw new Error('Could not get Privy access token.');
      await approveWithPrivy(user, privyAccessToken, walletResult.wallet, authProvider);
    }

    function googleRedirectUrl() {
      return window.location.origin + '/auth/privy/oauth/callback';
    }

    async function handleGoogleCallback() {
      const url = new URL(window.location.href);
      const authorizationCode = url.searchParams.get('privy_oauth_code');
      const stateCode = url.searchParams.get('privy_oauth_state');
      if (!authorizationCode && !stateCode) return;
      if (!authorizationCode || !stateCode) {
        throw new Error('Google login returned incomplete OAuth credentials.');
      }
      setStatus('Completing Google login...');
      const client = await initPrivy();
      const session = await client.auth.oauth.loginWithCode(
        authorizationCode,
        stateCode,
        'google'
      );
      await finishPrivySession(session, 'GOOGLE');
    }

    googleLoginButton.addEventListener('click', async () => {
      try {
        setBusy(googleLoginButton, true);
        setStatus('Starting Google login...');
        const accessCode = accessCodeInput.value.trim();
        if (accessCode) sessionStorage.setItem(ACCESS_CODE_KEY, accessCode);
        sessionStorage.setItem('ride:mcp:oauth_authorize_url', window.location.href);
        const client = await initPrivy();
        const response = await client.auth.oauth.generateURL('google', googleRedirectUrl());
        if (!response?.url) throw new Error('Google login URL was not returned.');
        window.location.assign(response.url);
      } catch (error) {
        setStatus(formatAuthError(error), true);
        setBusy(googleLoginButton, false);
      }
    });

    handleGoogleCallback().catch((error) => {
      setStatus(formatAuthError(error), true);
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
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2933;
      background: #f6f7f9;
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
      border-radius: 8px;
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
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n");
}
