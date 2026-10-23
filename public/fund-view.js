let client, csrf, user, funding;
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
async function init() {
  if (client) return client;
  const { default: Privy, LocalStorage } = await import(config.privy_sdk);
  const iframe = document.createElement("iframe");
  iframe.hidden = true;
  iframe.title = "Privy secure wallet";
  client = new Privy({
    appId: config.privy_app_id,
    ...(config.privy_client_id ? { clientId: config.privy_client_id } : {}),
    storage: new LocalStorage(),
    embeddedWalletMessagePoster: {
      postMessage: (message, origin, transfer) =>
        iframe.contentWindow?.postMessage(message, origin, transfer),
      reload: () => {
        iframe.src = client.embeddedWallet.getURL();
      },
    },
  });
  const walletUrl = new URL(client.embeddedWallet.getURL());
  if (walletUrl.protocol !== "https:")
    throw Error("Secure wallet origin unavailable.");
  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow || e.origin !== walletUrl.origin)
      return;
    try {
      client.embeddedWallet.onMessage(
        typeof e.data === "string" ? JSON.parse(e.data) : e.data,
      );
    } catch {
      /* Unrelated frame message. */
    }
  });
  iframe.src = walletUrl.href;
  document.body.append(iframe);
  await client.initialize();
  return client;
}
async function call(operation, body = {}) {
  const response = await fetch(`/agent/human/${operation}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-Ride-CSRF": csrf } : {}),
    },
    body: JSON.stringify({
      ...(operation === "login" ? {} : { deposit_id: config.deposit_id }),
      ...body,
    }),
  });
  const out = await response.json();
  if (!response.ok) throw Error(out.error?.message ?? "Rider request failed.");
  return out;
}
function button(parent, text, action) {
  const b = node("button", text);
  b.onclick = async () => {
    b.disabled = true;
    status.textContent = "Checking…";
    try {
      await action();
    } catch (e) {
      showError(e);
    } finally {
      b.disabled = false;
    }
  };
  parent.append(b);
  return b;
}
async function sign(challenge, activation = false) {
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
  funding = value.data.funding;
  content.replaceChildren();
  status.textContent = "";
  const c = node("section");
  c.className = "card";
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
    button(c, "Review changed amount", async () =>
      display(
        await call("funding_prepare", { amount_usdc: amount.value.trim() }),
      ),
    );
    const confirm = button(
      c,
      "Confirm this amount and fund trading",
      async () => {
        const signature = funding.requires_signature
          ? await sign(funding.signing_challenge)
          : undefined;
        display(
          await call("funding_confirm", {
            preview_hash: funding.preview_hash,
            signature,
          }),
        );
        await check();
      },
    );
    amount.addEventListener("input", () => {
      confirm.disabled = micros(amount.value) !== micros(funding.amount_usdc);
    });
  }
  button(c, "Check trading balance", check);
  if (funding.activation?.status === "requires_confirmation")
    button(c, "Confirm Ride trading-account activation", async () => {
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
  if (funding.transaction_hash) {
    const transaction = node("p", `Transaction: ${funding.transaction_hash}`);
    transaction.className = "deposit-address";
    c.append(transaction);
  }
  content.append(c);
}
async function check() {
  const out = await call("funding_status"),
    d = out.data.deposit_status;
  if (d.funding_status && d.funding_status !== funding.status)
    display(await call("funding"));
  status.className = d.available_to_copy ? "" : "warning";
  status.textContent = `${d.available_to_copy || d.trading_account_ready ? "Trading balance verified" : "Trading credit or activation pending"} · Wallet: ${d.wallet_balance_usdc ?? "unavailable"} USDC · Trading available: ${d.trading_balance_usdc ?? "unavailable"} USDC · ${d.next_action}`;
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
}
async function finish(session) {
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
  let saved;
  if (!session) {
    const response = await fetch("/agent/human/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.ok) saved = await response.json();
    else if (response.status !== 401 && response.status !== 403)
      throw Error("Could not restore the Ride session. Please retry.");
  }
  const login =
    saved ??
    (await call("login", {
      privyId: user.id,
      privyAccessToken: await c.getAccessToken(),
      walletAddress: wallet?.address,
      privyWalletId: wallet?.id,
      authProvider: "GOOGLE",
      accessCode: sessionStorage.getItem("ride:agent:access-code") ?? undefined,
    }));
  csrf = login.csrf;
  sessionStorage.removeItem("ride:agent:access-code");
  document.getElementById("login").hidden = true;
  display(await call("funding"));
  await check();
}
document.getElementById("sign-in").onclick = async () => {
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
  }
};
const query = new URL(location.href).searchParams;
try {
  const c = await init();
  if (query.get("privy_oauth_code") && query.get("privy_oauth_state")) {
    const session = await c.auth.oauth.loginWithCode(
      query.get("privy_oauth_code"),
      query.get("privy_oauth_state"),
      "google",
    );
    history.replaceState({}, "", location.pathname);
    await finish(session);
  } else if (query.has("error")) showError(Error("Rider login declined."));
  else await finish();
} catch (e) {
  showError(e);
}
