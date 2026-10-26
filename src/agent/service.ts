import {
  inputs,
  preferences,
  AgentError,
  result,
  type Preferences,
  type ToolName,
  type Result,
} from "./contracts.js";
import {
  D,
  cash,
  uid,
  fingerprint,
  now,
  fresh,
  recommend,
  assetAllowed,
  recommendedLeverage,
  defaultLeverageMode,
  maximumUserLeverage,
  minimumAllocation,
  eligibleCandidates,
  recommendationDiagnostics,
  aggregate,
  risk,
  pnl,
  type Portfolio,
  type Sleeve,
  type Plan,
  type Candidate,
} from "./domain.js";
import {
  Cursor,
  type Repository,
  type State,
  type Proposal,
  type Delegation,
} from "./repository.js";
import type { VenueAdapter } from "./adapter.js";
import { performanceView, recordConfigurations } from "./analytics.js";

import {
  compatibility,
  alternatives,
  basketLimits,
  validateCopySettings,
} from "./conversational.js";
import { depositView } from "./deposits.js";
import { localDay } from "./analytics.js";
import {
  preferenceCollection,
  completePreferences,
  normalizedAssetPreferences,
  savePreferenceCollection,
} from "./preferences.js";
import {
  browse,
  choosePlanPreferences,
  saveDiscovery,
  conversationView,
} from "./discovery.js";
import { FundingService } from "./funding.js";
import {
  planChange,
  type Detail,
  type AnalysisOptions,
} from "./conversation-presentation.js";
import { inheritReselectedSlots } from "./plan-reselection.js";

