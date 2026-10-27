import { z } from "zod";

// JSON-safe decimals: six-place USDC precision; no floating point accounting.
export const money = z.union([
  z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/),
  z
    .number()
    .finite()
    .nonnegative()
    .max(999999999999)
    .refine((v) => /^\d+(\.\d{1,6})?$/.test(String(v))),
]);
export const positiveMoney = money.refine(
  (v) => Number(v) > 0,
  "Amount must be positive",
);
export const id = z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/);
export const market = z.enum(["perps", "prediction", "both"]);
export const copySettings = {
  copy_mode: z.enum(["ride_recommends", "fixed", "proportional"]).optional(),
  fixed_margin_usdc: positiveMoney.optional(),
  proportional_multiplier: z.number().positive().max(10).optional(),
  loss_policy: z.enum(["exit", "pause_then_exit"]).optional(),
  emergency_exit_pct: z.number().min(1).max(100).optional(),
};
export const preferences = z
  .object({
    budget_usdc: positiveMoney,
    loss_trigger_pct: z.number().min(1).max(100),
    market: market.default("perps"),
    assets: z
      .array(z.string().regex(/^[A-Za-z][A-Za-z0-9:_-]{0,30}$/))
      .max(20)
      .default([]),
    allow_altcoins: z.boolean().default(true),
    portfolio_kind: z.enum(["single", "basket"]).optional(),
    basket_size: z.number().int().min(1).max(8).optional(),
    risk_tolerance: z.enum(["low", "medium", "high"]).optional(),
    asset_category: z.enum(["crypto", "rwa", "any"]).optional(),
    ...copySettings,
  })
  .strict();
const portfolioInput = z.object({ portfolio_id: id.optional() }).strict();
// Partial answers must not silently acquire defaults before the user chooses.
export const preferenceAnswers = z
  .object({
    ...preferences.shape,
    market: market,
    assets: preferences.shape.assets.unwrap(),
    allow_altcoins: z.boolean(),
  })
  .partial()
  .strict();
