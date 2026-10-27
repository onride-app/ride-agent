import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";
import {
  preferenceCollection,
  preferenceCollectionDisplay,
} from "./preferences.js";
import { emptyState } from "./repository.js";

class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  dataset: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, () => void> = {};
  disabled = false;
  hidden = false;
  required = false;
  value = "";
  id = "";
  textContent = "";
  className = "";
  validityMessage = "";
  constructor(public tag: string) {}
  append(...nodes: Element[]) {
    for (const node of nodes) node.parentElement = this;
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(name: string, handler: () => void) {
    this.listeners[name] = handler;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  setCustomValidity(message: string) {
    this.validityMessage = message;
  }
  dispatch(name: string) {
    this.listeners[name]?.();
    this.parentElement?.dispatch(name);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((node) => node.all())];
  }
  text(): string {
    return [this.textContent, ...this.children.map((node) => node.text())].join(
      "\n",
    );
  }
}

function api() {
  const source = readFileSync("public/agent-view.js", "utf8").replaceAll(
    /^export /gm,
    "",
  );
  return vm.runInNewContext(`${source}\n;({ planEditor, welcome, render });`, {
    document: { createElement: (tag: string) => new Element(tag) },
  });
}
function plan() {
  return {
    id: "plan_fixed_ui_original",
    preferences: {
      budget_usdc: "30.000000",
      market: "perps",
      portfolio_kind: "basket",
      loss_trigger_pct: 20,
    },
    allocations: ["7.500000", "10.000000", "12.500000"].map((amount, i) => ({
      trader: {
        id: `trader_fixed_ui_${i}`,
        handle: `Trader ${i + 1}`,
        market: "perps",
        score: 80,
      },
      amount_usdc: amount,
      copy_mode: "ride_recommends",
      leverage_cap: i ? null : 3,
      stop_loss_pct: 17 + i,
      loss_policy: "exit",
    })),
  };
}
const find = (root: Element, text: string) => {
  const node = root.all().find((n) => n.textContent === text);
  assert(node, text);
  return node;
};
const input = (root: Element, label: string) => {
  const field = root
    .all()
    .find((node) => node.tag === "label" && node.textContent === label);
  assert(field, label);
  return field.children.find((node) => ["input", "select"].includes(node.tag))!;
};
function fixture() {
  const saved = plan();
  const before = JSON.stringify(saved);
  const calls: any[] = [];
  const start = new Element("button");
  const root = api().planEditor(
    saved,
    {},
    (...args: any[]) => calls.push(args),
    start,
  ) as Element;
  return { root, start, calls, saved, before };
}

it("explains the missing Fixed amount immediately, blocks preview RPCs, and never invents a margin", () => {
  const { root, start, calls, saved, before } = fixture();
  const mode = input(root, "Copy mode");
  const fixed = input(root, "Fixed margin per source entry · USDC · required");
  const recalc = find(root, "Recalculate and review");
  assert.equal(fixed.value, "");
  assert.equal(fixed.parentElement!.hidden, true);
  assert.equal(fixed.required, false);
  mode.value = "fixed";
  mode.dispatch("change");
  assert.equal(fixed.required, true);
  assert.equal(fixed.parentElement!.hidden, false);
  assert.equal(fixed.attrs["aria-invalid"], "true");
  assert.match(
    fixed.validityMessage,
    /Enter the fixed margin per source entry/,
  );
  assert(
    root
      .all()
      .some(
        (n) =>
          !n.hidden &&
          n.textContent.includes("Trader 1: Enter the fixed margin"),
      ),
  );
  assert.equal(recalc.disabled, true);
  recalc.dispatch("click"); // Guard also applies when a host invokes the handler directly.
  assert.equal(calls.length, 0);
  assert.equal(start.disabled, true);
  assert.equal(JSON.stringify(saved), before);
});

it("validates decimal precision and the existing allocation bound, then sends only an explicit new preview", () => {
  const { root, calls, saved, before } = fixture();
  const mode = input(root, "Copy mode");
  const fixed = input(root, "Fixed margin per source entry · USDC · required");
  const recalc = find(root, "Recalculate and review");
  mode.value = "fixed";
  mode.dispatch("change");
  for (const value of [
    " ",
    "0",
    "-1",
    "1e1",
    "Infinity",
    "0.0000001",
    "7.500001",
    "9999999999999",
  ]) {
    fixed.value = value;
    fixed.dispatch("input");
    assert.equal(recalc.disabled, true, value);
    assert(fixed.validityMessage, value);
    recalc.dispatch("click");
  }
  assert.equal(calls.length, 0);
  fixed.value = "2.123456";
  fixed.dispatch("input");
  assert.equal(recalc.disabled, false);
  assert.equal(fixed.attrs["aria-invalid"], "false");
  assert.equal(fixed.validityMessage, "");
  recalc.dispatch("click");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "recalculate_plan");
  const args = calls[0][1];
  assert.equal(args.plan_id, saved.id);
  assert.equal(
    JSON.stringify(args.preferences),
    JSON.stringify(saved.preferences),
  );
  assert.equal(args.allocations[0].fixed_margin_usdc, "2.123456");
  assert.equal(args.allocations[0].copy_mode, "fixed");
  for (let i = 0; i < saved.allocations.length; i++)
    for (const name of [
      "amount_usdc",
      "leverage_cap",
      "stop_loss_pct",
      "loss_policy",
    ])
      assert.equal(
        args.allocations[i][name],
        (saved.allocations[i] as any)[name],
      );
  assert.equal(JSON.stringify(saved), before);
});

