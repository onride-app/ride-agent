import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";

class Element {
  children: Element[] = [];
  className = "";
  textContent = "";
  value = "";
  listeners: Record<string, () => void> = {};
  constructor(public tag: string) {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  addEventListener(name: string, handler: () => void) {
    this.listeners[name] = handler;
  }
  text(): string {
    return [this.textContent, ...this.children.map((n) => n.text())].join("\n");
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((n) => n.all())];
  }
}

function renderer() {
  const source = readFileSync("public/agent-view.js", "utf8").replaceAll(
    /^export /gm,
    "",
  );
  return vm.runInNewContext(`${source}\n;({ render });`, {
    document: { createElement: (tag: string) => new Element(tag) },
  }).render;
}

function fixture(executionStatus?: unknown, operational = true) {
  const root = new Element("main");
  const calls: unknown[] = [];
  const portfolio = {
    id: "portfolio_status_fixture",
    state: "active",
    operational,
    account_bound: true,
    activation: { status: "active" },
    execution_status: executionStatus,
    account_value_usdc: "43.000000",
    allocated_usdc: "43.000000",
    preferences: { loss_trigger_pct: 10 },
    sleeves: [],
    positions: [],
    executions: [{ key: "prior_exit_fixture", status: "settled" }],
  };
  const before = JSON.stringify(portfolio);
  const render = renderer();
  const display = () =>
    render(
      root,
      { status: "ok", data: { portfolio } },
      (...args: unknown[]) => calls.push(args),
      (...args: unknown[]) => calls.push(args),
    );
  display();
  assert.equal(JSON.stringify(portfolio), before);
  assert.deepEqual(calls, []);
  return {
    root,
    refresh(executionStatus: unknown) {
      portfolio.execution_status = executionStatus;
      const beforeRefresh = JSON.stringify(portfolio);
      display();
      assert.equal(JSON.stringify(portfolio), beforeRefresh);
      assert.deepEqual(calls, []);
    },
  };
}

const concentrationBlocker = {
  status: "blocked_by_risk",
  summary: "No order placed: blocked by risk",
  reason: {
    code: "ASSET_CONCENTRATION",
    message: "HYPE accounts for 100% of proposed exposure; limit 60%.",
    message_zh: "HYPE 占拟议组合总暴露的 100%，超过 60% 的资产集中度上限。",
    asset: "HYPE",
    concentration_pct: "100",
    limit_pct: "60",
  },
};

it("shows the current risk blocker before account balances even while source monitoring is operational", () => {
  const { root } = fixture(concentrationBlocker);
  const text = root.text();
  assert.match(text, /No order placed: blocked by risk/);
  assert.match(
    text,
    /HYPE accounts for 100% of proposed exposure; limit 60%\./,
  );
  assert.match(text, /Source monitoring is running/);
  assert.match(text, /Applies to the proposed target update\./);
  assert.match(text, /Existing orders, fills and exits are shown separately\./);
  assert.doesNotMatch(text, /因风控|拟议组合|信号监控/);
  assert.match(text, /Execution status\s+prior_exit_fixture\s+settled/);
  assert(root.all().some((node) => node.textContent === "Refresh portfolio"));
  assert.doesNotMatch(text, /Copying is not operational yet/);
  assert(
    text.indexOf("No order placed: blocked by risk") <
      text.indexOf("Agent trading account snapshot"),
  );
});

it("keeps account activation and risk blocking separate and renders reason text as text", () => {
  const message = "<img src=x onerror=submit()> violates the asset limit.";
  const { root } = fixture(
    {
      ...concentrationBlocker,
      reason: {
        ...concentrationBlocker.reason,
        message,
      },
    },
    false,
  );
  assert.match(root.text(), /Copying is not operational yet/);
  assert.match(root.text(), /No order placed: blocked by risk/);
  assert.doesNotMatch(root.text(), /Source monitoring is running/);
  assert(root.all().some((node) => node.textContent === message));
  assert(!root.all().some((node) => node.tag === "img"));
});

it("removes a resolved risk warning on refresh and does not invent one for older portfolio payloads", () => {
  const { root: legacy } = fixture();
  assert.doesNotMatch(legacy.text(), /blocked by risk|proposed target update/);
  const { root, refresh } = fixture(concentrationBlocker);
  assert.match(root.text(), /blocked by risk/);
  refresh({ status: "monitoring", summary: "Monitoring" });
  assert.doesNotMatch(root.text(), /blocked by risk|proposed target update/);
});

