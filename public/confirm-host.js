const config = /*CONFIG*/ {};
const status = document.getElementById("status");
const content = document.getElementById("content");
const loginView = document.getElementById("login");
const actions = document.getElementById("actions");
const signIn = document.getElementById("sign-in");
const signInApple = document.getElementById("sign-in-apple");
const embedded = config.embedded === true;
const providerKey = "ride:auth:provider";
let client,
  initialization,
  csrf,
  proposal,
  popup,
  challenge,
  submitting = false,
  needsStatusCheck = false,
  uncertainSubmission = false;
loginView.hidden = true;
document.getElementById("approve").textContent = config.demo
  ? "Confirm demo"
  : "Confirm these parameters";
document.getElementById("reject").textContent = config.demo
  ? "Cancel demo"
  : "Cancel proposal";
const missingStoredSession = (e) =>
  /no tokens found in storage/i.test(e?.message ?? String(e));
const authError = (e) =>
  e?.code === "AUTH_REQUIRED" || e?.code === "CSRF_REQUIRED";
const showError = (e) => {
  status.textContent = missingStoredSession(e)
    ? "Sign in to Ride to review this proposal."
    : (e?.message ?? String(e));
  status.className = "warning error";
  if (embedded && !loginView.hidden) announce("sign_in_required");
};
const knownProvider = (value) =>
  value === "APPLE" || value === "GOOGLE" ? value : undefined;