it("clears the irrelevant Fixed requirement on mode change while retaining user-entered values locally", () => {
  const { root, saved, before } = fixture();
  const mode = input(root, "Copy mode");
  const fixed = input(root, "Fixed margin per source entry · USDC · required");
  const multiplier = input(root, "Proportional multiplier");
  mode.value = "fixed";
  mode.dispatch("change");
  fixed.value = "2";
  fixed.dispatch("input");
  mode.value = "proportional";
  mode.dispatch("change");
  assert.equal(fixed.required, false);
  assert.equal(fixed.disabled, true);
  assert.equal(fixed.parentElement!.hidden, true);
  assert.equal(fixed.validityMessage, "");
  assert.equal(multiplier.disabled, false);
  assert.equal(multiplier.parentElement!.hidden, false);
  assert.equal(find(root, "Recalculate and review").disabled, false);
  mode.value = "fixed";
  mode.dispatch("change");
  assert.equal(fixed.value, "2");
  assert.equal(JSON.stringify(saved), before);
});

it("shows the same required input guidance in preference collection without a default amount", () => {
  const root = new Element("main");
  const calls: any[] = [];
  api().welcome(
    root,
    (...args: any[]) => calls.push(args),
    {
      budget_usdc: "30",
      risk_tolerance: "medium",
    },
    { missing_fields: ["fixed_margin_usdc"] },
  );
  const fixed = input(root, "Fixed margin per source entry · USDC · required");
  const submit = find(root, "Continue in conversation");
  assert.equal(fixed.required, true);
  assert.equal(submit.disabled, true);
  assert.match(root.text(), /Enter the fixed margin per source entry/);
  submit.dispatch("click");
  assert.equal(calls.length, 0);
  fixed.value = "0.000001";
  fixed.dispatch("input");
  assert.equal(submit.disabled, false);
  submit.dispatch("click");
  assert.equal(calls[0][0], "recommend_traders");
  assert.equal(calls[0][1].preferences.fixed_margin_usdc, "0.000001");
});

it("asks only for the missing Fixed amount in either conversation language without changing saved answers", () => {
  const state = emptyState();
  state.preference_draft = {
    budget_usdc: "30",
    risk_tolerance: "medium",
    copy_mode: "fixed",
  };
  const before = JSON.stringify(state);
  const collection = preferenceCollection(state);
  for (const locale of ["en", "zh"] as const) {
    const shown = preferenceCollectionDisplay(collection, locale);
    assert.deepEqual(shown.missing_fields, ["fixed_margin_usdc"]);
    assert.equal(shown.questions.length, 1);
    assert.match(shown.questions[0].question, /USDC/);
    if (locale === "en")
      assert.doesNotMatch(shown.questions[0].question, /[\u3400-\u9fff]/);
    else assert.match(shown.questions[0].question, /固定保证金/);
    assert.equal(shown.answers.fixed_margin_usdc, undefined);
  }
  assert.equal(JSON.stringify(state), before);
});

it("protects existing-copy controls with the same Fixed requirement without changing stored controls", () => {
  const source = plan();
  const portfolio = {
    id: "portfolio_fixed_ui_existing",
    state: "active",
    operational: true,
    preferences: source.preferences,
    sleeves: source.allocations.map((a, i) => ({
      ...a,
      copy_id: `copy_fixed_ui_${i}`,
      state: "active",
    })),
    executions: [],
    positions: [],
  };
  const before = JSON.stringify(portfolio);
  const root = new Element("main");
  const calls: any[] = [];
  api().render(
    root,
    { status: "ok", data: { portfolio } },
    () => {},
    (...args: any[]) => calls.push(args),
  );
  const mode = input(root, "Copy mode");
  const fixed = input(root, "Fixed margin per source entry · USDC · required");
  const review = find(root, "Review parameter change");
  mode.value = "fixed";
  mode.dispatch("change");
  assert.equal(review.disabled, true);
  review.dispatch("click");
  assert.equal(calls.length, 0);
  fixed.value = "2";
  fixed.dispatch("input");
  assert.equal(review.disabled, false);
  assert.equal(JSON.stringify(portfolio), before);
  assert.equal(calls.length, 0);
});
