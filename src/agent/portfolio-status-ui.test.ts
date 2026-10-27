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
  const source = readFileSync("public/agent-view.js", "utf8").replaceAll(
    /^export /gm,
    "",
  );
  const { render } = vm.runInNewContext(`${source}\n;({ render });`, {
    document: { createElement: (tag: string) => new Element(tag) },
  });
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
  assert.match(text, /因风控暂未下单/);
  assert.match(
    text,
    /HYPE 占拟议组合总暴露的 100%，超过 60% 的资产集中度上限。/,
  );
  assert.match(text, /信号监控正常运行/);
  assert.match(text, /此状态仅指本次目标调整/);
  assert.match(text, /历史订单、成交与退出记录单独展示/);
  assert.match(text, /Execution status\s+prior_exit_fixture\s+settled/);
  assert(root.all().some((node) => node.textContent === "Refresh portfolio"));
  assert.doesNotMatch(text, /Copying is not operational yet/);
  assert(
    text.indexOf("因风控暂未下单") <
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
        message_zh: undefined,
      },
    },
    false,
  );
  assert.match(root.text(), /Copying is not operational yet/);
  assert.match(root.text(), /因风控暂未下单/);
  assert.doesNotMatch(root.text(), /信号监控正常运行/);
  assert(root.all().some((node) => node.textContent === message));
  assert(!root.all().some((node) => node.tag === "img"));
});

it("removes a resolved risk warning on refresh and does not invent one for older portfolio payloads", () => {
  const { root: legacy } = fixture();
  assert.doesNotMatch(legacy.text(), /因风控暂未下单|本次目标调整/);
  const { root, refresh } = fixture(concentrationBlocker);
  assert.match(root.text(), /因风控暂未下单/);
  refresh({ status: "monitoring", summary: "Monitoring" });
  assert.doesNotMatch(root.text(), /因风控暂未下单|本次目标调整/);
});