export const analysisOptions = {
  locale: z.enum(["en", "zh"]).optional(),
  analysis_depth: z.enum(["summary", "extended"]).default("summary"),
  include_calculations: z.boolean().default(false),
};
export const candidateFilters = z
  .object({
    min_score: z.number().finite().min(0).max(100).optional(),
    max_drawdown_pct: z.number().finite().nonnegative().optional(),
    min_roi_pct: z.number().finite().optional(),
    max_roi_pct: z.number().finite().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.min_roi_pct == null ||
      v.max_roi_pct == null ||
      v.min_roi_pct <= v.max_roi_pct,
    "Minimum ROI must not exceed maximum ROI",
  );
export const candidateMetricWindow = z
  .object({
    start_at: z.number().int().positive(),
    end_at: z.number().int().positive(),
  })
  .strict()
  .refine(
    (v) => v.start_at < v.end_at,
    "Metric window must have start before end",
  );
export const inputs = {
  get_preferences: z
    .object({ locale: z.enum(["en", "zh"]).optional() })
    .strict(),
  prepare_deposit: z
    .object({ deposit_id: id, amount_usdc: positiveMoney })
    .strict(),
  get_deposit_options: z.object({}).strict(),
  get_deposit_address: z
    .object({
      market: z.enum(["perps", "prediction"]),
      asset: z.enum(["USDC", "USDT"]),
      network: z.enum(["Arbitrum", "Base", "Ethereum", "Polygon"]),
      amount_usdc: positiveMoney.optional(),
    })
    .strict(),
  check_deposit_status: z.object({ deposit_id: id }).strict(),
  get_daily_checkin: z
    .object({ timezone: z.string().max(80).optional() })
    .strict(),
  update_portfolio: z
    .object({ portfolio_id: id, loss_trigger_pct: z.number().min(1).max(100) })
    .strict(),
  set_preferences: preferenceAnswers,
  recommend_traders: z
    .object({
      base_plan_id: id.optional(),
      ...analysisOptions,
      detail: z.enum(["brief", "detailed"]).default("brief"),
      preferences: preferenceAnswers.optional(),
      batch_action: z.enum(["first", "next", "saved"]).optional(),
      batch_index: z.number().int().min(0).max(1).optional(),
      trader_ids: z
        .array(id)
        .min(1)
        .max(8)
        .refine(
          (v) => new Set(v).size === v.length,
          "Select each trader only once",
        )
        .optional(),
      selection: z.enum(["system"]).optional(),
    })
    .strict()
    .refine(
      (v) =>
        !v.base_plan_id ||
        (v.selection === "system" && !v.trader_ids && !v.batch_action),
      "A base-plan reselect requires selection:system without trader_ids or batch actions",
    ),
  browse_traders: z
    .object({
      locale: z.enum(["en", "zh"]).optional(),
      plan_id: id.optional(),
      exclude_selected: z.boolean().default(false),
      detail: z.enum(["brief", "detailed"]).default("brief"),
      sort_by: z.enum(["score", "drawdown", "roi"]).default("score"),
      direction: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(20).default(5),
      cursor: z.string().max(1024).optional(),
      compare_ids: z.array(id).min(1).max(8).optional(),
      filters: candidateFilters.optional(),
      metric_window: candidateMetricWindow.optional(),
    })
    .strict()
    .refine(
      (v) =>
        !v.compare_ids ||
        (v.filters === undefined && v.metric_window === undefined),
      "Compare exact IDs or filter candidates, not both",
    ),
  get_trader_profile: z
    .object({
      locale: z.enum(["en", "zh"]).optional(),
      trader_id: id,
      market: z.enum(["perps", "prediction"]).optional(),
    })
    .strict(),
  preview_copy_orders: z
    .object({
      plan_id: id,
      locale: z.enum(["en", "zh"]).optional(),
    })
    .strict(),
  start_copy: z
    .object({
      plan_id: id,
      compatibility_ack: z.string().length(64).optional(),
    })
    .strict(),
  recalculate_plan: z
    .object({
      plan_id: id,
      ...analysisOptions,
      detail: z.enum(["brief", "detailed"]).default("brief"),
      replacements: z
        .array(
          z.object({ outgoing_trader_id: id, incoming_trader_id: id }).strict(),
        )
        .min(1)
        .max(8)
        .optional(),
      preferences: preferenceAnswers.optional(),
      allocations: z
        .array(
          z
            .object({
              trader_id: id,
              amount_usdc: positiveMoney,
              leverage_cap: z
                .number()
                .int()
                .min(1)
                .max(40)
                .nullable()
                .optional(),
              stop_loss_pct: z.number().min(1).max(100).optional(),
              ...copySettings,
            })
            .strict(),
        )
        .min(1)
        .max(8)
        .optional(),
    })
    .strict()
    .refine(
      (v) => !v.replacements || (!v.allocations && !v.preferences),
      "Use replacements alone to preserve the original allocation and risk settings",
    ),
  get_performance: z
    .object({
      portfolio_id: id.optional(),
      period: z.enum(["daily", "weekly", "inception"]).default("weekly"),
    })
    .strict(),
  diagnose_copy: z
    .object({
      copy_id: id,
      start_at: z.number().int().positive(),
      end_at: z.number().int().positive(),
    })
    .strict()
    .refine(
      (v) => v.end_at > v.start_at && v.end_at - v.start_at <= 31 * 86400_000,
      "Use a time window of at most 31 days",
    ),
  get_notification_preferences: z.object({}).strict(),
  set_notification_preferences: z
    .object({
      daily_digest: z.boolean(),
      local_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      timezone: z
        .string()
        .max(80)
        .refine((v) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: v });
            return true;
          } catch {
            return false;
          }
        }, "Use an IANA timezone"),
    })
    .strict(),
  get_portfolio: portfolioInput
    .extend({
      plan_id: id.optional(),
      ...analysisOptions,
      detail: z.enum(["brief", "detailed"]).default("brief"),
    })
    .refine(
      (v) => !(v.plan_id && v.portfolio_id),
      "Read a plan or a portfolio, not both",
    ),
  update_copy: z
    .object({
      copy_id: id,
      amount_usdc: positiveMoney.optional(),
      leverage_cap: z.number().int().min(1).max(40).nullable().optional(),
      stop_loss_pct: z.number().min(1).max(100).optional(),
      replacement_trader_id: id.optional(),
      resume_new_trades: z.boolean().optional(),
      ...copySettings,
    })
    .strict()
    .refine((v) => Object.keys(v).length > 1, "Specify a change"),
  stop_copy: z
    .object({
      copy_id: id,
      mode: z.enum(["wind_down", "close_now"]).default("wind_down"),
    })
    .strict(),
  review_portfolio: portfolioInput,
  get_updates: z
    .object({
      cursor: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  close_position: z.object({ position_id: id }).strict(),
} as const;
export type ToolName = keyof typeof inputs;
export const mutationTools = new Set<ToolName>([
  "start_copy",
  "update_portfolio",
  "update_copy",
  "stop_copy",
  "close_position",
]);
// State edits are distinct from proposals that can move funds.
export const stateTools = new Set<ToolName>([
  "prepare_deposit",
  "set_preferences",
  "recalculate_plan",
  "recommend_traders",
  "set_notification_preferences",
  "get_deposit_address",
  "get_daily_checkin",
]);
export const TOOL_NAMES = Object.keys(inputs) as ToolName[];
export const errorDetails = z
  .object({
    operation: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
    grpc_code: z
      .enum([
        "OK",
        "CANCELLED",
        "UNKNOWN",
        "INVALID_ARGUMENT",
        "DEADLINE_EXCEEDED",
        "NOT_FOUND",
        "ALREADY_EXISTS",
        "PERMISSION_DENIED",
        "RESOURCE_EXHAUSTED",
        "FAILED_PRECONDITION",
        "ABORTED",
        "OUT_OF_RANGE",
        "UNIMPLEMENTED",
        "INTERNAL",
        "UNAVAILABLE",
        "DATA_LOSS",
        "UNAUTHENTICATED",
      ])
      .optional(),
    reason_code: z
      .string()
      .regex(/^[A-Z0-9_]{1,64}$/)
      .optional(),
    retry_after_ms: z.number().int().nonnegative().max(60_000).optional(),
    blockers: z
      .array(z.string().regex(/^[A-Z0-9_]{1,64}$/))
      .max(20)
      .optional(),
  })
  .strict();
export type ErrorDetails = z.infer<typeof errorDetails>;
export const output = z
  .object({
    version: z.literal("3"),
    status: z.enum([
      "ok",
      "requires_preferences",
      "empty",
      "requires_confirmation",
      "queued",
      "executing",
      "partially_filled",
      "settling",
      "completed",
      "failed",
      "uncertain",
      "stale",
    ]),
    data: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    as_of: z.string(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        retryable: z.boolean(),
        details: errorDetails.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Result = z.infer<typeof output>;
export type Preferences = z.infer<typeof preferences>;
export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public httpStatus = 409,
    public details?: ErrorDetails,
  ) {
    super(message);
  }
}
export function result(
  data: Record<string, unknown>,
  status: Result["status"] = "ok",
  warnings: string[] = [],
): Result {
  return {
    version: "3",
    status,
    data,
    warnings,
    as_of: new Date().toISOString(),
  };
}
export function failure(error: unknown): Result {
  const e =
    error instanceof AgentError
      ? error
      : error instanceof z.ZodError
        ? new AgentError(
            "INVALID_INPUT",
            "Input does not match the Ride tool contract.",
            false,
            400,
          )
        : new AgentError(
            "INTERNAL_ERROR",
            "Rider could not complete this request.",
            true,
            500,
          );
  return {
    ...result({}, "failed"),
    error: {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      ...(e.details ? { details: errorDetails.parse(e.details) } : {}),
    },
  };
}

// No raw upstream objects cross the MCP boundary. Reject accidental addresses
// anywhere, including explanations and nested arrays, instead of leaking them.
export function publicResult(value: unknown): Result {
  const checked = output.parse(value);
  const scan = structuredClone(checked);
  const own = scan.data.deposit as any;
  if (
    own &&
    /^deposit_[a-f0-9]{32}$/.test(own.id) &&
    ["wallet", "polymarket_bridge"].includes(own.provider) &&
    /^0x[a-fA-F0-9]{40}$/.test(own.address)
  )
    own.address = "owned deposit address";
  if (/0x[a-fA-F0-9]{40}\b/.test(JSON.stringify(scan)))
    throw new AgentError(
      "PRIVATE_DATA",
      "Response contained a private trading identity.",
      false,
      502,
    );
  return checked;
}
