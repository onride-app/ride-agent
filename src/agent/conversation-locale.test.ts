import assert from "node:assert/strict";
import { it } from "node:test";
import { fingerprint, type Plan } from "./domain.js";
import { candidate } from "./fixtures.js";
import {
  candidateDisplay,
  copyRule,
  copyabilityReason,
  historicalPeriodLabel,
  planChange,
  planDisplay,
} from "./conversation-presentation.js";
import { browse, conversationView, saveDiscovery } from "./discovery.js";
import { Cursor, emptyState } from "./repository.js";
import { localized, resolveLocale } from "./locale.js";

const han = /[\p{Script=Han}]/u;
const numbers = (text: string) => text.match(/-?\d+(?:\.\d+)?/g) ?? [];

function plan(count = 4): Plan {
  return {
    id: "plan_locale_original_0123",
    created_at: Date.now(),
    expires_at: Date.now() + 600_000,
    preferences: {
      budget_usdc: String(count * 7.5),
      market: "perps",
      assets: [],
      allow_altcoins: true,
      portfolio_kind: "basket",
      basket_size: count,
      copy_mode: "ride_recommends",
      risk_tolerance: "medium",
      loss_trigger_pct: 10,
    },
    preference_sources: { loss_trigger_pct: "user" },
    source_version: "strict_perp_v2_5_daily_live_v1",
    allocations: Array.from({ length: count }, (_, i) => ({
      copy_id: `copy_locale_${i}`,
      trader: candidate(i + 1),
      amount_usdc: "7.500000",
      leverage_cap: null,
      leverage_mode: "follow_source",
      copy_mode: "ride_recommends",
      stop_loss_pct: 30,
    })),
  };
}

function addRiskSelection(p: Plan) {
  p.risk_selection = {
    policy_version: "risk_fit_locale_test_v1",
    profile: "medium",
    status: "applied",
    scoring_version: p.source_version,
    priorities: ["profitQuality", "copyability"],
    candidate_count: 30,
    evidence_count: 30,
    unavailable_trader_ids: [],
    missing_metrics_by_trader: {},
    selected: p.allocations.map((a) => ({
      trader_id: a.trader.id,
      metrics: { profitQuality: 70, copyability: 80 },
      reasons: ["盈利质量模型分数 70.00", "可复制性模型分数 80.00"],
    })),
    explanation: "版本化产品排序规则",
  };
}

const actionFacts = (actions: ReturnType<typeof planDisplay>["next_actions"]) =>
  actions.map(({ label, arguments: args, ...action }) => {
    const { locale, ...facts } = args as typeof args & { locale?: string };
    return { ...action, arguments: facts };
  });

it("defaults to Chinese and keeps explicit locale helpers deterministic", () => {
  assert.equal(resolveLocale(), "zh");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(localized(undefined, "中文", "English"), "中文");
  assert.equal(localized("en", "中文", "English"), "English");
  const p = plan();
  assert.equal(
    planDisplay(p).markdown,
    planDisplay(p, "brief", undefined, { locale: "zh" }).markdown,
  );
  assert.deepEqual(
    copyRule(p.allocations[0]),
    copyRule(p.allocations[0], { locale: "zh" }),
  );
  assert.deepEqual(
    actionFacts(planDisplay(p).next_actions),
    actionFacts(
      planDisplay(p, "brief", undefined, { locale: "zh" }).next_actions,
    ),
  );
  assert(
    planDisplay(p).next_actions.every(
      (action) => !("locale" in action.arguments),
    ),
  );
});

it("keeps English plan and analysis text monolingual across selection, depth and calculation states", () => {
  const p = plan();
  addRiskSelection(p);
  const previous = structuredClone(p);
  previous.id = "plan_locale_previous_0123";
  previous.allocations[0].trader = candidate(9);
  for (const status of [
    "applied",
    "preserved_selection",
    "insufficient_evidence",
    "unsupported",
    "not_requested",
  ] as const) {
    p.risk_selection!.status = status;
    for (const detail of ["brief", "detailed"] as const) {
      for (const analysis_depth of ["summary", "extended"] as const) {
        for (const include_calculations of [false, true]) {
          const before = fingerprint(p);
          const view = planDisplay(p, detail, previous, {
            locale: "en",
            analysis_depth,
            include_calculations,
          });
          assert.doesNotMatch(JSON.stringify(view), han);
          assert.deepEqual(
            view.trader_ids,
            p.allocations.map((a) => a.trader.id),
          );
          assert(
            view.next_actions.every(
              (action) => (action.arguments as any).locale === "en",
            ),
          );
          assert.equal(fingerprint(p), before);
          assert.doesNotMatch(
            view.markdown,
            /guaranteed return|risk is reduced|actual leverage is lower/i,
          );
        }
      }
    }
  }
});

