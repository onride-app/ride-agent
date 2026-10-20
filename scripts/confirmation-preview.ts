// Loopback-only browser acceptance. No venue adapter, production credential,
// account or execution worker is imported or contacted by this fixture.
import { readFile } from "node:fs/promises";
import express from "express";
import { mountHumanConfirmation } from "../src/agent/human.js";
import { createRideHttpApp } from "../src/http_security.js";

const port = Number(process.env.RIDE_CONFIRM_PREVIEW_PORT ?? 17842);
const base = `http://127.0.0.1:${port}`;
const proposalId = "proposal_browser_fixture_00000000";
const counts = {
  login_exchanges: 0,
  proposal_reads: 0,
  mock_confirmations: 0,
  real_orders: 0,
};
const proposal = {
  id: proposalId,
  action: "start_copy",
  status: "requires_confirmation",
  arguments: {
    fixture: true,
    budget_usdc: "20",
    traders: ["fixture-A", "fixture-B"],
  },
  actual_portfolio_state: null,
  execution_state: "not_submitted",
  preview: {
    state_semantics: "projected_after_confirmation",
    loss_trigger_amount_usdc: "2.000000",
    fees: { estimate_usdc: null },
    portfolio: {
      portfolio: {
        projected_state: "activating",
        reserved_usdc: "0.000000",
        sleeves: ["A", "B"].map((name) => ({
          copy_id: `fixture-${name}`,
          trader: { handle: `Fixture trader ${name}`, market: "perps" },
          amount_usdc: "10.000000",
          leverage_cap: 3,
          leverage_cap_source: "inherited",
          projected_state: "active",
          stop_loss_pct: 30,
          loss_policy: "pause_then_exit",
          emergency_exit_pct: 70,
        })),
      },
    },
  },
  preview_hash: "a".repeat(64),
  expires_at: Date.now() + 60 * 60_000,
  confirmation_url: `${base}/agent/confirm/${proposalId}`,
};
const result = () => ({
  version: "3",
  status: "ok",
  data: { proposal },
  warnings: [],
  as_of: new Date().toISOString(),
});
const backend = express();
backend.use(express.json());
backend.post("/agent/human/:operation", (req, res) => {
  if (req.get("authorization") !== "Bearer local-fixture-core") {
    res.status(401).json({
      error: { code: "AUTH_REQUIRED", message: "Fixture identity required" },
    });
    return;
  }
  if (req.body.proposal_id !== proposalId) {
    res.status(404).json({ error: { code: "NOT_FOUND" } });
    return;
  }
  if (req.params.operation === "proposal") counts.proposal_reads++;
  else if (req.params.operation === "confirm") {
    if (req.body.preview_hash !== proposal.preview_hash) {
      res.status(409).json({ error: { code: "CONFLICT" } });
      return;
    }
    counts.mock_confirmations++;
    proposal.status = "queued";
  } else if (req.params.operation === "reject") proposal.status = "rejected";
  else {
    res.status(404).end();
    return;
  }
  res.json(result());
});
const listener = backend.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => listener.once("listening", resolve));
const app = createRideHttpApp("127.0.0.1");
mountHumanConfirmation(app, {
  base,
  backend: `http://127.0.0.1:${(listener.address() as any).port}`,
  cookieKey: "local-confirmation-fixture-only-".repeat(2),
  frameAncestors: ["'self'", `http://localhost:${port}`],
  auth: {
    privyAppId: "local-fixture",
    privyClientId: "",
    jsSdkUrl: `${base}/fixture/privy.js`,
    manualTokenAuthEnabled: false,
  },
  exchange: async (input) => {
    if (input.privyAccessToken !== "local-fixture-privy")
      throw Error("Fixture token required");
    counts.login_exchanges++;
    return { rideAuthToken: "local-fixture-core" };
  },
});
app.get("/fixture/privy.js", (_req, res) =>
  res.type("js").send(`
export class LocalStorage {}
export default class Privy {
  async initialize() {}
  user = { get: async () => {
    if (new URL(location.href).searchParams.get('fixture') === 'missing-session') throw Error('No tokens found in storage');
    return ({ user: { id: 'local-fixture-user', linkedAccounts: [
    { type:'wallet', chainType:'ethereum', walletClientType:'privy', address:'0x'+'1'.repeat(40), id:'local-fixture-wallet' }
  ] } }); } };
  async getAccessToken() { return 'local-fixture-privy'; }
  auth = { oauth: { generateURL: async () => { throw Error('Unexpected Google redirect in local acceptance'); } } };
}`),
);
app.get("/fixture/status", (_req, res) =>
  res.json({ ...counts, proposal_status: proposal.status }),
);
// A real postMessage host, with no OpenAI shim. Deliberately collides the
// host ping id with the app's initialize id before returning initialization.
app.get("/fixture/protocol-host", (_req, res) => {
  const data = {
    version: "3",
    status: "ok",
    warnings: [],
    data: {
      confirmation_demo: true,
      proposal: {
        id: "proposal_card_demo_00000000",
        action: "demo",
        status: "requires_confirmation",
        arguments: { amount_usdc: "0", execution: "disabled" },
        confirmation_url: `${base}/agent/card-demo`,
      },
    },
  };
  res.type("html")
    .send(`<!doctype html><meta charset="utf-8"><title>Ride protocol fixture · 0 USDC</title>
<h1>Ride 协议回归 · 0 USDC · 不连接账户</h1><p id="status">正在等待初始化</p><p id="height">卡片高度 150 px</p>
<iframe id="app" title="Ride protocol app" src="/fixture/protocol-app" style="width:740px;height:150px;border:1px solid #ddd"></iframe>
<button id="teardown">关闭模拟卡片</button><script>
const frame=document.getElementById('app');let initializeId;let pongs=0;
const send=data=>frame.contentWindow.postMessage({jsonrpc:'2.0',...data},location.origin);
window.addEventListener('message',event=>{
 if(event.source!==frame.contentWindow||event.origin!==location.origin)return;
 const m=event.data;
 if(m.method==='ui/initialize'){initializeId=m.id;send({id:m.id,method:'ping'});}
 else if(m.id===initializeId&&m.result){pongs++;send({id:initializeId,result:{protocolVersion:'2026-01-26',hostCapabilities:{openLinks:{}},hostInfo:{name:'Ride protocol fixture',version:'1'}}});initializeId=undefined;}
 else if(m.method==='ui/notifications/initialized'){document.getElementById('status').textContent='初始化与同 ID 心跳通过 · 无金融操作';send({method:'ui/notifications/tool-result',params:{structuredContent:${JSON.stringify(data).replaceAll("<", "\\u003c")}}});send({id:'healthy',method:'ping'});}
 else if(m.id==='healthy'&&m.result){pongs++;document.getElementById('status').textContent+=' · 心跳响应 '+pongs;}
 else if(m.method==='ui/notifications/size-changed'){frame.style.height=m.params.height+'px';document.getElementById('height').textContent='卡片高度 '+m.params.height+' px';}
 else if(m.id==='teardown'&&m.result){frame.remove();document.getElementById('status').textContent='关闭握手通过 · 无金融操作';}
 else if(m.method==='ui/open-link'){const url=new URL(m.params.url);if(url.origin===location.origin){window.open(url.href,'ride-protocol-demo');send({id:m.id,result:{}});}}
});
document.getElementById('teardown').onclick=()=>send({id:'teardown',method:'ui/resource-teardown'});
</script>`);
});
app.get("/fixture/protocol-app", async (_req, res) => {
  // Fixture only: the production resource is supplied by an MCP Apps host.
  res.removeHeader("X-Frame-Options");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res
    .type("html")
    .send(
      (await readFile("public/agent.html", "utf8")).replace(
        "/*HOST_CONFIG*/{}",
        JSON.stringify({ confirmation_origin: base }),
      ),
    );
});
app.get("/fixture/host", async (req, res) => {
  const demo = req.query.mode !== "proposal";
  const data = demo
    ? {
        version: "3",
        status: "ok",
        data: {
          confirmation_demo: true,
          proposal: {
            ...proposal,
            id: "proposal_card_demo_00000000",
            action: "demo",
            arguments: { amount_usdc: "0", execution: "disabled" },
          },
        },
        warnings: [],
        as_of: new Date().toISOString(),
      }
    : result();
  const html = (await readFile("public/agent.html", "utf8"))
    .replace("/*HOST_CONFIG*/{}", JSON.stringify({ confirmation_origin: base }))
    .replace(
      "<head>",
      `<head>${req.query.frame === "blocked" ? '<meta http-equiv="Content-Security-Policy" content="frame-src \'none\'">' : ""}<script>window.openai={toolOutput:${JSON.stringify(data).replaceAll("<", "\\u003c")},openExternal:async({href})=>{if(new URL(href).origin!==${JSON.stringify(base)})throw Error('Fixture links must stay local');window.open(href,'ride-fixture-page')},callTool:async()=>{throw Error('Fixture has no account tools')}};</script>`,
    );
  res.type("html").send(html);
});
app.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      base,
      demo: `${base}/fixture/host`,
      proposal: `${base}/agent/confirm/${proposalId}`,
    }),
  ),
);
