const config = /*CONFIG*/ {};
const status = document.getElementById("status");
const content = document.getElementById("content");
const loginView = document.getElementById("login");
const actions = document.getElementById("actions");
const signIn = document.getElementById("sign-in");
const embedded = config.embedded === true;
let client,
  initialization,
  csrf,
  proposal,
  popup,
  challenge,
  submitting = false;
loginView.hidden = true;
document.getElementById("approve").textContent = config.demo
  ? "确认模拟"
  : "确认本次操作";
document.getElementById("reject").textContent = config.demo
  ? "取消模拟"
  : "取消方案";
const missingStoredSession = (e) =>
  /no tokens found in storage/i.test(e?.message ?? String(e));
const showError = (e) => {
  status.textContent = missingStoredSession(e)
    ? "网页确认需要独立的 Ride 登录，请登录后继续查看方案。"
    : (e?.message ?? String(e));
  status.className = "warning error";
};
async function init() {
  if (client) return client;
  if (initialization) return initialization;
  if (!config.privy_app_id) throw Error("Ride Agent sign-in is unavailable.");
  const { default: Privy, LocalStorage } = await import(config.privy_sdk);
  initialization = (async () => {
    const next = new Privy({
      appId: config.privy_app_id,
      ...(config.privy_client_id ? { clientId: config.privy_client_id } : {}),
      storage: new LocalStorage(),
    });
    await next.initialize();
    client = next;
    return next;
  })();
  try {
    return await initialization;
  } finally {
    initialization = undefined;
  }
}
async function call(operation, body = {}) {
  const response = await fetch(`/agent/human/${operation}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(embedded ? { "X-Ride-Embedded": "1" } : {}),
      ...(csrf ? { "X-Ride-CSRF": csrf } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(
      payload.error?.message ?? "Ride Agent request failed.",
    );
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}
const authError = (e) =>
  e?.code === "AUTH_REQUIRED" || e?.code === "CSRF_REQUIRED";
function announce(state) {
  // No token, CSRF, handoff ticket or signing challenge crosses into the host.
  if (embedded)
    window.parent.postMessage(
      {
        type: "ride:confirmation-state",
        proposal_id: config.proposal_id,
        status: state,
        height: Math.min(1400, Math.max(420, document.body.scrollHeight + 24)),
      },
      "*",
    );
}
async function loadProposal() {
  const value = await call("proposal", { proposal_id: config.proposal_id });
  proposal = value.data.proposal;
  render(content, value);
  content.querySelectorAll("button").forEach((b) => b.remove());
  const expired = proposal.expires_at <= Date.now();
  actions.hidden = proposal.status !== "requires_confirmation" || expired;
  actions.querySelectorAll("button").forEach((b) => (b.disabled = submitting));
  status.className = "";
  status.textContent =
    expired && proposal.status === "requires_confirmation"
      ? "方案已过期，请在聊天中刷新方案。"
      : "";
  announce(proposal.status);
}
async function ready() {
  loginView.hidden = true;
  const url = new URL(location.href);
  const nonce = new URLSearchParams(url.hash.slice(1)).get("challenge");
  if (!embedded && url.searchParams.get("card_login") === "1") {
    if (!window.opener || !/^[a-f0-9]{64}$/.test(nonce ?? ""))
      throw Error("连接窗口已失效，请回到卡片重新连接。无需确认任何交易。");
    const { ticket } = await call("embed-ticket", {
      proposal_id: config.proposal_id,
      challenge: nonce,
    });
    window.opener.postMessage(
      {
        type: "ride:human-session",
        ticket,
        challenge: nonce,
        proposal_id: config.proposal_id,
      },
      location.origin,
    );
    status.textContent =
      "Ride Agent 已连接，请返回聊天卡片确认操作。此窗口没有提交交易。";
    return;
  }
  await loadProposal();
}
async function finish(session) {
  const c = await init();
  const user = session?.user ?? (await c.user.get()).user;
  if (!user?.id) return false;
  const accounts = user.linkedAccounts ?? user.linked_accounts ?? [];
  const wallet = accounts.find(
    (x) =>
      x.type === "wallet" &&
      (x.chainType ?? x.chain_type) === "ethereum" &&
      (x.walletClientType ?? x.wallet_client_type) === "privy",
  );
  if (!wallet)
    throw Error("Set up your Ride wallet in the App before confirming.");
  const token = await c.getAccessToken();
  if (!token) return false;
  const login = await call("login", {
    privyId: user.id,
    privyAccessToken: token,
    walletAddress: wallet.address,
    privyWalletId: wallet.id,
    authProvider: "GOOGLE",
    accessCode: sessionStorage.getItem("ride:agent:access-code") ?? undefined,
  });
  csrf = login.csrf;
  sessionStorage.removeItem("ride:agent:access-code");
  await ready();
  return true;
}
function showLogin() {
  loginView.hidden = false;
  actions.hidden = true;
  loginView.querySelector("p").textContent =
    "MCP 登录与网页确认使用独立的认证会话。请在此验证同一个 Ride 账户；有效的网页登录会自动复用。";
  if (embedded) {
    loginView.querySelector("h1").textContent = "连接 Ride 后在此确认";
    loginView.querySelector("p").textContent =
      "MCP 登录与网页确认使用独立的认证会话。首次连接会打开 Ride 登录窗口；网页登录有效时，后续卡片直接显示方案。";
    signIn.textContent = "连接 Ride";
    document.getElementById("access-code").parentElement.hidden = true;
  }
  announce("sign_in_required");
}
signIn.onclick = async () => {
  if (embedded) {
    challenge = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const url = new URL(
      `/agent/confirm/${config.proposal_id}`,
      location.origin,
    );
    url.searchParams.set("card_login", "1");
    url.hash = new URLSearchParams({ challenge }).toString();
    popup = window.open(
      url.href,
      "ride-human-sign-in",
      "popup,width=540,height=720",
    );
    if (!popup)
      showError(
        Error("此客户端未允许登录窗口，请使用卡片下方的 Ride 页面入口。"),
      );
    return;
  }
  signIn.disabled = true;
  try {
    const c = await init();
    sessionStorage.setItem("ride:mcp:oauth_authorize_url", location.href);
    sessionStorage.setItem(
      "ride:agent:access-code",
      document.getElementById("access-code").value,
    );
    const out = await c.auth.oauth.generateURL(
      "google",
      `${location.origin}/auth/privy/oauth/callback`,
    );
    location.assign(out.url);
  } catch (e) {
    showError(e);
    signIn.disabled = false;
  }
};
window.addEventListener("message", async (event) => {
  if (
    !embedded ||
    event.origin !== location.origin ||
    !popup ||
    event.source !== popup
  )
    return;
  const msg = event.data;
  if (
    msg?.type !== "ride:human-session" ||
    msg.challenge !== challenge ||
    msg.proposal_id !== config.proposal_id
  )
    return;
  try {
    const session = await call("embed-session", {
      ticket: msg.ticket,
      challenge,
      proposal_id: config.proposal_id,
    });
    csrf = session.csrf;
    popup.close();
    popup = undefined;
    challenge = undefined;
    // Prove the partitioned cookie was retained before offering approval.
    await call("session");
    await ready();
  } catch (e) {
    showError(
      authError(e)
        ? Error("此客户端没有保留卡片登录状态，请使用 Ride 页面入口。")
        : e,
    );
    showLogin();
  }
});
for (const [id, operation] of [
  ["approve", "confirm"],
  ["reject", "reject"],
]) {
  document.getElementById(id).onclick = async () => {
    if (submitting || !proposal || proposal.status !== "requires_confirmation")
      return;
    if (proposal.expires_at <= Date.now()) {
      actions.hidden = true;
      showError(Error("方案已过期，请在聊天中刷新方案。"));
      announce("expired");
      return;
    }
    submitting = true;
    actions.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const value = await call(operation, {
        proposal_id: config.proposal_id,
        ...(operation === "confirm"
          ? { preview_hash: proposal.preview_hash }
          : {}),
      });
      render(content, value);
      actions.hidden = true;
      status.textContent =
        operation === "confirm"
          ? "已确认并进入处理队列；成交和结算结果仍需核对。"
          : "已取消此方案。";
      announce(
        value.data?.proposal?.status ??
          (operation === "confirm" ? "queued" : "rejected"),
      );
    } catch (e) {
      showError(
        Error(`${e.message} 提交结果待核实，请刷新本方案状态；不要重复提交。`),
      );
      const refresh = el("button", "刷新本方案状态", "secondary");
      refresh.onclick = async () => {
        try {
          await loadProposal();
        } catch (error) {
          showError(error);
        }
      };
      content.append(refresh);
      // An uncertain submission stays disabled. Reading the same proposal ID
      // cannot create another proposal or resubmit the financial action.
    }
  };
}
function demo() {
  loginView.hidden = true;
  content.append(card("模拟确认卡片 · 不会交易"));
  content.firstElementChild.append(
    row("操作", "界面确认测试"),
    row("金额", "0 USDC"),
    el("p", "本卡片不连接账户、交易所或执行服务。", "muted"),
  );
  actions.hidden = false;
  for (const id of ["approve", "reject"])
    document.getElementById(id).onclick = () => {
      actions.hidden = true;
      status.textContent =
        id === "approve"
          ? "模拟确认成功 · 未提交交易"
          : "模拟已取消 · 未提交交易";
      announce(id === "approve" ? "demo_confirmed" : "demo_rejected");
    };
  announce("demo_ready");
}
async function start() {
  if (config.demo) {
    demo();
    return;
  }
  status.textContent = "正在恢复 Ride 登录…";
  const url = new URL(location.href),
    query = url.searchParams;
  if (query.has("error") && !query.has("privy_oauth_code")) {
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    history.replaceState({}, "", url.href);
    showLogin();
    showError(Error("Ride Agent 登录已取消。"));
    return;
  }
  try {
    if (query.get("privy_oauth_code") && query.get("privy_oauth_state")) {
      const c = await init();
      const session = await c.auth.oauth.loginWithCode(
        query.get("privy_oauth_code"),
        query.get("privy_oauth_state"),
        "google",
      );
      for (const key of ["privy_oauth_code", "privy_oauth_state"])
        url.searchParams.delete(key);
      history.replaceState({}, "", url.href);
      if (!(await finish(session))) showLogin();
      return;
    }
    try {
      csrf = (await call("session")).csrf;
      await ready();
      return;
    } catch (e) {
      if (!authError(e)) throw e;
      csrf = undefined;
    }
    // Existing Privy storage can silently renew an expired human cookie.
    // Never launch Google OAuth automatically, and never sign in inside a card.
    if (!embedded && (await finish())) return;
    status.textContent = "";
    showLogin();
  } catch (e) {
    showLogin();
    if (missingStoredSession(e)) {
      status.textContent = "";
      status.className = "";
    } else showError(e);
  }
}
start();
