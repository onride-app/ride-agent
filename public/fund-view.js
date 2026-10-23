let client,
  initialization,
  csrf,
  user,
  funding,
  expiryTimer,
  pollTimer,
  popup,
  popupChallenge,
  signatureWait;
const embedded = config.embedded === true;
let pollRemaining = 6;
let busy = false,
  submissionUnknown = false;
const status = document.getElementById("status"),
  content = document.getElementById("content");
const node = (tag, text) => {
  const n = document.createElement(tag);
  if (text != null) n.textContent = String(text);
  return n;
};
const micros = (amount) => {
  if (!/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/.test(String(amount).trim()))
    return null;
  const [whole, fraction = ""] = String(amount).trim().split(".");
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
};
const showError = (e) => {
  status.textContent = e?.message ?? String(e);
  status.className = "warning error";
};
function announce(state) {
  if (embedded)
    window.parent.postMessage(
      {
        type: "ride:funding-state",
        deposit_id: config.deposit_id,
        status: state,
        height: Math.min(1400, Math.max(420, document.body.scrollHeight + 24)),
      },
      "*",
    );
}
const nonce = () =>
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
function openWalletPopup(mode, activation = false) {
  popupChallenge = nonce();
  const url = new URL(`/agent/fund/${config.deposit_id}`, location.origin);
  url.searchParams.set(mode, "1");
  url.hash = new URLSearchParams({
    challenge: popupChallenge,
    ...(mode === "card_sign"
      ? {
          preview_hash: activation
            ? funding.activation.preview_hash
            : funding.preview_hash,
          activation: String(activation),
        }
      : {}),
  }).toString();
  popup = window.open(
    url.href,
    `ride-funding-wallet-${popupChallenge}`,
    "popup,width=540,height=720",
  );
  if (!popup)
    throw Error(
      "Allow the Ride wallet connection window, then return to this card to confirm.",
    );
}
function requestSignature(activation) {
  // This opens synchronously from the inline approval click. The popup can
  // authenticate/sign only; it never calls funding_confirm or moves funds.
  openWalletPopup("card_sign", activation);
  return new Promise((resolve, reject) => {
    const closedTimer = setInterval(() => {
      if (!popup?.closed) return;
      clearInterval(closedTimer);
      clearTimeout(signatureWait?.timer);
      signatureWait = undefined;
      reject(
        Error(
          "Wallet signing was cancelled. Review the amount before confirming again.",
        ),
      );
    }, 500);
    const timer = setTimeout(() => {
      clearInterval(closedTimer);
      signatureWait = undefined;
      reject(
        Error(
          "Wallet signing timed out. No funding submission was requested by this card.",
        ),
      );
    }, 120000);
    signatureWait = {
      resolve,
      reject,
      timer,
      closedTimer,
      hash: activation ? funding.activation.preview_hash : funding.preview_hash,
    };
  });
}
async function init() {
  if (client) return client;
  if (initialization) return initialization;
  initialization = initialize();
  try {
    return await initialization;
  } finally {
    initialization = undefined;
  }
}
async function initialize() {
  const { default: Privy, LocalStorage } = await import(config.privy_sdk);
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.title = "Privy secure wallet";
  const next = new Privy({
    appId: config.privy_app_id,
    ...(config.privy_client_id ? { clientId: config.privy_client_id } : {}),
    storage: new LocalStorage(),
    embeddedWalletMessagePoster: {
      postMessage: (message, origin, transfer) =>
        iframe.contentWindow?.postMessage(message, origin, transfer),
      reload: () => {
        iframe.src = next.embeddedWallet.getURL();
      },
    },
  });
  const walletUrl = new URL(next.embeddedWallet.getURL());
  if (walletUrl.protocol !== "https:")
    throw Error("Secure wallet origin unavailable.");
  const onWalletMessage = (e) => {
    if (e.source !== iframe.contentWindow || e.origin !== walletUrl.origin)
      return;
    try {
      next.embeddedWallet.onMessage(
        typeof e.data === "string" ? JSON.parse(e.data) : e.data,
      );
    } catch {
      /* Unrelated frame message. */
    }
  };
  window.addEventListener("message", onWalletMessage);
  iframe.src = walletUrl.href;
  document.body.append(iframe);
  try {
    await next.initialize();
    client = next;
    return client;
  } catch (e) {
    window.removeEventListener("message", onWalletMessage);
    iframe.remove();
    throw e;
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
    body: JSON.stringify({
      ...(operation === "login" ? {} : { deposit_id: config.deposit_id }),
      ...body,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const out = await response.json();
  if (!response.ok) {
    const error = Error(out.error?.message ?? "Rider request failed.");
    error.code = out.error?.code;
    throw error;
  }
  return out;
}
function button(parent, text, action) {
  const b = node("button", text);
  b.onclick = async () => {
    if (busy) return;
    busy = true;
    const controls = [...content.querySelectorAll("button,input")];
    controls.forEach((control) => (control.disabled = true));
    status.textContent = "Checking…";
    try {
      await action();
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
      controls.forEach((control) => (control.disabled = false));
      updateConfirmation();
    }
  };
  parent.append(b);
  return b;
}
async function sign(challenge, activation = false) {
  if (embedded) return requestSignature(activation);
  await init();
  user ??= (await client.user.get()).user;
  if (
    !challenge ||
    Number(challenge.domain?.chainId) !== (activation ? 421614 : 42161)
  )
    throw Error("Funding signature is on an unexpected network.");
  if (
    activation
      ? challenge.primaryType !== "HyperliquidTransaction:ApproveAgent"
      : challenge.primaryType !== "Permit"
  )
    throw Error("Unsupported funding signature.");
  const accounts = user?.linked_accounts ?? user?.linkedAccounts ?? [];
  const owner = activation ? funding.signing_wallet : challenge.message?.owner;
  const wallet = accounts.find(
    (w) =>
      w.type === "wallet" &&
      (w.chain_type ?? w.chainType) === "ethereum" &&
      (w.wallet_client_type ?? w.walletClientType) === "privy" &&
      (!owner || w.address?.toLowerCase() === owner.toLowerCase()),
  );
  if (!wallet)
    throw Error("The signing wallet is not available in this Ride account.");
  if (!activation) {
    const [whole, fraction = ""] = funding.amount_usdc.split(".");
    const raw = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    if (
      challenge.domain.verifyingContract?.toLowerCase() !==
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831" ||
      challenge.message.spender?.toLowerCase() !==
        "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7" ||
      BigInt(challenge.message.value) !== raw
    )
      throw Error("Permit does not match the displayed funding amount.");
  } else if (challenge.message?.hyperliquidChain !== "Mainnet")
    throw Error("Unexpected account activation network.");
  const provider = await client.embeddedWallet.getProvider(wallet);
  return provider.request({
    method: "eth_signTypedData_v4",
    params: [wallet.address, JSON.stringify(challenge)],
  });
}
function display(value) {
  clearTimeout(expiryTimer);
  funding = value.data.funding;
  announce(funding.status);
  if (funding.status !== "requires_confirmation") submissionUnknown = false;
  content.replaceChildren();
  status.textContent = "";
  const c = node("section");
  c.className = "card";
  const actions = node("div");
  actions.className = "actions";
  c.append(
    node("h1", "Fund your trading account"),
    node(
      "p",
      `${funding.amount_usdc} USDC · Arbitrum · Account …${funding.account_suffix}`,
    ),
    node("p", `Status: ${funding.status}`),
    node(
      "p",
      "This moves only the displayed amount from your Ride funding wallet to your Hyperliquid trading account. Copy trading needs a separate confirmation.",
    ),
  );
  if (funding.status === "requires_confirmation") {
    const label = node("label", "Funding amount · USDC"),
      amount = node("input");
    amount.value = funding.amount_usdc;
    amount.inputMode = "decimal";
    label.append(amount);
    c.append(label);
    amount.id = "funding-amount";
    const renew = button(actions, "Review amount / refresh quote", async () => {
      if (submissionUnknown) return;
      display(
        await call("funding_prepare", { amount_usdc: amount.value.trim() }),
      );
      status.className = "warning";
      status.textContent =
        "Fresh quote ready. Review the amount and confirm again. No funds have been submitted.";
    });
    renew.dataset.action = "refresh-quote";
    const confirm = button(
      actions,
      "Confirm this amount and fund trading",
      async () => {
        const selected = funding;
        if (submissionUnknown || selected.expires_at <= Date.now()) {
          updateConfirmation();
          return;
        }
        const signature = selected.requires_signature
          ? await sign(selected.signing_challenge)
          : undefined;
        // A wallet prompt can outlive a quote. Never submit an expired signed
        // snapshot or replace it with a fresh quote without another approval.
        if (selected.expires_at <= Date.now()) {
          updateConfirmation();
          return;
        }
        submissionUnknown = true;
        announce("submitting");
        try {
          display(
            await call("funding_confirm", {
              preview_hash: selected.preview_hash,
              signature,
            }),
          );
        } catch (e) {
          if (
            [
              "FUNDING_QUOTE_EXPIRED",
              "FUNDING_CHANGED",
              "SIGNATURE_REQUIRED",
            ].includes(e.code)
          ) {
            submissionUnknown = false;
            if (e.code === "FUNDING_QUOTE_EXPIRED") selected.expires_at = 0;
            else display(await call("funding"));
          }
          if (submissionUnknown)
            e.message =
              "Submission result is unverified. Check this request's status; do not submit again.";
          if (submissionUnknown) announce("uncertain");
          throw e;
        }
        await check();
      },
    );
    confirm.dataset.action = "confirm-funding";
    amount.addEventListener("input", () => {
      updateConfirmation();
    });
  }
  button(actions, "Check trading balance", check);
  if (funding.activation?.status === "requires_confirmation")
    button(actions, "Confirm Ride trading-account activation", async () => {
      const a = funding.activation;
      const signature = a.requires_signature
        ? await sign(a.signing_challenge, true)
        : undefined;
      display(
        await call("funding_activate", {
          preview_hash: a.preview_hash,
          signature,
        }),
      );
      await check();
    });
  c.append(actions);
  if (funding.transaction_hash) {
    const transaction = node("p", `Transaction: ${funding.transaction_hash}`);
    transaction.className = "deposit-address";
    c.append(transaction);
  }
  content.append(c);
  updateConfirmation();
  announce(
    submissionUnknown
      ? "uncertain"
      : funding.status === "requires_confirmation" &&
          funding.expires_at <= Date.now()
        ? "quote_expired"
        : funding.status,
  );
}
function updateConfirmation() {
  const confirm = content.querySelector('[data-action="confirm-funding"]');
  const renew = content.querySelector('[data-action="refresh-quote"]');
  if (!confirm) return;
  const expired =
    !Number.isFinite(funding.expires_at) || funding.expires_at <= Date.now();
  const amount = document.getElementById("funding-amount");
  confirm.disabled =
    busy ||
    submissionUnknown ||
    expired ||
    micros(amount.value) !== micros(funding.amount_usdc);
  renew.disabled = busy || submissionUnknown;
  if (submissionUnknown) {
    announce("uncertain");
    status.className = "warning";
    status.textContent =
      "Submission result is unverified. Check this request's status; do not submit again.";
  } else if (expired) {
    announce("quote_expired");
    status.className = "warning";
    status.textContent =
      "This funding quote expired. Refresh the quote, review the amount, then confirm again. No transfer was submitted by this expired confirmation.";
  } else {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      updateConfirmation,
      Math.max(1, funding.expires_at - Date.now() + 1),
    );
  }
}
async function check() {
  clearTimeout(pollTimer);
  const out = await call("funding_status"),
    d = out.data.deposit_status;
  display(await call("funding"));
  const messages = {
    submitting: "Funding submission is processing. Do not submit again.",
    submitted:
      "Funding transaction submitted; trading credit is pending. Do not submit again.",
    uncertain:
      "Funding submission is unverified. Check status; do not submit again.",
    credited: "Funding credited to your trading account.",
    failed:
      "Funding transaction failed. Review the transaction before preparing another request.",
  };
  status.className = funding.status === "credited" ? "good" : "warning";
  status.textContent = `${messages[funding.status] ?? "Funding has not been submitted."} · Wallet: ${d.wallet_balance_usdc ?? "unavailable"} USDC · Trading available: ${d.trading_balance_usdc ?? "unavailable"} USDC · ${d.next_action ?? ""}`;
  updateConfirmation();
  content
    .querySelectorAll('[data-action="review-activation"]')
    .forEach((b) => b.remove());
  if (
    d.activation_required &&
    Number(d.trading_balance_usdc) > 0 &&
    !funding.activation
  ) {
    const b = node("button", "Review account activation");
    b.dataset.action = "review-activation";
    b.onclick = async () => {
      try {
        display(await call("funding_activation_quote"));
      } catch (e) {
        showError(e);
      }
    };
    content.append(b);
  }
  if (
    ["submitting", "submitted", "uncertain"].includes(funding.status) &&
    pollRemaining-- > 0
  )
    pollTimer = setTimeout(async () => {
      if (busy) return;
      try {
        await check();
      } catch (e) {
        showError(e);
      }
    }, 4000);
}
async function ready() {
  document.getElementById("login").hidden = true;
  const url = new URL(location.href);
  const params = new URLSearchParams(url.hash.slice(1));
  const challenge = params.get("challenge");
  if (
    !embedded &&
    (url.searchParams.get("card_login") === "1" ||
      url.searchParams.get("card_sign") === "1")
  ) {
    if (!window.opener || !/^[a-f0-9]{64}$/.test(challenge ?? ""))
      throw Error("Wallet connection expired. Reopen it from the chat card.");
    if (url.searchParams.get("card_login") === "1") {
      const { ticket } = await call("embed-ticket", { challenge });
      window.opener.postMessage(
        {
          type: "ride:funding-session",
          deposit_id: config.deposit_id,
          ticket,
          challenge,
        },
        location.origin,
      );
      status.textContent =
        "Ride connected. Return to the chat card to review and confirm funding.";
      return;
    }
    // Re-read the owned frozen quote at the signing origin. The model/outer
    // widget cannot supply a challenge, address, amount or signature to sign.
    funding = (await call("funding")).data.funding;
    const activation = params.get("activation") === "true";
    const selected = activation ? funding.activation : funding;
    if (
      !selected ||
      selected.preview_hash !== params.get("preview_hash") ||
      selected.status !== "requires_confirmation" ||
      selected.expires_at <= Date.now()
    )
      throw Object.assign(
        Error(
          "Funding quote changed or expired. Refresh it in the chat card and approve again.",
        ),
        { code: "FUNDING_QUOTE_EXPIRED" },
      );
    content.replaceChildren(
      node("h1", `Wallet signature · ${funding.amount_usdc} USDC`),
      node("p", `${funding.network} · Account …${funding.account_suffix}`),
    );
    status.textContent =
      "Confirm the wallet signature for the amount approved in the chat card.";
    const signature = await sign(
      activation ? selected.signing_challenge : funding.signing_challenge,
      activation,
    );
    window.opener.postMessage(
      {
        type: "ride:funding-signature",
        deposit_id: config.deposit_id,
        challenge,
        preview_hash: selected.preview_hash,
        signature,
      },
      location.origin,
    );
    status.textContent =
      "Wallet signed. Return to the chat card to see the submission result.";
    return;
  }
  display(await call("funding"));
  await check();
}
function showLogin() {
  const login = document.getElementById("login");
  login.hidden = false;
  if (embedded) {
    login.querySelector("h1").textContent =
      "Connect Ride to confirm funding here";
    document.getElementById("sign-in").textContent = "Connect Ride";
    document.getElementById("access-code").parentElement.hidden = true;
    announce("sign_in_required");
  }
}
window.addEventListener("message", async (event) => {
  if (
    !embedded ||
    event.origin !== location.origin ||
    !popup ||
    event.source !== popup
  )
    return;
  const msg = event.data;
  if (msg?.deposit_id !== config.deposit_id || msg.challenge !== popupChallenge)
    return;
  if (
    msg.type === "ride:funding-signature" &&
    signatureWait &&
    msg.preview_hash === signatureWait.hash &&
    /^0x[a-fA-F0-9]{130}$/.test(msg.signature ?? "")
  ) {
    clearTimeout(signatureWait.timer);
    clearInterval(signatureWait.closedTimer);
    signatureWait.resolve(msg.signature);
    signatureWait = undefined;
    popup.close();
    popup = undefined;
    popupChallenge = undefined;
  } else if (msg.type === "ride:funding-signature-error" && signatureWait) {
    clearTimeout(signatureWait.timer);
    clearInterval(signatureWait.closedTimer);
    const error = Object.assign(
      Error(
        msg.code === "FUNDING_QUOTE_EXPIRED"
          ? "Funding quote expired. Refresh it and approve again."
          : "Wallet signing did not complete. Review the amount before confirming again.",
      ),
      { code: msg.code },
    );
    if (msg.code === "FUNDING_QUOTE_EXPIRED") funding.expires_at = 0;
    signatureWait.reject(error);
    signatureWait = undefined;
    popup.close();
    popup = undefined;
    popupChallenge = undefined;
  } else if (msg.type === "ride:funding-session" && !signatureWait) {
    try {
      csrf = (
        await call("embed-session", {
          ticket: msg.ticket,
          challenge: popupChallenge,
        })
      ).csrf;
      popup.close();
      popup = undefined;
      popupChallenge = undefined;
      await ready();
    } catch (e) {
      showLogin();
      showError(e);
    }
  }
});
async function finish(session) {
  if (!session) {
    try {
      csrf = (await call("session")).csrf;
      await ready();
      return;
    } catch (e) {
      if (
        ![
          "AUTH_REQUIRED",
          "CSRF_REQUIRED",
          ...(embedded ? ["NOT_FOUND"] : []),
        ].includes(e.code)
      )
        throw e;
    }
  }
  if (embedded) {
    showLogin();
    return;
  }
  const c = await init();
  user = session?.user ?? (await c.user.get()).user;
  if (!user) return;
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  const wallet = accounts.find(
    (w) =>
      w.type === "wallet" &&
      (w.chain_type ?? w.chainType) === "ethereum" &&
      (w.wallet_client_type ?? w.walletClientType) === "privy",
  );
  const login = await call("login", {
    privyId: user.id,
    privyAccessToken: await c.getAccessToken(),
    walletAddress: wallet?.address,
    privyWalletId: wallet?.id,
    authProvider: "GOOGLE",
    accessCode: sessionStorage.getItem("ride:agent:access-code") ?? undefined,
  });
  csrf = login.csrf;
  sessionStorage.removeItem("ride:agent:access-code");
  await ready();
}
document.getElementById("sign-in").onclick = async () => {
  try {
    if (embedded) {
      openWalletPopup("card_login");
      return;
    }
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
  }
};
const query = new URL(location.href).searchParams;
try {
  if (query.get("privy_oauth_code") && query.get("privy_oauth_state")) {
    const c = await init();
    const session = await c.auth.oauth.loginWithCode(
      query.get("privy_oauth_code"),
      query.get("privy_oauth_state"),
      "google",
    );
    const clean = new URL(location.href);
    clean.searchParams.delete("privy_oauth_code");
    clean.searchParams.delete("privy_oauth_state");
    history.replaceState({}, "", clean.href);
    await finish(session);
  } else if (query.has("error")) showError(Error("Rider login declined."));
  else await finish();
} catch (e) {
  showLogin();
  showError(e);
  if (
    !embedded &&
    query.get("card_sign") === "1" &&
    window.opener &&
    !/no tokens found in storage/i.test(e?.message ?? "")
  ) {
    const challenge = new URLSearchParams(
      new URL(location.href).hash.slice(1),
    ).get("challenge");
    if (/^[a-f0-9]{64}$/.test(challenge ?? ""))
      window.opener.postMessage(
        {
          type: "ride:funding-signature-error",
          deposit_id: config.deposit_id,
          challenge,
          code:
            e.code === "FUNDING_QUOTE_EXPIRED" ? e.code : "SIGNATURE_CANCELLED",
        },
        location.origin,
      );
  }
}
