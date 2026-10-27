import { preferences, type Preferences } from "./contracts.js";
import type { State } from "./repository.js";
import { localized, type Locale } from "./locale.js";

export function preferenceCollectionDisplay<T extends Record<string, any>>(
  value: T,
  locale?: Locale,
): T {
  if (!locale) return value;
  const out: Record<string, any> = structuredClone(value);
  const english: Record<string, string> = {
    budget_usdc: "How much USDC would you like to allocate?",
    risk_tolerance:
      "Is your risk preference conservative, balanced or aggressive?",
    fixed_margin_usdc:
      "How much USDC margin should each verified new source opening use in fixed mode?",
  };
  if (Array.isArray(out.questions))
    out.questions = out.questions.map((q: any) => ({
      ...q,
      question: localized(locale, q.question, english[q.field] ?? q.question),
    }));
  if (out.suggestions?.explanation)
    out.suggestions.explanation = localized(
      locale,
      out.suggestions.explanation,
      "Suggested portfolio loss-exit trigger, editable before confirmation; exits are best-effort, not a maximum-loss guarantee.",
    );
  return out as T;
}

// Product planning presets, not inferred user consent or guaranteed loss caps.
export const suggestedLoss = { low: 10, medium: 20, high: 30 } as const;
const questions = {
  budget_usdc: { question: "这次计划投入多少 USDC？", unit: "USDC" },
  risk_tolerance: {
    question: "风险偏好是稳健、平衡，还是进取？",
    options: ["low", "medium", "high"],
  },
  fixed_margin_usdc: {
    question: "你选择了固定保证金模式，每次新开仓使用多少 USDC？",
    unit: "USDC",
  },
};

// Never reinterpret an already approved legacy portfolio's asset semantics.
export function normalizedAssetPreferences<T extends Partial<Preferences>>(
  value: T,
  version = 2,
): T {
  return version !== 2 && ["any", "rwa"].includes(value.asset_category ?? "")
    ? { ...value, assets: [], allow_altcoins: true }
    : value;
}

export function preferenceCollection(
  s: State,
  answers: Partial<Preferences> = {},
) {
  const previous: Partial<Preferences> =
    s.preferences ??
    s.plans.at(-1)?.preferences ??
    s.portfolios.find((p) => p.state !== "closed")?.preferences ??
    {};
  const previousVersion = s.preferences
    ? s.preference_asset_filter_version
    : (s.plans.at(-1)?.asset_filter_version ??
      s.portfolios.find((p) => p.state !== "closed")?.asset_filter_version);
  const defaults = {
    market: "both" as const,
    assets: [] as string[],
    allow_altcoins: true,
    asset_category: "any" as const,
    copy_mode: "ride_recommends" as const,
  };
  const saved = {
    ...defaults,
    ...normalizedAssetPreferences(previous, previousVersion ?? 1),
    ...(s.preference_draft ?? {}),
    ...answers,
  };
  const sources: NonNullable<State["preference_sources"]> = {
    market: "default",
    assets: "default",
    allow_altcoins: "default",
    asset_category: "default",
    copy_mode: "default",
  };
  // Existing explicit numeric risk settings remain explicit, including old plans.
  for (const key of Object.keys(previous) as (keyof Preferences)[])
    if (previous[key] != null) sources[key] = "user";
  Object.assign(sources, s.preference_sources);
  for (const key of Object.keys(answers) as (keyof Preferences)[])
    if (answers[key] != null) sources[key] = "user";
  if (
    saved.risk_tolerance &&
    (saved.loss_trigger_pct == null ||
      sources.loss_trigger_pct === "recommended")
  ) {
    saved.loss_trigger_pct = suggestedLoss[saved.risk_tolerance];
    sources.loss_trigger_pct = "recommended";
  }
  const missing: (keyof typeof questions)[] = [];
  if (saved.budget_usdc == null) missing.push("budget_usdc");
  // An existing user-supplied numerical loss constraint is a custom risk answer.
  if (
    !saved.risk_tolerance &&
    !(saved.loss_trigger_pct != null && sources.loss_trigger_pct === "user")
  )
    missing.push("risk_tolerance");
  if (
    !missing.length &&
    saved.copy_mode === "fixed" &&
    saved.fixed_margin_usdc == null
  )
    missing.push("fixed_margin_usdc");
  return {
    ready: missing.length === 0,
    answers: saved,
    sources,
    missing_fields: missing,
    questions: missing.map((field) => ({ field, ...questions[field] })),
    defaults,
    suggestions:
      sources.loss_trigger_pct === "recommended"
        ? {
            loss_trigger_pct: saved.loss_trigger_pct,
            source: "Ride planning preset v1",
            requires_final_confirmation: true,
            explanation:
              "建议的组合亏损退出触发值，可修改；是尽力执行的退出触发条件，不是最大亏损保证。",
          }
        : null,
    optional_choices: {
      market: ["perps", "prediction", "both"],
      risk_tolerance: ["low", "medium", "high"],
      asset_category: ["crypto", "rwa", "any"],
      copy_mode: ["ride_recommends", "fixed", "proportional"],
    },
    instruction: missing.length
      ? "Ask only the returned missing questions in conversation. Save partial user answers. Do not open a full form, ask for trader count or funding, or invent budget or risk preference."
      : "Recommend now. Disclose defaults and label numeric risk parameters as suggestions for final Ride confirmation. Preserve explicit choices; a budget or preview never authorizes funds or trades.",
  };
}
export function savePreferenceCollection(
  s: State,
  collection: ReturnType<typeof preferenceCollection>,
): void {
  s.preference_sources = collection.sources;
  if (collection.ready) {
    s.preferences = preferences.parse(collection.answers);
    s.preference_asset_filter_version = 2;
    s.preference_draft = undefined;
  } else s.preference_draft = collection.answers;
}
export function completePreferences(
  s: State,
  answers: Partial<Preferences> = {},
) {
  const collection = preferenceCollection(s, answers);
  return collection.ready ? preferences.parse(collection.answers) : null;
}
