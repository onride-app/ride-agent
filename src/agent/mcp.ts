import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { accountCopiesInput } from "../account_reads.js";
import { claudeCardDomain } from "./card_hosts.js";
import { connectionReason, fetchAgentResponse } from "./connection.js";
import { requestContext } from "../request_diagnostics.js";
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

export const RESOURCE_URI = "ui://ride/agent-v10-compact-confirmation.html";
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
    "ui://ride/agent-v9-confirmation.html",
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
  fetcher: typeof fetch = fetch,
): Promise<Result> {
  if (!token)
    throw new AgentError("AUTH_REQUIRED", "Log in to Ride first.", false, 401);
  let response: Response | undefined;
  let body: unknown;
  try {
    response = await fetchAgentResponse(
      fetcher,
      new URL(`/agent/v1/${name}`, url),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(25000),
        redirect: "error",
      },
      name,
    );
    body = await response.json();
  } catch (error) {
    // Only fixed diagnostic codes; never log credentials, args, URLs or raw errors.
    console.error(
      JSON.stringify({
        event: "agent_connection_failure",
        request_id: requestContext.getStore()?.request_id,
        operation: TOOL_NAMES.includes(name as ToolName) ? name : "other",
        stage: response ? "response_body" : "connection",
        reason: connectionReason(error),
      }),
    );
    // An explicit auth rejection remains authoritative even if its body is HTML.
    if (response?.status === 401)
      return failure(
        new AgentError(
          "AUTH_REQUIRED",
          "Ride 登录已失效，请重新连接。",
          false,
          401,
        ),
      );
    if (response?.status === 403)
      return failure(
        new AgentError(
          "ACCESS_DENIED",
          "Ride 拒绝了此请求，请检查账户权限。",
          false,
          403,
        ),
      );
    if (name === "recommend_traders" || name === "recalculate_plan") {
      const value = failure(
        new AgentError(
          "PREVIEW_RESULT_UNKNOWN",
          "推荐结果未完整送达，方案可能已保存。请先读取已保存方案并核对本次预算、风险、选择及创建时间，不要重复提交或重新登录。",
          false,
          503,
        ),
      );
      value.data = {
        recovery: {
          next_tool: "get_portfolio",
          replay_original_request: false,
          execution_authorized: false,
          instruction:
            "核对 recovery 和 plan；匹配且未过期则展示原方案，过期则用原 plan_id 刷新。找不到匹配结果时说明尚无法确认，不要自动重试原请求。",
        },
      };
      return value;
    }
    if (mutationTools.has(name as ToolName) || stateTools.has(name as ToolName))
      return failure(
        new AgentError(
          "REQUEST_RESULT_UNKNOWN",
          "请求结果未完整送达。请先查询现有状态，不要重复提交；此错误不代表登录失效。",
          false,
          503,
        ),
      );
    throw new AgentError(
      "BACKEND_UNAVAILABLE",
      "Ride 服务暂时无法返回完整结果，请稍后查询状态。",
      true,
      503,
    );
  }
  if (!body || typeof body !== "object")
    throw new AgentError(
      "BACKEND_UNAVAILABLE",
      "Ride 返回了无效结果，请先查询已保存状态。",
      false,
      503,
    );
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
      "For an explicitly selected one-for-one swap, pass plan_id and replacements (outgoing_trader_id/incoming_trader_id); preserve count, slot amounts, copy settings and risk. Do not combine replacements with allocations/preferences. Generic allocations/count edits require an explicit user request. Returns a new immutable preview, original preserved, with plan_change and no execution. detail defaults brief; use get_portfolio with exact plan_id and detail:detailed to explain without recalculating.",
    get_performance:
      "Read persisted accounting snapshots for daily, weekly or inception performance. Historical sleeves remain after replacement; incomplete periods return null profit.",
    diagnose_copy:
      "Read an owned copy's source fills, attributed follower receipts and event-time execution decisions for the same window (maximum 31 days). Missing evidence and counterfactual profit remain unavailable.",
    get_notification_preferences:
      "Read daily Ride App digest preferences and actual push registration readiness. Server monitoring is independent of this chat.",
    set_notification_preferences:
      "Save explicitly requested daily Ride App digest opt-in, local time and IANA timezone. Critical risk alerts remain enabled; this does not authorize trading.",
    recommend_traders:
      "For a new system recommendation of a saved plan, pass base_plan_id and selection:system with only the requested risk_tolerance patch. Preserve original plan/count/slot amounts/controls; returns a new preview with versioned risk-selection evidence. Risk matching is a product rule, not measured risk optimization. After get_preferences collect only missing budget/risk in conversation. Default to conversation_display.markdown: one brief combined allocation/performance table plus copy-rule and exit-trigger summaries. Both underlying tables retain identical selected trader IDs/order. Offer browse alternatives and expand details; never invent a two-trader alternative. Do not use the top-five candidate_table as the recommended performance comparison; label candidate discovery separately. Assets default unrestricted, markets default both (either allowed); count is automatically feasible up to four unless user chooses 1–8 or trader_ids. Selections persist across edits; selection:system clears the pinned selection. Show candidates even if plan fails; no funding required. Defaults and risk parameters are suggestions for final Ride confirmation.",
    browse_traders:
      "Browse alternatives without changing the saved plan or preferences: pass plan_id and exclude_selected:true to omit its selected traders; absent/expired snapshots refresh on a request without cursor. detail defaults brief. Page or sort the entire current verified candidate snapshot by score/drawdown/ROI; missing metrics sort last. Filters min_score/max_drawdown_pct/min_roi_pct/max_roi_pct apply to the complete verified snapshot before sorting/pagination. metric_window requires exact verified start/end; missing/unknown periods are excluded, never replaced with another period. Display applied_filters/metric_basis/filter_counts and source coverage. Restart when query changes; carry the same filters/window with next_cursor. compare_ids cannot be mixed with filters/window. Default five, request limit:10 for ten more, pass next_cursor with the same sort. compare_ids compares named public IDs. Does not replace the plan, allocations or selections. Disclose source pool limits, metric periods and incomparable/missing data. Refresh expired snapshots by browsing without a cursor; never generate a replacement plan to browse.",
    get_trader_profile:
      "Read source statistics and Copy Score components using a public trader ID. Use locale:en for English or locale:zh for Chinese. Read source_evidence and leverage_context: legacy venue_max_leverage is a product planning envelope, not actual source leverage or the per-asset exchange limit. Current positions are not historical opening fills or measured copy success.",
    preview_copy_orders:
      "Inspect an exact owned saved plan_id with current public source evidence and per-asset venue rules, without changing its traders, amounts, controls or expiry. Use locale:en or locale:zh to match the user. Read-only hypothetical initial targets from a flat-account assumption, including rounding, basket netting, entry checks, existing portfolio risk rules and order minimums. Never binds an account, configures authority, funds, confirms, ticks a runner or submits an order. Fixed mode requires verified future source fills; incomplete scopes remain unverified. No claim of available collateral, future fill, slippage or actual copy-success rate. An expired plan is inspected as saved, never refreshed.",
    start_copy:
      "Create an expiring start proposal. Human confirmation in Ride is required unless bounded Ride authority applies.",
    get_portfolio:
      "Read an owned saved preview by plan_id, optionally detail:detailed with analysis_depth:summary for a concise first conclusion, analysis_depth:extended for further evidence, or detail:brief to collapse. Formulas are omitted unless include_calculations:true is explicitly requested; never regenerates that plan or changes preferences. Without plan_id, read current owned portfolio/last saved preview. Show conversation_display.markdown concisely in the user's language and distinguish preview from actual execution. For an owned portfolio, verify account_bound and operational and report execution_status separately: operational means monitoring is ready, not that an order was placed. When execution_status is blocked_by_risk, state its summary and concrete reason (in Chinese: 因风控暂未下单), scoped to the proposed target update; report historical orders/fills independently. Explain activation.readiness.blockers separately. A queued confirmation or active configuration alone is insufficient; never change risk rules to bypass a blocker.",
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
  return (
    descriptions[name] +
    ([
      "get_preferences",
      "recommend_traders",
      "recalculate_plan",
      "browse_traders",
      "get_trader_profile",
      "get_portfolio",
      "preview_copy_orders",
    ].includes(name)
      ? " Pass locale:en for an English user or locale:zh for a Chinese user. Show localized conversation_display, not archived free-form text from the immutable plan. If a cached client schema has no locale parameter, select only the matching markdown_by_locale.en or .zh variant; do not print both or ask for login to change language. A language change never changes the selected traders, amounts or controls."
      : "")
  );
}
