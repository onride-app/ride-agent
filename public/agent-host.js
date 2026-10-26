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
function confirmationCard(container, proposal, demo, kind = "proposal") {
  try {
    const base = new URL(hostConfig.confirmation_origin);
    const funding = kind === "funding";
    const id = funding ? proposal.deposit_id : proposal.id;
    const subject = funding ? "deposit_id" : "proposal_id";
    const messageType = funding
      ? "ride:funding-state"
      : "ride:confirmation-state";
    const standalonePath = funding
      ? `/agent/fund/${id}`
      : `/agent/confirm/${id}`;
    if (base.protocol !== "https:" && base.hostname !== "127.0.0.1")
      throw Error("Secure Ride origin unavailable.");
    if (
      !demo &&
      (!(
        funding ? /^deposit_[a-f0-9]{32}$/ : /^proposal_[a-zA-Z0-9_-]{8,100}$/
      ).test(id) ||
        new URL(proposal.confirmation_url).origin !== base.origin ||
        new URL(proposal.confirmation_url).pathname !== standalonePath)
    )
      throw Error(
        "The confirmation address does not match this Rider proposal.",
      );
    const frame = document.createElement("iframe");
    frame.title = funding
      ? "Rider funding confirmation"
      : demo
        ? "Rider confirmation demo"
        : "Rider confirmation";
    frame.className = "confirmation-frame";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute(
      "sandbox",
      funding
        ? "allow-scripts allow-same-origin allow-storage-access-by-user-activation"
        : "allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox",
    );
    if (funding) frame.setAttribute("allow", "storage-access");
    frame.src = new URL(
      funding
        ? demo
          ? "/agent/fund-demo"
          : `/agent/fund-card/${id}`
        : demo
          ? "/agent/card-demo"
          : `/agent/card/${id}`,
      base,
    ).href;
    container.append(frame);
    const state = el("p", "Connecting your Rider confirmation…", "muted");
    state.setAttribute("aria-live", "polite");
    container.append(state);
    const readyTimeout = setTimeout(() => {
      if (!frame.isConnected) {
        cleanup();
        return;
      }
      frame.hidden = true;
      state.textContent = funding
        ? "This client could not load the funding card. Refresh your Rider connection and try again. No funding has been submitted."
        : "This client could not load the confirmation card. Open the Rider page to review the same proposal; an existing sign-in will be reused.";
    }, 8000);
    const onMessage = (event) => {
      if (!frame.isConnected) {
        cleanup();
        return;
      }
      if (
        event.source !== frame.contentWindow ||
        event.origin !== base.origin ||
        event.data?.type !== messageType ||
        (!demo && event.data[subject] !== id)
      )
        return;
      clearTimeout(readyTimeout);
      frame.hidden = false;
      const names = {
        demo_ready: "Demo ready · no trading",
        demo_confirmed: "Demo confirmed · no transaction submitted",
        demo_rejected: "Demo cancelled · no transaction submitted",
        sign_in_required: "Connect Rider in the card",
        requires_confirmation: "Review the proposal before confirming",
        queued: "Confirmed and queued for processing",
        rejected: "Proposal cancelled",
        confirmed: "Confirmed",
        expired: "Proposal expired",
        quote_expired:
          "Funding quote expired. Refresh it in the card before confirming.",
        submitting: "Funding submission in progress. Do not submit again.",
        submitted: "Funding submitted. Waiting for the trading account credit.",
        credited: "Funding credited",
        uncertain:
          "Funding outcome needs verification. Check its status in the card.",
        failed: "Funding failed. Review the transaction record.",
      };
      state.textContent =
        funding && event.data.status === "requires_confirmation"
          ? "Review the exact amount and confirm funding in the card"
          : (names[event.data.status] ?? "Rider status updated");
      if (
        funding &&
        [
          "requires_confirmation",
          "quote_expired",
          "submitting",
          "submitted",
          "credited",
          "uncertain",
          "failed",
        ].includes(event.data.status)
      ) {
        // Only fixed public identifiers/status are copied into conversation
        // context; no signature, account identity or arbitrary frame fields.
        const context = { deposit_id: id, funding_status: event.data.status };
        if (window.openai?.setWidgetState)
          window.openai.setWidgetState(context);
        else if (connected)
          request("ui/update-model-context", {
            content: [{ type: "text", text: JSON.stringify(context) }],
          }).catch(() => {});
      }
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
          ? "0 USDC interface demo · no account or execution service"
          : funding
            ? `${proposal.amount_usdc} USDC · ${proposal.network} · check the card above for the funding outcome`
            : `Action ${proposal.action} · Status ${proposal.status} · Review the full proposal in Rider`,
        "muted",
      ),
    );
    if (proposal.confirmation_url && !funding) {
      const fallback = el("button", "Open in Rider", "secondary");
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
