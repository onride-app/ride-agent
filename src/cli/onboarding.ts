import { spawn } from "node:child_process";
import { setup, type ClientName } from "./setup.js";
import { login, withSessionLock } from "./session.js";

type RunCodex = (args: string[]) => Promise<void>;
type RunProgram = (command: string, args: string[]) => Promise<void>;
function runProgram(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${signal ?? code}`)),
    );
  });
}

export async function runCodex(
  args: string[],
  execute: RunProgram = runProgram,
): Promise<void> {
  try {
    await execute("codex", args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Use the official CLI without requiring a separate global installation.
    await execute("npx", ["-y", "@openai/codex@0.162.0", ...args]);
  }
}

export async function onboard(
  client: ClientName,
  server: string | undefined,
  options: {
    trade?: boolean;
    skipLogin?: boolean;
    distribution?: "github" | "npm";
  } = {},
  dependencies: {
    home?: string;
    codex?: RunCodex;
    cliLogin?: (server: string, trade: boolean) => Promise<unknown>;
  } = {},
) {
  const installed = await setup(
    client,
    server,
    dependencies.home,
    options.distribution,
  );
  if (options.skipLogin)
    return { ...installed, status: "configured", restart_required: true };
  const scopes = options.trade ? ["ride:read", "ride:trade"] : ["ride:read"];
  try {
    if (client === "codex")
      await (dependencies.codex ?? runCodex)([
        "mcp",
        "login",
        "ride",
        "--scopes",
        scopes.join(","),
      ]);
    else
      await (
        dependencies.cliLogin ??
        ((url, trade) => withSessionLock(() => login(url, trade)))
      )(installed.server, !!options.trade);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "Authentication failed";
    throw new Error(
      `Rider Skill and MCP are installed, but login is incomplete. Rerun the same setup command to retry. ${reason}`,
    );
  }
  return {
    ...installed,
    status: "connected",
    login_required: false,
    scopes,
    restart_required: true,
  };
}