function savedProvider(user) {
  const saved = knownProvider(sessionStorage.getItem(providerKey));
  if (saved) return saved;
  const accounts = user?.linkedAccounts ?? user?.linked_accounts ?? [];
  return accounts.some((a) => a.type === "apple_oauth" || a.type === "apple")
    ? "APPLE"
    : "GOOGLE";
}
function setLoginBusy(busy) {
  for (const button of [signIn, signInApple])
    if (button) button.disabled = busy;
}
async function init() {
  if (client) return client;
  if (initialization) return initialization;
  if (!config.privy_app_id) throw Error("Rider sign-in is unavailable.");
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
  if (!response.ok || payload.error) {
    const error = new Error(payload.error?.message ?? "Rider request failed.");
    error.code = payload.error?.code;
    error.httpStatus = response.status;
    throw error;
  }
  return payload;
}
function announce(state) {
  // No token, CSRF, handoff ticket or signing challenge crosses into the host.
  if (embedded)
    window.parent.postMessage(
      {
        type: "ride:confirmation-state",
        proposal_id: config.proposal_id,
        status: state,
        height: Math.min(
          1400,
          Math.max(
            420,
            (loginView.hidden
              ? document.body.scrollHeight
              : (loginView.parentElement?.scrollHeight ??
                loginView.scrollHeight ??
                document.body.scrollHeight)) + 24,
          ),
        ),
      },
      "*",
    );
}
function checkedProposal(value) {
  const next = value?.data?.proposal;
  if (
    next?.id !== config.proposal_id ||
    !["requires_confirmation", "queued", "completed", "rejected"].includes(
      next.status,
    ) ||
    !Number.isFinite(next.expires_at)
  )
    throw Error(
      "Rider returned an unverified proposal. Refresh this same proposal.",
    );
  return next;
}
function proposalStatusMessage(next) {
  if (next.status === "queued")
    return "Confirmation received. Processing is queued; trading execution is not yet verified.";
  if (next.status === "completed")
    return "This proposal has been applied. Check the latest portfolio status for trading activity.";
  if (next.status === "rejected") return "This proposal was cancelled.";
  return "";
}
async function loadProposal() {
  const value = await call("proposal", { proposal_id: config.proposal_id });
  const next = checkedProposal(value);
  const wasChecking = needsStatusCheck;
  loginView.hidden = true;
  // A read of this exact owned ID is the only way to clear an unknown result.
  // Older responses without a verified execution state cannot prove no submit.
  const stillUnknown =
    uncertainSubmission &&
    next.status === "requires_confirmation" &&
    next.execution_state !== "not_submitted";
  proposal = next;
  submitting = false;
  needsStatusCheck = stillUnknown;
  uncertainSubmission = stillUnknown;
  render(content, value);
  content.querySelectorAll("button").forEach((b) => b.remove());
  const expired = proposal.expires_at <= Date.now();
  actions.hidden = proposal.status !== "requires_confirmation" || expired;
  actions
    .querySelectorAll("button")
    .forEach((b) => (b.disabled = needsStatusCheck));
  status.className = stillUnknown ? "warning" : "";
  status.textContent = stillUnknown
    ? "The submission result is not yet verified. Refresh this same proposal; do not submit it again."
    : expired && proposal.status === "requires_confirmation"
      ? "This proposal expired. Refresh the proposal in chat."
      : wasChecking && proposal.status === "requires_confirmation"
        ? "This proposal has not been submitted. Review it before confirming."
        : proposalStatusMessage(proposal);
  if (stillUnknown) addRefresh();
  announce(stillUnknown ? "submission_unknown" : proposal.status);
}
function clearHandoffUrl(url) {
  url.searchParams.delete("card_login");
  url.searchParams.delete("auth_provider");
  const fragment = new URLSearchParams(url.hash.slice(1));
  fragment.delete("challenge");
  url.hash = fragment.toString();
  history.replaceState({}, "", url.href);
}
async function ready() {
  loginView.hidden = true;
  const url = new URL(location.href);
  const nonce = new URLSearchParams(url.hash.slice(1)).get("challenge");
  const cardLogin = !embedded && url.searchParams.get("card_login") === "1";
  let handoffFailed = false;
  if (cardLogin) {
    // Some hosts move OAuth into another browser or clear window.opener.
    // Authentication still permits an ownership-checked read in this window.
    // Losing the optional chat handoff must never create/confirm a new proposal.
    if (window.opener && /^[a-f0-9]{64}$/.test(nonce ?? "")) {
      try {
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
      } catch (e) {
        if (authError(e)) throw e;
        handoffFailed = true;
      }
    } else handoffFailed = true;
    clearHandoffUrl(url);
  }
  await loadProposal();
  if (
    cardLogin &&
    handoffFailed &&
    proposal.status === "requires_confirmation" &&
    !needsStatusCheck
  )
    status.textContent =
      "Signed in. Review and confirm this same proposal here. No action has been submitted.";
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
      ((x.walletClientType ?? x.wallet_client_type) === "privy" ||
        (x.connectorType ?? x.connector_type) === "embedded"),
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
    authProvider: savedProvider(user),
  });
  csrf = login.csrf;
  await ready();
  return true;
}
function showLogin() {
  loginView.hidden = false;
  actions.hidden = true;
  proposal = undefined;
  content.replaceChildren();
  loginView.querySelector("h1").textContent = "Sign in to review your proposal";
  loginView.querySelector("p").textContent = embedded
    ? "Use the Ride account that created this proposal. A Ride window opens only when sign-in is needed."
    : "Use the Ride account that created this proposal. You will review the same proposal after signing in.";
  signIn.textContent = "Continue with Google";
  if (signInApple) signInApple.textContent = "Continue with Apple";
  setLoginBusy(false);
  announce("sign_in_required");
}
async function signInWith(provider) {
  sessionStorage.setItem(providerKey, provider);
  if (embedded) {
    if (popup && !popup.closed) {
      popup.focus?.();
      return;
    }
    challenge = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((n) => n.toString(16).padStart(2, "0"))
      .join("");
    const url = new URL(
      `/agent/confirm/${config.proposal_id}`,
      location.origin,
    );
    url.searchParams.set("card_login", "1");
    url.searchParams.set("auth_provider", provider);
    url.hash = new URLSearchParams({ challenge }).toString();
    popup = window.open(
      url.href,
      "ride-human-sign-in",
      "popup,width=540,height=720",
    );
    if (!popup)
      showError(
        Error(
          "This client could not open sign-in. Open the Ride confirmation link below the card to review this same proposal.",
        ),
      );
    return;
  }
  setLoginBusy(true);
  try {
    const c = await init();
    sessionStorage.setItem("ride:mcp:oauth_authorize_url", location.href);
    const out = await c.auth.oauth.generateURL(
      provider.toLowerCase(),
      `${location.origin}/auth/privy/oauth/callback`,
    );
    if (!out?.url) throw Error("Ride sign-in did not return a login URL.");
    location.assign(out.url);
  } catch (e) {
    showError(e);
    setLoginBusy(false);
  }
}
signIn.onclick = () => signInWith("GOOGLE");
if (signInApple) signInApple.onclick = () => signInWith("APPLE");
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
    // Keep the authenticated Ride window available until this card has proved
    // both its partitioned cookie and ownership of the same proposal.
    await call("session");
    await ready();
    popup.close();
    popup = undefined;
    challenge = undefined;
  } catch (e) {
    showLogin();
    showError(
      authError(e)
        ? Error(
            "Continue in the Ride window to review and confirm this proposal. This client could not retain the chat sign-in session.",
          )
        : e,
    );
  }
});
function addRefresh() {
  const refresh = el("button", "Refresh this proposal's status", "secondary");
  refresh.onclick = async () => {
    refresh.disabled = true;
    try {
      csrf = (await call("session")).csrf;
      await loadProposal();
    } catch (e) {
      if (authError(e) || e?.code === "NOT_FOUND") showLogin();
      showError(
        e?.code === "NOT_FOUND"
          ? Error(
              "This proposal is not available for this Ride account. Sign in with the account that created it.",
            )
          : e,
      );
      refresh.disabled = false;
    }
  };
  content.append(refresh);
}
for (const [id, operation] of [
  ["approve", "confirm"],
  ["reject", "reject"],
]) {
  document.getElementById(id).onclick = async () => {
    if (
      submitting ||
      needsStatusCheck ||
      !proposal ||
      proposal.status !== "requires_confirmation"
    )
      return;
    if (proposal.expires_at <= Date.now()) {
      actions.hidden = true;
      showError(Error("This proposal expired. Refresh the proposal in chat."));
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
      const next = checkedProposal(value);
      if (next.status === "requires_confirmation")
        throw Error("The confirmation result has not been verified.");
      proposal = next;
      submitting = false;
      render(content, value);
      actions.hidden = true;
      status.className = "";
      status.textContent = proposalStatusMessage(proposal);
      announce(proposal.status);
    } catch (e) {
      submitting = false;
      needsStatusCheck = true;
      // A definite HTTP/auth/validation rejection is different from a lost
      // response. Neither permits another submit before re-reading the same ID.
      const rejected =
        authError(e) ||
        (Number.isInteger(e?.httpStatus) &&
          e.httpStatus >= 400 &&
          e.httpStatus < 500);
      uncertainSubmission = !rejected;
      if (authError(e) || e?.code === "NOT_FOUND") showLogin();
      showError(
        Error(
          authError(e)
            ? "Your Ride sign-in session expired. Sign in to review this same proposal before trying again."
            : e?.code === "NOT_FOUND"
              ? "This proposal is not available for this Ride account. Sign in with the account that created it."
              : rejected
                ? `${e.message} The request was rejected. Refresh this proposal before trying again.`
                : `${e.message} The result is not yet verified. Refresh this same proposal; do not submit it again.`,
        ),
      );
      addRefresh();
      announce(rejected ? "request_rejected" : "submission_unknown");
    }
  };
}
function demo() {
  loginView.hidden = true;
  content.append(card("Demo confirmation · no trade"));
  content.firstElementChild.append(
    row("Action", "Interface confirmation test"),
    row("Amount", "0 USDC"),
    el(
      "p",
      "This demo does not connect to an account, exchange or execution service.",
      "muted",
    ),
  );
  actions.hidden = false;
  for (const id of ["approve", "reject"])
    document.getElementById(id).onclick = () => {
      actions.hidden = true;
      status.textContent =
        id === "approve"
          ? "Demo confirmed · no trade submitted"
          : "Demo cancelled · no trade submitted";
      content.append(
        el(
          "p",
          "Return to chat to review or adjust a proposal. Real copy trading requires its own confirmation.",
          "muted",
        ),
      );
      announce(id === "approve" ? "demo_confirmed" : "demo_rejected");
    };
  announce("demo_ready");
}
async function start() {
  if (config.demo) {
    demo();
    return;
  }
  status.textContent = "Restoring Ride sign-in…";
  const url = new URL(location.href),
    query = url.searchParams;
  const intendedProvider = knownProvider(query.get("auth_provider"));
  if (intendedProvider) sessionStorage.setItem(providerKey, intendedProvider);
  if (query.has("error") && !query.has("privy_oauth_code")) {
    url.searchParams.delete("error");
    url.searchParams.delete("error_description");
    history.replaceState({}, "", url.href);
    showLogin();
    showError(
      Error("Ride sign-in was cancelled. Your proposal has not been changed."),
    );
    return;
  }
  try {
    if (query.get("privy_oauth_code") && query.get("privy_oauth_state")) {
      const c = await init();
      const session = await c.auth.oauth.loginWithCode(
        query.get("privy_oauth_code"),
        query.get("privy_oauth_state"),
        savedProvider().toLowerCase(),
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
    // Reuse an existing Privy session; provider OAuth starts only on a button click.
    if (!embedded && (await finish())) return;
    status.textContent = "";
    showLogin();
  } catch (e) {
    showLogin();
    if (missingStoredSession(e)) {
      status.textContent = "";
      status.className = "";
    } else
      showError(
        e?.code === "NOT_FOUND"
          ? Error(
              "This proposal is not available for this Ride account. Sign in with the account that created it.",
            )
          : e,
      );
  }
}
start();