it("preserves trader order, amounts, numeric evidence and next-action semantics between languages", () => {
  const p = plan(8);
  addRiskSelection(p);
  const before = fingerprint(p);
  for (const detail of ["brief", "detailed"] as const) {
    for (const analysis_depth of ["summary", "extended"] as const) {
      const zh = planDisplay(p, detail, undefined, {
        locale: "zh",
        analysis_depth,
        include_calculations: true,
      });
      const en = planDisplay(p, detail, undefined, {
        locale: "en",
        analysis_depth,
        include_calculations: true,
      });
      assert.deepEqual(en.trader_ids, zh.trader_ids);
      assert.deepEqual(numbers(en.markdown), numbers(zh.markdown));
      assert.deepEqual(
        actionFacts(en.next_actions),
        actionFacts(zh.next_actions),
      );
      let at = -1;
      for (const a of p.allocations) {
        const next = en.markdown.indexOf(a.trader.handle);
        assert(next > at);
        at = next;
      }
    }
  }
  const next = structuredClone(p);
  next.id = "plan_locale_replaced_0123";
  next.allocations[2].trader = candidate(9);
  const { explanation: zhText, ...zhFacts } = planChange(p, next, {
    locale: "zh",
  });
  const { explanation: enText, ...enFacts } = planChange(p, next, {
    locale: "en",
  });
  assert.match(zhText, han);
  assert.doesNotMatch(enText, han);
  assert.deepEqual(enFacts, zhFacts);
  assert.equal(fingerprint(p), before);
});

it("uses only the supplied read-only source evidence and never treats a product cap as actual leverage", () => {
  const p = plan();
  const a = p.allocations[0];
  a.trader.venue_max_leverage = 40;
  const missing = copyRule(a, { locale: "en" });
  assert.equal(missing.source_equity_usdc, null);
  assert.equal(missing.next_order_size, null);
  assert.equal(missing.leverage_cap, null);
  assert.match(
    missing.leverage_cap_meaning!,
    /product permits settings up to 40x/,
  );
  assert.match(
    missing.leverage_cap_meaning!,
    /not actual source-trader leverage or a per-asset venue limit/,
  );
  const evidence = {
    [a.trader.id]: {
      source_equity_usdc: "1250.000000",
      next_order_size: {
        status: "blocked",
        observed_at: Date.now(),
        scope: "hypothetical_initial_target",
        positions: [
          {
            key: "perps:BTC",
            target_quantity: "0.0001",
            order_notional_usdc: "7.50",
            minimum_notional_usdc: "10.00",
            status: "below_minimum",
            reason_code: "MIN_NOTIONAL",
          },
        ],
      },
    },
    unrelated_trader: {
      source_equity_usdc: "999.000000",
      next_order_size: null,
    },
  };
  const before = structuredClone(evidence);
  const planBefore = fingerprint(p);
  for (const locale of ["en", "zh"] as const) {
    const rule = copyRule(a, { locale, copy_evidence: evidence });
    assert.equal(rule.source_equity_usdc, "1250.000000");
    assert.deepEqual(
      rule.next_order_size,
      evidence[a.trader.id].next_order_size,
    );
    assert.notEqual(
      rule.next_order_size,
      evidence[a.trader.id].next_order_size,
    );
    (rule.next_order_size as any).positions[0].target_quantity = "999";
    assert.deepEqual(evidence, before);
  }
  assert.equal(
    copyRule(p.allocations[1], { copy_evidence: evidence }).source_equity_usdc,
    null,
  );
  assert.equal(fingerprint(p), planBefore);
});

