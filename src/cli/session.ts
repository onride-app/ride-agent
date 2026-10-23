import {
  mkdir,
  readFile,
  writeFile,
  rename,
  lstat,
  chmod,
  open,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { AgentError } from "../agent/contracts.js";

export interface Session {
  server: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expires_at?: number;
  redirect_uri?: string;
}
export function serverUrl(value: string): string {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/mcp" ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["127.0.0.1", "localhost"].includes(u.hostname)
      ))
  )
    throw new AgentError(
      "INVALID_SERVER",
      "Server must be an HTTPS MCP URL (or loopback for development).",
      false,
      400,
    );
  return u.href;
}
export const sessionDir = () =>
  process.env.RIDE_CONFIG_DIR ?? join(homedir(), ".ride");
async function secureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const s = await lstat(dir);
  if (s.isSymbolicLink() || !s.isDirectory() || s.uid !== process.getuid?.())
    throw new Error("Unsafe Rider credential directory");
  await chmod(dir, 0o700);
}
export async function loadSession(
  dir = sessionDir(),
): Promise<Session | undefined> {
  await secureDirectory(dir);
  try {
    const path = join(dir, "session.json"),
      s = await lstat(path);
    if (s.isSymbolicLink() || !s.isFile() || s.uid !== process.getuid?.())
      throw new Error("Unsafe credential file");
    const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await h.chmod(0o600);
      return JSON.parse(await h.readFile("utf8")) as Session;
    } finally {
      await h.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export async function saveSession(
  session: Session,
  dir = sessionDir(),
): Promise<void> {
  await secureDirectory(dir);
  const target = join(dir, "session.json");
  try {
    if ((await lstat(target)).isSymbolicLink())
      throw new Error("Unsafe credential file");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temp = join(dir, `session-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(session), { mode: 0o600, flag: "wx" });
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function withSessionLock<T>(
  fn: () => Promise<T>,
  dir = sessionDir(),
): Promise<T> {
  await secureDirectory(dir);
  let handle;
  try {
    handle = await open(join(dir, "session.lock"), "wx", 0o600);
  } catch {
    throw new AgentError(
      "SESSION_BUSY",
      "Another Rider command is updating credentials. Retry after it finishes.",
      true,
    );
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    await unlink(join(dir, "session.lock"));
  }
}
export async function openBrowser(url: string): Promise<void> {
  const u = new URL(url);
  if (!["https:", "http:"].includes(u.protocol))
    throw new Error("Unsafe browser URL");
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["url.dll,FileProtocolHandler", u.href]
      : [u.href];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(command, args, { stdio: "ignore", shell: false });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Could not open browser")),
    );
  });
}
export function providerFor(
  session: Session,
  scope: string,
  redirect: (url: URL) => Promise<void>,
  redirectUri?: string,
): OAuthClientProvider {
  let verifier = "";
  return {
    redirectUrl: redirectUri ?? session.redirect_uri,
    clientMetadata: {
      client_name: "Rider",
      redirect_uris: [
        redirectUri ?? session.redirect_uri ?? "http://127.0.0.1/unused",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope,
    },
    clientInformation: () => session.client,
    saveClientInformation: async (c) => {
      session.client = c;
      await saveSession(session);
    },
    tokens: () => session.tokens,
    saveTokens: async (t) => {
      session.tokens = t;
      session.expires_at = Date.now() + (t.expires_in ?? 3600) * 1000;
      await saveSession(session);
    },
    redirectToAuthorization: redirect,
    saveCodeVerifier: (v) => {
      verifier = v;
    },
    codeVerifier: () => verifier,
    invalidateCredentials: async (kind) => {
      if (kind === "all" || kind === "tokens") {
        delete session.tokens;
        delete session.expires_at;
      }
      if (kind === "all" || kind === "client") delete session.client;
      await saveSession(session);
    },
  };
}
export async function login(
  server: string,
  trade = false,
  opener = openBrowser,
): Promise<void> {
  const normalized = serverUrl(server),
    scope = trade ? "ride:read ride:trade" : "ride:read",
    state = randomBytes(32).toString("base64url");
  const session: Session = { server: normalized };
  let resolveCode!: (code: string) => void, rejectCode!: (e: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const callbackPath = `/callback/${randomBytes(16).toString("hex")}`;
  const listener = createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://127.0.0.1`);
    const given = Buffer.from(u.searchParams.get("state") ?? ""),
      expected = Buffer.from(state);
    if (
      req.method !== "GET" ||
      u.pathname !== callbackPath ||
      given.length !== expected.length ||
      !timingSafeEqual(given, expected)
    ) {
      res.writeHead(400).end("Invalid OAuth callback");
      return;
    }
    if (u.searchParams.has("error")) {
      res.writeHead(400).end("Rider authorization declined");
      rejectCode(new Error("Authorization declined"));
      return;
    }
    const code = u.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("Missing code");
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      })
      .end("Rider connected. You can close this window.");
    resolveCode(code);
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const addr = listener.address();
  if (!addr || typeof addr === "string")
    throw new Error("Callback listener unavailable");
  const redirect = `http://127.0.0.1:${addr.port}${callbackPath}`;
  session.redirect_uri = redirect;
  const provider = providerFor(
    session,
    scope,
    (url) => opener(url.href),
    redirect,
  );
  provider.state = () => state;
  const timeout = setTimeout(
    () => rejectCode(new Error("Authorization timed out")),
    300000,
  );
  codePromise.catch(() => {});
  try {
    const first = await auth(provider, { serverUrl: normalized, scope });
    if (first === "REDIRECT") {
      const code = await codePromise;
      const complete = await auth(provider, {
        serverUrl: normalized,
        authorizationCode: code,
        scope,
      });
      if (complete !== "AUTHORIZED")
        throw new Error("Authorization did not complete");
    }
  } finally {
    clearTimeout(timeout);
    listener.close();
  }
}
export async function accessToken(session: Session): Promise<string> {
  if (!session.tokens)
    throw new AgentError("AUTH_REQUIRED", "Run ride login first.", false, 401);
  if ((session.expires_at ?? 0) < Date.now() + 60000) {
    const p = providerFor(
      session,
      session.tokens.scope ?? "ride:read",
      async () => {
        throw new AgentError(
          "AUTH_REQUIRED",
          "Run ride login again.",
          false,
          401,
        );
      },
    );
    if ((await auth(p, { serverUrl: session.server })) !== "AUTHORIZED")
      throw new AgentError(
        "AUTH_REQUIRED",
        "Run ride login again.",
        false,
        401,
      );
  }
  return session.tokens.access_token;
}
