import { AgentError } from "./contracts.js";
import {
  D,
  cash,
  uid,
  now,
  fresh,
  fingerprint,
  risk,
  aggregate,
  pnl,
  type Portfolio,
  type Execution,
  type Sleeve,
  assetAllowed,
} from "./domain.js";
import {
  applyFill,
  applyFunding,
  internalCross,
  reconcileQuantities,
} from "./ledger.js";
import { event, AgentService } from "./service.js";
import type { State } from "./repository.js";
import { checkPerpsOrder } from "./order_rules.js";
import { describeRiskBlocker } from "./risk-status.js";
import { observeSources, sourceEvidenceReady } from "./source-observations.js";
import { orderedSourceFills } from "./source-fill-evidence.js";
import {
  recordPerformance,
  recordReceipt,
  recordDecision,
  localDay,
  performanceView,
} from "./analytics.js";

export class AgentRunner {
  private sourceTimes = new Map<string, number>();
  private venueRetryAt = new Map<string, number>();
  constructor(private service: AgentService) {}
  async tick(user: string): Promise<void> {
    const { repository, adapter } = this.service;
    // Planning is committed before any submission. A process crash cannot
    // erase a possibly submitted execution identifier or its frozen payload.
    const nextVenueRetryAt = await repository.transact(user, async (state) => {
      for (const p of state.portfolios.filter((p) => p.state !== "closed")) {
        // A rejected read already tells us when capacity can return. Starting
        // another full account pipeline every five seconds consumes scarce
        // weight on partial observations before it can possibly finish.
        // This uses persisted error data, so a runner restart cannot bypass
        // the delay. Durable submission reconciliation below still runs.
        if (venueReadRetryPending(p)) continue;
        const sources = observeSources(
          adapter,
          p.sleeves.filter((s) => s.state !== "closed").map((s) => s.trader),
          (id, observation) => {
            // Late public reads may update this bounded cache, never a state
            // transaction that already committed or any execution cursor.
            try {
              if (observation.ok && sourceEvidenceReady(observation.value)) {
                if (this.sourceTimes.size >= 2000)
                  this.sourceTimes.delete(
                    this.sourceTimes.keys().next().value!,
                  );
                this.sourceTimes.set(id, observation.value.observed_at);
              }
            } catch {
              /* Malformed evidence cannot refresh a timestamp. */
            }
          },
        );
        try {
          if (!p.account_id) {
            const snap = await adapter.bind(user, p);
            if (
              !snap.dedicated ||
              !snap.eligible ||
              !fresh(snap.observed_at) ||
              Object.values(snap.positions).some((q) => !D(q).isZero()) ||
              snap.orders.length
            )
              throw new AgentError(
                "OWNERSHIP_CONFLICT",
                "Dedicated account must be empty before initial ownership is established.",
              );
            p.account_id = snap.account_id;
            p.venue_accounts = snap.venue_accounts;
            p.ledger_chain_block =
              snap.chain_block == null ? undefined : snap.chain_block + 1;
            p.initial_equity = snap.account_value_usdc;
            p.ledger_started_at = snap.observed_at;
            p.snapshot = snap;
            p.state = "active";
            p.reconciliation = "complete";
            p.audit_started_at = snap.observed_at;
            recordPerformance(state, p);
            event(
              state,
              "portfolio_active",
              p.id,
              "Configuration activated; entries are evaluated separately.",
            );
          }
          const snap = await adapter.account(user, p);
          if (!fresh(snap.observed_at) || !snap.eligible || !snap.dedicated)
            throw new AgentError(
              "ACCOUNT_STALE",
              "Fresh eligible owned account evidence is required.",
              true,
            );
          p.snapshot = snap;
          p.last_error = undefined;
          p.audit_started_at ??= snap.observed_at;
          if (p.state === "attention")
            p.state = p.loss_latched ? "loss_triggered" : "active";
          for (const e of p.executions.filter(
            (e) =>
              e.task_id &&
              !["completed", "failed", "superseded"].includes(e.status),
          )) {
            const observed = await adapter.execution(user, p, e);
            e.status = observed.status;
            e.observed_quantity = observed.observed_quantity;
            if (e.status === "completed" && !observed.settled)
              e.status = "settling";
          }
          for (const fill of [...snap.fills]
            .filter(
              (f) =>
                f.key.startsWith("prediction:") ||
                f.at >= (p.ledger_started_at ?? Infinity),
            )
            .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
            if (!p.seen_fills.includes(fill.id)) {
              const before = structuredClone(p.sleeves);
              applyFill(p, fill);
              recordReceipt(p, fill, before);
              checkpoint(state, p, fill.key, fill.at);
            }
          }
          for (const f of snap.funding
            .filter((f) => f.at >= (p.ledger_started_at ?? Infinity))
            .sort((a, b) => a.at - b.at)) {
            if (p.seen_funding.includes(f.id)) continue;
            const history = [...state.checkpoints]
              .reverse()
              .filter((c) => c.key === `${p.id}:${f.key}` && c.at <= f.at)
              .sort((a, b) => b.at - a.at)[0];
            const before = p.sleeves.map((s) => ({
              copy_id: s.copy_id,
              funding: s.lots[f.key]?.funding ?? "0",
            }));
            applyFunding(p, f, history?.quantities ?? {});
            for (const old of before) {
              const sleeve = p.sleeves.find((s) => s.copy_id === old.copy_id)!;
              const delta = D(sleeve.lots[f.key]?.funding ?? 0).minus(
                old.funding,
              );
              if (!delta.isZero())
                (p.funding_receipts ??= []).push({
                  copy_id: old.copy_id,
                  id: f.id,
                  key: f.key,
                  at: f.at,
                  amount_usdc: delta.toString(),
                });
            }
          }
          for (const flow of snap.flows.filter(
            (f) =>
              f.id.startsWith("poly_flow_") ||
              f.at >= (p.ledger_started_at ?? Infinity),
          )) {
            if (p.seen_flows.includes(flow.id)) continue;
            p.flow_total = D(p.flow_total).plus(flow.amount_usdc).toString();
            p.seen_flows.push(flow.id);
          }
          p.reconciliation = reconcileQuantities(p) ? "complete" : "incomplete";
          if (p.reconciliation === "complete")
            p.audit_verified_at = snap.observed_at;
          for (const e of p.executions.filter(
            (e) => e.status === "completed",
          )) {
            if (p.reconciliation === "complete") {
              e.unfilled_allocations ??= structuredClone(e.allocations);
              e.allocations = {};
            }
          }
          const profit = pnl(p);
          recordPerformance(state, p);
          if (
            profit.net_usdc != null &&
            D(profit.net_usdc).lte(
              D(p.preferences.budget_usdc)
                .times(p.preferences.loss_trigger_pct)
                .div(100)
                .neg(),
            ) &&
            !p.loss_latched
          ) {
            p.loss_latched = true;
            p.state = "loss_triggered";
            p.revision++;
            p.control_id = uid("control");
            for (const s of p.sleeves) {
              s.state = "loss_triggered";
              for (const x of Object.values(s.intents)) x.quantity = "0";
            }
            for (const e of p.executions)
              if (e.status === "queued") e.status = "superseded";
            event(
              state,
              "loss_triggered",
              p.id,
              "Loss threshold reached. Risk increases blocked; owned exits remain under reconciliation.",
            );
          }
          if (p.loss_latched) {
            await adapter.fence(user, p);
            await adapter.cancelIncreasing(user, p);
          }
          const plannedChanges = new Map<string, Sleeve>();
          for (const s of p.sleeves) {
            if (s.state === "closed") continue;
            if (["closing", "loss_triggered"].includes(s.state)) {
              for (const x of Object.values(s.intents)) x.quantity = "0";
              if (s.state === "loss_triggered" && !p.loss_latched)
                await adapter.fence(user, p);
              continue;
            }
            const currentProfit = profit.sleeves.find(
              (x) => x.copy_id === s.copy_id,
            )?.net_usdc;
            if (
              currentProfit != null &&
              D(currentProfit).lte(
                D(s.amount_usdc).times(s.stop_loss_pct).div(100).neg(),
              )
            ) {
              const emergency =
                s.loss_policy !== "pause_then_exit" ||
                D(currentProfit).lte(
                  D(s.amount_usdc)
                    .times(s.emergency_exit_pct ?? 70)
                    .div(100)
                    .neg(),
                );
              if (emergency || s.state !== "risk_off") {
                s.state = emergency ? "loss_triggered" : "risk_off";
                if (emergency)
                  for (const x of Object.values(s.intents)) x.quantity = "0";
                p.revision++;
                p.control_id = uid("control");
                for (const execution of p.executions)
                  if (execution.status === "queued")
                    execution.status = "superseded";
                await adapter.fence(user, p);
                await adapter.cancelIncreasing(user, p);
                event(
                  state,
                  emergency ? "sleeve_loss_triggered" : "sleeve_risk_off",
                  p.id,
                  emergency
                    ? "Emergency threshold reached; owned exits are pending reconciliation."
                    : "Trader pause threshold reached; new exposure is blocked while reductions and closes continue.",
                  { copy_id: s.copy_id },
                );
              }
              if (emergency) continue;
            }
            if (now() - (s.reviewed_at ?? 0) >= 86400_000) {
              const updated = await adapter.profile(s.trader.id);
              if (updated.scored_at >= s.trader.scored_at) {
                const inactive =
                  updated.last_trade_at == null
                    ? null
                    : now() - updated.last_trade_at;
                const normal = Math.max(
                  7 * 86400_000,
                  (updated.median_hold_hours ?? 168) * 3600_000 * 2,
                );
                if (
                  updated.eligibility !== "PASS" ||
                  updated.score < s.trader.score - 10 ||
                  updated.style !== s.trader.style ||
                  (inactive != null && inactive > normal)
                )
                  eventOnce(
                    state,
                    "daily_review",
                    p.id,
                    "Trader score, style or trading activity needs review.",
                    {
                      copy_id: s.copy_id,
                      previous_score: s.trader.score,
                      current_score: updated.score,
                      previous_style: s.trader.style,
                      current_style: updated.style,
                      inactive_days:
                        inactive != null && inactive > normal
                          ? Math.floor(inactive / 86400_000)
                          : null,
                    },
                  );
                s.trader = updated;
                s.reviewed_at = now();
              }
            }
            if (p.reconciliation !== "complete" && s.initialized) continue;
            let observation = await sources.get(s.trader.id);
            if (!observation.ok) throw observation.error;
            // Collection overlaps the complete account read. Its first result
            // may have expired while that read was queued or in flight.
            if (!fresh(observation.value.observed_at, 5000)) {
              const value = await adapter.source(s.trader);
              observation = { ok: true, value };
            }
            const source = observation.value;
            if (
              !sourceEvidenceReady(source) ||
              !fresh(source.observed_at, 5000) ||
              source.positions.some(
                (position) => !fresh(position.observed_at, 5000),
              )
            )
              throw new AgentError(
                "SOURCE_STALE",
                "Source coverage or equity is incomplete.",
                true,
              );
            if (!fresh(snap.observed_at))
              throw new AgentError(
                "ACCOUNT_STALE",
                "Account evidence expired while refreshing the source observation.",
                true,
              );
            s.last_source_at = source.observed_at;
            const leverageRules =
              s.leverage_mode == null
                ? undefined
                : fingerprint(
                    source.positions.map((x) => [
                      x.key,
                      snap.max_leverages[x.key] ?? null,
                    ]),
                  );
            if (
              source.revision === s.source_revision &&
              s.copy_mode !== "fixed" &&
              (leverageRules == null ||
                leverageRules === s.leverage_rules_revision)
            )
              continue;
            const trial = structuredClone(p),
              t = trial.sleeves.find((x) => x.copy_id === s.copy_id)!;
            let fixedWindowVerified = false;
            if (
              t.copy_mode === "fixed" &&
              t.fixed_last_fill_at != null &&
              (source.observed_at < t.fixed_last_fill_at ||
                (source.observed_at === t.fixed_last_fill_at &&
                  source.revision !== t.source_revision))
            )
              throw new AgentError(
                "SOURCE_FILL_EVIDENCE_MISSING",
                "Fixed-copy source evidence is not newer than its verified fill cursor.",
                true,
              );
            if (
              t.copy_mode === "fixed" &&
              t.fixed_last_fill_at != null &&
              source.observed_at > t.fixed_last_fill_at
            ) {
              if (!adapter.sourceFills)
                throw new AgentError(
                  "SOURCE_FILL_EVIDENCE_MISSING",
                  "Fixed copying requires verified source fill history.",
                  true,
                );
              const fills = await adapter.sourceFills(
                t.trader,
                t.fixed_last_fill_at,
                source.observed_at,
              );
              if (!fills.complete)
                throw new AgentError(
                  "SOURCE_FILL_EVIDENCE_MISSING",
                  "Source fills are incomplete; fixed-copy targets remain unchanged.",
                  true,
                );
              fixedWindowVerified = true;
              for (const fill of orderedSourceFills(
                fills.fills,
                source,
                t.fixed_last_fill_at,
                source.observed_at,
                t.source_quantities ?? {},
                t.fixed_seen_fills ?? [],
              )) {
                const previousSource = D(fill.start_quantity!),
                  currentSource = previousSource.plus(fill.quantity),
                  previousTarget = D(t.fixed_targets?.[fill.key] ?? 0);
                const position = source.positions.find(
                  (x) => x.key === fill.key,
                );
                const leverage = Math.min(
                  t.leverage_cap ?? Number.POSITIVE_INFINITY,
                  position?.source_leverage ??
                    t.intents[fill.key]?.source_leverage ??
                    1,
                  snap.max_leverages[fill.key] ?? 1,
                );
                const unit = D(t.fixed_margin_usdc ?? 0)
                  .times(leverage)
                  .div(fill.price);
                let target = previousTarget;
                if (currentSource.isZero()) target = D(0);
                else if (
                  previousSource.isZero() ||
                  previousSource.isPositive() !== currentSource.isPositive()
                )
                  target = unit.times(currentSource.isPositive() ? 1 : -1);
                else if (currentSource.abs().lt(previousSource.abs()))
                  target = previousTarget.times(
                    currentSource.abs().div(previousSource.abs()),
                  );
                else
                  target = previousTarget.plus(
                    unit.times(currentSource.isPositive() ? 1 : -1),
                  );
                (t.fixed_targets ??= {})[fill.key] = target.toString();
                (t.source_quantities ??= {})[fill.key] =
                  currentSource.toString();
                (t.fixed_seen_fills ??= []).push(fill.id);
              }
            }
            if (t.copy_mode === "fixed") {
              // A complete snapshot may omit a closed position. Before
              // clearing its target, verified fills must explain that closure.
              // Check the full source set, before the user's asset filters.
              const sourceKeys = new Set(source.positions.map((x) => x.key));
              const trackedKeys = new Set([
                ...Object.keys(t.source_quantities ?? {}),
                ...Object.keys(t.fixed_targets ?? {}),
                ...Object.keys(t.intents),
              ]);
              for (const key of trackedKeys) {
                if (sourceKeys.has(key)) continue;
                if (
                  fixedWindowVerified &&
                  unadmittedSuppressedShadow(p, s, key)
                ) {
                  // Initial entry-deviation checks may leave a theoretical
                  // fixed target which never became an admitted intent. A
                  // verified flat source can retire that shadow; it is not an
                  // owned follower close and must not fabricate a receipt.
                  (t.source_quantities ??= {})[key] = "0";
                  (t.fixed_targets ??= {})[key] = "0";
                  continue;
                }
                const quantity = t.source_quantities?.[key];
                if (
                  (quantity != null && !D(quantity).isZero()) ||
                  (quantity == null &&
                    [t.fixed_targets?.[key], t.intents[key]?.quantity].some(
                      (value) => value != null && !D(value).isZero(),
                    ))
                )
                  throw new AgentError(
                    "SOURCE_FILL_EVIDENCE_MISSING",
                    "A disappeared fixed-copy source position lacks verified closing fills.",
                    true,
                  );
              }
            }
            const permitted = source.positions.filter(
              (x) =>
                x.market === "prediction" ||
                assetAllowed(
                  p.preferences,
                  x.asset,
                  s.trader.asset_categories?.[x.asset] ??
                    (p.asset_filter_version === 2
                      ? s.trader.asset_category
                      : undefined),
                  p.asset_filter_version ?? 1,
                ),
            );
            const activeKeys = new Set(
              permitted
                .filter((x) => !D(x.quantity).isZero())
                .map((x) => x.key),
            );
            t.suppressed = t.suppressed.filter((key) => activeKeys.has(key));
            for (const old of Object.values(t.intents))
              if (!activeKeys.has(old.key)) {
                old.quantity = "0";
                if (t.source_quantities) t.source_quantities[old.key] = "0";
                if (t.fixed_targets) t.fixed_targets[old.key] = "0";
              }
            const raw = permitted.map((x) => {
              const px = snap.prices[x.key];
              if (!px || !fresh(x.observed_at))
                throw new AgentError(
                  "STALE_PRICE",
                  "Current source and follower prices are required.",
                  true,
                );
              const newPolicy = t.leverage_mode != null && x.market === "perps";
              const zeroSource = D(x.quantity).isZero();
              if (
                newPolicy &&
                !zeroSource &&
                (x.source_leverage_verified === false ||
                  !Number.isInteger(x.source_leverage) ||
                  x.source_leverage < 1)
              )
                throw new AgentError(
                  "SOURCE_LEVERAGE_UNAVAILABLE",
                  "Verified source leverage is required before following a Perps position.",
                  true,
                );
              if (
                newPolicy &&
                !zeroSource &&
                (!Number.isFinite(snap.max_leverages[x.key]) ||
                  snap.max_leverages[x.key] < 1)
              )
                throw new AgentError(
                  "VENUE_RULES_UNAVAILABLE",
                  "A fresh per-asset venue leverage limit is required.",
                  true,
                );
              const sourceLeverage =
                newPolicy && zeroSource ? 1 : x.source_leverage;
              const leverage = Math.min(
                t.leverage_cap ?? Number.POSITIVE_INFINITY,
                sourceLeverage,
                snap.max_leverages[x.key] ?? 1,
              );
              let quantity = D(x.quantity)
                .times(D(t.amount_usdc).div(source.account_value_usdc))
                .times(D(leverage).div(Math.max(1, sourceLeverage)))
                .times(t.proportional_multiplier ?? 1);
              if (t.copy_mode === "fixed") {
                const previousSource = D(t.source_quantities?.[x.key] ?? 0),
                  previousTarget = D(t.fixed_targets?.[x.key] ?? 0),
                  currentSource = D(x.quantity);
                const unit = D(t.fixed_margin_usdc ?? 0)
                  .times(leverage)
                  .div(px);
                if (
                  t.fixed_last_fill_at != null &&
                  !currentSource.eq(previousSource)
                )
                  throw new AgentError(
                    "SOURCE_FILL_EVIDENCE_MISSING",
                    "Source position changes are not fully explained by verified fills.",
                    true,
                  );
                if (currentSource.isZero()) quantity = D(0);
                else if (
                  previousSource.isZero() ||
                  previousSource.isPositive() !== currentSource.isPositive()
                )
                  quantity = unit.times(currentSource.isPositive() ? 1 : -1);
                else {
                  if (!currentSource.eq(previousSource))
                    throw new AgentError(
                      "SOURCE_FILL_EVIDENCE_MISSING",
                      "Source position changes are not fully explained by verified fills.",
                      true,
                    );
                  quantity = previousTarget;
                }
                (t.source_quantities ??= {})[x.key] = x.quantity;
                (t.fixed_targets ??= {})[x.key] = quantity.toString();
              }
              return {
                ...x,
                quantity: quantity.toString(),
                raw_source_quantity: x.quantity,
                source_leverage: leverage,
                price: px,
              };
            });
            const margin = raw.reduce(
                (n, x) =>
                  n.plus(
                    D(x.quantity).abs().times(x.price).div(x.source_leverage),
                  ),
                D(0),
              ),
              scale = margin.gt(t.amount_usdc)
                ? D(t.amount_usdc).div(margin)
                : D(1);
            for (const x of raw) {
              if (t.suppressed.includes(x.key)) continue;
              if (
                !t.initialized &&
                !D(x.quantity).isZero() &&
                (x.source_entry_price == null ||
                  D(x.price)
                    .minus(x.source_entry_price)
                    .abs()
                    .div(x.source_entry_price)
                    .gt("0.002"))
              ) {
                t.suppressed.push(x.key);
                recordDecision(
                  p,
                  t,
                  x,
                  x.price,
                  null,
                  "ENTRY_DEVIATION_OR_MISSING_SOURCE_PRICE",
                );
                continue;
              }
              let q = D(x.quantity)
                .times(scale)
                .toDecimalPlaces(snap.quantity_decimals?.[x.key] ?? 8);
              const current = D(t.lots[x.key]?.quantity ?? 0);
              if (
                p.preferences.portfolio_kind &&
                x.market === "perps" &&
                !D(x.quantity).isZero() &&
                q.isZero() &&
                current.isZero()
              ) {
                t.intents[x.key] = { ...x, quantity: "0" };
                recordDecision(
                  p,
                  t,
                  x,
                  x.price,
                  null,
                  "BELOW_MINIMUM_QUANTITY",
                );
                continue;
              }
              if (["wind_down", "risk_off"].includes(t.state)) {
                if (current.isZero() || current.isPositive() !== q.isPositive())
                  q = D(0);
                else {
                  const previous = s.intents[x.key]?.quantity;
                  const ceiling =
                    previous == null
                      ? current.abs()
                      : D.min(current.abs(), D(previous).abs());
                  q = D.min(q.abs(), ceiling).times(q.isPositive() ? 1 : -1);
                }
              }
              if (
                !(p.preferences.portfolio_kind && x.market === "perps") &&
                !q.isZero() &&
                q
                  .abs()
                  .times(x.price)
                  .lt(snap.min_notionals[x.key] ?? t.trader.min_notional_usdc)
              ) {
                if (current.isZero()) {
                  recordDecision(
                    p,
                    t,
                    x,
                    x.price,
                    null,
                    "BELOW_MINIMUM_NOTIONAL",
                  );
                  continue;
                }
                q = D(0);
              }
              t.intents[x.key] = { ...x, quantity: q.toString() };
              recordDecision(
                p,
                t,
                x,
                x.price,
                q.toString(),
                "TARGET_EVALUATED",
              );
            }
            t.initialized = true;
            if (t.copy_mode === "fixed")
              t.fixed_last_fill_at = source.observed_at;
            t.source_revision = source.revision;
            if (leverageRules != null)
              t.leverage_rules_revision = leverageRules;
            const sleeveProfit = profit.sleeves.find(
              (x) => x.copy_id === s.copy_id,
            )?.net_usdc;
            if (
              t.loss_policy !== "pause_then_exit" &&
              sleeveProfit != null &&
              D(sleeveProfit).lte(
                D(t.amount_usdc).times(t.stop_loss_pct).div(100).neg(),
              )
            ) {
              t.state = "loss_triggered";
              for (const x of Object.values(t.intents)) x.quantity = "0";
              event(
                state,
                "sleeve_loss_triggered",
                p.id,
                "Sleeve loss threshold reached; exit is pending verification.",
                { copy_id: t.copy_id },
              );
            }
            plannedChanges.set(s.copy_id, t);
          }
          if (plannedChanges.size) {
            const basket = structuredClone(p);
            for (const sleeve of basket.sleeves) {
              const change = plannedChanges.get(sleeve.copy_id);
              if (change) Object.assign(sleeve, change);
            }
            try {
              risk(basket, snap.prices, true);
              p.sleeves = basket.sleeves;
              p.target_blocker = undefined;
            } catch (error) {
              if (error instanceof AgentError) {
                p.target_blocker = describeRiskBlocker(
                  error,
                  basket,
                  snap.prices,
                );
                eventOnce(state, error.code, p.id, error.message);
              } else throw error;
            }
          } else {
            // No proposed source update remains blocked in this planning pass.
            p.target_blocker = undefined;
          }
          const targets = risk(p, snap.prices, true);
          const keys = new Set([
            ...targets.map((x) => x.key),
            ...p.sleeves.flatMap((s) => Object.keys(s.lots)),
          ]);
          for (const key of keys) {
            if (
              p.executions.some(
                (e) =>
                  e.key === key &&
                  !["completed", "failed", "superseded"].includes(e.status),
              )
            )
              continue;
            const target = targets.find((x) => x.key === key),
              observed = snap.positions[key] ?? "0",
              price = snap.prices[key];
            let q = target?.quantity ?? "0";
            if (!price) continue;
            let allocations = internalCross(p, key, price);
            checkpoint(state, p, key, now());
            if (D(q).eq(observed)) continue;
            if (p.preferences.portfolio_kind && key.startsWith("perps:")) {
              const check = checkPerpsOrder(snap, key, q);
              if (!check.ok) {
                const { ok: _, ...details } = check;
                if (
                  !state.updates.some(
                    (u) =>
                      u.kind === check.code &&
                      u.portfolio_id === p.id &&
                      u.data.key === key &&
                      now() - u.at < 3600_000,
                  )
                ) {
                  event(state, check.code, p.id, check.message, {
                    key,
                    target_quantity: q,
                    ...details,
                  });
                  // Routine skipped orders are visible in history, not push alerts.
                  state.updates.at(-1)!.notification = "cancelled";
                }
                for (const sleeve of p.sleeves) {
                  const intent = sleeve.intents[key];
                  if (intent)
                    recordDecision(p, sleeve, intent, price, null, check.code);
                }
                if (
                  check.code === "BELOW_MINIMUM_NOTIONAL" &&
                  !D(observed).isZero() &&
                  !D(q).isZero() &&
                  D(observed).isPositive() !== D(q).isPositive()
                ) {
                  // A flip is a close followed by a new opening leg. Preserve
                  // the valid close when the new direction is below minimum.
                  q = "0";
                  for (const sleeve of p.sleeves)
                    if (sleeve.intents[key]) sleeve.intents[key].quantity = "0";
                  allocations = internalCross(p, key, price);
                  checkpoint(state, p, key, now());
                } else continue;
              }
            } else if (
              !D(q).isZero() &&
              D(q)
                .minus(observed)
                .abs()
                .times(price)
                .lt(snap.min_notionals[key] ?? "0")
            )
              continue;
            if (
              p.reconciliation !== "complete" &&
              D(q).abs().gt(D(observed).abs())
            )
              continue;
            const delta = D(q).minus(observed),
              reserve = delta
                .abs()
                .times(price)
                .div(
                  Math.max(
                    1,
                    Math.min(
                      p.sleeves.some((s) => s.leverage_mode != null)
                        ? Number.POSITIVE_INFINITY
                        : 8,
                      ...(p.sleeves.some((s) => s.leverage_mode != null) &&
                      key.startsWith("perps:")
                        ? [snap.max_leverages[key] ?? 1]
                        : []),
                      ...p.sleeves
                        .filter((s) => s.intents[key])
                        .map((s) =>
                          Math.min(
                            s.leverage_cap ?? Number.POSITIVE_INFINITY,
                            s.intents[key].source_leverage,
                          ),
                        ),
                    ),
                  ),
                )
                .times("1.003");
            const outstanding = p.executions
              .filter(
                (e) =>
                  !["completed", "failed", "superseded"].includes(e.status) &&
                  e.key.split(":")[0] === key.split(":")[0],
              )
              .reduce((n, e) => n.plus(e.reserve_usdc), D(0));
            const reduction =
              D(q).abs().lte(D(observed).abs()) &&
              (D(q).isZero() || D(q).isPositive() === D(observed).isPositive());
            if (
              !reduction &&
              outstanding
                .plus(reserve)
                .gt(
                  snap.available_by_market?.[
                    key.startsWith("prediction:") ? "prediction" : "perps"
                  ] ?? snap.available_usdc,
                )
            ) {
              eventOnce(
                state,
                "FUNDS_RESERVED",
                p.id,
                "Target waits for verified available funds.",
              );
              continue;
            }
            const id = uid("execution");
            const frozen = {
              id,
              key,
              target_quantity: q,
              allocations,
              revision: p.revision,
              created_at: now(),
              expires_at: now() + 60_000,
            };
            p.executions.push({
              ...frozen,
              fingerprint: fingerprint(frozen),
              status: "queued",
              task_id: null,
              observed_quantity: null,
              reserve_usdc: reduction ? "0.000000" : cash(reserve),
              error: null,
            });
          }
          for (const s of p.sleeves.filter((s) =>
            ["wind_down", "risk_off", "closing", "loss_triggered"].includes(
              s.state,
            ),
          )) {
            if (
              Object.values(s.lots).every((l) => D(l.quantity).isZero()) &&
              Object.values(s.intents).every((l) => D(l.quantity).isZero()) &&
              p.reconciliation === "complete" &&
              !p.executions.some(
                (e) =>
                  !["completed", "failed", "superseded"].includes(e.status),
              )
            )
              s.state = "closed";
          }
          if (
            p.sleeves.every((s) => s.state === "closed") &&
            p.reconciliation === "complete"
          ) {
            await adapter.release(user, p);
            p.state = "closed";
            eventOnce(
              state,
              "portfolio_closed",
              p.id,
              "All owned positions and pending executions have settled.",
            );
          }
          for (const proposal of state.proposals.filter(
            (q) => q.portfolio_id === p.id && q.status === "queued",
          )) {
            const tasks = p.executions.filter(
              (e) =>
                e.revision ===
                (proposal.committed_revision ?? proposal.expected_revision + 1),
            );
            if (
              p.sleeves.every((s) => s.initialized || s.state === "closed") &&
              tasks.every((e) =>
                ["completed", "superseded"].includes(e.status),
              ) &&
              p.reconciliation === "complete" &&
              targets.every((t) => D(t.quantity).eq(snap.positions[t.key] ?? 0))
            )
              proposal.status = "completed";
          }
        } catch (e) {
          const err =
            e instanceof AgentError
              ? e
              : new AgentError(
                  "MONITOR_UNAVAILABLE",
                  "Portfolio observation failed; increasing execution is suspended.",
                  true,
                );
          p.state = p.loss_latched ? "loss_triggered" : "attention";
          p.last_error = {
            at: now(),
            code: err.code,
            message: err.message,
            retryable: err.retryable,
            ...(err.details ? { details: err.details } : {}),
          };
          eventOnce(
            state,
            err.code,
            p.id,
            err.message,
            err.details ? { diagnostics: err.details } : {},
          );
        } finally {
          // Public collection must not keep a failed account transaction open
          // beyond the database idle timeout. SourceFeed keeps sampling.
          for (const sleeve of p.sleeves) {
            const at = this.sourceTimes.get(sleeve.trader.id);
            if (
              at != null &&
              fresh(at, 5000) &&
              at > (sleeve.last_source_at ?? 0)
            )
              sleeve.last_source_at = at;
          }
        }
        recordPerformance(state, p);
      }
      return Math.min(
        Infinity,
        ...state.portfolios
          .filter((p) => p.state !== "closed")
          .map((p) => venueReadRetryAt(p) ?? Infinity),
      );
    });
    if (Number.isFinite(nextVenueRetryAt)) {
      if (this.venueRetryAt.size >= 2000)
        this.venueRetryAt.delete(this.venueRetryAt.keys().next().value!);
      this.venueRetryAt.set(user, nextVenueRetryAt);
    } else this.venueRetryAt.delete(user);
    await repository.transact(user, async (state) => {
      for (const p of state.portfolios)
        for (const e of p.executions.filter(
          (e) => ["queued", "uncertain"].includes(e.status) && !e.task_id,
        )) {
          if (
            e.status === "queued" &&
            (e.revision !== p.revision || p.state === "attention")
          ) {
            e.status = "superseded";
            continue;
          }
          if (e.status === "queued" && e.expires_at <= now()) {
            e.status = "failed";
            e.error = "Target expired before submission";
            continue;
          }
          try {
            if (e.status === "uncertain") {
              const observed = await adapter.execution(user, p, e);
              if (observed.status !== "failed") {
                e.status = observed.status;
                e.task_id = observed.task_id ?? e.task_id;
                e.observed_quantity = observed.observed_quantity;
                continue;
              }
              if (e.revision !== p.revision || p.state === "attention") {
                e.status = "superseded";
                continue;
              }
              if (e.expires_at <= now()) {
                e.status = "failed";
                e.error = "Target expired before submission";
                continue;
              }
            }
            // The bridge revalidates source revision, ownership, authority, price
            // deviation, live margin and Core policy immediately before signing.
            const submit = await adapter.submit(user, p, e);
            e.task_id = submit.task_id;
            e.status = "submitted";
            event(
              state,
              "execution_submitted",
              p.id,
              "Order submitted; fill and settlement are pending.",
              { execution_id: e.id },
            );
          } catch (error) {
            if (
              error instanceof AgentError &&
              error.code === "EXECUTION_REJECTED"
            ) {
              e.status = "failed";
              e.error = error.message;
            } else {
              e.status = "uncertain";
              e.error =
                "Submission result unknown; same execution identifier must be reconciled.";
            }
            eventOnce(
              state,
              e.status === "failed"
                ? "EXECUTION_REJECTED"
                : "EXECUTION_UNCERTAIN",
              p.id,
              e.error,
              { execution_id: e.id },
            );
          }
        }
      const prefs = state.notification_preferences;
      if (prefs?.daily_digest) {
        const local = localDay(now(), prefs.timezone),
          enabled = localDay(prefs.enabled_at, prefs.timezone);
        if (
          local.time >= prefs.local_time &&
          prefs.last_digest_day !== local.day &&
          (enabled.day < local.day || enabled.time < prefs.local_time)
        ) {
          const p = state.portfolios.at(-1);
          if (p) {
            const performance = performanceView(state, p, "daily");
            event(
              state,
              "daily_digest",
              p.id,
              `Ride daily report · ${local.day} · net profit ${performance.net_profit_usdc ?? "unavailable"} USDC · ${performance.coverage} coverage.`,
              { performance, timezone: prefs.timezone, digest_day: local.day },
            );
          }
          prefs.last_digest_day = local.day;
        }
      }
      for (const update of state.updates.filter(
        (e) =>
          e.notification === "pending" &&
          (e.next_notification_at ?? 0) <= now(),
      ))
        try {
          // Disabling an opted-in digest cancels queued digest delivery only.
          if (
            update.kind === "daily_digest" &&
            (!prefs?.daily_digest ||
              update.data.digest_day !== localDay(now(), prefs.timezone).day)
          ) {
            update.notification = "cancelled";
            continue;
          }
          await adapter.notify(user, update);
          update.notification = "delivered";
          update.notification_error = undefined;
          update.next_notification_at = undefined;
        } catch (error) {
          update.notification_attempts =
            (update.notification_attempts ?? 0) + 1;
          update.next_notification_at =
            now() +
            Math.min(
              3600_000,
              5000 * 2 ** Math.min(10, update.notification_attempts),
            );
          update.notification_error =
            error instanceof AgentError ? error.code : "PUSH_UNAVAILABLE";
          /* Durable retry on the next tick. */
        }
    });
  }
  async run(signal: AbortSignal, intervalMs = 5000): Promise<void> {
    const users = new Map<
        string,
        { due: number; running: boolean; present: boolean }
      >(),
      inFlight = new Set<Promise<void>>();
    let nextDiscovery = 0,
      wake = () => {};
    try {
      while (!signal.aborted) {
        if (now() >= nextDiscovery) {
          const discovered = new Set(await this.service.repository.users());
          nextDiscovery = now() + intervalMs;
          for (const [user, entry] of users) {
            entry.present = discovered.has(user);
            if (!entry.present && !entry.running) users.delete(user);
          }
          for (const user of discovered)
            if (!users.has(user))
              users.set(user, { due: now(), running: false, present: true });
        }
        while (!signal.aborted && inFlight.size < 2) {
          // Keep a slow user's transaction from delaying every other user.
          // Oldest due time wins; Map order breaks ties without overlapping
          // callbacks for the same user or bypassing tick's PostgreSQL lock.
          const ready = [...users].filter(
            ([, entry]) =>
              entry.present && !entry.running && entry.due <= now(),
          );
          ready.sort((a, b) => a[1].due - b[1].due);
          const next = ready[0];
          if (!next) break;
          const [user, entry] = next;
          entry.running = true;
          let task!: Promise<void>;
          task = Promise.resolve().then(async () => {
            try {
              if (signal.aborted) return;
              await this.tick(user);
            } catch {
              this.venueRetryAt.delete(user);
              if (!signal.aborted)
                console.error(
                  "Rider monitoring cycle failed; retained for retry.",
                );
            } finally {
              entry.running = false;
              const retry = this.venueRetryAt.get(user);
              entry.due =
                retry != null
                  ? Math.min(now() + intervalMs, Math.max(now(), retry))
                  : now() + intervalMs;
              if (!entry.present) users.delete(user);
              inFlight.delete(task);
              wake();
            }
          });
          inFlight.add(task);
        }
        if (signal.aborted) break;
        const nextDue = Math.min(
          nextDiscovery,
          ...[...users.values()]
            .filter(
              (entry) => inFlight.size < 2 && entry.present && !entry.running,
            )
            .map((entry) => entry.due),
        );
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = () => {};
            resolve();
          };
          const timer = setTimeout(done, Math.max(0, nextDue - now()));
          wake = done;
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally {
      // Shutdown stops admission immediately and preserves durable completion
      // of transactions and external-effect reconciliation already in flight.
      await Promise.all(inFlight);
    }
  }
}
function venueReadRetryPending(p: Portfolio): boolean {
  const retryAt = venueReadRetryAt(p);
  return retryAt != null && now() < retryAt;
}
function venueReadRetryAt(p: Portfolio): number | undefined {
  const error = p.last_error;
  if (
    !error?.retryable ||
    !["VENUE_READ_BUDGET_EXHAUSTED", "VENUE_RATE_LIMITED"].includes(error.code)
  )
    return;
  const delay = error.details?.retry_after_ms;
  if (
    Number.isSafeInteger(error.at) &&
    error.at <= now() &&
    typeof delay === "number" &&
    Number.isSafeInteger(delay) &&
    delay > 0 &&
    delay <= 60000
  )
    return error.at + delay;
}
function unadmittedSuppressedShadow(
  p: Portfolio,
  s: Sleeve,
  key: string,
): boolean {
  return (
    s.suppressed.includes(key) &&
    !Object.hasOwn(s.intents, key) &&
    !Object.hasOwn(s.lots, key) &&
    !p.executions.some(
      (e) =>
        e.key === key &&
        (Object.hasOwn(e.allocations, s.copy_id) ||
          Object.hasOwn(e.unfilled_allocations ?? {}, s.copy_id)),
    ) &&
    !(p.receipts ?? []).some(
      (r) => r.copy_id === s.copy_id && r.fill.key === key,
    ) &&
    !(p.decisions ?? []).some(
      (d) =>
        d.copy_id === s.copy_id && d.key === key && d.target_quantity != null,
    )
  );
}
function checkpoint(s: State, p: Portfolio, key: string, at: number): void {
  s.checkpoints.push({
    at,
    key: `${p.id}:${key}`,
    quantities: Object.fromEntries(
      p.sleeves.map((x) => [x.copy_id, x.lots[key]?.quantity ?? "0"]),
    ),
  });
}
function eventOnce(
  s: State,
  kind: string,
  pid: string,
  message: string,
  data: Record<string, unknown> = {},
): void {
  if (
    !s.updates.some(
      (e) =>
        e.kind === kind &&
        e.portfolio_id === pid &&
        fingerprint(e.data) === fingerprint(data) &&
        now() - e.at < 3600_000,
    )
  )
    event(s, kind, pid, message, data);
}