it("localizes fixed, proportional and prediction copy rules without changing settings", () => {
  const p = plan();
  const a = p.allocations[0];
  for (const copy_mode of [
    "fixed",
    "proportional",
    "ride_recommends",
  ] as const) {
    a.copy_mode = copy_mode;
    a.fixed_margin_usdc = "2.500000";
    a.proportional_multiplier = 1.5;
    a.leverage_cap = 3;
    for (const market of ["perps", "prediction"] as const) {
      a.trader.market = market;
      const before = fingerprint(p);
      const en = copyRule(a, { locale: "en", include_calculations: true });
      const zh = copyRule(a, { locale: "zh", include_calculations: true });
      assert.doesNotMatch(JSON.stringify(en), han);
      for (const key of [
        "mode",
        "allocated_usdc",
        "fixed_margin_usdc",
        "proportional_multiplier",
        "leverage_cap",
        "sizing_basis",
        "source_equity_usdc",
        "next_order_size",
      ] as const)
        assert.deepEqual(en[key], zh[key]);
      assert.deepEqual(numbers(en.summary), numbers(zh.summary));
      assert.equal(fingerprint(p), before);
    }
  }
});

it("localizes candidate availability and historical periods with the same values and unchanged plan", () => {
  const p = plan();
  const rows = p.allocations.map((a) => a.trader);
  rows[0].metric_periods = {
    roi: {
      period: "source_30d",
      start_at: 1_700_000_000_000,
      end_at: 1_702_592_000_000,
      basis: "source report",
    },
    drawdown: {
      period: "unknown",
      start_at: null,
      end_at: null,
      basis: "source report",
    },
  };
  rows[1].source_roi_pct = null;
  rows[1].source_drawdown_pct = Number.NaN;
  const before = fingerprint(p);
  for (const availability of [
    "available",
    "source_empty",
    "no_matching_candidates",
    "end_of_results",
  ] as const) {
    for (const detail of ["brief", "detailed"] as const) {
      const list = availability === "available" ? rows : [];
      const en = candidateDisplay(list, p, detail, availability, {
        locale: "en",
        historical_metrics: ["roi", "drawdown"],
      });
      const zh = candidateDisplay(list, p, detail, availability, {
        locale: "zh",
        historical_metrics: ["roi", "drawdown"],
      });
      assert.doesNotMatch(JSON.stringify(en), han);
      assert.deepEqual(numbers(en.markdown), numbers(zh.markdown));
      assert.equal(en.base_plan_id, p.id);
      assert.equal(en.availability, zh.availability);
      assert.deepEqual(en.historical_metrics, zh.historical_metrics);
      assert.doesNotMatch(en.markdown, /NaN|Infinity/);
    }
  }
  assert.equal(
    historicalPeriodLabel(rows[0], "roi", "en"),
    "2023-11-15 to 2023-12-15 (Shanghai)",
  );
  assert.equal(
    historicalPeriodLabel(rows[0], "drawdown", "en"),
    "Period unverified; not a same-period comparison",
  );
  assert.equal(fingerprint(p), before);
});

it("keeps the ordinary preview to one table and concise rules without claiming a measured copy success rate", () => {
  const p = plan();
  for (const locale of ["en", "zh"] as const) {
    const view = planDisplay(p, "brief", undefined, { locale });
    assert.equal((view.markdown.match(/\| Trader \|/g) ?? []).length, 1);
    assert.equal(view.analysis, null);
    assert(view.markdown.length < (locale === "en" ? 1800 : 1300));
    assert.doesNotMatch(
      view.markdown,
      /目标数量|Target quantity|Calculation method|接口|interface|token|bridge|成功率|copy success rate/,
    );
    assert.equal(view.next_actions.length, 2);
  }
});

