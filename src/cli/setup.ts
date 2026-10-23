import {
  readFile,
  mkdir,
  lstat,
  writeFile,
  cp,
  rm,
  readdir,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import TOML from "@iarna/toml";
import { serverUrl } from "./session.js";
import {
  mcpLaunchArgs,
  PACKAGE_NAME,
  VERSION,
  GITHUB_REPOSITORY,
} from "../version.js";

export type ClientName = "codex" | "claude-code" | "cursor";
const legacySkillHashes = new Set([
  // Complete company bootstrap Skill shipped in @onride/agent@0.5.1-rc.0 and 0.5.2.
  "5c7f618213f7a57d1582c05db6e91916841fa073e40e0767580808818cbe101d",
  // Complete Skill shipped in the public @glenyang/ride-cli@0.5.0 tarball.
  "352f6193233417a573d583669a7effc396a46746085ee6e81197923030a64fb3",
  // Complete unmodified released v0.4.1, v0.4.2 and v0.4.3 Skill trees.
  "eb93a8803fb194e78a94507b37572df0f800c91fe82f0351041e0962c35f57d2",
  "7121fe569d33be5eea9f600b96b31246b09962942883d0986642766ede89054c",
  "51b095b73aed49b49f64f004e51ed2f3bf369d26dd3628a3fccf954e8322ee6e",
  // Unmodified v0.4.0 Skill tree.
  "fa661229246655abb153eccc5fea9862e53b6c02f18b9c3e12b9b962119c4272",
  // Unmodified v0.3.4 Skill tree.
  "d460b444e14160d31557f8e1067ee6a12d3c6b1a38d9fbee8f0a4c9fc6c42d89",
  // Unmodified v0.3.3 Skill tree.
  "7cb7c4a8623ccc6208dc8f7503183b57f9435706c6abdbc016a85c30361f791c",
  // Unmodified v0.3.2 Skill tree.
  "7b10fc2561bfef91af30912041fc517a471d15126f8c1e0d6a98860e3d7121c8",
  // Unmodified v0.3.1 Skill tree.
  "79f8eb9333ba4b463daa78f1e97c010861ed81c0c6297814e180ca9fc20843f6",
  // Unmodified v0.3.0 Skill tree.
  "c128e338d1ba8c5b35cb752e67be9abb497a060a0b0826c567bf0a464d55b0c2",
  // Complete, unmodified Skill trees shipped in v0.2.1 and v0.2.2.
  "dc89f7beb9d8e2cb31f2dabfac80b18e546b2cd24f4318f1b84a5e1f93a65619",
  "34e2442586e5136274d18e0037bae2c3c9eaefca9d37a3be597ec79f1081e432",
]);
const managedVersions = [
  "0.2.1",
  "0.2.2",
  "0.2.3",
  "0.3.0",
  "0.3.1",
  "0.3.2",
  "0.3.3",
  "0.3.4",
  "0.4.0",
  "0.4.1",
  "0.4.2",
  "0.4.3",
  "0.5.0",
  "0.5.1",
  "0.5.1-rc.0",
  "0.5.2",
  VERSION,
];

async function skillHash(root: string): Promise<string | undefined> {
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Unsafe existing Rider Skill");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  const files = new Map<string, Buffer>();
  async function visit(relative: string): Promise<void> {
    for (const item of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink())
        throw new Error("Unsafe existing Rider Skill");
      if (item.isDirectory()) await visit(name);
      else if (item.isFile()) files.set(name, await readFile(join(root, name)));
      else throw new Error("Unsafe existing Rider Skill");
    }
  }
  await visit("");
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort())
    hash.update(name).update("\0").update(files.get(name)!).update("\0");
  return hash.digest("hex");
}

function managedStdio(
  current: Record<string, unknown>,
  server: string,
): boolean {
  if (
    Object.keys(current).sort().join(",") !== "args,command" ||
    current.command !== "npx"
  )
    return false;
  // Accept only launch shapes emitted by released installers. Extra arguments,
  // env, wrappers and unknown versions belong to the user and require review.
  return [...managedVersions, "latest"].some((version) => {
    const packages = [
      ...["@glenyang/ride-cli", "@glen-yang/ride-cli", PACKAGE_NAME].map(
        (name) => `${name}@${version}`,
      ),
      ...(version === "latest"
        ? []
        : [
            `github:Glen-yang/ride-mcp#v${version}`,
            `github:${GITHUB_REPOSITORY}#v${version}`,
          ]),
    ];
    return packages.some((pkg) =>
      [["-y"], ["-y", "--prefer-online"]].some(
        (prefix) =>
          JSON.stringify(current.args) ===
          JSON.stringify([...prefix, pkg, "mcp", "--server", server]),
      ),
    );
  });
}

function installedServer(
  current: Record<string, unknown> | undefined,
): string | undefined {
  if (!current) return undefined;
  if (typeof current.url === "string") return current.url;
  const args = current.args;
  if (
    Array.isArray(args) &&
    args.at(-2) === "--server" &&
    typeof args.at(-1) === "string"
  ) {
    const server = args.at(-1) as string;
    if (managedStdio(current, server)) return server;
  }
  return undefined;
}

