import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import vm from "node:vm";

function fixture(funding = false, wrongUrl = false) {
  const listeners = new Set<(event: any) => void>();
  const timers = new Map<number, () => void>();
  let timerId = 0;
  let toolCalls = 0;
  const nodes: any[] = [];
  const contexts: any[] = [];
  const node = (tag: string, textContent = "") => ({
    tag,
    textContent,
    hidden: false,
    isConnected: true,
    contentWindow: {},
    style: {},
    attributes: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    append(...children: any[]) {
      nodes.push(...children);
    },
    prepend() {},
    querySelector() {
      return null;
    },
    addEventListener() {},
  });
  const root = node("main");
  const proposal = {
    id: "proposal_fallback_fixture_00000000",
    action: "stop_copy",
    status: "completed",
    confirmation_url:
      "https://ride.test/agent/confirm/proposal_fallback_fixture_00000000",
  };
  const fundingView = {
    deposit_id: "deposit_" + "a".repeat(32),
    amount_usdc: "30.000000",
    network: "Arbitrum",
    status: "requires_confirmation",
    confirmation_url: `https://${wrongUrl ? "foreign.test" : "ride.test"}/agent/fund/deposit_${"a".repeat(32)}`,
  };
  vm.runInNewContext(
    readFileSync("public/agent-host.js", "utf8").replace(
      "/*HOST_CONFIG*/ {}",
      JSON.stringify({ confirmation_origin: "https://ride.test" }),
    ),
    {
      document: { getElementById: () => root, createElement: node },
      window: {
        openai: {
          toolOutput: {},
          callTool() {
            toolCalls++;
          },
          setWidgetState(value: any) {
            contexts.push(value);
          },
        },
        addEventListener(name: string, handler: any) {
          if (name === "message") listeners.add(handler);
        },
        removeEventListener(_name: string, handler: any) {
          listeners.delete(handler);
        },
      },
      URL,
      setTimeout(callback: () => void) {
        timers.set(++timerId, callback);
        return timerId;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
      el: node,
      render(_root: any, _data: any, _open: any, _tool: any, card: any) {
        card(
          root,
          funding ? fundingView : proposal,
          false,
          funding ? "funding" : "proposal",
        );
      },
    },
  );
  const frame = nodes.find((n) => n.tag === "iframe");
  const state = nodes.find((n) => n.textContent === "正在连接 Ride 确认卡片…");
  return {
    frame,
    state,
    timers,
    toolCalls: () => toolCalls,
    contexts,
    expire() {
      for (const callback of [...timers.values()]) callback();
      timers.clear();
    },
    message(overrides: any = {}) {
      const event = {
        source: frame.contentWindow,
        origin: "https://ride.test",
        data: {
          type: funding ? "ride:funding-state" : "ride:confirmation-state",
          ...(funding
            ? { deposit_id: fundingView.deposit_id }
            : { proposal_id: proposal.id }),
          status: funding ? "credited" : "completed",
          signing_challenge: "must never enter model context",
        },
        ...overrides,
      };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

it("unresponsive confirmation frames show a usable fallback without calling an account tool", () => {
  const f = fixture();
  f.expire();
  assert.equal(f.frame.hidden, true);
  assert.match(f.state.textContent, /在 Ride 页面中打开/);
  assert.equal(f.toolCalls(), 0);
});

it("funding cards validate their own URL/frame/deposit and send only public funding status into AI context", () => {
  const rejected = fixture(true, true);
  assert.equal(rejected.frame, undefined);
  const f = fixture(true);
  assert.equal(
    f.frame.src,
    `https://ride.test/agent/fund-card/deposit_${"a".repeat(32)}`,
  );
  assert.doesNotMatch(f.frame.attributes.sandbox, /allow-popups/);
  assert.match(
    f.frame.attributes.sandbox,
    /allow-storage-access-by-user-activation/,
  );
  f.expire();
  assert.match(f.state.textContent, /刷新 Rider 连接/);
  assert.doesNotMatch(f.state.textContent, /页面中打开/);
  f.message({ origin: "https://evil.test" });
  f.message({ source: {} });
  f.message({
    data: {
      type: "ride:funding-state",
      deposit_id: "deposit_" + "b".repeat(32),
      status: "credited",
    },
  });
  assert.equal(f.contexts.length, 0);
  f.message();
  assert.equal(f.state.textContent, "入金已到账");
  assert.deepEqual(JSON.parse(JSON.stringify(f.contexts)), [
    { deposit_id: "deposit_" + "a".repeat(32), funding_status: "credited" },
  ]);
  assert.equal(f.toolCalls(), 0);
});

it("only a message from the owned Ride frame can cancel fallback or restore a late connection", () => {
  for (const overrides of [
    { origin: "https://other.test" },
    { source: {} },
    {
      data: {
        type: "ride:confirmation-state",
        proposal_id: "proposal_other",
        status: "completed",
      },
    },
  ]) {
    const f = fixture();
    f.message(overrides);
    assert.equal(f.timers.size, 1);
    f.expire();
    assert.equal(f.frame.hidden, true);
    f.message();
    assert.equal(f.frame.hidden, false);
    assert.doesNotMatch(f.state.textContent, /未能加载/);
    assert.equal(f.toolCalls(), 0);
  }
  const f = fixture();
  f.message();
  assert.equal(f.timers.size, 0);
  assert.equal(f.frame.hidden, false);
});