it("keeps actual precheck blockers visible in one concise sentence in either language", () => {
  const p = plan();
  const evidence = {
    [p.allocations[0].trader.id]: {
      source_equity_usdc: "1000.000000",
      next_order_size: {
        status: "blocked",
        reason_code: "ASSET_CONCENTRATION",
        scope: "hypothetical_initial_target",
        observed_at: Date.now(),
        positions: [
          { status: "skipped", reason_code: "BELOW_MINIMUM_NOTIONAL" },
        ],
      },
    },
  };
  const before = fingerprint(p);
  const en = planDisplay(p, "brief", undefined, {
    locale: "en",
    copy_evidence: evidence,
  });
  const zh = planDisplay(p, "brief", undefined, {
    locale: "zh",
    copy_evidence: evidence,
  });
  assert.doesNotMatch(en.markdown, han);
  assert.match(en.markdown, /existing concentration limit/);
  assert.match(en.markdown, /below the venue minimum/);
  assert.match(zh.markdown, /现有集中度上限/);
  assert.match(zh.markdown, /低于交易所最小下单额/);
  assert.equal((en.markdown.match(/\nLimit: /g) ?? []).length, 1);
  assert.equal((zh.markdown.match(/\n限制：/g) ?? []).length, 1);
  assert.equal((en.markdown.match(/\| Trader \|/g) ?? []).length, 1);
  assert.doesNotMatch(
    en.markdown,
    /add funds|increase leverage|replace.*trader|success rate/i,
  );
  assert.equal(fingerprint(p), before);
  for (const code of [
    "ASSET_CONCENTRATION",
    "BUDGET_EXCEEDED",
    "SCOPED_COLLATERAL_REQUIRED",
    "INVALID_OUTCOME_POSITION",
    "BELOW_MINIMUM_NOTIONAL",
    "BELOW_MINIMUM_QUANTITY",
    "ENTRY_DEVIATION_OR_MISSING_SOURCE_PRICE",
    "SOURCE_STALE",
    "SOURCE_INCOMPLETE",
    "SOURCE_EQUITY_UNVERIFIED",
    "SOURCE_LEVERAGE_UNAVAILABLE",
    "FIXED_FILL_EVIDENCE_REQUIRED",
    "VENUE_RULES_UNAVAILABLE",
  ])
    assert.doesNotMatch(copyabilityReason(code, "en"), han);
});

it("localizes every generated discovery and final-review explanation while retaining exact selected rows and numbers", () => {
  const p = plan();
  addRiskSelection(p);
  p.allocations[0].leverage_cap = 5;
  p.allocations[0].leverage_cap_source = "inherited";
  p.allocations[0].leverage_mode = "custom_cap";
  p.allocations[1].leverage_cap_source = "inherited";
  const before = fingerprint(p);
  const rows = p.allocations.map((a) => a.trader);
  const en = conversationView(p, {}, rows, false, "brief", undefined, {
    locale: "en",
  });
  const zh = conversationView(p, {}, rows, false, "brief", undefined, {
    locale: "zh",
  });
  assert.doesNotMatch(JSON.stringify(en), han);
  assert.match(
    en.final_review!.risk_setting_explanation,
    /previously selected.*10%/,
  );
  assert.match(zh.final_review!.risk_setting_explanation, /之前明确选择的10%/);
  assert.match(
    en.planning_constraints.maximum_custom_leverage_cap_meaning,
    /not actual source-trader leverage/,
  );
  assert.match(
    en.recommended_portfolio[0].reason,
    /saved 5x extra leverage cap/,
  );
  assert.match(en.recommended_portfolio[1].reason, /no cap to clear/);
  for (const view of [en, zh]) {
    const expected = p.allocations.map((a) => a.trader.id);
    assert.deepEqual(
      view.recommended_portfolio.map((r) => r.trader_id),
      expected,
    );
    assert.deepEqual(
      view.recommended_trader_comparison.map((r) => r.trader_id),
      expected,
    );
    assert.deepEqual(
      view.final_review!.traders.map((r) => r.trader_id),
      expected,
    );
    assert.deepEqual(
      view.recommended_portfolio.map((r) => r.amount_usdc),
      p.allocations.map((a) => a.amount_usdc),
    );
  }
  assert.deepEqual(
    numbers(en.final_review!.risk_setting_explanation),
    numbers(zh.final_review!.risk_setting_explanation),
  );
  assert.equal(fingerprint(p), before);
});