function proposalFixture(
  status = "completed",
  currentId: string | null = "portfolio_confirm_fixture",
  withConfirmationCard = false,
) {
  const proposal = {
    id: "proposal_original_confirm_fixture",
    portfolio_id: "portfolio_confirm_fixture",
    status,
    action: "start_copy",
    preview_hash: "a".repeat(64),
    expires_at: Date.now() + 60_000,
    preview: {
      portfolio: {
        portfolio: {
          projected_state: "active",
          sleeves: [
            {
              trader: { id: "trader_frozen", handle: "Frozen preview trader" },
              amount_usdc: "43.000000",
              projected_state: "active",
            },
          ],
        },
      },
      fees: { estimate_usdc: "0.010000" },
    },
    arguments: { plan_id: "plan_original_fixture" },
  };
  const value = {
    status: "ok",
    data: {
      proposal,
      confirmation_card: withConfirmationCard,
      current_portfolio: currentId
        ? {
            id: currentId,
            revision: 7,
            operational: true,
            as_of: Date.now(),
            execution_status: concentrationBlocker,
          }
        : null,
    },
  };
  const before = JSON.stringify(value);
  const root = new Element("main");
  const calls: unknown[] = [];
  const render = renderer();
  render(
    root,
    value,
    (...args: unknown[]) => calls.push(args),
    (...args: unknown[]) => calls.push(args),
    withConfirmationCard
      ? (target: Element, shown: typeof proposal) => {
          assert.equal(shown, proposal);
          target.append(new Element("article"));
          target.children.at(-1)!.textContent =
            "Original confirmation card: Frozen preview trader · 43.000000 USDC";
        }
      : undefined,
  );
  assert.equal(JSON.stringify(value), before);
  assert.deepEqual(calls, []);
  return root;
}

for (const status of ["queued", "completed"])
  it(`shows the exact current portfolio risk beside a frozen ${status} proposal without adding controls`, () => {
    const root = proposalFixture(status);
    const text = root.text();
    assert.match(text, /Operation status/);
    assert.doesNotMatch(text, /Review before confirming/);
    assert.match(text, /Current portfolio status/);
    assert.match(text, /Revision\s+7/);
    assert.match(text, /No order placed: blocked by risk/);
    assert.match(text, /HYPE accounts for 100%.*limit 60%/);
    assert.match(text, /Frozen preview trader/);
    assert.match(text, /43.000000 USDC/);
    assert.match(text, /Frozen parameters/);
    assert.match(text, /0.010000 USDC/);
    assert.match(text, /plan_original_fixture/);
    assert.doesNotMatch(text, /Agent trading account snapshot|因风控|拟议组合/);
    assert.equal(root.all().filter((n) => n.tag === "button").length, 0);
    assert(
      text.indexOf("Current portfolio status") <
        text.indexOf("Frozen preview trader"),
    );
  });

it("preserves the confirmation-card renderer while adding only a read-only current status card", () => {
  const root = proposalFixture("completed", "portfolio_confirm_fixture", true);
  assert.match(root.text(), /Current portfolio status/);
  assert.match(
    root.text(),
    /Original confirmation card: Frozen preview trader/,
  );
  assert.match(root.text(), /43.000000 USDC/);
  assert.equal(root.all().filter((n) => n.tag === "button").length, 0);
});

it("never attaches another portfolio's risk to a proposal or treats a pending preview as the current portfolio", () => {
  for (const status of ["requires_confirmation", "rejected", "expired"])
    for (const withCard of [false, true]) {
      const root = proposalFixture(
        status,
        "portfolio_confirm_fixture",
        withCard,
      );
      assert.doesNotMatch(
        root.text(),
        /Current portfolio status|blocked by risk/,
      );
    }
  for (const currentId of [null, "portfolio_unrelated_fixture"])
    for (const withCard of [false, true]) {
      const root = proposalFixture("completed", currentId, withCard);
      assert.doesNotMatch(
        root.text(),
        /Current portfolio status|blocked by risk/,
      );
    }
});
