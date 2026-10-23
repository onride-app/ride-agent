import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { accountCopiesInput } from "../account_reads.js";
import { claudeCardDomain } from "./card_hosts.js";
import {
  AgentError,
  failure,
  inputs,
  mutationTools,
  stateTools,
  publicResult,
  output,
  TOOL_NAMES,
  type Result,
  type ToolName,
} from "./contracts.js";

export const RESOURCE_URI = "ui://ride/agent-v9-confirmation.html";
export type McpOAuthContext = { resourceMetadataUrl: string };

function securityMeta(scope: string, oauth?: McpOAuthContext) {
  // The SDK preserves extension fields under _meta in tools/list.
  return oauth
    ? { securitySchemes: [{ type: "oauth2", scopes: [scope] }] }
    : {};
}

function toolResult(
  value: Result,
  scope: string,
  oauth?: McpOAuthContext,
): CallToolResult {
  const response: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: !!value.error,
  };
  if (
    oauth &&
    ["AUTH_REQUIRED", "SCOPE_REQUIRED"].includes(value.error?.code ?? "")
  ) {
    const insufficientScope = value.error?.code === "SCOPE_REQUIRED";
    // Use fixed descriptions, never upstream error text or bearer tokens.
    response._meta = {
      "mcp/www_authenticate": [
        `Bearer resource_metadata=${JSON.stringify(oauth.resourceMetadataUrl)}, ` +
          `error="${insufficientScope ? "insufficient_scope" : "invalid_token"}", ` +
          `error_description="${insufficientScope ? "Reconnect Ride to grant the required permission." : "Your Ride session has expired. Reconnect Ride to continue."}", ` +
          `scope=${JSON.stringify(scope)}`,
      ],
    };
  }
  return response;
}

