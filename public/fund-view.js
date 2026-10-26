let client,
  initialization,
  csrf,
  user,
  funding,
  expiryTimer,
  pollTimer,
  walletBridge,
  walletConnection,
  walletStorage;
let walletState = "idle";
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
  iframe.loading = "eager";
  iframe.title = "Privy secure wallet";
  const bridge = {
    loaded: false,
    waiters: new Set(),
    waitForLoad() {
      if (bridge.loaded) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          bridge.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          bridge.waiters.delete(done);
          reject(
            Error(
              "Secure wallet could not load. Check your connection, then reconnect the signing wallet. No funding was submitted.",
            ),
          );
        }, 45000);
        bridge.waiters.add(done);
      });
    },
  };
  iframe.addEventListener("load", () => {
    bridge.loaded = true;
    for (const done of [...bridge.waiters]) done();
  });
  const next = new Privy({
    appId: config.privy_app_id,
    ...(config.privy_client_id ? { clientId: config.privy_client_id } : {}),
    storage: walletStorage ?? new LocalStorage(),
    embeddedWalletMessagePoster: {
      postMessage: (message, _origin, transfer) =>
        iframe.contentWindow?.postMessage(message, walletUrl.origin, transfer),
      reload: () => {
        bridge.loaded = false;
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
    bridge.dispose = () => {
      window.removeEventListener("message", onWalletMessage);
      iframe.remove();
    };
    walletBridge = bridge;
    return client;
  } catch (e) {
    window.removeEventListener("message", onWalletMessage);
    iframe.remove();
    throw e;
  }
}
async function connectWallet(reconnect = false) {
  if (walletConnection) return walletConnection;
  if (walletState === "ready" && !reconnect) return;
  walletState = "connecting";
  updateConfirmation();
  walletConnection = (async () => {
    try {
      const c = await init();
      if (reconnect) c.embeddedWallet.reload();
      // The SDK's signing timeout includes waitForReady(). Load the frame and
      // verify its message bridge before starting that short signing window.
      await walletBridge.waitForLoad();
      if (!(await c.embeddedWallet.ping(10000)))
        throw Error(
          "Secure wallet did not respond. Check your connection, then reconnect the signing wallet. No funding was submitted.",
        );
      walletState = "ready";
    } catch (e) {
      walletState = "failed";
      throw e;
    } finally {
      updateConfirmation();
    }
  })();
  try {
    return await walletConnection;
  } finally {
    walletConnection = undefined;
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
  await connectWallet();
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
  const selected = activation ? funding.activation : funding;
  if (selected.expires_at <= Date.now())
    throw Object.assign(
      Error(
        "Funding quote expired while connecting the wallet. Refresh it and review the amount again.",
      ),
      { code: "FUNDING_QUOTE_EXPIRED" },
    );
  const provider = await client.embeddedWallet.getProvider(wallet);
  try {
    return await provider.request({
      method: "eth_signTypedData_v4",
      params: [wallet.address, JSON.stringify(challenge)],
    });
  } catch (e) {
    if (/timeout|timed out/i.test(e?.message ?? "")) {
      walletState = "failed";
      e.message =
        "Wallet signing timed out before a funding submission. Reconnect the signing wallet, then review the quote before confirming again.";
      updateConfirmation();
    }
    throw e;
  }
}
function needsWalletConnection() {
  return (
    !submissionUnknown &&
    ((funding.status === "requires_confirmation" &&
      funding.requires_signature) ||
      (funding.activation?.status === "requires_confirmation" &&
        funding.activation.requires_signature))
  );
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
  if (needsWalletConnection()) {
    const connection = node("p");
    connection.id = "wallet-connection";
    c.append(connection);
    const connect = button(actions, "Reconnect signing wallet", async () => {
      if (embedded) await connectInline();
      else await connectWallet(true);
      status.className = "warning";
      status.textContent =
        "Signing wallet connected. Review the amount and funding status before confirming.";
    });
    connect.dataset.action = "connect-wallet";
  }
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
  if (!embedded && needsWalletConnection() && walletState === "idle")
    void connectWallet().catch(showError);
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
  const connection = content.querySelector('[id="wallet-connection"]');
  const connect = content.querySelector('[data-action="connect-wallet"]');
  if (connection)
    connection.textContent = {
      idle: "Signing wallet has not connected yet.",
      connecting: "Connecting signing wallet… No transfer is being submitted.",
      ready: "Signing wallet connected.",
      failed:
        "Signing wallet connection failed. Reconnect before confirming funding.",
    }[walletState];
  if (connect) connect.disabled = busy || walletState === "connecting";
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
    (funding.requires_signature && walletState !== "ready") ||
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
    document.getElementById("sign-in").textContent =
      "Connect Ride in this card";
    document.getElementById("sign-in-apple").hidden = true;
    announce("sign_in_required");
  }
}
async function connectInline() {
  // Request only Ride's own browser session, directly from this human click.
  // No session material or signature is sent to the outer MCP App/model.
  if (document.requestStorageAccess) {
    try {
      const handle = await document.requestStorageAccess({
        cookies: true,
        localStorage: true,
      });
      if (handle?.localStorage) {
        if (initialization) await initialization;
        if (walletConnection) await walletConnection.catch(() => {});
        walletBridge?.dispose();
        client = user = walletBridge = undefined;
        walletState = "idle";
        const storage = handle.localStorage;
        walletStorage = {
          async get(key) {
            const value = storage.getItem(key);
            return value === null ? undefined : JSON.parse(value);
          },
          put(key, value) {
            if (value === undefined) storage.removeItem(key);
            else storage.setItem(key, JSON.stringify(value));
          },
          del: (key) => storage.removeItem(key),
          getKeys: () => Object.keys(storage),
        };
      }
    } catch {
      // A partitioned session may already exist. Try it without opening a page.
    }
  }
  const c = await init();
  try {
    user = (await c.user.get()).user;
  } catch {
    user = undefined;
  }
  if (!user)
    throw Error(
      "This client cannot restore your Ride signing session inside the card. No page was opened and no funds were submitted.",
    );
  const accounts = user.linked_accounts ?? user.linkedAccounts ?? [];
  const wallet = accounts.find(
    (w) =>
      w.type === "wallet" &&
      (w.chain_type ?? w.chainType) === "ethereum" &&
      (w.wallet_client_type ?? w.walletClientType) === "privy",
  );
  csrf = (
    await call("embedded-login", {
      privyId: user.id,
      privyAccessToken: await c.getAccessToken(),
      walletAddress: wallet?.address,
      privyWalletId: wallet?.id,
      authProvider: loginProvider(user),
    })
  ).csrf;
  await ready();
  if (needsWalletConnection()) await connectWallet(walletState === "failed");
}
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
    authProvider: loginProvider(user),
  });
  csrf = login.csrf;
  await ready();
}
function loginProvider(currentUser) {
  const stored = sessionStorage.getItem("ride:auth:provider");
  if (stored === "GOOGLE" || stored === "APPLE") return stored;
  if (stored != null) throw Error("Choose Google or Apple to restart sign-in.");
  const accounts =
    currentUser?.linked_accounts ?? currentUser?.linkedAccounts ?? [];
  return accounts.some((a) => a.type === "apple_oauth" || a.type === "apple") &&
    !accounts.some((a) => a.type === "google_oauth" || a.type === "google")
    ? "APPLE"
    : "GOOGLE";
}
async function startLogin(provider) {
  try {
    if (embedded) {
      await connectInline();
      return;
    }
    sessionStorage.setItem("ride:auth:provider", provider);
    const c = await init();
    sessionStorage.setItem("ride:mcp:oauth_authorize_url", location.href);
    const out = await c.auth.oauth.generateURL(
      provider.toLowerCase(),
      `${location.origin}/auth/privy/oauth/callback`,
    );
    location.assign(out.url);
  } catch (e) {
    showError(e);
  }
}
document.getElementById("sign-in").onclick = () => startLogin("GOOGLE");
document.getElementById("sign-in-apple").onclick = () => startLogin("APPLE");
const query = new URL(location.href).searchParams;
try {
  if (query.get("privy_oauth_code") && query.get("privy_oauth_state")) {
    const c = await init();
    const session = await c.auth.oauth.loginWithCode(
      query.get("privy_oauth_code"),
      query.get("privy_oauth_state"),
      loginProvider().toLowerCase(),
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
