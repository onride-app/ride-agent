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
export const inputs = {
  get_preferences: z.object({}).strict(),
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
    .strict(),
  browse_traders: z
    .object({
      sort_by: z.enum(["score", "drawdown", "roi"]).default("score"),
      direction: z.enum(["asc", "desc"]).optional(),
      limit: z.number().int().min(1).max(20).default(5),
      cursor: z.string().max(1024).optional(),
      compare_ids: z.array(id).min(1).max(8).optional(),
    })
    .strict(),
  get_trader_profile: z
    .object({
      trader_id: id,
      market: z.enum(["perps", "prediction"]).optional(),
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
      preferences: preferenceAnswers.optional(),
      allocations: z
        .array(
          z
            .object({
              trader_id: id,
              amount_usdc: positiveMoney,
              leverage_cap: z.number().int().min(1).max(40).nullable().optional(),
              stop_loss_pct: z.number().min(1).max(100).optional(),
              ...copySettings,
            })
            .strict(),
        )
        .min(1)
        .max(8)
        .optional(),
    })
    .strict(),
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
  get_portfolio: portfolioInput,
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
      .object({ code: z.string(), message: z.string(), retryable: z.boolean() })
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
    error: { code: e.code, message: e.message, retryable: e.retryable },
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