export function registerAppAccountRead(
  server: McpServer,
  invoke: (args: unknown, extra: any) => Promise<Result>,
  oauth?: McpOAuthContext,
): void {
  server.registerTool(
    "get_my_copies",
    {
      title: "Your Ride App copies and positions",
      description:
        "Read the signed-in account's existing Ride App Perps and prediction copies and current copied positions. Successful reads verify login, including empty accounts. App copies remain managed in Ride.",
      inputSchema: accountCopiesInput,
      outputSchema: output,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      _meta: securityMeta("ride:read", oauth),
    },
    async (args, extra) => {
      try {
        const value = publicResult(await invoke(args, extra));
        return toolResult(value, "ride:read", oauth);
      } catch (e) {
        const value = failure(e);
        return toolResult(value, "ride:read", oauth);
      }
    },
  );
}
export function registerAgentTools(
  server: McpServer,
  invoke: (name: ToolName, args: unknown, extra: any) => Promise<Result>,
  readOnly = false,
  confirmation?: {
    base: string;
    readProposal?: (id: string, extra: any) => Promise<Result>;
  },
  oauth?: McpOAuthContext,
): void {
  const confirmationOrigin = confirmation
    ? new URL(confirmation.base).origin
    : undefined;
  server.server.registerCapabilities({
    extensions: {
      "io.modelcontextprotocol/ui": {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    },
  });
  for (const resourceUri of [
    RESOURCE_URI,
    "ui://ride/agent-v8-confirmation.html",
    "ui://ride/agent-v7-confirmation.html",
    "ui://ride/agent-v6-confirmation.html",
    "ui://ride/agent-v5-confirmation.html",
    "ui://ride/agent-v4-confirmation.html",
    "ui://ride/agent-v3.html",
  ])
    server.registerResource(
      "ride-agent-cards",
      resourceUri,
      {
        mimeType: "text/html;profile=mcp-app",
        _meta: { "openai/widgetPrefersBorder": true },
      },
      async () => ({
        contents: [
          {
            uri: resourceUri,
            mimeType: "text/html;profile=mcp-app",
            text: (
              await readFile(
                fileURLToPath(
                  new URL("../../public/agent.html", import.meta.url),
                ),
                "utf8",
              )
            ).replace(
              "/*HOST_CONFIG*/{}",
              JSON.stringify({
                confirmation_origin: confirmationOrigin,
              }).replaceAll("<", "\\u003c"),
            ),
            _meta: {
              "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
              ui: {
                prefersBorder: true,
                ...(confirmationOrigin
                  ? {
                      csp: { frameDomains: [confirmationOrigin] },
                      domain: claudeCardDomain(confirmation!.base),
                    }
                  : {}),
              },
              ...(confirmationOrigin
                ? {
                    "openai/widgetCSP": { frame_domains: [confirmationOrigin] },
                  }
                : {}),
            },
          },
        ],
      }),
    );
  if (confirmation?.readProposal && !readOnly)
    server.registerTool(
      "show_confirmation_card",
      {
        title: "Rider confirmation card",
        description:
          "Show an owned frozen proposal in a human confirmation card. mode:demo renders a 0-USDC interface test without account changes or any execution. This tool never confirms, signs or submits a proposal.",
        inputSchema: z
          .object({
            mode: z.enum(["demo", "proposal"]).default("demo"),
            proposal_id: z
              .string()
              .regex(/^proposal_[a-zA-Z0-9_-]{8,100}$/)
              .optional(),
          })
          .strict(),
        outputSchema: output,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        _meta: {
          ...securityMeta("ride:read", oauth),
          ui: { resourceUri: RESOURCE_URI },
          "openai/outputTemplate": RESOURCE_URI,
          "openai/ui": { entrypoints: [{ type: "thread" }] },
        },
      },
      async ({ mode, proposal_id }, extra) => {
        try {
          if (!extra.authInfo?.scopes?.includes("ride:read"))
            throw new AgentError(
              "SCOPE_REQUIRED",
              "Missing ride:read permission.",
              false,
              403,
            );
          let value: Result;
          if (mode === "demo")
            value = {
              version: "3",
              status: "ok",
              data: {
                confirmation_demo: true,
                funding_demo: true,
                proposal: {
                  id: "proposal_card_demo_00000000",
                  action: "demo",
                  status: "requires_confirmation",
                  arguments: { amount_usdc: "0", execution: "disabled" },
                  preview: {},
                  expires_at: Date.now() + 300_000,
                  confirmation_url: new URL(
                    "/agent/card-demo",
                    confirmation.base,
                  ).href,
                },
              },
              warnings: [],
              as_of: new Date().toISOString(),
            };
          else {
            if (!proposal_id)
              throw new AgentError(
                "NOT_FOUND",
                "Choose an owned proposal to display.",
                false,
                400,
              );
            value = publicResult(
              await confirmation.readProposal!(proposal_id, extra),
            );
            value.data.confirmation_card = true;
          }
          return toolResult(value, "ride:read", oauth);
        } catch (e) {
          const value = failure(e);
          return toolResult(value, "ride:read", oauth);
        }
      },
    );
  for (const name of TOOL_NAMES) {
    if (
      readOnly &&
      (mutationTools.has(name) ||
        (stateTools.has(name) && name !== "recommend_traders"))
    )
      continue;
    server.registerTool(
      name,
      {
        title: name.replaceAll("_", " "),
        description: description(name),
        inputSchema: inputs[name],
        outputSchema: output,
        annotations: {
          readOnlyHint: !mutationTools.has(name) && !stateTools.has(name),
          destructiveHint: mutationTools.has(name),
          idempotentHint: !stateTools.has(name) && !mutationTools.has(name),
          openWorldHint: true,
        },
        _meta: {
          ...securityMeta(
            mutationTools.has(name) ? "ride:trade" : "ride:read",
            oauth,
          ),
          ...(mutationTools.has(name) || name === "prepare_deposit"
            ? {
                ui: { resourceUri: RESOURCE_URI },
                "openai/outputTemplate": RESOURCE_URI,
              }
            : {}),
        },
      },
      async (args: unknown, extra: any) => {
        try {
          const value = publicResult(await invoke(name, args, extra));
          return toolResult(
            value,
            mutationTools.has(name) ? "ride:trade" : "ride:read",
            oauth,
          );
        } catch (e) {
          const value = failure(e);
          return toolResult(
            value,
            mutationTools.has(name) ? "ride:trade" : "ride:read",
            oauth,
          );
        }
      },
    );
  }
}
export async function invokeAgent(
  url: string,
  token: string | undefined,
  name: string,
  args: unknown,
): Promise<Result> {
  if (!token)
    throw new AgentError("AUTH_REQUIRED", "Log in to Ride first.", false, 401);
  const response = await fetch(new URL(`/agent/v1/${name}`, url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(25000),
    redirect: "error",
  });
  const body = await response.json();
  if (!response.ok && !(body as Result).error)
    throw new AgentError(
      "BACKEND_UNAVAILABLE",
      "Rider request failed.",
      response.status >= 500,
      response.status,
    );
  return publicResult(body);
}
function description(name: ToolName): string {
  const descriptions: Record<ToolName, string> = {
    get_preferences:
      "Read saved/partial answers. Start in chat with budget and risk preference only; ask only returned missing questions. Preserve earlier answers. Numeric risk presets are suggestions requiring final confirmation, not user consent.",
    prepare_deposit:
      "Prepare an exact-amount deposit activation for an owned funding request. Display the returned inline Rider funding confirmation card. The user connects the existing Ride session, reviews, confirms and signs inside the trusted card without opening a page. If inline rendering or session access is blocked, report that blocker and leave funding unsubmitted. The URL is for explicitly requested standalone use. Expired quotes must be refreshed and approved again. Never claim success until check_deposit_status verifies trading credit.",
    get_deposit_options:
      "Read currently supported funding routes. No funds are transferred.",
    get_deposit_address:
      "Create an owned funding request and verified receiving address/QR for the chosen supported network. No transfer or signing is performed.",
    check_deposit_status:
      "Read an account-owned deposit request. Wallet receipt, bridge settlement and copy-ready funds remain separate.",
    get_daily_checkin:
      "Offer one portfolio performance review per local day and timezone; does not send a message or notification.",
    update_portfolio:
      "Propose changing the owned portfolio loss threshold; requires Rider confirmation and cannot unlatch a triggered stop.",
    set_preferences:
      "Save only supplied user answers, including partial budget/risk answers. Defaults and numeric risk suggestions are marked separately; do not ask for optional settings up front. Existing portfolios are unchanged.",
    recalculate_plan:
      "Refresh a saved preview or validate edited trader allocations against fresh eligibility, budget and leverage limits. Returns a new frozen plan; no execution.",
    get_performance:
      "Read persisted accounting snapshots for daily, weekly or inception performance. Historical sleeves remain after replacement; incomplete periods return null profit.",
    diagnose_copy:
      "Read an owned copy's source fills, attributed follower receipts and event-time execution decisions for the same window (maximum 31 days). Missing evidence and counterfactual profit remain unavailable.",
    get_notification_preferences:
      "Read daily Ride App digest preferences and actual push registration readiness. Server monitoring is independent of this chat.",
    set_notification_preferences:
      "Save explicitly requested daily Ride App digest opt-in, local time and IANA timezone. Critical risk alerts remain enabled; this does not authorize trading.",
    recommend_traders:
      "After get_preferences collect only missing budget/risk in conversation. Show recommended_portfolio and recommended_trader_comparison as two compact chat tables with identical selected trader IDs/order. Do not use the top-five candidate_table as the recommended performance comparison; label candidate discovery separately. Assets default unrestricted, markets default both (either allowed); count is automatically feasible up to four unless user chooses 1–8 or trader_ids. Selections persist across edits; selection:system clears the pinned selection. Show candidates even if plan fails; no funding required. Defaults and risk parameters are suggestions for final Ride confirmation.",
    browse_traders:
      "Page or sort the entire current verified candidate snapshot by score/drawdown/ROI; missing metrics sort last. Default five, request limit:10 for ten more, pass next_cursor with the same sort. compare_ids compares named public IDs. Does not replace the plan, allocations or selections. Disclose source pool limits, metric periods and incomparable/missing data. Refresh expired snapshots through recommend_traders.",
    get_trader_profile:
      "Read verified source statistics and actual Copy Score components using a public trader ID.",
    start_copy:
      "Create an expiring start proposal. Human confirmation in Ride is required unless bounded Ride authority applies.",
    get_portfolio:
      "Read the signed-in account, per-market account balances, Agent portfolio and existing Ride App copies and positions. Account funds and copy allocation remaining are distinct; unavailable modules are null, not zero. An empty Agent portfolio still confirms login. App copies remain separately managed in Ride. Missing values are null.",
    update_copy:
      "Propose amount, leverage cap, sleeve loss trigger or an explicit eligible replacement. Released funds must be verified.",
    stop_copy:
      "Propose wind_down (default) or close_now. Removing a hedge can increase net exposure and is risk checked.",
    review_portfolio:
      "Read factual portfolio observations and suggested changes. Suggestions do not execute.",
    get_updates:
      "Read persisted monitoring and execution events using an opaque account-bound cursor. This call does not schedule monitoring.",
    close_position:
      "Propose closing one owned aggregate position. All affected sleeves are included.",
  };
  return descriptions[name];
}