it("changes browse language without changing filters, cursor semantics, selections or saved plans", () => {
  const p = plan();
  const state = emptyState();
  state.preferences = p.preferences;
  state.plans.push(p);
  state.selected_trader_ids = p.allocations.map((a) => a.trader.id);
  const candidates = [1, 2, 3, 4, 5, 6, 7, 8].map(candidate);
  saveDiscovery(state, p.preferences, candidates);
  const cursor = new Cursor("l".repeat(32));
  const before = fingerprint(state);
  const args = {
    plan_id: p.id,
    exclude_selected: true,
    filters: { min_score: 80, min_roi_pct: 0, max_drawdown_pct: 5 },
    sort_by: "roi" as const,
    limit: 2,
  };
  const en = browse(
    state,
    p.preferences,
    { ...args, locale: "en" },
    "alice",
    cursor,
  );
  const zh = browse(
    state,
    p.preferences,
    { ...args, locale: "zh" },
    "alice",
    cursor,
  );
  assert.doesNotMatch(JSON.stringify(en), han);
  assert.deepEqual(
    en.candidates.map((c) => c.id),
    zh.candidates.map((c) => c.id),
  );
  assert.deepEqual(en.applied_filters, zh.applied_filters);
  assert.deepEqual(en.filter_counts, zh.filter_counts);
  assert.equal(en.candidates_meta.next_cursor, zh.candidates_meta.next_cursor);
  assert.match(en.conversation_display.markdown, /Filters:.*Source return/);
  assert.match(en.candidates_meta.sort_warning!, /source-reported values/);
  assert.equal(en.plan_unchanged, true);
  assert.equal(en.preferences_unchanged, true);
  const second = browse(
    state,
    p.preferences,
    { ...args, locale: "zh", cursor: en.candidates_meta.next_cursor! },
    "alice",
    cursor,
  );
  assert(
    second.candidates.every(
      (c) => !en.candidates.some((first) => first.id === c.id),
    ),
  );
  assert.equal(fingerprint(state), before);
});

it("provides exact locale variants to older clients without changing the default Markdown, plan or evidence", () => {
  const p = plan();
  addRiskSelection(p);
  const previous = structuredClone(p);
  previous.id = "plan_locale_previous_0123";
  const evidence = {
    [p.allocations[0].trader.id]: {
      source_equity_usdc: "1234.000000",
      next_order_size: {
        status: "blocked",
        reason_code: "ASSET_CONCENTRATION",
        scope: "hypothetical_initial_target",
        observed_at: Date.now(),
        positions: [
          { status: "skipped", reason_code: "BELOW_MINIMUM_NOTIONAL" },
        ],
      },
    },
  };
  const before = fingerprint(p);
  const previousBefore = fingerprint(previous);
  const evidenceBefore = structuredClone(evidence);
  for (const detail of ["brief", "detailed"] as const) {
    for (const analysis_depth of ["summary", "extended"] as const) {
      for (const include_calculations of [false, true]) {
        const options = {
          analysis_depth,
          include_calculations,
          copy_evidence: evidence,
        };
        const legacy = planDisplay(p, detail, previous, options);
        const zh = planDisplay(p, detail, previous, {
          ...options,
          locale: "zh",
        });
        const en = planDisplay(p, detail, previous, {
          ...options,
          locale: "en",
        });
        assert(legacy.markdown_by_locale);
        assert.equal(legacy.markdown, zh.markdown);
        assert.equal(legacy.markdown_by_locale.zh, zh.markdown);
        assert.equal(legacy.markdown_by_locale.en, en.markdown);
        assert.doesNotMatch(legacy.markdown_by_locale.en, han);
        assert.equal("markdown_by_locale" in zh, false);
        assert.equal("markdown_by_locale" in en, false);
        assert.match(legacy.instruction, /禁止同时展示两份/);
        assert.match(legacy.instruction, /show only markdown_by_locale.en/);
        assert.deepEqual(legacy.trader_ids, en.trader_ids);
        assert.deepEqual(
          actionFacts(legacy.next_actions),
          actionFacts(en.next_actions),
        );
        if (detail === "brief") {
          assert.equal(
            (legacy.markdown.match(/\| Trader \|/g) ?? []).length,
            1,
          );
          assert.equal(
            (legacy.markdown_by_locale.en.match(/\| Trader \|/g) ?? []).length,
            1,
          );
        }
      }
    }
  }
  assert.equal(fingerprint(p), before);
  assert.equal(fingerprint(previous), previousBefore);
  assert.deepEqual(evidence, evidenceBefore);
});
