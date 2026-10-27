import assert from "node:assert/strict";
import { it } from "node:test";
import { fingerprint, type Plan } from "./domain.js";
import { candidate } from "./fixtures.js";
import { copyRule, planDisplay } from "./conversation-presentation.js";

function plan(count: number, budget = String(count * 7.5)): Plan {
  return {
    id: "plan_brief_fixture_12345678",
    created_at: Date.now(),
    expires_at: Date.now() + 600_000,
    preferences: {
      budget_usdc: budget,
      market: "perps",
      assets: [],
      allow_altcoins: true,
      portfolio_kind: count === 1 ? "single" : "basket",
      basket_size: count,
      risk_tolerance: "medium",
      loss_trigger_pct: 10,
    },
    preference_sources: { loss_trigger_pct: "user" },
    source_version: "strict_perp_v2_5_daily_live_v1",
    allocations: Array.from({ length: count }, (_, i) => ({
      copy_id: `copy_brief_fixture_${i}`,
      trader: candidate(i + 1),
      amount_usdc:
        count === 3 && budget === "43"
          ? ["14.333334", "14.333333", "14.333333"][i]
          : (Number(budget) / count).toFixed(6),
      leverage_cap: null,
      leverage_mode: "follow_source",
      copy_mode: "ride_recommends",
      stop_loss_pct: 30,
    })),
  };
}

const numeric = (s: string) => s.match(/-?\d+(?:\.\d+)?/g) ?? [];

it("makes the normal two- and three-trader brief materially shorter than the reviewed default", () => {
  for (const [count, budget, zhLimit, enLimit] of [
    [2, "20", 345, 850],
    [3, "43", 395, 1000],
  ] as const) {
    const p = plan(count, budget);
    const zh = planDisplay(p, "brief", undefined, { locale: "zh" });
    const en = planDisplay(p, "brief", undefined, { locale: "en" });
    assert(
      zh.markdown.length < zhLimit,
      `${count} traders: ${zh.markdown.length} Chinese characters`,
    );
    assert(
      en.markdown.length < enLimit,
      `${count} traders: ${en.markdown.length} English characters`,
    );
    for (const view of [zh, en]) {
      assert.equal(
        (view.markdown.match(/\| Trader \| USDC \|/g) ?? []).length,
        1,
      );
      assert.equal(view.analysis, null);
      assert.doesNotMatch(
        view.markdown,
        /模型分项|Model components|计算方法|Calculation method|接口|interface|audit|未测得|measured portfolio risk improvement/,
      );
    }
    assert.match(zh.markdown, /需本人确认/);
    assert.match(en.markdown, /Requires your confirmation/);
    assert.match(zh.markdown, /未达最小下单额跳过/);
    assert.match(en.markdown, /skip below-minimum orders/);
    assert.match(zh.markdown, /组合退出/);
    assert.match(en.markdown, /Portfolio exit/);
    assert.deepEqual(numeric(en.markdown), numeric(zh.markdown));
  }
});

it("keeps every selected trader, exact slot amount and unknown-period marker for one through eight traders", () => {
  for (let count = 1; count <= 8; count++) {
    const p = plan(count);
    const before = fingerprint(p);
    for (const locale of ["zh", "en"] as const) {
      const view = planDisplay(p, "brief", undefined, { locale });
      assert.deepEqual(
        view.trader_ids,
        p.allocations.map((a) => a.trader.id),
      );
      assert.equal(
        (view.markdown.match(/^\| Trader \d+ \|/gm) ?? []).length,
        count,
      );
      let last = -1;
      for (const a of p.allocations) {
        const at = view.markdown.indexOf(
          `| ${a.trader.handle} | ${a.amount_usdc} |`,
        );
        assert(at > last);
        last = at;
      }
      assert.equal((view.markdown.match(/%†/g) ?? []).length, count * 2);
      assert.match(
        view.markdown,
        locale === "zh" ? /†周期未核实/ : /† periods unverified/,
      );
      assert.equal(
        view.markdown.split("\n").filter((line) => line.startsWith("†")).length,
        1,
      );
    }
    assert.equal(fingerprint(p), before);
  }
});