export async function setup(
  client: ClientName,
  requestedServer: string | undefined,
  home?: string,
  distribution: "github" | "npm" = "npm",
): Promise<{
  client: ClientName;
  server: string;
  config: string;
  skill: string;
  login_required: true;
  transport: "http" | "stdio";
  auto_updates: { mcp: "hosted" | "on_restart" | "pinned"; workflow: "live" };
}> {
  if (!["codex", "claude-code", "cursor"].includes(client))
    throw new Error("Unsupported client");
  const base = home ?? homedir();
  const codex =
    home === undefined && process.env.CODEX_HOME
      ? process.env.CODEX_HOME
      : join(base, ".codex");
  const config =
    client === "codex"
      ? join(codex, "config.toml")
      : client === "claude-code"
        ? join(base, ".claude.json")
        : join(base, ".cursor", "mcp.json");
  const skill = join(
    client === "codex"
      ? codex
      : join(base, client === "claude-code" ? ".claude" : ".cursor"),
    "skills",
    "ride",
  );
  let old: string | undefined;
  try {
    if ((await lstat(config)).isSymbolicLink())
      throw new Error("Configuration is a symlink; refusing to replace it");
    old = await readFile(config, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const conflict = () =>
    new Error(
      `Existing Rider MCP registration differs at ${config}; no files changed. Back up this file, retain your server URL and custom parameters, and replace only the old package with ${PACKAGE_NAME}@latest after review. Keep a customized registration under manual management; see docs/ride-agent-migration.md.`,
    );
  const parsed =
    client === "codex"
      ? (TOML.parse(old ?? "") as any)
      : JSON.parse(old ?? "{}");
  const current =
    client === "codex" ? parsed.mcp_servers?.ride : parsed.mcpServers?.ride;
  const server = serverUrl(
    requestedServer ?? installedServer(current) ?? "https://mcp.onride.me/mcp",
  );
  const args = mcpLaunchArgs(distribution, server);
  const entry = client === "codex" ? { url: server } : { command: "npx", args };
  let next: string;
  if (client === "codex") {
    if (
      current &&
      current.url === server &&
      !("command" in current) &&
      !("args" in current) &&
      !("bearer_token_env_var" in current) &&
      !("http_headers" in current) &&
      !("env_http_headers" in current) &&
      current.enabled !== false
    ) {
      next = old!;
    } else if (current && managedStdio(current, server)) {
      // Only our generated legacy stanza is replaced; unrelated text stays verbatim.
      const stanza =
        /^\[mcp_servers\.ride\][ \t]*(?:#[^\n]*)?\r?\n([^]*?)(?=^\[|$(?![^]))/m;
      const match = stanza.exec(old!);
      if (
        !match ||
        !/^command[ \t]*=/m.test(match[1]) ||
        !/^args[ \t]*=.*\][ \t]*\r?$/m.test(match[1])
      )
        throw conflict();
      next = old!.replace(stanza, (text) =>
        text
          .replace(
            /^command[ \t]*=.*\r?\n/m,
            `url = ${JSON.stringify(server)}\n`,
          )
          .replace(/^args[ \t]*=.*\][ \t]*\r?\n?/m, ""),
      );
    } else {
      if (current) throw conflict();
      next = `${old ?? ""}\n[mcp_servers.ride]\nurl = ${JSON.stringify(server)}\n`;
    }
    // Verify the edited stanza really resolves to the intended native HTTP server.
    const check = (TOML.parse(next) as any).mcp_servers.ride;
    if (check.url !== server || check.command || check.args) throw conflict();
  } else {
    if (current && !managedStdio(current, server)) throw conflict();
    parsed.mcpServers = { ...parsed.mcpServers, ride: entry };
    next = JSON.stringify(parsed, null, 2) + "\n";
  }
  const packaged = fileURLToPath(
    new URL("../../skills/ride/", import.meta.url),
  );
  const present = await skillHash(skill),
    incoming = await skillHash(packaged);
  if (present && present !== incoming && !legacySkillHashes.has(present))
    throw new Error(
      `Existing Rider Skill differs at ${skill}; no files changed. Back up and compare your custom instructions with the packaged skills/ride. Keep a merged Skill under manual management, or move your backup aside yourself before retrying setup --skip-login.`,
    );
  await mkdir(dirname(skill), { recursive: true });
  await mkdir(dirname(config), { recursive: true });
  const suffix = randomBytes(6).toString("hex");
  const tempSkill = `${skill}.${suffix}.tmp`,
    backupSkill = `${skill}.${suffix}.bak`;
  const tempConfig = `${config}.${suffix}.tmp`;
  let committed = false,
    skillChanged = false,
    skillBackedUp = false;
  try {
    if (present !== incoming)
      await cp(packaged, tempSkill, { recursive: true, dereference: false });
    await writeFile(tempConfig, next, { mode: 0o600, flag: "wx" });
    let latest: string | undefined;
    try {
      if ((await lstat(config)).isSymbolicLink())
        throw new Error("Configuration changed during setup");
      latest = await readFile(config, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (latest !== old || (await skillHash(skill)) !== present)
      throw new Error(
        "Client configuration or Skill changed during setup; retry",
      );
    if (present !== incoming) {
      if (present !== undefined) {
        await fs.rename(skill, backupSkill);
        skillBackedUp = true;
      }
      await fs.rename(tempSkill, skill);
      skillChanged = true;
    }
    await fs.rename(tempConfig, config);
    committed = true;
    return {
      client,
      server,
      config,
      skill,
      login_required: true,
      transport: client === "codex" ? "http" : "stdio",
      auto_updates: {
        mcp:
          client === "codex"
            ? "hosted"
            : distribution === "npm"
              ? "on_restart"
              : "pinned",
        workflow: "live",
      },
    };
  } catch (e) {
    if (skillChanged) await rm(skill, { recursive: true, force: true });
    if (skillBackedUp) await fs.rename(backupSkill, skill);
    throw e;
  } finally {
    await rm(tempConfig, { force: true });
    await rm(tempSkill, { force: true, recursive: true });
    if (committed) await rm(backupSkill, { force: true, recursive: true });
  }
}
