import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const temp = await mkdtemp(join(tmpdir(), "ride-package-"));
try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  )[0];
  for (const f of packed.files) {
    assert(
      !/(\.test\.|fixtures[./]|dist\/index\.|(^|\/)\.env$|\.pem$|session\.json|output\/|\.playwright)/.test(
        f.path,
      ),
      `Unwanted package file: ${f.path}`,
    );
    assert(
      /^(dist\/|public\/(agent|confirm|fund|fund-demo)\.html|public\/(app-auth\.css|OFL-Poppins\.txt)$|skills\/|docs\/|README\.md|LICENSE|package\.json|\.env\.example)/.test(
        f.path,
      ),
      `Unexpected file: ${f.path}`,
    );
  }
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      temp,
      "--no-audit",
      "--no-fund",
      join(temp, packed.filename),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  for (const bin of ["ride"]) {
    const help = execFileSync(
      join(temp, "node_modules/.bin", bin),
      ["--help"],
      { encoding: "utf8" },
    );
    assert(help.includes("Rider"));
  }
  const root = join(temp, "node_modules", packed.name);
  const metadata = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  assert.equal(metadata.name, "@onride/agent");
  assert.equal(metadata.bin.ride, "dist/cli.js");
  for (const file of packed.files) {
    const body = await readFile(join(root, file.path), "utf8");
    assert(
      !/(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,})/.test(
        body,
      ),
      `Possible credential: ${file.path}`,
    );
  }
  const { setup } = await import(
    pathToFileURL(join(root, "dist/cli/setup.js"))
  );
  const { runCli } = await import(
    pathToFileURL(join(root, "dist/cli/commands.js"))
  );
  const { onboard } = await import(
    pathToFileURL(join(root, "dist/cli/onboarding.js"))
  );
  const { detectClients, selectClient } = await import(
    pathToFileURL(join(root, "dist/cli/clients.js"))
  );
  for (const client of ["codex", "claude-code", "cursor"]) {
    const home = join(temp, client);
    const result = await setup(client, "https://ride.test/mcp", home);
    const text = await readFile(result.config, "utf8");
    assert(
      text.includes(
        client === "codex"
          ? 'url = "https://ride.test/mcp"'
          : `${packed.name}@latest`,
      ),
    );
    await setup(client, undefined, home);
    assert.equal(await readFile(result.config, "utf8"), text);
    const autoHome = join(temp, "auto", client);
    await mkdir(
      join(autoHome, client === "claude-code" ? ".claude" : `.${client}`),
      { recursive: true },
    );
    const log = console.log;
    let authenticated = false;
    try {
      console.log = () => {};
      await runCli([], {
        selectClient: (requested) =>
          selectClient(requested, {
            detect: () =>
              detectClients({ home: autoHome, path: "", platform: "linux" }),
            interactive: false,
          }),
        onboard: (selected, server, options) =>
          onboard(selected, server, options, {
            home: autoHome,
            codex: async (args) => {
              assert.equal(args.at(-1), "ride:read,ride:trade");
              authenticated = true;
            },
            cliLogin: async (server, trade) => {
              assert.equal(trade, true);
              authenticated = true;
            },
          }),
      });
    } finally {
      console.log = log;
    }
    assert(authenticated);
    assert(
      (await readFile(join(result.skill, "SKILL.md"), "utf8")).includes(
        "name: ride",
      ),
    );
  }
  // Exercise the built stdio server, not a source import.
  const mcp = new Client({ name: "ride-package-verification", version: "1" });
  try {
    await mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "dist/cli.js"), "mcp"],
        env: {
          PATH: process.env.PATH ?? "",
          HOME: temp,
          RIDE_CONFIG_DIR: join(temp, "isolated-session"),
        },
      }),
    );
    assert.deepEqual(mcp.getServerVersion(), {
      name: "Rider",
      title: "Rider",
      version: metadata.version,
    });
    const { tools } = await mcp.listTools();
    assert(tools.some((tool) => tool.name === "get_ride_guide"));
    assert(tools.some((tool) => tool.name === "start_copy"));
  } finally {
    await mcp.close();
  }
  console.log(
    JSON.stringify({
      files: packed.files.length,
      tarball_bytes: packed.size,
      bins: 1,
      client_setups: 3,
      bare_command_setups: 3,
      private_history: false,
    }),
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