it("shows mixed modes, multipliers and saved caps inside the same compact table without changing them", () => {
  const p = plan(4);
  p.allocations[0].copy_mode = "fixed";
  p.allocations[0].fixed_margin_usdc = "2.500000";
  p.allocations[1].copy_mode = "proportional";
  p.allocations[1].proportional_multiplier = 1.5;
  p.allocations[1].leverage_cap = 4;
  p.allocations[1].leverage_mode = "custom_cap";
  p.allocations[2].leverage_cap = 3;
  p.allocations[2].leverage_cap_source = "inherited";
  delete p.allocations[2].leverage_mode;
  p.allocations[3].trader.market = "prediction";
  p.allocations[3].leverage_cap = 1;
  const before = fingerprint(p);
  const rulesBefore = p.allocations.map((a) => copyRule(a));
  const en = planDisplay(p, "brief", undefined, { locale: "en" });
  const zh = planDisplay(p, "brief", undefined, { locale: "zh" });
  assert.match(en.markdown, /Copy settings/);
  assert.match(en.markdown, /Fixed 2.500000 USDC/);
  assert.match(en.markdown, /Proportional ×1.5.*saved 4x cap/);
  assert.match(en.markdown, /saved 3x cap/);
  assert.match(en.markdown, /prediction markets 1x/);
  assert.match(zh.markdown, /固定 2.500000 USDC/);
  assert.match(zh.markdown, /保留 3x 上限/);
  assert.deepEqual(numeric(en.markdown), numeric(zh.markdown));
  assert.equal((en.markdown.match(/\| Trader \| USDC \|/g) ?? []).length, 1);
  assert.equal(fingerprint(p), before);
  assert.deepEqual(
    p.allocations.map((a) => copyRule(a)),
    rulesBefore,
  );
});

it("keeps every actual risk or evidence blocker in the single limitation line", () => {
  const p = plan(2);
  const copy_evidence = {
    [p.allocations[0].trader.id]: {
      source_equity_usdc: "1000",
      next_order_size: {
        status: "blocked",
        reason_code: "ASSET_CONCENTRATION",
        scope: "hypothetical_initial_target",
        positions: [
          { status: "blocked", reason_code: "BELOW_MINIMUM_NOTIONAL" },
        ],
      },
    },
    [p.allocations[1].trader.id]: {
      source_equity_usdc: null,
      next_order_size: {
        status: "incomplete",
        reason_code: "SOURCE_LEVERAGE_UNAVAILABLE",
        scope: "hypothetical_initial_target",
        positions: [],
      },
    },
  };
  const before = structuredClone(copy_evidence);
  const en = planDisplay(p, "brief", undefined, {
    locale: "en",
    copy_evidence,
  });
  const limit = en.markdown
    .split("\n")
    .find((line) => line.startsWith("Limit:"))!;
  assert.match(limit, /concentration limit/);
  assert.match(limit, /below the venue minimum/);
  assert.match(limit, /actual source leverage is unverified/);
  assert.match(limit, /periods unverified/);
  assert.equal(
    en.markdown.split("\n").filter((line) => line.startsWith("Limit:")).length,
    1,
  );
  assert.doesNotMatch(
    en.markdown,
    /increase funds|add funds|increase leverage|success rate/i,
  );
  assert.deepEqual(copy_evidence, before);
});

it("keeps saved uniform legacy caps explicit and leaves detailed analysis opt-in", () => {
  const p = plan(2);
  for (const a of p.allocations) {
    a.leverage_cap = 3;
    a.leverage_cap_source = "inherited";
    delete a.leverage_mode;
  }
  const brief = planDisplay(p, "brief", undefined, { locale: "en" });
  assert.match(brief.markdown, /saved 3x user cap/);
  assert.doesNotMatch(
    brief.markdown,
    /no extra user cap|Model components|Target quantity/,
  );
  const detailed = planDisplay(p, "detailed", undefined, { locale: "en" });
  assert(detailed.markdown.length > brief.markdown.length);
  assert.match(detailed.markdown, /Analysis:/);
  assert.doesNotMatch(detailed.markdown, /\| Leverage stability \|/);
  const extended = planDisplay(p, "detailed", undefined, {
    locale: "en",
    analysis_depth: "extended",
  });
  assert.match(extended.markdown, /\| Leverage stability \|/);
  assert.doesNotMatch(extended.markdown, /Target quantity =/);
  const calculated = planDisplay(p, "detailed", undefined, {
    locale: "en",
    include_calculations: true,
  });
  assert.match(calculated.markdown, /Target quantity =/);
});
