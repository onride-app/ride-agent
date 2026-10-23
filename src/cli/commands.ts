import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  inputs,
  mutationTools,
  type ToolName,
  type Result,
  AgentError,
} from "../agent/contracts.js";
import {
  invokeAgent,
  registerAgentTools,
  registerAppAccountRead,
} from "../agent/mcp.js";
import { accountCopiesInput } from "../account_reads.js";
import {
  loadSession,
  login,
  accessToken,
  withSessionLock,
  openBrowser,
  serverUrl,
} from "./session.js";
import { onboard } from "./onboarding.js";
import { selectClient } from "./clients.js";
import { VERSION } from "../version.js";
import { fetchGuide, GUIDE_INSTRUCTIONS, registerGuide } from "../guide.js";

export const HELP = `Rider — AI Copy-Trading Agent\n  Run with no arguments to install Skill + MCP and start browser login.\n  setup [--client codex|claude-code|cursor|auto] [--trade] [--skip-login] [--server URL] [--distribution npm|github]\n  login --server https://YOUR-RIDE-HOST/mcp [--trade]\n  preferences --json '{"budget_usdc":"500","risk_tolerance":"medium"}'\n  recommend | traders [--sort score|drawdown|roi] [--limit 10] [--cursor CURSOR] | trader TRADER_ID | portfolio [PORTFOLIO_ID] | review [PORTFOLIO_ID]\n  copy start PLAN_ID | copy update COPY_ID --json '{"leverage_cap":5}'\n  copy stop COPY_ID [--mode wind_down|close_now]\n  updates [--cursor CURSOR] [--limit 20] | position close POSITION_ID\n  plan recalculate PLAN_ID [--json ALLOCATIONS_JSON]\n  performance [PORTFOLIO_ID] [--period daily|weekly|inception]\n  diagnose COPY_ID --start-at MILLISECONDS --end-at MILLISECONDS\n  copies [--status open] [--limit 100] [--offset 0]\n  notifications [--json SETTINGS_JSON]\n  proposal PROPOSAL_ID | confirm PROPOSAL_ID\n  guide [--server URL] (current workflow; no login)\n  mcp [--server URL]\n  deposit options | deposit address --json ROUTE | deposit prepare DEPOSIT_ID --json AMOUNT | deposit status DEPOSIT_ID\n  portfolio update PORTFOLIO_ID --json CHANGES | daily [--timezone Asia/Shanghai]\nSetup installs Skill + MCP and starts browser login (default server: https://mcp.onride.me/mcp).\nJSON output is default. --pretty renders a human-readable view. Confirmation opens Ride.\n`;
export function parseCommand(argv: string[]): {
  command: string;
  name?: ToolName;
  args: Record<string, unknown>;
  flags: Record<string, string | boolean>;
  positionals: string[];
} {
  const flags: Record<string, string | boolean> = {},
    positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith("--")) {
      const key = x.slice(2);
      if (["pretty", "trade", "help", "skip-login"].includes(key))
        flags[key] = true;
      else {
        const value = argv[++i];
        if (!value || value.startsWith("--"))
          throw new Error(`Missing --${key} value`);
        flags[key] = value;
      }
    } else positionals.push(x);
  }
  const command = positionals[0] ?? "setup";
  if (
    command === "setup" &&
    flags.distribution !== undefined &&
    !["npm", "github"].includes(String(flags.distribution))
  ) {
    throw new Error("--distribution must be npm or github.");
  }
  let name: ToolName | undefined;
  let args: Record<string, unknown> = {};
  if (flags.json) {
    const parsed = JSON.parse(flags.json as string);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("--json requires an object");
    args = parsed;
  }
  if (command === "deposit") {
    if (positionals[1] === "prepare") {
      name = "prepare_deposit";
      args.deposit_id = positionals[2];
    } else if (positionals[1] === "options") name = "get_deposit_options";
    else if (positionals[1] === "address") name = "get_deposit_address";
    else if (positionals[1] === "status") {
      name = "check_deposit_status";
      args.deposit_id = positionals[2];
    } else
      throw new Error(
        'Use deposit options, address --json ROUTE, prepare DEPOSIT_ID --json \'{"amount_usdc":"10"}\', or status DEPOSIT_ID',
      );
  }
  if (command === "daily") {
    name = "get_daily_checkin";
    if (flags.timezone) args.timezone = flags.timezone;
  }
  if (command === "preferences")
    name = flags.json ? "set_preferences" : "get_preferences";
  if (command === "plan" && positionals[1] === "recalculate") {
    name = "recalculate_plan";
    args.plan_id = positionals[2];
  }
  if (command === "performance") {
    name = "get_performance";
    if (positionals[1]) args.portfolio_id = positionals[1];
    if (flags.period) args.period = flags.period;
  }
  if (command === "diagnose") {
    name = "diagnose_copy";
    args.copy_id = positionals[1];
    args.start_at = Number(flags["start-at"]);
    args.end_at = Number(flags["end-at"]);
  }
  if (command === "notifications")
    name = flags.json
      ? "set_notification_preferences"
      : "get_notification_preferences";
  if (command === "recommend") name = "recommend_traders";
  if (command === "traders") {
    name = "browse_traders";
    if (flags.sort) args.sort_by = flags.sort;
    if (flags.direction) args.direction = flags.direction;
    if (flags.limit) args.limit = Number(flags.limit);
    if (flags.cursor) args.cursor = flags.cursor;
  }
  if (command === "trader") {
    name = "get_trader_profile";
    args.trader_id = positionals[1];
  }
  if (command === "portfolio" && positionals[1] === "update") {
    name = "update_portfolio";
    args.portfolio_id = positionals[2];
  } else if (command === "portfolio" || command === "review") {
    name = command === "portfolio" ? "get_portfolio" : "review_portfolio";
    if (positionals[1]) args.portfolio_id = positionals[1];
  }
  if (command === "updates") {
    name = "get_updates";
    if (flags.cursor) args.cursor = flags.cursor;
    if (flags.limit) args.limit = Number(flags.limit);
  }
  if (command === "copy") {
    const action = positionals[1];
    name =
      action === "start"
        ? "start_copy"
        : action === "update"
          ? "update_copy"
          : action === "stop"
            ? "stop_copy"
            : undefined;
    if (!name) throw new Error("Unknown copy command");
    args[action === "start" ? "plan_id" : "copy_id"] = positionals[2];
    if (flags.mode) args.mode = flags.mode;
  }
  if (command === "position" && positionals[1] === "close") {
    name = "close_position";
    args.position_id = positionals[2];
  }
  return { command, name, args, flags, positionals };
}
export async function runCli(
  argv: string[],
  installDependencies: {
    selectClient?: typeof selectClient;
    onboard?: typeof onboard;
  } = {},
): Promise<void> {
  const parsed = parseCommand(argv),
    { command, name, args, flags, positionals } = parsed;
  if (command === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (command === "setup") {
    const server = flags.server ?? process.env.RIDE_MCP_URL;
    console.log(
      JSON.stringify(
        await (installDependencies.onboard ?? onboard)(
          await (installDependencies.selectClient ?? selectClient)(
            flags.client as string | undefined,
          ),
          server as string | undefined,
          {
            trade: positionals.length === 0 || flags.trade === true,
            skipLogin: flags["skip-login"] === true,
            distribution: flags.distribution === "github" ? "github" : "npm",
          },
        ),
      ),
    );
    return;
  }
  if (command === "login") {
    const server =
      flags.server ?? process.env.RIDE_MCP_URL ?? "https://mcp.onride.me/mcp";
    await withSessionLock(() => login(server as string, flags.trade === true));
    console.log(
      JSON.stringify({
        status: "connected",
        scopes: flags.trade ? ["ride:read", "ride:trade"] : ["ride:read"],
      }),
    );
    return;
  }
  if (command === "guide") {
    const url =
      flags.server ?? process.env.RIDE_MCP_URL ?? "https://mcp.onride.me/mcp";
    console.log(JSON.stringify(await fetchGuide(String(url))));
    return;
  }
  if (command === "mcp") {
    const server = new McpServer(
      { name: "ride", title: "Rider", version: VERSION },
      { instructions: GUIDE_INSTRUCTIONS },
    );
    registerGuide(server, async () => {
      const session =
        flags.server || process.env.RIDE_MCP_URL
          ? undefined
          : await loadSession();
      return fetchGuide(
        String(
          flags.server ??
            process.env.RIDE_MCP_URL ??
            session?.server ??
            "https://mcp.onride.me/mcp",
        ),
      );
    });
    registerAgentTools(server, async (tool, input) =>
      withSessionLock(async () => {
        const session = await loadSession();
        if (!session)
          throw new AgentError(
            "AUTH_REQUIRED",
            "Run ride login first.",
            false,
            401,
          );
        if (
          flags.server &&
          serverUrl(flags.server as string) !== session.server
        )
          throw new AgentError(
            "AUTH_REQUIRED",
            "Login issuer does not match this MCP configuration.",
            false,
            401,
          );
        return invokeAgent(
          session.server,
          await accessToken(session),
          tool,
          input,
        );
      }),
    );
    registerAppAccountRead(server, async (input) =>
      withSessionLock(async () => {
        const session = await loadSession();
        if (
          !session ||
          (flags.server && serverUrl(flags.server as string) !== session.server)
        )
          throw new AgentError(
            "AUTH_REQUIRED",
            "Run ride login first.",
            false,
            401,
          );
        return invokeAgent(
          session.server,
          await accessToken(session),
          "get_my_copies",
          input,
        );
      }),
    );
    await server.connect(new StdioServerTransport());
    return;
  }
  await withSessionLock(async () => {
    const session = await loadSession();
    if (!session)
      throw new AgentError(
        "AUTH_REQUIRED",
        "Run ride login first.",
        false,
        401,
      );
    const token = await accessToken(session);
    if (command === "copies") {
      const input = accountCopiesInput.parse({
        ...args,
        ...(flags.limit ? { limit: Number(flags.limit) } : {}),
        ...(flags.offset ? { offset: Number(flags.offset) } : {}),
        ...(flags.status ? { status: flags.status } : {}),
      });
      print(
        await invokeAgent(session.server, token, "get_my_copies", input),
        !!flags.pretty,
      );
      return;
    }
    if (command === "proposal" || command === "confirm") {
      const value = await invokeAgent(session.server, token, "proposal", {
        proposal_id: positionals[1],
      });
      if (command === "confirm") {
        const proposal = value.data.proposal as { confirmation_url?: string };
        if (!proposal?.confirmation_url)
          throw new Error("Proposal has no confirmation URL");
        const confirmation = new URL(proposal.confirmation_url);
        if (confirmation.origin !== new URL(session.server).origin)
          throw new Error("Confirmation origin does not match Rider");
        await openBrowser(confirmation.href);
      }
      print(value, !!flags.pretty);
      return;
    }
    if (!name) throw new Error("Unknown command. Run ride --help.");
    const input = inputs[name].parse(args);
    if (
      mutationTools.has(name) &&
      !session.tokens?.scope?.split(" ").includes("ride:trade")
    )
      throw new AgentError(
        "SCOPE_REQUIRED",
        "Run ride login --trade to enable proposals.",
        false,
        403,
      );
    print(
      await invokeAgent(session.server, token, name, input),
      !!flags.pretty,
    );
  });
}
function print(value: Result, pretty: boolean): void {
  if (!pretty) {
    console.log(JSON.stringify(value));
    return;
  }
  console.log(`Rider · ${value.status} · ${value.as_of}`);
  const data = value.data as any;
  if (Array.isArray(data.candidates)) {
    console.log(
      `Eligible candidates: ${data.candidates.length} returned / ${data.candidates_meta?.total ?? data.candidates.length} total`,
    );
    console.table(
      data.candidates.map((c: any) => ({
        trader: c.handle,
        id: c.id,
        score: c.score,
        market: c.market,
        assets: c.assets.join(", "),
        eligibility: c.eligibility,
      })),
    );
  }
  if (data.account_balances) {
    const b = data.account_balances;
    console.log(
      `Account total: ${b.summary.account_value_usd ?? "unavailable"} USD · verified subtotal: ${b.summary.known_subtotal_usd ?? "unavailable"} USD`,
    );
    console.table(
      Object.entries(b.markets).map(([market, m]: [string, any]) => ({
        market,
        status: m.status,
        equity_USD: m.account_value_usd ?? "unavailable",
        trading_USDC: m.available_trading_usdc ?? "unavailable",
        reserved_USDC: m.occupied_or_reserved_usdc ?? "unavailable",
        positions_USD: m.positions_value_usd ?? "unavailable",
        fetched_at: m.fetched_at,
      })),
    );
  }
  if (value.error) {
    console.log(`${value.error.code}: ${value.error.message}`);
    if (value.data.recommendation_diagnostics)
      console.log(
        JSON.stringify(value.data.recommendation_diagnostics, null, 2),
      );
    return;
  }
  if (data.account?.authenticated)
    console.log(`Signed in: ${data.account.display_name ?? "Ride user"}`);
  const app =
    data.app_copies ?? (data.query_scope === "ride_app_copies" ? data : null);
  if (app?.perps && app?.prediction) {
    for (const [market, copies] of [
      ["Perps", app.perps],
      ["Prediction", app.prediction],
    ] as const) {
      console.log(
        `${market} App copies · ${copies.configs.length} configs · ${copies.positions.length} current positions`,
      );
      console.table(copies.configs);
      console.table(copies.positions);
    }
    console.log(`Coverage: ${app.coverage_complete ? "complete" : "partial"}`);
  }
  if (data.plan && !data.saved_preview) {
    console.table(
      data.plan.allocations.map((s: any) => ({
        trader: s.trader.handle,
        market: s.trader.market,
        score: s.trader.score,
        USDC: s.amount_usdc,
        leverage: `${s.leverage_cap == null ? "Follow source · no extra cap" : `≤${s.leverage_cap}x`}${s.leverage_cap_source === "inherited" || (s.trader.market === "perps" && s.leverage_cap != null && !s.leverage_mode) ? " · 继承旧设置" : ""}`,
        style: s.trader.style,
      })),
    );
    console.log(`Plan: ${data.plan.id}`);
  } else if (data.portfolio) {
    const p = data.portfolio;
    console.log(
      `Portfolio ${p.id} · ${p.state}\nAccount ${p.account_value_usdc ?? "unavailable"} USDC · Net profit ${p.net_profit_usdc ?? "unavailable"} USDC`,
    );
    console.table(
      p.sleeves.map((s: any) => ({
        trader: s.trader.handle,
        state: s.state,
        USDC: s.amount_usdc,
        net: s.net_profit_usdc ?? "unavailable",
      })),
    );
    console.table(p.positions);
  } else if (data.saved_preview) {
    console.log(`Saved preview · ${data.plan_status} · ${data.plan.id}`);
  } else if (app) {
    // App account tables above are already complete.
  } else if (data.trader) {
    console.log(
      `${data.trader.handle} · ${data.trader.market} · Copy Score ${data.trader.score}`,
    );
    console.table(data.trader.components);
  } else if (data.proposal) {
    console.log(
      `${data.proposal.action} · ${data.proposal.id}\nConfirm in Ride: ${data.proposal.confirmation_url}`,
    );
  } else console.log(JSON.stringify(data, null, 2));
  for (const warning of value.warnings) console.log(warning);
}