export class AgentService {
  get funding() {
    return new FundingService(
      this.repository,
      this.adapter,
      this.confirmationBase,
    );
  }
  constructor(
    readonly repository: Repository,
    readonly adapter: VenueAdapter,
    readonly confirmationBase: string,
    readonly cursor: Cursor,
  ) {}
  async tool(user: string, name: ToolName, input: unknown): Promise<Result> {
    const args = inputs[name].parse(input) as Record<string, unknown>;
    if (name === "prepare_deposit")
      return this.funding.prepare(
        user,
        args.deposit_id as string,
        String(args.amount_usdc),
      );
    if (name === "get_preferences")
      return this.repository.transact(user, async (s) => {
        const collection = preferenceCollection(s);
        return result(
          { preference_collection: collection },
          collection.ready ? "ok" : "requires_preferences",
        );
      });
    if (name === "get_deposit_options") {
      if (!this.adapter.depositOptions)
        throw new AgentError(
          "DEPOSIT_UNAVAILABLE",
          "Funding details are unavailable on this adapter.",
          true,
          503,
        );
      return result({ deposit_options: await this.adapter.depositOptions() });
    }
    if (name === "get_trader_profile") {
      const c = await this.adapter.profile(args.trader_id as string);
      if (args.market && c.market !== args.market)
        throw new AgentError(
          "NOT_FOUND",
          "Trader does not belong to this market.",
          false,
          404,
        );
      return this.repository.transact(user, async (state) =>
        result({
          trader: c,
          preferences: preferenceCollection(state).answers,
          saved_plan: state.portfolios.some((p) => p.state !== "closed")
            ? null
            : (state.plans.at(-1) ?? null),
        }),
      );
    }
    if (name === "browse_traders") {
      return this.repository.transact(user, async (s) => {
        const base = args.plan_id
          ? s.plans.find((p) => p.id === args.plan_id)
          : args.exclude_selected
            ? s.plans.at(-1)
            : undefined;
        if ((args.plan_id || args.exclude_selected) && !base)
          throw new AgentError(
            "NOT_FOUND",
            "Saved plan not found for this account.",
            false,
            404,
          );
        const pref = base
          ? normalizedAssetPreferences(
              base.preferences,
              base.asset_filter_version ?? 1,
            )
          : completePreferences(s);
        if (!pref)
          return result(
            { preference_collection: preferenceCollection(s) },
            "requires_preferences",
          );
        if (
          !args.cursor &&
          (!s.discovery ||
            s.discovery.expires_at <= now() ||
            s.discovery.preference_hash !== fingerprint(pref))
        )
          saveDiscovery(s, pref, await this.adapter.candidates(pref.market));
        return result(browse(s, pref, args as any, user, this.cursor));
      });
    }
    if (name === "recommend_traders") {
      return this.repository.transact(user, async (s) => {
        if (args.base_plan_id) return this.reselectPlan(user, s, args);
        // Older catalogs can still express a risk-only change. Resolve that
        // intent against the owned last preview instead of re-equalizing money.
        const existing = s.plans.at(-1);
        const patch = (args.preferences ?? {}) as Partial<Preferences>;
        const projected = preferenceCollection(s, patch);
        if (
          existing &&
          !args.trader_ids &&
          !args.batch_action &&
          (args.selection === "system" ||
            (!s.selected_trader_ids?.length &&
              existing.selection_source !== "explicit")) &&
          projected.ready &&
          projected.answers.risk_tolerance &&
          projected.answers.risk_tolerance !==
            existing.preferences.risk_tolerance
        ) {
          const base = normalizedAssetPreferences(
            existing.preferences,
            existing.asset_filter_version ?? 1,
          );
          const desired = { ...base, ...projected.answers };
          const omitRecommendedExit =
            existing.preference_sources?.loss_trigger_pct === "recommended" &&
            projected.sources.loss_trigger_pct === "recommended";
          const controls = (value: Partial<Preferences>) =>
            Object.fromEntries(
              Object.entries(value).filter(
                ([key]) =>
                  key !== "risk_tolerance" &&
                  !(omitRecommendedExit && key === "loss_trigger_pct"),
              ),
            );
          if (fingerprint(controls(base)) === fingerprint(controls(desired)))
            return this.reselectPlan(user, s, {
              ...args,
              base_plan_id: existing.id,
              selection: "system",
              preferences: { risk_tolerance: projected.answers.risk_tolerance },
            });
        }
        const answers = (args.preferences ?? {}) as any;
        const collection = preferenceCollection(s, answers);
        savePreferenceCollection(s, collection);
        if (!collection.ready) {
          return result(
            { preference_collection: collection },
            "requires_preferences",
          );
        }
        const savedPref = s.preferences!;
        if (args.selection === "system") {
          s.selected_trader_ids = undefined;
          s.selection_source = "system";
        }
        if (args.trader_ids) {
          s.selected_trader_ids = [...new Set(args.trader_ids as string[])];
          s.selection_source = "explicit";
        }
        const selectedIds = s.selected_trader_ids;
        let pool: Candidate[];
        try {
          pool = await this.adapter.candidates(savedPref.market);
        } catch (error) {
          const code =
            error instanceof AgentError
              ? error.code
              : "CANDIDATE_SOURCE_UNAVAILABLE";
          return {
            ...result(
              {
                ...conversationView(null, collection, [], !!selectedIds),
                plan: null,
                plan_unchanged: true,
                saved_plan_id: s.plans.at(-1)?.id ?? null,
                account: { authenticated: true, user_id: user },
                selected_trader_ids: selectedIds ?? [],
                missing_selected_trader_ids: null,
                candidates: [],
                candidates_meta: { total: null, returned: 0, has_more: false },
                candidate_source: {
                  status: "unavailable",
                  previous_snapshot_retained: !!s.discovery,
                  previous_snapshot_at: s.discovery?.created_at ?? null,
                },
                recommendation_diagnostics: {
                  diagnostic_id: uid("diagnostic"),
                  stage: "candidate_source_fetch",
                  blocker: code,
                  count_semantics:
                    "Source verification failed; candidate counts and feasible trader counts are unavailable, not zero.",
                  source_candidates: null,
                  requested_basket_size: savedPref.basket_size ?? null,
                  feasible_basket_sizes: null,
                  funding_required: false,
                },
              },
              "stale",
            ),
            error: {
              code,
              message:
                "The complete candidate source is temporarily unavailable. Retry shortly; your saved plan, selection and previous candidate snapshot were preserved. Funding is not required.",
              retryable: true,
            },
          };
        }
        const planningPool = selectedIds
          ? pool.filter((c) => selectedIds.includes(c.id))
          : pool;
        const pref = choosePlanPreferences(
          savedPref,
          planningPool,
          selectedIds,
        );
        saveDiscovery(s, savedPref, pool);
        const candidatePage =
          s.discovery!.expires_at > now()
            ? browse(s, savedPref, { limit: 5 }, user, this.cursor)
                .candidates_meta
            : null;
        let displayedPool = eligibleCandidates(pref, pool);
        if (args.batch_action) {
          const hash = fingerprint(pref),
            old = s.recommendation_batches;
          if (
            !old ||
            (args.batch_action === "first" && old.preference_hash !== hash)
          ) {
            s.recommendation_batches = {
              preference_hash: hash,
              batches: [displayedPool.slice(0, 8).map((c) => c.id)],
              change_used: old?.change_used ?? false,
              active_index: 0,
            };
          }
          const batches = s.recommendation_batches!;
          if (batches.preference_hash !== hash)
            throw new AgentError(
              "PREFERENCES_CHANGED",
              "Refresh the first page with the current preferences.",
            );
          if (args.batch_action === "next") {
            const excluded = new Set(batches.batches.flat());
            const next = displayedPool
              .filter((c) => !excluded.has(c.id))
              .slice(0, 8);
            if (!next.length)
              throw new AgentError(
                "NO_NEW_BATCH",
                "No additional fresh eligible traders are available.",
                true,
              );
            batches.batches.push(next.map((c) => c.id));
            batches.change_used = true;
            batches.active_index = batches.batches.length - 1;
          } else if (args.batch_action === "saved") {
            if (!batches.batches[Number(args.batch_index ?? 0)])
              throw new AgentError(
                "NOT_FOUND",
                "Saved batch not found.",
                false,
                404,
              );
            batches.active_index = Number(args.batch_index ?? 0);
          }
          const selectedIds = new Set(batches.batches[batches.active_index]);
          displayedPool = displayedPool.filter((c) => selectedIds.has(c.id));
        }
        let plan: Plan;
        try {
          if (selectedIds && planningPool.length !== selectedIds.length)
            throw new AgentError(
              "SELECTED_TRADERS_UNAVAILABLE",
              "Some selected traders are absent from the current source pool; review the missing selected IDs without substituting traders.",
            );
          const saved = s.plans.at(-1);
          plan =
            args.batch_action &&
            saved &&
            fingerprint(saved.preferences) === fingerprint(pref)
              ? structuredClone(saved)
              : recommend(pref, planningPool, {
                  selection_source: selectedIds
                    ? (s.selection_source ?? "legacy_unknown")
                    : "system",
                  risk_selection: selectedIds ? "preserve" : "apply",
                });
          // Browsing must preserve a user's edited plan. Preference changes keep
          // custom weights if still valid, or explain the conflict instead of resetting them.
          if (
            selectedIds &&
            saved &&
            !args.batch_action &&
            fingerprint(saved.allocations.map((a) => a.trader.id).sort()) ===
              fingerprint([...selectedIds].sort())
          ) {
            const total = saved.allocations.reduce(
              (n, a) => n.plus(a.amount_usdc),
              D(0),
            );
            for (const a of plan.allocations) {
              const old = saved.allocations.find(
                (x) => x.trader.id === a.trader.id,
              )!;
              if (
                total.gt(pref.budget_usdc) ||
                D(old.amount_usdc).lt(minimumAllocation(pref, a.trader)) ||
                (old.leverage_cap != null &&
                  old.leverage_cap >
                    (old.leverage_mode === "custom_cap"
                      ? (maximumUserLeverage(a.trader) ?? 0)
                      : (a.leverage_cap ?? Number.POSITIVE_INFINITY)))
              )
                throw new AgentError(
                  "ALLOCATION_REVIEW_REQUIRED",
                  "The saved amounts or leverage no longer fit the updated budget/risk constraints. Review the saved plan and explicitly adjust allocations; other choices were preserved.",
                );
              Object.assign(a, {
                amount_usdc: old.amount_usdc,
                leverage_cap: old.leverage_cap,
                leverage_mode: old.leverage_mode,
                leverage_cap_source: "inherited",
                leverage_cap_inherited_from_plan_id: saved.id,
                stop_loss_pct: old.stop_loss_pct,
              });
              for (const key of [
                "copy_mode",
                "fixed_margin_usdc",
                "proportional_multiplier",
                "loss_policy",
                "emergency_exit_pct",
              ] as const)
                if (!(key in answers) && old[key] != null)
                  (a as any)[key] = old[key];
            }
          }
          plan.preference_sources = collection.sources;
          plan.allocations.forEach(validateCopySettings);
        } catch (error) {
          const diagnostics = recommendationDiagnostics(pref, planningPool);
          const sourceUnavailable = [
            "source_data_unavailable",
            "market_source_data_unavailable",
            "stale_source_scores",
          ].includes(diagnostics.blocker ?? "");
          const diagnosticCode =
            error instanceof AgentError
              ? error.code
              : "RECOMMENDATION_SYSTEM_ERROR";
          if (diagnosticCode !== "NO_EXECUTABLE_PLAN") {
            diagnostics.stage = "plan_validation";
            diagnostics.blocker = diagnosticCode;
          }
          if (diagnosticCode === "ALLOCATION_REVIEW_REQUIRED") {
            diagnostics.stage = "saved_allocation_validation";
            diagnostics.rules.push({
              trader_id: "plan",
              rule: diagnosticCode,
              field: "allocations/budget_usdc/leverage_cap",
              current: s.plans.at(-1)?.allocations.map((a) => ({
                trader_id: a.trader.id,
                amount_usdc: a.amount_usdc,
                leverage_cap: a.leverage_cap,
              })),
              required: {
                budget_usdc: pref.budget_usdc,
                limits: planningPool.map((c) => ({
                  trader_id: c.id,
                  minimum_usdc: cash(minimumAllocation(pref, c)),
                  leverage_cap:
                    defaultLeverageMode(pref, c) === "follow_source"
                      ? null
                      : recommendedLeverage(pref, c),
                })),
              },
              message:
                "Saved allocations no longer meet the updated amount or leverage limits. Edit only the conflicting amounts/caps through recalculate_plan; no risk or budget was increased.",
            });
          }
          if (diagnosticCode === "SELECTED_TRADERS_UNAVAILABLE") {
            diagnostics.stage = "selected_trader_lookup";
            diagnostics.rules.push({
              trader_id: "plan",
              rule: diagnosticCode,
              field: "trader_ids",
              current: selectedIds?.filter(
                (id) => !planningPool.some((c) => c.id === id),
              ),
              required:
                "Fresh verified source profile for every selected trader",
              message:
                "Refresh the source or explicitly change the unavailable trader selection; no substitute was selected.",
            });
          }
          console.warn(
            JSON.stringify({
              event: "recommendation_failed",
              diagnostic_id: diagnostics.diagnostic_id,
              stage: diagnostics.stage,
              error_code: diagnosticCode,
              blocker: diagnostics.blocker,
              requested_count: diagnostics.requested_basket_size,
            }),
          );
          const message = sourceUnavailable
            ? "Current trader source data is unavailable. Funding is not required; retry when source data is refreshed."
            : `The requested ${diagnostics.requested_basket_size}-trader plan could not be generated: ${diagnostics.blocker ?? diagnosticCode}. ${diagnostics.feasible_basket_sizes.length ? "Feasible trader counts: " + diagnostics.feasible_basket_sizes.join(", ") + ". Review an alternative without changing risk settings." : "Review the per-trader rules and affected fields below."} Diagnostic: ${diagnostics.diagnostic_id}.`;
          return {
            ...result(
              {
                ...conversationView(
                  null,
                  collection,
                  eligibleCandidates(pref, pool),
                  !!selectedIds,
                ),
                preferences: pref,
                candidate_page: candidatePage,
                plan: null,
                saved_plan_id: s.plans.at(-1)?.id ?? null,
                missing_selected_trader_ids:
                  selectedIds?.filter(
                    (id) => !planningPool.some((c) => c.id === id),
                  ) ?? [],
                account: { authenticated: true, user_id: user },
                candidates: eligibleCandidates(pref, pool),
                recommendation_diagnostics: diagnostics,
                candidate_limits: eligibleCandidates(pref, pool).map((c) => ({
                  trader_id: c.id,
                  leverage_cap:
                    defaultLeverageMode(pref, c) === "follow_source"
                      ? null
                      : recommendedLeverage(pref, c),
                  maximum_leverage_cap: maximumUserLeverage(c),
                })),
                candidates_meta: {
                  total: eligibleCandidates(pref, pool).length,
                  returned: eligibleCandidates(pref, pool).length,
                  has_more: false,
                },
              },
              sourceUnavailable ? "stale" : "empty",
            ),
            error: {
              code: diagnosticCode,
              message,
              retryable:
                sourceUnavailable ||
                diagnosticCode === "RECOMMENDATION_SYSTEM_ERROR",
            },
          };
        }
        plan.allocations.forEach(validateCopySettings);
        s.plans = s.plans
          .filter((x) => x.created_at > now() - 90 * 86400_000)
          .slice(-99);
        s.plans.push(plan);
        return result(
          {
            ...conversationView(
              plan,
              collection,
              eligibleCandidates(pref, pool),
              !!selectedIds,
              args.detail as Detail,
              undefined,
              args as AnalysisOptions,
            ),
            plan,
            preferences: pref,
            candidate_page: candidatePage,
            recommendation_diagnostics: recommendationDiagnostics(
              pref,
              planningPool,
            ),
            market_coverage: {
              requested: pref.market,
              selected: [
                ...new Set(plan.allocations.map((a) => a.trader.market)),
              ],
              meaning:
                "Selected markets are the allowed search universe; a plan may use only one market.",
            },
            candidates_meta: {
              total: eligibleCandidates(pref, pool).length,
              returned: eligibleCandidates(pref, pool).length,
              has_more: false,
            },
            candidates: eligibleCandidates(pref, pool),
            candidate_limits: eligibleCandidates(pref, pool).map((c) => ({
              trader_id: c.id,
              leverage_cap:
                defaultLeverageMode(pref, c) === "follow_source"
                  ? null
                  : recommendedLeverage(pref, c),
              maximum_leverage_cap: maximumUserLeverage(c),
            })),
            portfolio_historical_drawdown_pct: null,
            compatibility: compatibility(plan),
            alternatives: alternatives(plan, eligibleCandidates(pref, pool)),
            ...(args.batch_action
              ? {
                  recommendation_batches: {
                    ...s.recommendation_batches,
                    preview_quota_applies: false,
                    displayed_candidates: displayedPool,
                  },
                }
              : {}),
            reasons: plan.allocations.map((x) => ({
              trader_id: x.trader.id,
              reason: `Copy Score ${x.trader.score}; source drawdown ${x.trader.source_drawdown_pct}%; ${x.trader.assets.join("/")}; ${x.trader.style}; ${x.trader.direction}; allocation ${x.amount_usdc} USDC, ${x.leverage_cap == null ? "follow source leverage without an extra user cap" : `user leverage cap ${x.leverage_cap}x`}.`,
            })),
          },
          "ok",
          [
            "Historical rankings under your preferences are not investment advice; past performance does not guarantee future results.",
          ],
        );
      });
    }
    return this.repository.transact(user, async (s) => {
      if (name === "get_deposit_address") {
        if (!this.adapter.depositAddress)
          throw new AgentError(
            "DEPOSIT_UNAVAILABLE",
            "Deposit addresses are unavailable.",
            true,
            503,
          );
        const ownedPortfolio = s.portfolios.find((p) => p.state !== "closed");
        const deposit = await this.adapter.depositAddress(
          user,
          args,
          ownedPortfolio?.id,
        );
        (s.deposits ??= []).push(deposit);
        s.deposits = s.deposits.slice(-50);
        return result({ deposit: await depositView(deposit) });
      }
      if (name === "check_deposit_status") {
        const deposit = s.deposits?.find((d) => d.id === args.deposit_id);
        if (!deposit)
          throw new AgentError(
            "NOT_FOUND",
            "Deposit request not found for this account.",
            false,
            404,
          );
        if (!this.adapter.depositStatus)
          throw new AgentError(
            "DEPOSIT_UNAVAILABLE",
            "Deposit tracking is unavailable.",
            true,
            503,
          );
        const status = await this.adapter.depositStatus(deposit, user);
        if (deposit.funding) {
          if (status.funding_credit_verified)
            deposit.funding.status = "credited";
          else if (status.funding_receipt === "reverted")
            deposit.funding.status = "failed";
          status.funding_status = deposit.funding.status;
        }
        const savedPlan = s.plans.at(-1);
        if (savedPlan && status.trading_balance_usdc != null) {
          const required = savedPlan.allocations
            .filter((a) => a.trader.market === deposit.market)
            .reduce((total, a) => total.plus(a.amount_usdc), D(0));
          status.trading_account_ready = status.available_to_copy === true;
          status.required_for_saved_plan_usdc = cash(required);
          status.saved_plan_funded =
            status.trading_account_ready &&
            D(status.trading_balance_usdc).gte(required);
          status.available_to_copy = status.saved_plan_funded;
          status.saved_plan_shortfall_usdc = cash(
            D.max(0, required.minus(status.trading_balance_usdc)),
          );
          if (status.trading_account_ready && !status.saved_plan_funded)
            status.next_action = `Trading balance is verified, but the saved plan still needs ${status.saved_plan_shortfall_usdc} USDC. Fund the difference or explicitly choose a smaller plan, then refresh it.`;
        }
        return result({
          deposit_status: status,
          saved_plan_id: s.plans.at(-1)?.id ?? null,
        });
      }
      if (name === "get_daily_checkin") {
        const timezone = String(
          args.timezone ?? s.notification_preferences?.timezone ?? "UTC",
        );
        try {
          new Intl.DateTimeFormat("en", { timeZone: timezone });
        } catch {
          throw new AgentError(
            "INVALID_TIMEZONE",
            "Use an IANA timezone.",
            false,
            400,
          );
        }
        const p = findPortfolio(s),
          day = localDay(now(), timezone).day,
          seen = (s.daily_checkin_days ??= {});
        const offer = !!p && seen[timezone] !== day;
        if (p) seen[timezone] = day;
        return result({
          daily_checkin: {
            offer_review: offer,
            day,
            timezone,
            portfolio_id: p?.id ?? null,
            performance: p && offer ? performanceView(s, p, "daily") : null,
          },
        });
      }
      if (name === "set_preferences") {
        const collection = preferenceCollection(s, args as any);
        savePreferenceCollection(s, collection);
        if (!collection.ready) {
          return result(
            {
              preference_collection: collection,
              existing_portfolios_unchanged: true,
            },
            "requires_preferences",
          );
        }
        return result({
          preference_saved: true,
          preferences: s.preferences,
          preference_collection: preferenceCollection(s),
          existing_portfolios_unchanged: true,
        });
      }
      if (name === "recalculate_plan") {
        const previous = s.plans.find((x) => x.id === args.plan_id);
        if (!previous)
          throw new AgentError(
            "NOT_FOUND",
            "Saved plan not found for this account.",
            false,
            404,
          );
        const replacements = args.replacements as
          | { outgoing_trader_id: string; incoming_trader_id: string }[]
          | undefined;
        const replacedSlots = new Map<
          string,
          (typeof previous.allocations)[number]
        >();
        if (replacements) {
          const outgoing = new Set(
            replacements.map((r) => r.outgoing_trader_id),
          );
          const incoming = new Set(
            replacements.map((r) => r.incoming_trader_id),
          );
          if (
            outgoing.size !== replacements.length ||
            incoming.size !== replacements.length
          )
            throw new AgentError(
              "INVALID_REPLACEMENT",
              "Each outgoing and incoming trader must be unique.",
            );
          for (const r of replacements) {
            const slot = previous.allocations.find(
              (a) => a.trader.id === r.outgoing_trader_id,
            );
            if (
              !slot ||
              previous.allocations.some(
                (a) => a.trader.id === r.incoming_trader_id,
              )
            )
              throw new AgentError(
                "INVALID_REPLACEMENT",
                "Replace an existing selected trader with an unselected trader; the original plan is unchanged.",
              );
            replacedSlots.set(r.incoming_trader_id, slot);
          }
        }
        const previousPreferences = normalizedAssetPreferences(
          previous.preferences,
          previous.asset_filter_version ?? 1,
        );
        const editCollection = preferenceCollection(
          {
            ...s,
            preferences: previousPreferences,
            preference_sources:
              previous.preference_sources ?? s.preference_sources,
            preference_draft: undefined,
          },
          (args.preferences ?? {}) as Partial<Preferences>,
        );
        const pref = args.preferences
          ? preferences.parse(editCollection.answers)
          : previousPreferences;
        const requested = (
          replacements
            ? previous.allocations.map((a) => ({
                trader_id:
                  replacements.find((r) => r.outgoing_trader_id === a.trader.id)
                    ?.incoming_trader_id ?? a.trader.id,
                amount_usdc: a.amount_usdc,
              }))
            : (args.allocations ??
              previous.allocations.map((x) => ({
                trader_id: x.trader.id,
                amount_usdc: x.amount_usdc,
                leverage_cap: x.leverage_cap,
                stop_loss_pct: x.stop_loss_pct,
              })))
        ) as {
          trader_id: string;
          amount_usdc: string;
          leverage_cap?: number | null;
          stop_loss_pct?: number;
          copy_mode?: "ride_recommends" | "fixed" | "proportional";
          fixed_margin_usdc?: string;
          proportional_multiplier?: number;
          loss_policy?: "exit" | "pause_then_exit";
          emergency_exit_pct?: number;
        }[];
        if (
          new Set(requested.map((x) => x.trader_id)).size !== requested.length
        )
          throw new AgentError(
            "DUPLICATE_TRADER",
            "Select each trader only once.",
            false,
            400,
          );
        const [minCount, maxCount] = basketLimits(pref);
        if (requested.length < minCount || requested.length > maxCount)
          throw new AgentError(
            "INVALID_BASKET",
            `Select ${minCount}–${maxCount} traders for this plan.`,
            false,
            400,
          );
        const effectivePref = pref.portfolio_kind
          ? { ...pref, basket_size: requested.length }
          : pref;
        const pool = await Promise.all(
          requested.map((x) => this.adapter.profile(x.trader_id)),
        );
        const plan = recommend(effectivePref, pool, {
          selection_source:
            args.allocations || replacements
              ? "explicit"
              : (previous.selection_source ?? "legacy_unknown"),
          risk_selection: "preserve",
        });
        plan.previous_plan_id = previous.id;
        plan.preference_sources = args.preferences
          ? editCollection.sources
          : previous.preference_sources;
        if (plan.allocations.length !== requested.length)
          throw new AgentError(
            "PLAN_CHANGED",
            "A selected trader is no longer eligible for these preferences.",
          );
        const total = requested.reduce((n, x) => n.plus(x.amount_usdc), D(0));
        if (total.gt(pref.budget_usdc))
          throw new AgentError(
            "BUDGET_EXCEEDED",
            "Allocations exceed the requested budget.",
          );
        plan.allocations = requested.map((x, i) => {
          const prior =
            previous.allocations.find((a) => a.trader.id === x.trader_id) ??
            replacedSlots.get(x.trader_id);
          const settings = {
            ...prior,
            ...((args.preferences as Partial<Preferences>) ?? {}),
            ...x,
          };
          const modeChanged =
            (x.copy_mode ??
              (args.preferences as Partial<Preferences> | undefined)
                ?.copy_mode) != null &&
            settings.copy_mode !==
              (prior?.copy_mode ?? previous.preferences.copy_mode);
          const capEdited =
            args.allocations != null && x.leverage_cap !== undefined;
          const leverageMode =
            pool[i].market === "prediction"
              ? "cap"
              : capEdited && x.leverage_cap === null
                ? "follow_source"
                : capEdited
                  ? "custom_cap"
                  : prior && !modeChanged
                    ? (prior.leverage_mode ?? "cap")
                    : defaultLeverageMode(
                        {
                          ...pref,
                          copy_mode: settings.copy_mode ?? pref.copy_mode,
                        },
                        pool[i],
                      );
          const cap =
            leverageMode === "custom_cap"
              ? maximumUserLeverage(pool[i])
              : recommendedLeverage(pref, pool[i], leverageMode);
          const leverage =
            x.leverage_cap !== undefined
              ? x.leverage_cap
              : prior
                ? prior.leverage_cap
                : leverageMode === "follow_source"
                  ? null
                  : cap;
          if (
            cap == null ||
            (leverage == null
              ? leverageMode !== "follow_source"
              : leverage > cap) ||
            (pool[i].market === "prediction" && leverage !== 1)
          )
            throw new AgentError(
              "INVALID_LEVERAGE",
              "Perps leverage caps must use the App-supported 1–40x range; Prediction requires 1x.",
            );
          if (
            D(x.amount_usdc).lt(minimumAllocation(pref, pool[i])) ||
            (pref.portfolio_kind !== "single" &&
              D(x.amount_usdc).gt(total.times("0.55")))
          )
            throw new AgentError(
              "INVALID_ALLOCATION",
              "Each allocation must meet the minimum and stay at or below 55% of selected capital.",
            );
          return {
            ...plan.allocations.find((a) => a.trader.id === x.trader_id)!,
            amount_usdc: cash(x.amount_usdc),
            leverage_cap: leverage,
            leverage_cap_source: capEdited
              ? "user"
              : prior
                ? "inherited"
                : "default",
            leverage_cap_inherited_from_plan_id:
              !capEdited && prior ? previous.id : undefined,
            leverage_mode: leverageMode === "cap" ? undefined : leverageMode,
            stop_loss_pct: x.stop_loss_pct ?? prior?.stop_loss_pct ?? 30,
            copy_mode: settings.copy_mode ?? pref.copy_mode,
            fixed_margin_usdc:
              settings.fixed_margin_usdc == null
                ? undefined
                : cash(settings.fixed_margin_usdc),
            proportional_multiplier:
              settings.proportional_multiplier ?? pref.proportional_multiplier,
            loss_policy: settings.loss_policy ?? pref.loss_policy,
            emergency_exit_pct:
              settings.emergency_exit_pct ?? pref.emergency_exit_pct,
          };
        });
        if (plan.risk_selection) {
          const byId = new Map(
            plan.risk_selection.selected.map((row) => [row.trader_id, row]),
          );
          plan.risk_selection.selected = plan.allocations.flatMap((a) => {
            const row = byId.get(a.trader.id);
            return row ? [row] : [];
          });
        }
        s.plans = s.plans
          .filter((x) => x.created_at > now() - 90 * 86400_000)
          .slice(-99);
        plan.allocations.forEach(validateCopySettings);
        s.plans.push(plan);
        if (args.preferences)
          savePreferenceCollection(
            s,
            preferenceCollection(s, args.preferences as Partial<Preferences>),
          );
        if ((args.allocations || replacements) && pref.portfolio_kind) {
          s.selected_trader_ids = requested.map((x) => x.trader_id);
          s.selection_source = "explicit";
        }
        const sourcePool = await this.adapter.candidates(pref.market);
        const candidates = eligibleCandidates(pref, sourcePool);
        const savedPreferences = completePreferences(s)!;
        saveDiscovery(s, savedPreferences, sourcePool);
        return result(
          {
            ...conversationView(
              plan,
              editCollection,
              candidates,
              !!s.selected_trader_ids,
              args.detail as Detail,
              previous,
              args as AnalysisOptions,
            ),
            plan,
            candidates,
            candidate_limits: candidates.map((c) => ({
              trader_id: c.id,
              leverage_cap:
                defaultLeverageMode(pref, c) === "follow_source"
                  ? null
                  : recommendedLeverage(pref, c),
              maximum_leverage_cap: maximumUserLeverage(c),
            })),
            compatibility: compatibility(plan),
            alternatives: alternatives(plan, candidates),
            recommendation_batches: s.recommendation_batches
              ? {
                  ...s.recommendation_batches,
                  preview_quota_applies: false,
                  displayed_candidates: candidates.filter((c) =>
                    s.recommendation_batches!.batches[
                      s.recommendation_batches!.active_index
                    ].includes(c.id),
                  ),
                }
              : undefined,
            candidate_page:
              s.discovery!.expires_at > now()
                ? browse(s, savedPreferences, { limit: 5 }, user, this.cursor)
                    .candidates_meta
                : null,
            previous_plan_id: previous.id,
            plan_change: planChange(previous, plan),
            edit_kind: replacements
              ? "one_for_one_replacement"
              : args.allocations || args.preferences
                ? "explicit_edit"
                : "refresh",
            requires_new_confirmation: true,
            unallocated_usdc: cash(D(pref.budget_usdc).minus(total)),
            portfolio_historical_drawdown_pct: null,
          },
          "ok",
          [
            "Capital weights are not live exposure. Source entry and actual gross concentration are checked before execution.",
            "Loss triggers initiate exits; slippage can exceed the threshold.",
          ],
        );
      }
      if (name === "get_performance") {
        const p = findPortfolio(s, args.portfolio_id as string | undefined);
        if (!p) return result({ performance: null }, "empty");
        const performance = performanceView(s, p, args.period as string);
        return result(
          { performance },
          performance.coverage === "complete" ? "ok" : "stale",
        );
      }
      if (name === "diagnose_copy") {
        const p = findByOwnership(s, args);
        if (!p)
          throw new AgentError(
            "NOT_FOUND",
            "Owned copy not found.",
            false,
            404,
          );
        const sleeve = p.sleeves.find((x) => x.copy_id === args.copy_id)!;
        const start = args.start_at as number,
          end = args.end_at as number;
        if (end > now())
          throw new AgentError(
            "INVALID_WINDOW",
            "The diagnostic window cannot extend into the future.",
            false,
            400,
          );
        let source: { fills: unknown[]; complete: boolean; reason?: string } = {
          fills: [],
          complete: false,
          reason: "Source fill history unavailable.",
        };
        try {
          source =
            (await this.adapter.sourceFills?.(sleeve.trader, start, end)) ??
            source;
        } catch {
          /* Explicit missing evidence below. */
        }
        const receipts = (p.receipts ?? []).filter(
          (x) =>
            x.copy_id === sleeve.copy_id &&
            x.fill.at >= start &&
            x.fill.at < end,
        );
        const decisions = (p.decisions ?? []).filter(
          (x) => x.copy_id === sleeve.copy_id && x.at >= start && x.at < end,
        );
        const began = p.audit_started_at ?? Infinity;
        const followerComplete =
          start >= began && (p.audit_verified_at ?? 0) >= end;
        return result(
          {
            diagnostic: {
              copy_id: sleeve.copy_id,
              trader: sleeve.trader.handle,
              window: { start_at: start, end_at: end },
              source_fills: source.fills,
              source_coverage: source.complete ? "complete" : "incomplete",
              follower_verified_through: p.audit_verified_at ?? null,
              source_missing_reason: source.reason ?? null,
              follower_coverage: followerComplete ? "complete" : "incomplete",
              follower_fills: receipts,
              decisions,
              current_configuration: {
                amount_usdc: sleeve.amount_usdc,
                leverage_cap: sleeve.leverage_cap,
                ...(sleeve.leverage_mode
                  ? { leverage_mode: sleeve.leverage_mode }
                  : {}),
                stop_loss_pct: sleeve.stop_loss_pct,
              },
              funding: (p.funding_receipts ?? []).filter(
                (x) =>
                  x.copy_id === sleeve.copy_id && x.at >= start && x.at < end,
              ),
              executions: p.executions
                .filter(
                  (e) =>
                    e.created_at >= start &&
                    e.created_at < end &&
                    (sleeve.copy_id in e.allocations ||
                      sleeve.copy_id in (e.unfilled_allocations ?? {})),
                )
                .map(
                  ({ allocations, unfilled_allocations, fingerprint, ...e }) =>
                    e,
                ),
              events: s.updates
                .filter(
                  (e) =>
                    e.portfolio_id === p.id &&
                    e.at >= start &&
                    e.at < end &&
                    (!e.data.copy_id || e.data.copy_id === sleeve.copy_id),
                )
                .map(({ notification, ...e }) => e),
              fees_usdc: receipts.length
                ? cash(receipts.reduce((n, x) => n.plus(x.fee_usdc), D(0)))
                : followerComplete
                  ? "0.000000"
                  : null,
              profit_difference_usdc: null,
              missing_reason:
                "Source and follower fills are separate evidence. No counterfactual profit or fill pairing is inferred; missing historical evidence remains unavailable.",
            },
          },
          source.complete && followerComplete ? "ok" : "stale",
        );
      }
      if (
        name === "get_notification_preferences" ||
        name === "set_notification_preferences"
      ) {
        if (name === "set_notification_preferences")
          s.notification_preferences = {
            ...(args as {
              daily_digest: boolean;
              local_time: string;
              timezone: string;
            }),
            enabled_at: now(),
            last_digest_day: s.notification_preferences?.last_digest_day,
          };
        let delivery = { configured: false, device_registered: false };
        try {
          delivery =
            (await this.adapter.notificationStatus?.(user)) ?? delivery;
        } catch {
          /* Report unavailable without claiming delivery. */
        }
        return result({
          notification_preferences: s.notification_preferences ?? {
            daily_digest: false,
            local_time: "09:00",
            timezone: "UTC",
          },
          delivery: {
            ...delivery,
            channel: "Ride App",
            status:
              delivery.configured && delivery.device_registered
                ? "ready"
                : "unavailable",
          },
          monitoring: "server",
          critical_risk_alerts: "enabled",
        });
      }
      if (name === "get_updates") {
        const c = args.cursor
          ? this.cursor.decode(user, args.cursor as string)
          : { at: 0, id: "" };
        const events = s.updates
          .filter((x) => x.at > c.at || (x.at === c.at && x.id > c.id))
          .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
        const page = events.slice(0, args.limit as number);
        const last = page.at(-1);
        return result(
          {
            updates: page.map(({ notification, ...event }) => event),
            next_cursor: last
              ? this.cursor.encode(user, last.at, last.id)
              : (args.cursor ?? null),
            has_more: events.length > page.length,
          },
          page.length ? "ok" : "empty",
        );
      }
      if (name === "get_portfolio") {
        if (args.plan_id) {
          const plan = s.plans.find((p) => p.id === args.plan_id);
          if (!plan)
            throw new AgentError(
              "NOT_FOUND",
              "Saved plan not found for this account.",
              false,
              404,
            );
          const previous = s.plans.find((p) => p.id === plan.previous_plan_id);
          return result({
            ...conversationView(
              plan,
              preferenceCollection({
                ...s,
                preferences: plan.preferences,
                preference_sources:
                  plan.preference_sources ?? s.preference_sources,
                preference_draft: undefined,
              }),
              plan.allocations.map((a) => a.trader),
              !!s.selected_trader_ids?.length,
              args.detail as Detail,
              previous,
              args as AnalysisOptions,
            ),
            plan,
            compatibility: compatibility(plan),
            ...(previous ? { plan_change: planChange(previous, plan) } : {}),
            read_only: true,
            plan_unchanged: true,
            plan_status: plan.expires_at > now() ? "ready" : "expired",
          });
        }
        const p = findPortfolio(s, args.portfolio_id as string | undefined);
        if (!p) {
          if (args.portfolio_id) return result({ portfolio: null }, "empty");
          const plan = s.plans.at(-1);
          return plan
            ? result(
                {
                  portfolio: null,
                  ...conversationView(
                    plan,
                    preferenceCollection(s),
                    plan.allocations.map((a) => a.trader),
                    !!s.selected_trader_ids?.length,
                    args.detail as Detail,
                    s.plans.find((p) => p.id === plan.previous_plan_id),
                    args as AnalysisOptions,
                  ),
                  recovery: {
                    source: "saved_preview",
                    plan_id: plan.id,
                    created_at: plan.created_at,
                    expires_at: plan.expires_at,
                    read_only: true,
                    instruction:
                      "这是已保存的方案，读取不会重新生成或执行交易。先核对预算、风险、选择和创建时间是否对应刚才的请求；不匹配时不可宣称恢复成功。过期时只刷新此方案，不重复推荐。",
                  },
                  plan,
                  compatibility: compatibility(plan),
                  recommendation_batches: s.recommendation_batches,
                  saved_preview: true,
                  plan_status: plan.expires_at > now() ? "ready" : "expired",
                  candidates: plan.allocations.map((a) => a.trader),
                  unallocated_usdc: cash(
                    D(plan.preferences.budget_usdc).minus(
                      plan.allocations.reduce(
                        (n, a) => n.plus(a.amount_usdc),
                        D(0),
                      ),
                    ),
                  ),
                },
                "empty",
              )
            : result(
                {
                  portfolio: null,
                  preference_collection: preferenceCollection(s),
                },
                "empty",
              );
        }
        try {
          p.snapshot = await this.adapter.account(user, p);
        } catch {
          /* Return explicitly stale stored snapshot; runner owns settlement. */
        }
        return portfolioView(p);
      }
      if (name === "review_portfolio") {
        const p = findPortfolio(s, args.portfolio_id as string | undefined);
        if (!p)
          return result(
            { portfolio: null, observations: [], suggestions: [] },
            "empty",
          );
        return result({
          portfolio_id: p.id,
          observations: review(p),
          suggestions: review(p).map((x) => ({
            observation: x,
            requires_confirmation: true,
          })),
          as_of: p.snapshot?.observed_at ?? null,
        });
      }
      return this.propose(user, s, name, args);
    });
  }
  private async propose(
    user: string,
    s: State,
    name: ToolName,
    args: Record<string, unknown>,
  ): Promise<Result> {
    let p: Portfolio,
      actionAmount = "0";
    if (name === "start_copy") {
      const plan = s.plans.find((x) => x.id === args.plan_id);
      if (!plan)
        throw new AgentError(
          "NOT_FOUND",
          "Plan not found for this account.",
          false,
          404,
        );
      if (plan.expires_at <= now())
        throw new AgentError("PLAN_EXPIRED", "Refresh trader recommendations.");
      await this.validatePlan(plan);
      if (
        plan.preferences.portfolio_kind &&
        compatibility(plan).warnings &&
        args.compatibility_ack !== compatibility(plan).fingerprint
      )
        throw new AgentError(
          "COMPATIBILITY_REVIEW_REQUIRED",
          "Review the overlap warnings and acknowledge this exact plan before starting.",
        );
      if (s.portfolios.some((x) => x.state !== "closed"))
        throw new AgentError(
          "OWNERSHIP_CONFLICT",
          "An existing Agent portfolio must finish closing before starting another.",
        );
      p = fromPlan(plan);
      actionAmount = cash(plan.preferences.budget_usdc);
    } else {
      const owned = findByOwnership(s, args);
      if (!owned)
        throw new AgentError(
          "NOT_FOUND",
          "Owned copy or position not found.",
          false,
          404,
        );
      p = structuredClone(owned);
      if (args.replacement_trader_id) {
        args = {
          ...args,
          replacement_copy_id: uid("copy"),
          replacement_at: now(),
        };
      }
      await this.mutatePreview(p, args, name);
      const copy = owned.sleeves.find((x) => x.copy_id === args.copy_id);
      actionAmount =
        name === "update_copy"
          ? cash(
              D((args.amount_usdc as string) ?? copy?.amount_usdc ?? 0)
                .minus(copy?.amount_usdc ?? 0)
                .abs(),
            )
          : "0.000000";
    }
    const snapshot = await this.adapter.preflight(user, p);
    if (
      !fresh(snapshot.observed_at) ||
      !snapshot.eligible ||
      !snapshot.dedicated
    )
      throw new AgentError(
        "ACCOUNT_NOT_READY",
        "A fresh, eligible dedicated trading account is required.",
      );
    if (D(actionAmount).gt(snapshot.available_usdc))
      throw new AgentError(
        "INSUFFICIENT_FUNDS",
        "Verified available funds do not cover this change.",
      );
    for (const market of ["perps", "prediction"] as const) {
      const allocation = p.sleeves
        .filter((s) => s.trader.market === market && s.state !== "closed")
        .reduce((n, s) => n.plus(s.amount_usdc), D(0));
      if (
        snapshot.available_by_market?.[market] != null &&
        name === "start_copy" &&
        allocation.gt(snapshot.available_by_market[market]!)
      )
        throw new AgentError(
          "INSUFFICIENT_FUNDS",
          "Each market requires its own verified available funds.",
        );
    }
    if (name === "start_copy") this.assertScopedFunding(p, snapshot);
    p.snapshot = snapshot;
    const proposedTargets =
      name === "start_copy" ? [] : risk(p, snapshot.prices, true);
    if (name !== "start_copy") {
      const actual = aggregate(p, snapshot.prices, "actual");
      const additional = proposedTargets.reduce(
        (n, a) =>
          n.plus(
            D.max(
              0,
              D(a.net_notional_usdc)
                .abs()
                .minus(
                  D(
                    actual.find((x) => x.key === a.key)?.net_notional_usdc ?? 0,
                  ).abs(),
                ),
            ).div(
              Math.min(
                ...p.sleeves
                  .filter((s) => s.intents[a.key])
                  .map((s) =>
                    Math.min(
                      s.leverage_cap ?? Number.POSITIVE_INFINITY,
                      s.intents[a.key].source_leverage,
                    ),
                  ),
                p.sleeves.some((s) => s.leverage_mode != null)
                  ? (snapshot.max_leverages[a.key] ?? 1)
                  : 8,
              ),
            ),
          ),
        D(0),
      );
      actionAmount = cash(D.max(actionAmount, additional.times("1.003")));
      if (D(actionAmount).gt(snapshot.available_usdc))
        throw new AgentError(
          "INSUFFICIENT_FUNDS",
          "Removing this hedge requires additional verified margin.",
        );
    }
    const projected = portfolioView(p).data.portfolio as Record<string, any>;
    const { state: projectedState, ...projectedFields } = projected;
    const preview = {
      state_semantics: "projected_after_confirmation",
      portfolio: {
        portfolio: {
          ...projectedFields,
          projected_state: projectedState,
          sleeves: projected.sleeves.map(
            ({ state, ...sleeve }: Record<string, any>) => ({
              ...sleeve,
              projected_state: state,
            }),
          ),
        },
      },
      proposed_positions: proposedTargets,
      action: name,
      parameters: args,
      loss_trigger_amount_usdc: cash(
        D(p.preferences.budget_usdc)
          .times(p.preferences.loss_trigger_pct)
          .div(100),
      ),
      existing_entry_max_deviation_pct: 0.2,
      fees: { estimate_usdc: null, exact_fee_at_settlement: true },
      execution_state: "not_submitted",
    };
    const existing = s.proposals.find(
      (x) =>
        x.status === "requires_confirmation" &&
        x.expires_at > now() &&
        x.action === name &&
        fingerprint(publicArguments(x.arguments)) ===
          fingerprint(publicArguments(args)) &&
        x.expected_revision === p.revision,
    );
    const proposal: Proposal = existing ?? {
      id: uid("proposal"),
      action: name,
      arguments: args,
      portfolio_id: p.id,
      expected_revision: p.revision,
      created_at: now(),
      expires_at: now() + 5 * 60_000,
      status: "requires_confirmation",
      snapshot_hash: fingerprint({
        account_id: snapshot.account_id,
        positions: snapshot.positions,
      }),
      amount_usdc: actionAmount,
      warnings: [
        "Loss thresholds trigger best-effort exits; losses can exceed the threshold.",
        "Activation is not proof of a fill.",
      ],
      preview,
    };
    if (!existing) s.proposals.push(proposal);
    const d = s.delegation;
    if (d && this.delegationAllows(d, p, proposal)) {
      await this.commit(user, s, proposal);
      return this.proposalView(proposal, s);
    }
    return this.proposalView(proposal, s);
  }
  private async reselectPlan(
    user: string,
    state: State,
    args: Record<string, unknown>,
  ): Promise<Result> {
    const previous = state.plans.find((p) => p.id === args.base_plan_id);
    if (!previous)
      throw new AgentError(
        "NOT_FOUND",
        "Saved plan not found for this account.",
        false,
        404,
      );
    const basePreferences = normalizedAssetPreferences(
      previous.preferences,
      previous.asset_filter_version ?? 1,
    );
    if (
      (basePreferences.basket_size != null &&
        basePreferences.basket_size !== previous.allocations.length) ||
      (basePreferences.portfolio_kind === "single" &&
        previous.allocations.length !== 1)
    )
      throw new AgentError(
        "RESELECT_SETTINGS_CONFLICT",
        "The original count and stored preferences disagree; review the original plan first.",
      );
    const answers = (args.preferences ?? {}) as Partial<Preferences>;
    for (const key of Object.keys(answers) as (keyof Preferences)[]) {
      if (
        key !== "risk_tolerance" &&
        fingerprint(answers[key] ?? null) !==
          fingerprint(basePreferences[key] ?? null)
      )
        throw new AgentError(
          "RESELECT_SETTINGS_CONFLICT",
          "A system reselect preserves the original budget, count and settings. Edit other fields separately.",
        );
    }
    const collection = preferenceCollection(
      {
        ...state,
        preferences: basePreferences,
        preference_asset_filter_version: previous.asset_filter_version,
        preference_sources: previous.preference_sources ?? {},
        preference_draft: undefined,
      },
      answers,
    );
    const pref = preferences.parse(collection.answers);
    if (!pref.risk_tolerance)
      throw new AgentError(
        "RISK_PREFERENCE_REQUIRED",
        "Choose a risk preference for system reselection; a numerical exit trigger does not imply one.",
      );
    const pool = await this.adapter.candidates(pref.market);
    const plan = recommend(
      { ...pref, basket_size: previous.allocations.length },
      pool,
      {
        selection_source: "system",
        risk_selection: "apply",
      },
    );
    if (plan.risk_selection?.status !== "applied")
      throw new AgentError(
        "RISK_FIT_UNAVAILABLE",
        "The complete comparable risk evidence is unavailable. The original plan, preferences and selection were preserved.",
        true,
        409,
      );
    plan.preference_sources = collection.sources;
    inheritReselectedSlots(previous, plan);
    const candidates = eligibleCandidates(pref, pool);
    // Stage everything before touching persisted account state, including in-memory repositories.
    const next = structuredClone(state);
    savePreferenceCollection(next, collection);
    next.selected_trader_ids = undefined;
    next.selection_source = "system";
    next.recommendation_batches = undefined;
    next.plans = [
      structuredClone(previous),
      ...next.plans
        .filter(
          (p) => p.id !== previous.id && p.created_at > now() - 90 * 86400_000,
        )
        .slice(-98),
      plan,
    ];
    saveDiscovery(next, pref, pool);
    const data = {
      ...conversationView(
        plan,
        collection,
        candidates,
        false,
        args.detail as Detail,
        previous,
        args as AnalysisOptions,
      ),
      plan,
      preferences: pref,
      candidates,
      candidate_page: browse(next, pref, { limit: 5 }, user, this.cursor)
        .candidates_meta,
      previous_plan_id: previous.id,
      plan_change: planChange(previous, plan),
      edit_kind: "system_reselection",
      original_plan_unchanged: true,
      slot_amounts_unchanged: true,
      requires_new_confirmation: true,
      execution_authorized: false,
    };
    Object.assign(state, next);
    return result(data);
  }
  async proposal(user: string, id: string): Promise<Result> {
    return this.repository.transact(user, async (s) => {
      const p = s.proposals.find((x) => x.id === id);
      if (!p)
        throw new AgentError("NOT_FOUND", "Proposal not found.", false, 404);
      return this.proposalView(p, s);
    });
  }
  async update(user: string, eventId: string): Promise<Result> {
    return this.repository.transact(user, async (s) => {
      const update = s.updates.find((x) => x.id === eventId);
      if (!update)
        throw new AgentError(
          "NOT_FOUND",
          "Report not found for this Ride account.",
          false,
          404,
        );
      const {
        notification,
        notification_attempts,
        next_notification_at,
        notification_error,
        ...record
      } = update;
      return result({ update: record });
    });
  }
  async confirm(user: string, id: string, hash: string): Promise<Result> {
    return this.repository.transact(user, async (s) => {
      const p = s.proposals.find((x) => x.id === id);
      if (!p)
        throw new AgentError("NOT_FOUND", "Proposal not found.", false, 404);
      if (hash !== fingerprint(p.preview))
        throw new AgentError(
          "PROPOSAL_CHANGED",
          "The displayed proposal does not match the frozen confirmation.",
        );
      await this.commit(user, s, p);
      return this.proposalView(p, s);
    });
  }
  async reject(user: string, id: string): Promise<Result> {
    return this.repository.transact(user, async (s) => {
      const p = s.proposals.find((x) => x.id === id);
      if (!p)
        throw new AgentError("NOT_FOUND", "Proposal not found.", false, 404);
      if (p.status === "requires_confirmation") p.status = "rejected";
      return this.proposalView(p, s);
    });
  }
  async authorize(
    user: string,
    input: Omit<
      Delegation,
      "id" | "used_usdc" | "daily_used_usdc" | "day" | "revoked"
    >,
  ): Promise<Result> {
    return this.repository.transact(user, async (s) => {
      const p = findPortfolio(s, input.portfolio_id);
      if (!p)
        throw new AgentError("NOT_FOUND", "Portfolio not found.", false, 404);
      if (
        input.expires_at <= now() ||
        input.expires_at > now() + 30 * 86400_000 ||
        D(input.per_action_usdc).gt(input.daily_usdc) ||
        D(input.daily_usdc).gt(input.total_usdc) ||
        D(input.total_usdc).gt(p.preferences.budget_usdc) ||
        input.leverage_cap < 1 ||
        input.leverage_cap > 40
      )
        throw new AgentError(
          "INVALID_AUTHORITY",
          "Authorization limits exceed the portfolio or expiry constraints.",
          false,
          400,
        );
      s.delegation = {
        ...input,
        id: uid("grant"),
        used_usdc: "0",
        daily_used_usdc: "0",
        day: new Date().toISOString().slice(0, 10),
        revoked: false,
      };
      return result({ authorization: s.delegation });
    });
  }
  async revoke(user: string): Promise<Result> {
    return this.repository.transact(user, async (s) => {
      if (s.delegation) s.delegation.revoked = true;
      return result({ revoked: true });
    });
  }
  private delegationAllows(d: Delegation, p: Portfolio, q: Proposal): boolean {
    const day = new Date().toISOString().slice(0, 10);
    if (d.day !== day) {
      d.day = day;
      d.daily_used_usdc = "0";
    }
    return (
      !d.revoked &&
      d.expires_at > now() &&
      d.portfolio_id === p.id &&
      p.sleeves
        .filter((s) => s.state !== "closed")
        .every(
          (s) =>
            d.markets.includes(s.trader.market) &&
            s.leverage_cap != null &&
            s.leverage_cap <= d.leverage_cap &&
            s.trader.assets.every((a) => d.assets.includes(a)),
        ) &&
      D(q.amount_usdc).lte(d.per_action_usdc) &&
      D(d.used_usdc).plus(q.amount_usdc).lte(d.total_usdc) &&
      D(d.daily_used_usdc).plus(q.amount_usdc).lte(d.daily_usdc)
    );
  }
  private async commit(user: string, s: State, q: Proposal): Promise<void> {
    if (q.status === "queued" || q.status === "completed") return;
    if (q.status !== "requires_confirmation" || q.expires_at <= now())
      throw new AgentError("PROPOSAL_EXPIRED", "Create a fresh proposal.");
    let p = s.portfolios.find((x) => x.id === q.portfolio_id);
    if (q.action === "start_copy") {
      const plan = s.plans.find((x) => x.id === q.arguments.plan_id);
      if (
        !plan ||
        plan.expires_at <= now() ||
        s.portfolios.some((x) => x.state !== "closed")
      )
        throw new AgentError(
          "PLAN_CHANGED",
          "Plan expired or account ownership changed.",
        );
      p = fromPlan(plan, q.portfolio_id);
      await this.validatePlan(plan);
    }
    if (!p || p.revision !== q.expected_revision)
      throw new AgentError(
        "REVISION_CHANGED",
        "Portfolio changed; create a new proposal.",
      );
    const snapshot = await this.adapter.preflight(user, p);
    if (
      !fresh(snapshot.observed_at) ||
      !snapshot.eligible ||
      !snapshot.dedicated ||
      q.snapshot_hash !==
        fingerprint({
          account_id: snapshot.account_id,
          positions: snapshot.positions,
        })
    )
      throw new AgentError(
        "ACCOUNT_CHANGED",
        "Account state changed; review a fresh proposal.",
      );
    if (q.action === "start_copy")
      for (const market of ["perps", "prediction"] as const) {
        const allocation = p.sleeves
          .filter((s) => s.trader.market === market)
          .reduce((n, s) => n.plus(s.amount_usdc), D(0));
        if (
          snapshot.available_by_market?.[market] != null &&
          allocation.gt(snapshot.available_by_market[market]!)
        )
          throw new AgentError(
            "INSUFFICIENT_FUNDS",
            "Market available funds changed; review a fresh proposal.",
          );
      }
    if (q.action === "start_copy") this.assertScopedFunding(p, snapshot);
    const pending = p.executions
      .filter((e) => !["completed", "failed", "superseded"].includes(e.status))
      .reduce((n, e) => n.plus(e.reserve_usdc), D(0));
    if (D(q.amount_usdc).plus(pending).gt(snapshot.available_usdc))
      throw new AgentError(
        "INSUFFICIENT_FUNDS",
        "Available funds changed or are reserved by pending execution.",
      );
    if (q.action !== "start_copy")
      await this.mutatePreview(p, q.arguments, q.action as ToolName);
    p.snapshot = snapshot;
    p.revision++;
    p.control_id = q.id;
    recordConfigurations(p);
    q.committed_revision = p.revision;
    // Before changing target policy, reconcile Core's old tasks. The adapter
    // fences old revision work; no stale increasing order may survive a stop.
    if (p.account_id) await this.adapter.fence(user, p);
    if (!s.portfolios.some((x) => x.id === p!.id)) s.portfolios.push(p);
    q.status = "queued";
    if (s.delegation && this.delegationAllows(s.delegation, p, q)) {
      s.delegation.used_usdc = cash(
        D(s.delegation.used_usdc).plus(q.amount_usdc),
      );
      s.delegation.daily_used_usdc = cash(
        D(s.delegation.daily_used_usdc).plus(q.amount_usdc),
      );
    }
    event(
      s,
      "proposal_confirmed",
      p.id,
      "Confirmed parameters queued for execution.",
      { proposal_id: q.id },
    );
  }
  private assertScopedFunding(
    p: Portfolio,
    snapshot: NonNullable<Portfolio["snapshot"]>,
  ) {
    if (
      p.sleeves.some(
        (s) =>
          s.trader.asset_category === "rwa" ||
          Object.values(s.trader.asset_categories ?? {}).includes("rwa"),
      )
    ) {
      const required = new Map<string, ReturnType<typeof D>>();
      for (const sleeve of p.sleeves) {
        const scopes = [
          ...new Set(
            sleeve.trader.assets
              .filter(
                (a) =>
                  (sleeve.trader.asset_categories?.[a] ??
                    sleeve.trader.asset_category) === "rwa",
              )
              .map((a) => (a.includes(":") ? a.split(":")[0] : "core")),
          ),
        ];
        for (const scope of scopes)
          required.set(
            scope,
            (required.get(scope) ?? D(0)).plus(sleeve.amount_usdc),
          );
      }
      for (const [scope, amount] of required)
        if (amount.gt(snapshot.available_by_scope?.[scope] ?? 0))
          throw new AgentError(
            "SCOPED_COLLATERAL_REQUIRED",
            "RWA allocation needs verified available USDC in each selected DEX. Fund its trading scope in Ride before confirmation.",
          );
    }
  }
  private async validatePlan(plan: Plan): Promise<void> {
    const rows = await Promise.all(
      plan.allocations.map((a) => this.adapter.profile(a.trader.id)),
    );
    const allowed = eligibleCandidates(
      plan.preferences,
      rows,
      plan.asset_filter_version ?? 1,
    );
    if (
      allowed.length !== plan.allocations.length ||
      plan.allocations.some(
        (a, i) =>
          (a.leverage_cap == null
            ? a.leverage_mode !== "follow_source"
            : a.leverage_cap >
              ((a.leverage_mode === "custom_cap"
                ? maximumUserLeverage(rows[i])
                : recommendedLeverage(
                    plan.preferences,
                    rows[i],
                    a.leverage_mode ?? "cap",
                  )) ?? 0)) ||
          D(a.amount_usdc).lt(
            plan.preferences.portfolio_kind && rows[i].market === "perps"
              ? minimumAllocation(plan.preferences, rows[i])
              : rows[i].min_notional_usdc,
          ),
      )
    )
      throw new AgentError(
        "PLAN_CHANGED",
        "Trader eligibility or execution limits changed; recalculate and review a new plan.",
      );
  }
  private async mutatePreview(
    p: Portfolio,
    args: Record<string, unknown>,
    name: ToolName,
  ): Promise<void> {
    if (name === "update_portfolio") {
      if (p.loss_latched)
        throw new AgentError(
          "LOSS_LATCHED",
          "A triggered portfolio stop must finish exiting; changing the threshold cannot restart it.",
        );
      p.preferences = {
        ...p.preferences,
        loss_trigger_pct: args.loss_trigger_pct as number,
      };
      return;
    }
    let s = p.sleeves.find((x) => x.copy_id === args.copy_id);
    if (name === "close_position") {
      const positions = aggregate(p, p.snapshot?.prices ?? {}, "actual");
      const a = positions.find((x) => x.position_id === args.position_id);
      if (!a)
        throw new AgentError(
          "NOT_FOUND",
          "Owned aggregate position not found.",
          false,
          404,
        );
      for (const sleeve of p.sleeves) {
        if (sleeve.intents[a.key]) sleeve.intents[a.key].quantity = "0";
        if (!sleeve.suppressed.includes(a.key)) sleeve.suppressed.push(a.key);
      }
      risk(p, p.snapshot!.prices, true);
      return;
    }
    if (!s) throw new AgentError("NOT_FOUND", "Copy not found.", false, 404);
    if (name === "stop_copy") {
      s.state = args.mode === "close_now" ? "closing" : "wind_down";
      if (args.mode === "close_now")
        for (const x of Object.values(s.intents)) x.quantity = "0";
    }
    if (name === "update_copy") {
      if (args.replacement_trader_id) {
        if (
          s.state !== "closed" ||
          Object.values(s.lots).some((x) => !D(x.quantity).isZero()) ||
          p.reconciliation !== "complete" ||
          p.executions.some(
            (e) => !["completed", "failed", "superseded"].includes(e.status),
          )
        )
          throw new AgentError(
            "FUNDS_NOT_RELEASED",
            "Wind down and reconcile the old copy before replacing its allocation.",
          );
        if (
          p.sleeves.some(
            (x) =>
              x.replaced_at != null && now() - x.replaced_at < 7 * 86400_000,
          )
        )
          throw new AgentError(
            "REPLACEMENT_LIMIT",
            "One replacement is allowed per seven days.",
          );
        const trader = await this.adapter.profile(
          args.replacement_trader_id as string,
        );
        const replacementCap =
          s.leverage_mode === "custom_cap"
            ? maximumUserLeverage(trader)
            : recommendedLeverage(
                p.preferences,
                trader,
                s.leverage_mode ?? "cap",
              );
        if (
          !eligibleCandidates(
            p.preferences,
            [trader],
            p.asset_filter_version ?? 1,
          ).length ||
          replacementCap == null
        )
          throw new AgentError(
            "TRADER_INELIGIBLE",
            "Replacement needs fresh, eligible scores and verified risk limits.",
          );
        if (
          trader.eligibility !== "PASS" ||
          trader.expires_at <= now() ||
          (p.preferences.market !== "both" &&
            trader.market !== p.preferences.market) ||
          (trader.market === "perps" &&
            !trader.assets.every((a) =>
              assetAllowed(
                p.preferences,
                a,
                trader.asset_categories?.[a] ?? trader.asset_category,
                p.asset_filter_version ?? 1,
              ),
            ))
        )
          throw new AgentError(
            "TRADER_INELIGIBLE",
            "Replacement is not eligible for this portfolio.",
          );
        const replacement: Sleeve = {
          ...s,
          leverage_cap:
            s.leverage_cap == null
              ? null
              : Math.min(s.leverage_cap, replacementCap),
          copy_id: String(args.replacement_copy_id ?? uid("copy")),
          trader,
          state: "active",
          lots: {},
          intents: {},
          initialized: false,
          suppressed: [],
          source_revision: null,
          replaced_at: Number(args.replacement_at ?? now()),
        };
        p.sleeves.push(replacement);
        s.replaced_at = replacement.replaced_at;
        s = replacement;
      }
      if (args.amount_usdc !== undefined) {
        const next = D(args.amount_usdc as string),
          ratio = next.div(s.amount_usdc);
        const total = p.sleeves
          .filter((x) => x.state !== "closed")
          .reduce(
            (n, x) => n.plus(x.copy_id === s!.copy_id ? next : x.amount_usdc),
            D(0),
          );
        if (total.gt(p.preferences.budget_usdc))
          throw new AgentError(
            "BUDGET_EXCEEDED",
            "Sleeve allocations exceed the approved budget.",
          );
        for (const x of Object.values(s.intents))
          x.quantity = D(x.quantity)
            .times(ratio)
            .toDecimalPlaces(p.snapshot?.quantity_decimals?.[x.key] ?? 8)
            .toString();
        s.amount_usdc = cash(next);
        s.source_revision = null;
      }
      if (args.leverage_cap !== undefined) {
        if (s.trader.market === "prediction" && args.leverage_cap !== 1)
          throw new AgentError(
            "INVALID_LEVERAGE",
            "Prediction positions require leverage 1.",
          );
        const current = await this.adapter.profile(s.trader.id);
        const allowed = maximumUserLeverage(current);
        if ((args.leverage_cap as number) > (allowed ?? 0))
          throw new AgentError(
            "INVALID_LEVERAGE",
            "Perps leverage caps must use the App-supported 1–40x range; Prediction requires 1x.",
          );
        s.leverage_cap = args.leverage_cap as number | null;
        if (s.trader.market === "perps")
          s.leverage_mode =
            s.leverage_cap == null ? "follow_source" : "custom_cap";
        for (const x of Object.values(s.intents)) {
          const leverage = Math.min(
            s.leverage_cap ?? Number.POSITIVE_INFINITY,
            x.source_leverage,
          );
          x.quantity = D(x.quantity)
            .times(leverage)
            .div(x.source_leverage)
            .toDecimalPlaces(p.snapshot?.quantity_decimals?.[x.key] ?? 8)
            .toString();
          x.source_leverage = leverage;
        }
        // Re-evaluate this source even if it has not traded since the user
        // changed the allocation or cap. Parameters must affect actual targets.
        s.source_revision = null;
      }
      if (args.stop_loss_pct !== undefined)
        s.stop_loss_pct = args.stop_loss_pct as number;
      const priorMode = s.copy_mode ?? "ride_recommends";
      const priorMultiplier = s.proportional_multiplier ?? 1;
      for (const key of [
        "copy_mode",
        "fixed_margin_usdc",
        "proportional_multiplier",
        "loss_policy",
        "emergency_exit_pct",
      ] as const)
        if (args[key] !== undefined) (s as any)[key] = args[key];
      validateCopySettings(s);
      if (
        ["copy_mode", "fixed_margin_usdc", "proportional_multiplier"].some(
          (key) => args[key] !== undefined,
        )
      ) {
        s.source_revision = null;
        if ((s.copy_mode ?? "ride_recommends") !== priorMode) {
          s.fixed_targets = {};
          s.source_quantities = {};
          s.fixed_seen_fills = [];
          s.fixed_last_fill_at = undefined;
        } else if (
          s.copy_mode !== "fixed" &&
          args.proportional_multiplier !== undefined
        ) {
          for (const intent of Object.values(s.intents))
            intent.quantity = D(intent.quantity)
              .times(s.proportional_multiplier ?? 1)
              .div(priorMultiplier)
              .toDecimalPlaces(p.snapshot?.quantity_decimals?.[intent.key] ?? 8)
              .toString();
        }
      }
      if (args.resume_new_trades) {
        const net = pnl(p).sleeves.find(
          (x) => x.copy_id === s!.copy_id,
        )?.net_usdc;
        if (
          s.state !== "risk_off" ||
          net == null ||
          D(net).lte(D(s.amount_usdc).times(s.stop_loss_pct).div(100).neg())
        )
          throw new AgentError(
            "RESUME_BLOCKED",
            "Fresh reconciled profit must be above the pause threshold before resuming.",
          );
        s.state = "active";
        s.source_revision = null;
      }
    }
    if (p.snapshot) risk(p, p.snapshot.prices, true);
  }
  private proposalView(p: Proposal, state: State): Result {
    const portfolio = state.portfolios.find((x) => x.id === p.portfolio_id);
    const tasks =
      portfolio?.executions
        .filter(
          (e) =>
            e.revision === (p.committed_revision ?? p.expected_revision + 1),
        )
        .map(({ allocations, fingerprint, ...e }) => e) ?? [];
    return result(
      {
        proposal: {
          ...p,
          preview_hash: fingerprint(p.preview),
          confirmation_url: new URL(
            `/agent/confirm/${p.id}`,
            this.confirmationBase,
          ).href,
          execution_tasks: tasks,
          portfolio_state: portfolio?.state ?? null,
          actual_portfolio_state: portfolio?.state ?? null,
          preview_state_semantics: "projected_after_confirmation",
          execution_state:
            p.status === "requires_confirmation" ? "not_submitted" : p.status,
        },
      },
      p.status === "requires_confirmation"
        ? "requires_confirmation"
        : p.status === "queued"
          ? "queued"
          : p.status === "completed"
            ? "completed"
            : "failed",
      p.warnings,
    );
  }
}
export function fromPlan(plan: Plan, id = uid("portfolio")): Portfolio {
  return {
    id,
    account_id: null,
    revision: 0,
    state: "activating",
    preferences: plan.preferences,
    asset_filter_version: plan.asset_filter_version,
    sleeves: plan.allocations.map((a) => ({
      ...a,
      state: "active",
      lots: {},
      intents: {},
      initialized: false,
      suppressed: [],
      source_revision: null,
      last_source_at: null,
      replaced_at: null,
    })),
    executions: [],
    snapshot: null,
    initial_equity: null,
    created_at: now(),
    ledger_started_at: null,
    seen_fills: [],
    seen_funding: [],
    seen_flows: [],
    flow_total: "0",
    reconciliation: "pending",
    loss_latched: false,
  };
}
function findPortfolio(s: State, id?: string): Portfolio | undefined {
  return id
    ? s.portfolios.find((x) => x.id === id)
    : ([...s.portfolios].reverse().find((x) => x.state !== "closed") ??
        s.portfolios.at(-1));
}
function findByOwnership(
  s: State,
  args: Record<string, unknown>,
): Portfolio | undefined {
  return s.portfolios.find((p) =>
    args.portfolio_id
      ? p.id === args.portfolio_id
      : args.copy_id
        ? p.sleeves.some((x) => x.copy_id === args.copy_id)
        : aggregate(p, p.snapshot?.prices ?? {}, "actual").some(
            (x) => x.position_id === args.position_id,
          ),
  );
}
export function portfolioView(p: Portfolio): Result {
  const snap = p.snapshot,
    stats = pnl(p),
    stale = !snap || !fresh(snap.observed_at);
  let positions: ReturnType<typeof aggregate> = [];
  try {
    positions = aggregate(p, snap?.prices ?? {}, "actual");
  } catch {
    /* unavailable */
  }
  const pending = p.executions.filter(
    (e) => !["completed", "failed", "superseded"].includes(e.status),
  );
  return result(
    {
      portfolio: {
        id: p.id,
        revision: p.revision,
        state: p.state,
        preferences: p.preferences,
        created_at: p.created_at,
        ledger_started_at: p.ledger_started_at,
        account_value_usdc: snap?.account_value_usdc ?? null,
        available_usdc: stale ? null : (snap?.available_usdc ?? null),
        reserved_usdc: cash(
          pending.reduce((n, e) => n.plus(e.reserve_usdc), D(0)),
        ),
        allocated_usdc: cash(
          p.sleeves
            .filter((s) => s.state !== "closed")
            .reduce((n, s) => n.plus(s.amount_usdc), D(0)),
        ),
        net_profit_usdc: stats.net_usdc,
        external_flows_usdc: stats.external_flows_usdc,
        reconciliation: p.reconciliation,
        sleeves: p.sleeves.map((s) => ({
          copy_id: s.copy_id,
          trader: s.trader,
          amount_usdc: s.amount_usdc,
          leverage_cap: s.leverage_cap,
          leverage_cap_source: s.leverage_cap_source,
          leverage_cap_inherited_from_plan_id:
            s.leverage_cap_inherited_from_plan_id,
          ...(s.leverage_mode ? { leverage_mode: s.leverage_mode } : {}),
          stop_loss_pct: s.stop_loss_pct,
          loss_policy: s.loss_policy,
          emergency_exit_pct: s.emergency_exit_pct,
          state: s.state,
          net_profit_usdc:
            stats.sleeves.find((x) => x.copy_id === s.copy_id)?.net_usdc ??
            null,
        })),
        positions,
        executions: p.executions.map(({ allocations, fingerprint, ...e }) => e),
        as_of: snap?.observed_at ?? null,
        loss_trigger_amount_usdc: cash(
          D(p.preferences.budget_usdc)
            .times(p.preferences.loss_trigger_pct)
            .div(100),
        ),
      },
    },
    stale
      ? "stale"
      : p.executions.some((e) => e.status === "uncertain")
        ? "uncertain"
        : pending.some((e) => e.status === "partially_filled")
          ? "partially_filled"
          : pending.length
            ? "executing"
            : "ok",
  );
}
export function review(p: Portfolio): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const s of p.sleeves) {
    if (s.last_source_at == null || !fresh(s.last_source_at, 60_000))
      out.push({ kind: "source_stale", copy_id: s.copy_id });
    const inactive =
      s.trader.last_trade_at == null ? null : now() - s.trader.last_trade_at;
    const normal = Math.max(
      7 * 86400_000,
      (s.trader.median_hold_hours ?? 168) * 3600_000 * 2,
    );
    if (inactive != null && inactive > normal)
      out.push({
        kind: "inactivity",
        copy_id: s.copy_id,
        inactive_days: Math.floor(inactive / 86400_000),
        normal_hold_hours: s.trader.median_hold_hours,
      });
    if (s.trader.expires_at <= now())
      out.push({ kind: "score_stale", copy_id: s.copy_id });
  }
  if (p.reconciliation !== "complete")
    out.push({ kind: "accounting_incomplete" });
  if (p.loss_latched)
    out.push({
      kind: "loss_triggered",
      remaining_positions: aggregate(p, p.snapshot?.prices ?? {}, "actual"),
    });
  return out;
}
export function event(
  s: State,
  kind: string,
  portfolioId: string | null,
  message: string,
  data: Record<string, unknown> = {},
): void {
  s.updates.push({
    id: uid("update"),
    at: now(),
    kind,
    portfolio_id: portfolioId,
    message,
    data,
    notification: "pending",
  });
}

function publicArguments(args: Record<string, unknown>) {
  const { replacement_copy_id, replacement_at, ...publicArgs } = args;
  return publicArgs;
}
