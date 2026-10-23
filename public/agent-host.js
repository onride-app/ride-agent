const root = document.getElementById("content");
const hostConfig = /*HOST_CONFIG*/ {};
let requestId = 0;
const pending = new Map();
const history = [];
const frameCleanups = new Set();
let connected = false;
let fixedHeight = false;
let lastHeight;
let sizeObserver;
let current = window.openai?.toolOutput ?? null;
function notifySize() {
  if (!connected || fixedHeight) return;
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (!Number.isFinite(height) || height <= 0 || height === lastHeight) return;
  lastHeight = height;
  window.parent.postMessage(
    {
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height },
    },
    "*",
  );
}
function showError(message) {
  root.querySelector(".host-error")?.remove();
  root.prepend(el("p", message, "warning error host-error"));
}
function accept(value) {
  if (value) {
    if (current) history.push(current);
    current = value;
    draw();
  }
}
function draw() {
  for (const cleanup of frameCleanups) cleanup();
  render(
    root,
    current,
    openLink,
    callTool,
    hostConfig.confirmation_origin ? confirmationCard : undefined,
  );
  if (history.length) {
    const back = el("button", "Back", "secondary");
    back.addEventListener("click", () => {
      current = history.pop();
      draw();
    });
    root.prepend(back);
  }
}
function confirmationCard(container, proposal, demo) {
  try {
    const base = new URL(hostConfig.confirmation_origin);
    const id = proposal.id;
    if (base.protocol !== "https:" && base.hostname !== "127.0.0.1")
      throw Error("Secure Ride origin unavailable.");
    if (
      !demo &&
      (!/^proposal_[a-zA-Z0-9_-]{8,100}$/.test(id) ||
        new URL(proposal.confirmation_url).origin !== base.origin ||
        new URL(proposal.confirmation_url).pathname !== `/agent/confirm/${id}`)
    )
      throw Error(
        "The confirmation address does not match this Rider proposal.",
      );
    const frame = document.createElement("iframe");
    frame.title = demo ? "Rider 模拟确认卡片" : "Rider 操作确认";
    frame.className = "confirmation-frame";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox",
    );
    frame.src = new URL(
      demo ? "/agent/card-demo" : `/agent/card/${id}`,
      base,
    ).href;
    container.append(frame);
    const state = el("p", "正在连接 Ride 确认卡片…", "muted");
    state.setAttribute("aria-live", "polite");
    container.append(state);
    const readyTimeout = setTimeout(() => {
      if (!frame.isConnected) {
        cleanup();
        return;
      }
      frame.hidden = true;
      state.textContent =
        "当前客户端未能加载内嵌确认。请在 Ride 页面中打开；有效登录会自动复用。";
    }, 8000);
    const onMessage = (event) => {
      if (!frame.isConnected) {
        cleanup();
        return;
      }
      if (
        event.source !== frame.contentWindow ||
        event.origin !== base.origin ||
        event.data?.type !== "ride:confirmation-state" ||
        (!demo && event.data.proposal_id !== id)
      )
        return;
      clearTimeout(readyTimeout);
      frame.hidden = false;
      const names = {
        demo_ready: "模拟卡片已就绪 · 不会交易",
        demo_confirmed: "模拟确认成功 · 未提交交易",
        demo_rejected: "模拟已取消 · 未提交交易",
        sign_in_required: "请在卡片中连接 Ride",
        requires_confirmation: "请核对方案并确认",
        queued: "已确认，等待处理",
        rejected: "方案已取消",
        confirmed: "已确认",
        expired: "方案已过期",
      };
      state.textContent = names[event.data.status] ?? "Rider 状态已更新";
      if (Number.isFinite(event.data.height))
        frame.style.height = `${Math.min(1400, Math.max(420, event.data.height))}px`;
    };
    const cleanup = () => {
      clearTimeout(readyTimeout);
      window.removeEventListener("message", onMessage);
      frameCleanups.delete(cleanup);
    };
    frameCleanups.add(cleanup);
    window.addEventListener("message", onMessage);
    container.append(
      el(
        "p",
        demo
          ? "0 USDC 界面测试 · 不连接账户或执行服务"
          : `操作 ${proposal.action} · 状态 ${proposal.status} · 请在 Ride 中核对完整方案`,
        "muted",
      ),
    );
    if (proposal.confirmation_url) {
      const fallback = el("button", "在 Ride 页面中打开", "secondary");
      const fallbackUrl = demo
        ? new URL("/agent/card-demo", base).href
        : proposal.confirmation_url;
      fallback.onclick = () => openLink(fallbackUrl);
      container.append(fallback);
    }
  } catch (error) {
    showError(error.message);
  }
}
function request(method, params) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(
        new Error(
          "The host did not respond. Use the equivalent Ride tool or CLI command in the conversation.",
        ),
      );
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
}
let busy = false;
async function callTool(name, args) {
  if (busy) return;
  busy = true;
  const buttons = [...root.querySelectorAll("button,input,select")].map(
    (button) => ({ button, disabled: button.disabled }),
  );
  buttons.forEach(({ button }) => {
    button.disabled = true;
  });
  try {
    const reply = window.openai?.callTool
      ? await window.openai.callTool(name, args)
      : await request("tools/call", { name, arguments: args });
    const value = reply?.structuredContent ?? (reply?.version ? reply : null);
    if (value) accept(value);
    else {
      const text = reply?.content?.find((x) => x.type === "text")?.text;
      if (text) accept(JSON.parse(text));
      else
        throw new Error(
          "The host returned no Ride result. Use the tool in the conversation.",
        );
    }
  } catch (e) {
    showError(e.message ?? "Rider request failed.");
  } finally {
    busy = false;
    buttons.forEach(({ button, disabled }) => {
      button.disabled = disabled;
    });
  }
}
async function openLink(url) {
  try {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.hostname !== "127.0.0.1")
      throw new Error("Rider requires a secure confirmation URL.");
    const response = window.openai?.openExternal
      ? await window.openai.openExternal({ href: url })
      : await request("ui/open-link", { url });
    if (response?.isError)
      throw new Error(
        `The host could not open the link. Open Rider confirmation manually: ${url}`,
      );
  } catch (e) {
    showError(e.message);
  }
}
draw();
window.addEventListener("openai:set_globals", (event) =>
  accept(event.detail?.globals?.toolOutput),
);
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (msg?.jsonrpc !== "2.0") return;
  // Requests from the host have their own id namespace. A host ping may have
  // the same id as our pending ui/initialize; it is not its response.
  if (typeof msg.method === "string" && msg.id !== undefined) {
    const supported = ["ping", "ui/resource-teardown"].includes(msg.method);
    if (msg.method === "ui/resource-teardown") {
      connected = false;
      sizeObserver?.disconnect();
      for (const cleanup of frameCleanups) cleanup();
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    }
    window.parent.postMessage(
      {
        jsonrpc: "2.0",
        id: msg.id,
        ...(supported
          ? { result: {} }
          : { error: { code: -32601, message: "Method not found" } }),
      },
      "*",
    );
    return;
  }
  const entry =
    msg.method === undefined && ("result" in msg || "error" in msg)
      ? pending.get(msg.id)
      : undefined;
  if (entry) {
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }
  if (msg?.method === "ui/notifications/tool-result")
    if (msg.params?.structuredContent) accept(msg.params.structuredContent);
    else {
      const text = msg.params?.content?.find(
        (item) => item.type === "text",
      )?.text;
      if (text) {
        try {
          accept(JSON.parse(text));
        } catch {
          showError("Rider returned an unreadable result.");
        }
      }
    }
  if (msg.method === "ui/notifications/host-context-changed") {
    fixedHeight = typeof msg.params?.containerDimensions?.height === "number";
    notifySize();
  }
});
if (!window.openai?.callTool)
  request("ui/initialize", {
    appInfo: { name: "Rider", version: "0.5.3" },
    appCapabilities: {},
    protocolVersion: "2026-01-26",
  })
    .then((result) => {
      if (result?.protocolVersion !== "2026-01-26")
        throw Error("The host did not complete Ride card initialization.");
      connected = true;
      fixedHeight =
        typeof result.hostContext?.containerDimensions?.height === "number";
      window.parent.postMessage(
        { jsonrpc: "2.0", method: "ui/notifications/initialized" },
        "*",
      );
      if (typeof ResizeObserver !== "undefined") {
        sizeObserver = new ResizeObserver(notifySize);
        sizeObserver.observe(document.body);
      }
      notifySize();
    })
    .catch((e) => showError(e.message));
