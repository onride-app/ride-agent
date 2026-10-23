// Loopback-only acceptance: all wallet, signature, balance and transfer data
// below are fictional. No provider, production token or worker is connected.
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createRideHttpApp } from "../src/http_security.js";
import { backendApp } from "../src/agent/backend.js";
import { AgentService } from "../src/agent/service.js";
import { FakeAdapter } from "../src/agent/fixtures.js";
import { MemoryRepository, Cursor } from "../src/agent/repository.js";
import { mountHumanConfirmation } from "../src/agent/human.js";

const port = Number(process.env.RIDE_FUNDING_PREVIEW_PORT ?? 17843);
const base = `http://127.0.0.1:${port}`;
const repository = new MemoryRepository(),
  adapter = new FakeAdapter();
const deposit = {
  id: "deposit_" + "a".repeat(32),
  market: "perps" as const,
  asset: "USDC" as const,
  network: "Arbitrum",
  address: "0x" + "5".repeat(40),
  provider: "wallet" as const,
  created_at: Date.now(),
};
let quoted = 0,
  submitted = 0,
  credited = false,
  lost = false,
  signatures = 0;
let publicFunding: any;
const counts = { real_transfers: 0, login_exchanges: 0 };
adapter.depositStatus = async () => ({
  wallet_balance_usdc: credited ? "0" : "30",
  trading_balance_usdc: credited ? "35" : "5",
  available_to_copy: credited,
  funding_credit_verified: credited,
  trading_account_ready: credited,
});
adapter.fundingOperation = async (operation, _user, input) => {
  if (operation === "submit") {
    submitted++;
    if (lost) throw Error("Simulated response loss");
    credited = true;
    return {
      submitted: true,
      transaction_hash: "0x" + "a".repeat(64),
      receipt_status: "0x1",
    };
  }
  quoted++;
  return {
    amount_usdc: input.amount_usdc,
    wallet: { master: deposit.address },
    requires_signature: true,
    permit_nonce: String(quoted),
    permit_deadline: Math.floor(Date.now() / 1000) + 300,
    typed_data: {
      domain: {
        chainId: 42161,
        verifyingContract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      },
      primaryType: "Permit",
      message: {
        owner: deposit.address,
        spender: "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
        value: "30000000",
      },
    },
  };
};
const service = new AgentService(
  repository,
  adapter,
  base,
  new Cursor("fixture".repeat(8)),
);
const backend = backendApp(
  service,
  async (token) => {
    if (token !== "local-funding-core") throw Error("Fixture auth required");
    return "fixture";
  },
  "127.0.0.1",
).listen(0, "127.0.0.1");
await once(backend, "listening");
const app = createRideHttpApp("127.0.0.1");
mountHumanConfirmation(app, {
  base,
  backend: `http://127.0.0.1:${(backend.address() as any).port}`,
  cookieKey: "local-funding-fixture-only-".repeat(2),
  frameAncestors: ["'self'"],
  auth: {
    privyAppId: "local-fixture",
    privyClientId: "",
    jsSdkUrl: `${base}/fixture/privy.js`,
    manualTokenAuthEnabled: false,
  },
  exchange: async (input) => {
    if (input.privyAccessToken !== "local-funding-privy")
      throw Error("Fixture auth required");
    counts.login_exchanges++;
    return { rideAuthToken: "local-funding-core" };
  },
});
async function reset(expired = false) {
  credited = false;
  lost = false;
  submitted = 0;
  quoted = 0;
  signatures = 0;
  await repository.transact("fixture", async (s) => {
    s.deposits = [structuredClone(deposit)];
  });
  publicFunding = (await service.funding.prepare("fixture", deposit.id, "30"))
    .data.funding;
  if (expired)
    await repository.transact("fixture", async (s) => {
      s.deposits![0].funding!.expires_at = Date.now() - 1000;
    });
  if (expired) publicFunding.expires_at = Date.now() - 1000;
}
await reset(true);
app.post("/fixture/reset", async (req, res) => {
  await reset(req.body.expired !== false);
  lost = req.body.lost === true;
  res.json({ fixture: true });
});
app.post("/fixture/signature", (_req, res) => {
  signatures++;
  res.json({ signature: "0x" + "b".repeat(130) });
});
app.get("/fixture/status", (_req, res) =>
  res.json({ ...counts, quoted, submitted, signatures, credited }),
);
app.get("/fixture/privy.js", (_req, res) =>
  res.type("js").send(`
const user = { id: "fixture", linked_accounts: [{ type: "wallet", chain_type: "ethereum", wallet_client_type: "privy", address: "${deposit.address}" }] };
export class LocalStorage {}
export default class Privy {
  user = { get: async () => ({ user }) };
  initialize = async () => {};
  getAccessToken = async () => "local-funding-privy";
  auth = { oauth: { generateURL: async () => ({ url: location.href }), loginWithCode: async () => ({ user }) } };
  embeddedWallet = { getURL: () => "https://wallet.test.invalid/fixture", onMessage() {}, getProvider: async () => ({ request: async () => (await (await fetch("/fixture/signature", {method:"POST"})).json()).signature }) };
}`),
);
app.get("/fixture/widget", async (_req, res) => {
  const funding = publicFunding;
  const html = (await readFile("public/agent.html", "utf8"))
    .replace("/*HOST_CONFIG*/{}", JSON.stringify({ confirmation_origin: base }))
    .replace(
      "<script",
      `<script>window.openai={toolOutput:${JSON.stringify({ version: "3", status: "requires_confirmation", data: { funding } })},callTool:async()=>{},setWidgetState:(value)=>parent.postMessage({fixture_state:value},"*")};</script><script`,
    );
  res.removeHeader("X-Frame-Options");
  res.set(
    "Content-Security-Policy",
    "base-uri 'self'; frame-ancestors 'self'; object-src 'none'",
  );
  res.type("html").send(html);
});
app.get("/", (_req, res) =>
  res.type("html")
    .send(`<!doctype html><html><head><title>Fictional inline funding acceptance</title><style>body{font:16px system-ui;margin:30px;background:#f5f5f5}iframe{width:100%;height:1000px;border:1px solid #ddd;background:white}</style></head><body><h1>Local funding fixture · no real transfers</h1><p>Expired quotes, inline approval, wallet signing and verified credit use fictional data.</p><button id="expired">Expired quote</button> <button id="fresh">Fresh quote</button> <button id="lost">Lost submission response</button><p id="result">No approval yet</p><iframe title="AI conversation funding card" src="/fixture/widget"></iframe><script>
window.addEventListener("message",e=>{if(e.origin===location.origin&&e.data?.fixture_state)document.getElementById("result").textContent=JSON.stringify(e.data.fixture_state)});
for(const [id,options] of [["expired",{expired:true}],["fresh",{expired:false}],["lost",{expired:false,lost:true}]])document.getElementById(id).onclick=async()=>{await fetch("/fixture/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(options)});document.querySelector("iframe").src="/fixture/widget?"+Date.now()};
</script></body></html>`),
);
const server = app.listen(port, "127.0.0.1");
await once(server, "listening");
console.log(`Funding fixture: ${base} (fictional only)`);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
    backend.close();
    backend.closeAllConnections();
  });
