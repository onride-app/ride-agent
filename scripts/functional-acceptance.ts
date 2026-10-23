import { compatibility } from "../src/agent/conversational.js";
// Functional acceptance: real MCP gateway + CLI + HTTP + PostgreSQL;
// only authentication identity and exchange reads/fills are simulated.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { backendApp, validateCoreIdentity } from "../src/agent/backend.js";
import { PgRepository, Cursor } from "../src/agent/repository.js";
import { AgentService } from "../src/agent/service.js";
import { AgentRunner } from "../src/agent/runner.js";
import { candidate, snapshot } from "../src/agent/fixtures.js";
import {
  D,
  now,
  cash,
  type Portfolio,
  type Execution,
  type Candidate,
  type AccountSnapshot,
} from "../src/agent/domain.js";
import type { VenueAdapter } from "../src/agent/adapter.js";
import { saveSession } from "../src/cli/session.js";

const run = promisify(execFile),
  root = resolve("."),
  results: any[] = [],
  requests: any[] = [];
const databaseUrl = process.env.RIDE_AGENT_FUNCTIONAL_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Set RIDE_AGENT_FUNCTIONAL_DATABASE_URL to an isolated disposable PostgreSQL database.",
  );
const temp = await mkdtemp(join(tmpdir(), "ride-functional-"));
const repo = new PgRepository(databaseUrl);
const users = {
  alice: randomUUID(),
  preferences: randomUUID(),
  funding: randomUUID(),
  bob: randomUUID(),
  unknown: randomUUID(),
  loss: randomUUID(),
  entry: randomUUID(),
  authority: randomUUID(),
  sleeveLoss: randomUUID(),
  replacement: randomUUID(),
  guard: randomUUID(),
  windDown: randomUUID(),
  prediction: randomUUID(),
  both: randomUUID(),
  preview: randomUUID(),
  v17: randomUUID(),
  v17Single: randomUUID(),
  v17Rwa: randomUUID(),
  widget: randomUUID(),
};
const identities = new Map(
  Object.entries(users).map(([name, id]) => ["fixture_core_" + name, id]),
);
const servers: any[] = [];
let gateway: ReturnType<typeof spawn> | undefined;
let gatewayLogs = "";
const clients: Client[] = [];
let unknownClient: Client;
let widgetClient: Client;
const reportPath = resolve("output/deployment/functional-acceptance.json");
async function listen(app: any) {
  const s = app.listen(0, "127.0.0.1");
  servers.push(s);
  await new Promise<void>((r) => s.once("listening", r));
  return `http://127.0.0.1:${s.address().port}`;
}
class SimulatedVenue implements VenueAdapter {
  pool: Candidate[] = [1, 2, 3, 4, 5, 6].map((i) => ({
    ...candidate(i),
    source_drawdown_pct: 2,
  }));
  bank = new Map<string, AccountSnapshot>();
  available = new Map<string, string>();
  tasks = new Map<string, { user: string; e: Execution; status: any }>();
  submits: any[] = [];
  notices: any[] = [];
  fences = 0;
  releases = 0;
  factor = "1";
  sourceRev = 1;
  entryPrice = "100";
  loseResponse = false;
  accountFor(user: string) {
    if (!this.bank.has(user))
      this.bank.set(user, {
        ...snapshot(),
        account_id: "account_" + user.replaceAll("-", ""),
        quantity_decimals: { "perps:BTC": 8, "perps:ETH": 8 },
      });
    return this.bank.get(user)!;
  }
  mark(user: string) {
    const s = this.accountFor(user);
    s.account_value_usdc = cash(
      D(500)
        .plus(
          s.fills.reduce(
            (n, f) =>
              n
                .plus(D(f.quantity).times(D(s.prices[f.key]).minus(f.price)))
                .minus(f.fee_usdc),
            D(0),
          ),
        )
        .plus(s.funding.reduce((n, f) => n.plus(f.amount_usdc), D(0))),
    );
    s.available_usdc = this.available.get(user) ?? s.account_value_usdc;
    s.observed_at = now();
  }
  async depositOptions() {
    return {
      routes: [
        {
          market: "perps",
          asset: "USDC",
          network: "Arbitrum",
          activation_required: true,
        },
      ],
    };
  }
  async depositAddress(user: string, input: any) {
    return {
      id: "deposit_" + randomUUID().replaceAll("-", ""),
      market: input.market,
      asset: input.asset,
      network: input.network,
      address: "0x" + "5".repeat(40),
      provider: "wallet" as const,
      created_at: now(),
    };
  }
  fundingOperation?: VenueAdapter["fundingOperation"];
  async depositStatus(deposit: any): Promise<any> {
    return {
      deposit_id: deposit.id,
      status: "awaiting_deposit",
      available_to_copy: false,
    };
  }
  async candidates() {
    return structuredClone(this.pool);
  }
  async profile(id: string) {
    const c = this.pool.find((c) => c.id === id);
    if (!c) throw Error("Trader not found");
    return structuredClone(c);
  }
  async preflight(user: string) {
    this.mark(user);
    return structuredClone(this.accountFor(user));
  }
  async bind(user: string) {
    return this.preflight(user);
  }
  async account(user: string) {
    return this.preflight(user);
  }
  async source(c: Candidate) {
    const asset = c.assets[0],
      key =
        c.market === "prediction"
          ? "prediction:token_" + c.id
          : "perps:" + asset;
    const prediction = c.market === "prediction";
    return {
      observed_at: now(),
      revision: "cycle_" + this.sourceRev + "_" + c.id,
      account_value_usdc: "1000",
      complete: true,
      positions: [
        {
          key,
          asset,
          market: c.market,
          quantity: D(prediction ? 1000 : c.direction === "short" ? -5 : 5)
            .times(this.factor)
            .toString(),
          price: prediction ? "0.5" : "100",
          source_entry_price: prediction ? "0.5" : this.entryPrice,
          source_leverage: prediction ? 1 : 5,
          observed_at: now(),
          source_revision: "cycle_" + this.sourceRev + "_" + c.id,
        },
      ],
    };
  }
  async submit(user: string, p: Portfolio, e: Execution) {
    assert.ok(!this.tasks.has(e.id), "Same execution submitted twice");
    this.tasks.set(e.id, { user, e: structuredClone(e), status: "submitted" });
    this.submits.push({
      user,
      id: e.id,
      key: e.key,
      target: e.target_quantity,
      at: now(),
    });
    if (this.loseResponse) {
      this.loseResponse = false;
      throw Error("Simulated response loss after acceptance");
    }
    return { task_id: "task_" + e.id };
  }
  async execution(user: string, p: Portfolio, e: Execution) {
    const t = this.tasks.get(e.id);
    return t
      ? {
          task_id: "task_" + e.id,
          status: t.status,
          observed_quantity: this.accountFor(user).positions[e.key] ?? "0",
          settled: t.status === "completed",
        }
      : { status: "failed" as const, observed_quantity: "0", settled: true };
  }
  async fence() {
    this.fences++;
  }
  async release() {
    this.releases++;
  }
  async cancelIncreasing() {}
  async notify(user: string, event: any) {
    this.notices.push({ user, ...structuredClone(event) });
  }
  fill(user: string, fraction = 1) {
    const s = this.accountFor(user);
    for (const [id, t] of this.tasks) {
      if (t.user !== user || t.status === "completed" || t.status === "failed")
        continue;
      const delta = D(t.e.target_quantity)
        .minus(s.positions[t.e.key] ?? 0)
        .times(fraction)
        .toDecimalPlaces(8, 1);
      if (delta.isZero()) {
        t.status = "completed";
        continue;
      }
      s.fills.push({
        id: "fill_" + randomUUID(),
        order_id: "order_" + id,
        task_id: "task_" + id,
        key: t.e.key,
        quantity: delta.toString(),
        price: s.prices[t.e.key],
        fee_usdc: "0.050000",
        at: now(),
      });
      s.positions[t.e.key] = D(s.positions[t.e.key] ?? 0)
        .plus(delta)
        .toString();
      t.status = fraction === 1 ? "completed" : "partially_filled";
    }
    this.mark(user);
  }
  funding(user: string, key: string, amount: string) {
    this.accountFor(user).funding.push({
      id: "funding_" + randomUUID(),
      key,
      amount_usdc: amount,
      at: now(),
    });
    this.mark(user);
  }
  reset() {
    this.factor = "1";
    this.sourceRev++;
    this.entryPrice = "100";
    this.pool = [1, 2, 3, 4, 5, 6].map((i) => ({
      ...candidate(i),
      source_drawdown_pct: 2,
    }));
  }
}
const venue = new SimulatedVenue();
let service: AgentService, runner: AgentRunner;
let base: string;
async function check(name: string, body: () => Promise<any>) {
  try {
    const evidence = await body();
    results.push({ name, status: "passed", evidence });
    console.log("PASS " + name);
  } catch (e) {
    results.push({
      name,
      status: "failed",
      error: e instanceof Error ? e.message : String(e),
    });
    console.log(
      "FAIL " + name + ": " + (e instanceof Error ? e.message : String(e)),
    );
  }
}
async function post(path: string, token: string, body: any) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  return { status: r.status, data };
}
async function oauth(name: keyof typeof users) {
  const redirect = "http://127.0.0.1:55736/callback",
    verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url");
  const r = await fetch(base + "/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Functional fixture " + name,
      redirect_uris: [redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(r.status, 201);
  const c = await r.json();
  const approved = await fetch(base + "/auth/approve", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "approve",
      client_id: c.client_id,
      redirect_uri: redirect,
      code_challenge: challenge,
      scope: "ride:read ride:trade",
      resource: base + "/mcp",
      ride_token: "fixture_core_" + name,
    }),
    redirect: "manual",
  });
  assert.equal(approved.status, 302);
  const code = new URL(approved.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const exchanged = await fetch(base + "/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: c.client_id,
      redirect_uri: redirect,
      code,
      code_verifier: verifier,
      resource: base + "/mcp",
    }),
  });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  const client = new Client({ name: "functional-acceptance", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + tokens.access_token },
      },
    }),
  );
  clients.push(client);
  return { client, tokens, configDir: join(temp, name) };
}
async function tool(c: Client, name: string, args: any = {}) {
  const r = await c.callTool({ name, arguments: args });
  const value: any =
    r.structuredContent ??
    JSON.parse((r.content as any[]).find((x) => x.type === "text").text);
  requests.push({ tool: name, args, result: value });
  return value;
}
// This acceptance client explicitly reviews the fixture overlap report. It never confirms real funds.
function reviewStart(plan: any) {
  return {
    plan_id: plan.id,
    compatibility_ack: compatibility(plan).fingerprint,
  };
}
async function ok(c: Client, name: string, args: any = {}) {
  const v = await tool(c, name, args);
  assert.ok(!v.error, JSON.stringify(v.error));
  return v;
}
async function human(name: keyof typeof users, operation: string, body: any) {
  return post("/agent/human/" + operation, "fixture_core_" + name, body);
}
async function approve(name: keyof typeof users, p: any) {
  assert.equal(p.status, "requires_confirmation");
  const r = await human(name, "confirm", {
    proposal_id: p.id,
    preview_hash: p.preview_hash,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.data.proposal.status, "queued");
  return r.data;
}
async function settle(name: keyof typeof users) {
  await runner.tick(users[name]);
  venue.fill(users[name]);
  await runner.tick(users[name]);
}
const pref = {
  budget_usdc: "500",
  loss_trigger_pct: 20,
  market: "perps",
  assets: ["BTC", "ETH"],
  allow_altcoins: false,
  // Fixed six-person fixture keeps legacy execution/accounting scenarios comparable.
  portfolio_kind: "basket" as const,
  basket_size: 6,
};
try {
  await repo.migrate();
  const graph = express();
  graph.use(express.json());
  graph.post("/graphql", (req, res) => {
    const id = identities.get(
      (req.get("authorization") ?? "").replace("Bearer ", ""),
    );
    res.json(
      id
        ? {
            data: {
              copyTradeSummary: { totalConfigs: 0 },
              me: { id },
              myCopyTradeConfigs: [],
              myPerpsAutoRideConfigs: [],
              myPerpsAutoRidePositions: [],
              ...Object.fromEntries(
                [0, 1, 2, 3].map((i) => [
                  "positions" + i,
                  { positions: [], totalCount: 0, hasNextPage: false },
                ]),
              ),
            },
          }
        : { errors: [{ message: "Fixture identity rejected" }] },
    );
  });
  const graphBase = await listen(graph);
  const temporary = express();
  const reserve = temporary.listen(0, "127.0.0.1");
  await new Promise<void>((r) => reserve.once("listening", r));
  base = "http://127.0.0.1:" + (reserve.address() as any).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  service = new AgentService(
    repo,
    venue,
    base,
    new Cursor(randomBytes(32).toString("hex")),
  );
  runner = new AgentRunner(service);
  const backend = await listen(
    backendApp(service, (t) => validateCoreIdentity(t, graphBase + "/graphql")),
  );
  gateway = spawn(process.execPath, ["dist/server.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: new URL(base).port,
      PUBLIC_BASE_URL: base,
      RIDE_AGENT_BACKEND_URL: backend,
      RIDE_GRAPHQL_URL: graphBase + "/graphql",
      PRIVY_APP_ID: "functional-fixture",
      RIDE_AGENT_HUMAN_COOKIE_KEY: randomBytes(32).toString("hex"),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  gateway.stderr!.on("data", (d) => (gatewayLogs += String(d)));
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(base + "/health")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok((await fetch(base + "/health")).ok, gatewayLogs);
  const alice = await oauth("alice"),
    bob = await oauth("bob");
  await saveSession(
    {
      server: base + "/mcp",
      tokens: alice.tokens,
      expires_at: Date.now() + 3600000,
    },
    alice.configDir,
  );
  let plan: any, portfolio: any, start: any;
  const cli = async (args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, ["dist/cli.js", ...args], {
          cwd: root,
          env: { PATH: process.env.PATH, RIDE_CONFIG_DIR: alice.configDir },
        })
      ).stdout,
    );
  await check("36 当前流程：HTTP/MCP/CLI 同源且无需重新登录", async () => {
    const response = await fetch(base + "/ride/guide");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const guide = await response.json();
    const mcp = await alice.client.callTool({
      name: "get_ride_guide",
      arguments: {},
    });
    assert.deepEqual(mcp.structuredContent, guide);
    assert.deepEqual(await cli(["guide", "--server", base + "/mcp"]), guide);
    assert.equal((await alice.client.listTools()).tools.length, 26);
    assert(alice.client.getInstructions()?.includes("get_ride_guide"));
    assert.equal(guide.protocol, "ride-guide-v1");
    const demo = await alice.client.callTool({
      name: "show_confirmation_card",
      arguments: { mode: "demo" },
    });
    assert.equal((demo.structuredContent as any).data.confirmation_demo, true);
    return { release: guide.release, sha256: guide.sha256, tools: 26 };
  });
  await check(
    "45 20-USDC Perps：MCP/CLI 推荐、重算和确认前不下单",
    async () => {
      // Reuse the existing fixture login; a preview needs no new OAuth client.
      const c = alice;
      venue.available.set(users.alice, "20");
      try {
        const before = venue.submits.length;
        const first = await ok(c.client, "recommend_traders", {
          preferences: { ...pref, budget_usdc: "20" },
          trader_ids: [venue.pool[0].id],
        });
        assert.equal(first.data.plan.allocations[0].amount_usdc, "20.000000");
        assert.equal(
          first.data.planning_constraints.perps_product_minimum_usdc,
          null,
        );
        const edited = await ok(c.client, "recalculate_plan", {
          plan_id: first.data.plan.id,
          allocations: [
            {
              trader_id: venue.pool[0].id,
              amount_usdc: "20",
              leverage_cap: 3,
              stop_loss_pct: 25,
            },
          ],
        });
        await saveSession(
          {
            server: base + "/mcp",
            tokens: c.tokens,
            expires_at: now() + 3600000,
          },
          c.configDir,
        );
        const cliPreview = JSON.parse(
          (
            await run(process.execPath, ["dist/cli.js", "recommend"], {
              cwd: root,
              env: { PATH: process.env.PATH, RIDE_CONFIG_DIR: c.configDir },
            })
          ).stdout,
        );
        assert.equal(
          cliPreview.data.plan.allocations[0].amount_usdc,
          "20.000000",
        );
        assert.equal(cliPreview.data.plan.allocations[0].stop_loss_pct, 25);
        assert.equal(cliPreview.data.plan.preferences.loss_trigger_pct, 20);
        const proposal = (
          await ok(c.client, "start_copy", reviewStart(cliPreview.data.plan))
        ).data.proposal;
        assert.equal(proposal.status, "requires_confirmation");
        assert.equal(venue.submits.length, before);
        return {
          budget_usdc: "20",
          allocation_usdc: edited.data.plan.allocations[0].amount_usdc,
          cli_preserves_amount_and_risk: true,
          status: proposal.status,
          submitted_orders: 0,
        };
      } finally {
        venue.available.delete(users.alice);
        await repo.pool.query("DELETE FROM ride_agent_state WHERE user_id=$1", [
          users.alice,
        ]);
      }
    },
  );
  await check("01 偏好：500 USDC / 20% / BTC ETH", async () => {
    const v = await ok(alice.client, "set_preferences", pref);
    assert.equal(v.data.preferences.budget_usdc, "500");
    return v.data;
  });
  await check("02 推荐：3–6 人、等权且金额合计精确 500", async () => {
    const v = await ok(alice.client, "recommend_traders");
    plan = v.data.plan;
    assert.ok(plan.allocations.length >= 3 && plan.allocations.length <= 6);
    assert.equal(
      plan.allocations
        .reduce((n: any, a: any) => n.plus(a.amount_usdc), D(0))
        .toFixed(6),
      "500.000000",
    );
    return {
      count: plan.allocations.length,
      amounts: plan.allocations.map((a: any) => a.amount_usdc),
    };
  });
  await check("03 风险筛选：高回撤 trader 不应突破用户亏损上限", async () => {
    const risky = { ...candidate(7), score: 100, source_drawdown_pct: 25 };
    venue.pool.push(risky);
    try {
      const v = await ok(alice.client, "recommend_traders");
      assert.ok(
        v.data.plan.allocations.every(
          (a: any) =>
            a.trader.source_drawdown_pct * a.leverage_cap <=
            pref.loss_trigger_pct,
        ),
        "Recommendation included a trader whose historical drawdown × suggested leverage exceeds 20%",
      );
      return { excluded: risky.id };
    } finally {
      venue.pool = venue.pool.filter((c) => c.id !== risky.id);
    }
  });
  await check("04 trader 详情：八项分数和源数据返回", async () => {
    const v = await ok(alice.client, "get_trader_profile", {
      trader_id: plan.allocations[0].trader.id,
    });
    assert.equal(Object.keys(v.data.trader.components).length, 8);
    return { components: v.data.trader.components };
  });
  await check("05 Skill CLI 与 MCP 推荐结果一致", async () => {
    const v = await cli(["recommend"]);
    assert.deepEqual(
      v.data.plan.allocations.map((a: any) => [
        a.trader.id,
        a.amount_usdc,
        a.leverage_cap,
      ]),
      plan.allocations.map((a: any) => [
        a.trader.id,
        a.amount_usdc,
        a.leverage_cap,
      ]),
    );
    return { sameBackend: true };
  });
  await check("06 开始跟单：只生成提案，尚无仓位和订单", async () => {
    const v = await ok(alice.client, "start_copy", reviewStart(plan));
    start = v.data.proposal;
    assert.equal(start.status, "requires_confirmation");
    assert.equal(
      (await ok(alice.client, "get_portfolio")).data.agent_portfolio_status,
      "empty",
    );
    assert.equal(venue.submits.length, 0);
    return {
      status: start.status,
      lossTrigger: start.preview.loss_trigger_amount_usdc,
    };
  });
  await check("07 确认：拒绝跨用户、篡改摘要和机器令牌", async () => {
    for (const [token, hash, expected] of [
      ["fixture_core_bob", start.preview_hash, "NOT_FOUND"],
      ["fixture_core_alice", "f".repeat(64), "PROPOSAL_CHANGED"],
      [alice.tokens.access_token, start.preview_hash, "AUTH_REQUIRED"],
    ]) {
      const r = await post("/agent/human/confirm", token, {
        proposal_id: start.id,
        preview_hash: hash,
      });
      assert.equal(r.data.error?.code, expected);
    }
    return { denials: 3 };
  });
  await check("08 人工确认后激活；部分成交与最终成交分开", async () => {
    await approve("alice", start);
    await runner.tick(users.alice);
    assert.ok(
      venue.submits.length > 0,
      JSON.stringify(
        await repo.transact(users.alice, async (s) => ({
          updates: s.updates,
          sleeves: s.portfolios[0]?.sleeves.map((x) => ({
            trader: x.trader.id,
            assets: x.trader.assets,
            amount: x.amount_usdc,
            initialized: x.initialized,
          })),
        })),
      ),
    );
    venue.fill(users.alice, 0.5);
    await runner.tick(users.alice);
    const partial = await ok(alice.client, "get_portfolio");
    assert.equal(partial.status, "partially_filled");
    venue.fill(users.alice);
    await runner.tick(users.alice);
    portfolio = (await ok(alice.client, "get_portfolio")).data.portfolio;
    assert.ok(portfolio.positions.some((p: any) => !D(p.quantity).isZero()));
    assert.ok(portfolio.executions.every((e: any) => e.status === "completed"));
    return {
      partial: partial.status,
      positions: portfolio.positions.map((p: any) => ({
        key: p.key,
        quantity: p.quantity,
        gross: p.gross_notional_usdc,
        net: p.net_notional_usdc,
      })),
    };
  });
  await check("09 手续费、资金费真实归属；重复拉取不重复记账", async () => {
    venue.funding(users.alice, "perps:BTC", "-0.100000");
    await runner.tick(users.alice);
    const a = (await ok(alice.client, "get_portfolio")).data.portfolio;
    await runner.tick(users.alice);
    const b = (await ok(alice.client, "get_portfolio")).data.portfolio;
    assert.notEqual(a.net_profit_usdc, null);
    assert.equal(a.net_profit_usdc, b.net_profit_usdc);
    assert.equal(
      a.net_profit_usdc,
      cash(D(venue.accountFor(users.alice).account_value_usdc).minus(500)),
    );
    return { netProfit: a.net_profit_usdc };
  });
  await check("10 修改金额、杠杆和 sleeve 止损：确认前不生效", async () => {
    const s = portfolio.sleeves[0];
    const v = await ok(alice.client, "update_copy", {
      copy_id: s.copy_id,
      amount_usdc: "60",
      leverage_cap: 3,
      stop_loss_pct: 25,
    });
    assert.equal(
      (await ok(alice.client, "get_portfolio")).data.portfolio.sleeves[0]
        .amount_usdc,
      s.amount_usdc,
    );
    await approve("alice", v.data.proposal);
    await settle("alice");
    portfolio = (await ok(alice.client, "get_portfolio")).data.portfolio;
    const changed = portfolio.sleeves.find((x: any) => x.copy_id === s.copy_id);
    assert.equal(changed.amount_usdc, "60.000000");
    assert.equal(changed.leverage_cap, 3);
    assert.equal(changed.stop_loss_pct, 25);
    const persisted = await repo.transact(users.alice, async (state) =>
      state.portfolios[0].sleeves.find((x) => x.copy_id === s.copy_id)!,
    );
    assert.equal(persisted.intents["perps:BTC"].source_leverage, 3);
    assert.equal(persisted.intents["perps:BTC"].quantity, "0.18");
    const done = await human("alice", "proposal", {
      proposal_id: v.data.proposal.id,
    });
    assert.equal(done.data.data.proposal.status, "completed");
    return changed;
  });
  await check("11 复盘只给建议；评分下降产生持久事件", async () => {
    venue.pool[0] = { ...venue.pool[0], score: 40, scored_at: now() };
    await repo.transact(users.alice, async (s) => {
      s.portfolios[0].sleeves[0].reviewed_at = 0;
    });
    await runner.tick(users.alice);
    const before = venue.submits.length;
    const review = await ok(alice.client, "review_portfolio");
    assert.equal(venue.submits.length, before);
    const u = await ok(alice.client, "get_updates");
    assert.ok(u.data.updates.some((e: any) => e.kind === "daily_review"));
    return {
      observations: review.data.observations,
      eventKinds: u.data.updates.map((e: any) => e.kind),
    };
  });
  await check("12 增量通知游标与用户绑定", async () => {
    const first = await ok(alice.client, "get_updates", { limit: 2 });
    assert.ok(first.data.next_cursor);
    const next = await ok(alice.client, "get_updates", {
      cursor: first.data.next_cursor,
      limit: 100,
    });
    assert.ok(
      !next.data.updates.some((e: any) =>
        first.data.updates.some((f: any) => e.id === f.id),
      ),
    );
    const leaked = await tool(bob.client, "get_updates", {
      cursor: first.data.next_cursor,
    });
    assert.ok(leaked.error);
    return {
      first: 2,
      next: next.data.updates.length,
      otherUserError: leaked.error.code,
      delivered: venue.notices.length,
    };
  });
  await check("13 停跟默认 wind_down：不新增，已有仓位保留", async () => {
    portfolio = (await ok(alice.client, "get_portfolio")).data.portfolio;
    const s = portfolio.sleeves.find((s: any) => s.trader.assets[0] === "BTC");
    const v = await ok(alice.client, "stop_copy", { copy_id: s.copy_id });
    assert.equal(v.data.proposal.arguments.mode, "wind_down");
    await approve("alice", v.data.proposal);
    await runner.tick(users.alice);
    const state = await repo.transact(
      users.alice,
      async (s) => s.portfolios[0],
    );
    const sleeve = state.sleeves.find(
      (s) => s.copy_id === v.data.proposal.arguments.copy_id,
    )!;
    assert.equal(sleeve.state, "wind_down");
    assert.ok(Object.values(sleeve.lots).some((l) => !D(l.quantity).isZero()));
    const old = D(sleeve.intents["perps:BTC"].quantity).abs();
    venue.factor = "1.1";
    venue.sourceRev++;
    await runner.tick(users.alice);
    const after = await repo.transact(users.alice, async (s) =>
      s.portfolios[0].sleeves.find((x) => x.copy_id === sleeve.copy_id)!,
    );
    assert.ok(D(after.intents["perps:BTC"].quantity).abs().lte(old));
    await settle("alice");
    return { state: sleeve.state, retainedLots: true };
  });
  await check("14 close_now：停止一个 trader 并完成其退出", async () => {
    portfolio = (await ok(alice.client, "get_portfolio")).data.portfolio;
    const s = portfolio.sleeves.find(
      (s: any) => s.trader.assets[0] === "ETH" && s.state === "active",
    );
    const v = await ok(alice.client, "stop_copy", {
      copy_id: s.copy_id,
      mode: "close_now",
    });
    await approve("alice", v.data.proposal);
    await settle("alice");
    const st = await repo.transact(users.alice, async (s) =>
      s.portfolios[0].sleeves.find(
        (x) => x.copy_id === v.data.proposal.arguments.copy_id,
      )!,
    );
    assert.equal(st.state, "closed");
    return { state: st.state };
  });
  await check(
    "15 平掉单个 BTC 净仓：涉及 sleeves 一起更新且不立即重开",
    async () => {
      portfolio = (await ok(alice.client, "get_portfolio")).data.portfolio;
      const pos = portfolio.positions.find(
        (p: any) => p.key === "perps:BTC" && !D(p.quantity).isZero(),
      );
      assert.ok(pos);
      const v = await ok(alice.client, "close_position", {
        position_id: pos.position_id,
      });
      await approve("alice", v.data.proposal);
      await settle("alice");
      await runner.tick(users.alice);
      assert.ok(
        D(venue.accountFor(users.alice).positions["perps:BTC"] ?? 0).isZero(),
      );
      return { position: pos.position_id, closed: true };
    },
  );
  await check("16 额度授权、超额度人工确认、撤销后恢复逐次确认", async () => {
    venue.reset();
    const c = await oauth("authority");
    await ok(c.client, "set_preferences", pref);
    const uncappedPlan = (await ok(c.client, "recommend_traders")).data.plan;
    const plan = (
      await ok(c.client, "recalculate_plan", {
        plan_id: uncappedPlan.id,
        allocations: uncappedPlan.allocations.map((a: any) => ({
          trader_id: a.trader.id,
          amount_usdc: a.amount_usdc,
          leverage_cap: 8,
        })),
      })
    ).data.plan;
    await approve(
      "authority",
      (await ok(c.client, "start_copy", reviewStart(plan))).data.proposal,
    );
    await settle("authority");
    const portfolio = (await ok(c.client, "get_portfolio")).data.portfolio;
    const grant = await human("authority", "authorize", {
      portfolio_id: portfolio.id,
      total_usdc: "100",
      per_action_usdc: "20",
      daily_usdc: "50",
      expires_at: now() + 3600000,
      markets: ["perps"],
      assets: ["BTC", "ETH"],
      leverage_cap: 8,
    });
    assert.equal(grant.status, 200);
    const s = portfolio.sleeves.find((s: any) => s.state === "active");
    const amount = cash(D(s.amount_usdc).minus(5));
    const bounded = await ok(c.client, "update_copy", {
      copy_id: s.copy_id,
      amount_usdc: amount,
    });
    assert.equal(bounded.data.proposal.status, "queued");
    await settle("authority");
    const excess = await ok(c.client, "update_copy", {
      copy_id: s.copy_id,
      amount_usdc: cash(D(amount).minus(25)),
    });
    assert.equal(excess.data.proposal.status, "requires_confirmation");
    await human("authority", "reject", {
      proposal_id: excess.data.proposal.id,
    });
    assert.equal((await human("authority", "revoke", {})).status, 200);
    const revoked = await ok(c.client, "update_copy", {
      copy_id: s.copy_id,
      amount_usdc: cash(D(amount).minus(5)),
    });
    assert.equal(revoked.data.proposal.status, "requires_confirmation");
    await human("authority", "reject", {
      proposal_id: revoked.data.proposal.id,
    });
    return {
      bounded: "queued",
      excess: "requires_confirmation",
      revoked: "requires_confirmation",
    };
  });
  await check("17 未知提交结果：查询原执行 ID，不能再次下单", async () => {
    venue.reset();
    const c = await oauth("unknown");
    unknownClient = c.client;
    await ok(c.client, "set_preferences", { ...pref, budget_usdc: "300" });
    const p = (await ok(c.client, "recommend_traders")).data.plan;
    const q = (await ok(c.client, "start_copy", reviewStart(p))).data.proposal;
    await approve("unknown", q);
    venue.loseResponse = true;
    await runner.tick(users.unknown);
    const before = venue.submits.filter((s) => s.user === users.unknown).length;
    const a = await ok(c.client, "get_portfolio");
    assert.equal(a.status, "uncertain");
    await runner.tick(users.unknown);
    assert.equal(
      venue.submits.filter((s) => s.user === users.unknown).length,
      before,
    );
    await settle("unknown");
    return { uncertain: a.status, noDuplicateSubmission: true };
  });
  await check("18 老仓偏离超过 0.2%：等待新周期再跟入", async () => {
    venue.reset();
    venue.entryPrice = "99";
    const c = await oauth("entry");
    await ok(c.client, "set_preferences", pref);
    const p = (await ok(c.client, "recommend_traders")).data.plan;
    await approve(
      "entry",
      (await ok(c.client, "start_copy", reviewStart(p))).data.proposal,
    );
    await runner.tick(users.entry);
    assert.equal(venue.submits.filter((s) => s.user === users.entry).length, 0);
    venue.factor = "0";
    venue.sourceRev++;
    await runner.tick(users.entry);
    venue.factor = "1";
    venue.entryPrice = "100";
    venue.sourceRev++;
    await runner.tick(users.entry);
    assert.ok(venue.submits.some((s) => s.user === users.entry));
    return { oldEntryBlocked: true, newCycleEntered: true };
  });
  await check("19 组合亏损触发：阻止风险增加并退出、生成通知", async () => {
    venue.reset();
    venue.pool = venue.pool.map((c) => ({ ...c, source_drawdown_pct: 0.1 }));
    const c = await oauth("loss");
    await ok(c.client, "set_preferences", { ...pref, loss_trigger_pct: 1 });
    const p = (await ok(c.client, "recommend_traders")).data.plan;
    await approve(
      "loss",
      (await ok(c.client, "start_copy", reviewStart(p))).data.proposal,
    );
    await settle("loss");
    venue.funding(users.loss, "perps:BTC", "-6");
    await runner.tick(users.loss);
    const state = await repo.transact(users.loss, async (s) => s.portfolios[0]);
    assert.equal(state.loss_latched, true);
    assert.ok(
      state.sleeves.every(
        (s) => s.state === "loss_triggered" || s.state === "closed",
      ),
    );
    await settle("loss");
    assert.ok(
      Object.values(venue.accountFor(users.loss).positions).every((q) =>
        D(q).isZero(),
      ),
    );
    const updates = await ok(c.client, "get_updates");
    assert.ok(
      updates.data.updates.some((e: any) => e.kind === "loss_triggered"),
    );
    return {
      latched: true,
      positionsFlat: true,
      notified: venue.notices.some(
        (e) => e.user === users.loss && e.kind === "loss_triggered",
      ),
    };
  });
  await check("20 数据不全时收益显示 unavailable，不能冒充 0", async () => {
    venue.accountFor(users.unknown).coverage_complete = false;
    await runner.tick(users.unknown);
    const c = unknownClient;
    const v = await ok(c, "get_portfolio");
    assert.equal(v.data.portfolio.net_profit_usdc, null);
    return {
      netProfit: v.data.portfolio.net_profit_usdc,
      reconciliation: v.data.portfolio.reconciliation,
    };
  });
  await check(
    "21 sleeve 默认 30% 止损：组合尚未触发时单独退出亏损 trader",
    async () => {
      venue.reset();
      const c = await oauth("sleeveLoss");
      await ok(c.client, "set_preferences", pref);
      const plan = (await ok(c.client, "recommend_traders")).data.plan;
      assert.ok(plan.allocations.every((a: any) => a.stop_loss_pct === 30));
      await approve(
        "sleeveLoss",
        (await ok(c.client, "start_copy", reviewStart(plan))).data.proposal,
      );
      await settle("sleeveLoss");
      venue.funding(users.sleeveLoss, "perps:BTC", "-30");
      await runner.tick(users.sleeveLoss);
      const state = await repo.transact(
        users.sleeveLoss,
        async (s) => s.portfolios[0],
      );
      assert.equal(state.loss_latched, false);
      const stopped = state.sleeves.filter((s) => s.state === "loss_triggered");
      assert.ok(stopped.length > 0 && stopped.length < state.sleeves.length);
      assert.ok(
        stopped.every((s) =>
          Object.values(s.intents).every((x) => D(x.quantity).isZero()),
        ),
      );
      await settle("sleeveLoss");
      const settled = await repo.transact(
        users.sleeveLoss,
        async (s) => s.portfolios[0],
      );
      assert.ok(
        stopped.every(
          (s) =>
            settled.sleeves.find((x) => x.copy_id === s.copy_id)!.state ===
            "closed",
        ),
      );
      const updates = (await ok(c.client, "get_updates")).data.updates;
      assert.ok(updates.some((e: any) => e.kind === "sleeve_loss_triggered"));
      return { portfolioLossTriggered: false, stoppedCopies: stopped.length };
    },
  );
  await check(
    "22 换人：未释放资金拒绝、退出后确认换人、七天内第二次拒绝",
    async () => {
      venue.reset();
      const c = await oauth("replacement");
      await ok(c.client, "set_preferences", pref);
      const plan = (await ok(c.client, "recommend_traders")).data.plan;
      await approve(
        "replacement",
        (await ok(c.client, "start_copy", reviewStart(plan))).data.proposal,
      );
      await settle("replacement");
      const old = (await ok(c.client, "get_portfolio")).data.portfolio
        .sleeves[0];
      venue.pool.push(candidate(7), candidate(8));
      const early = await tool(c.client, "update_copy", {
        copy_id: old.copy_id,
        replacement_trader_id: candidate(7).id,
      });
      assert.equal(early.error?.code, "FUNDS_NOT_RELEASED");
      await approve(
        "replacement",
        (
          await ok(c.client, "stop_copy", {
            copy_id: old.copy_id,
            mode: "close_now",
          })
        ).data.proposal,
      );
      await settle("replacement");
      const swap = (
        await ok(c.client, "update_copy", {
          copy_id: old.copy_id,
          replacement_trader_id: candidate(7).id,
        })
      ).data.proposal;
      await approve("replacement", swap);
      await settle("replacement");
      const portfolio = (await ok(c.client, "get_portfolio")).data.portfolio;
      assert.ok(
        portfolio.sleeves.some(
          (s: any) => s.trader.id === candidate(7).id && s.state === "active",
        ),
      );
      const next = portfolio.sleeves.find(
        (s: any) => s.trader.assets[0] === "ETH" && s.state === "active",
      );
      await approve(
        "replacement",
        (
          await ok(c.client, "stop_copy", {
            copy_id: next.copy_id,
            mode: "close_now",
          })
        ).data.proposal,
      );
      await settle("replacement");
      const repeat = await tool(c.client, "update_copy", {
        copy_id: next.copy_id,
        replacement_trader_id: candidate(8).id,
      });
      assert.equal(repeat.error?.code, "REPLACEMENT_LIMIT");
      return {
        beforeExit: early.error.code,
        replaced: candidate(7).id,
        repeat: repeat.error.code,
      };
    },
  );
  await check(
    "23 冻结提案：余额下降、提案过期、推荐过期均拒绝执行",
    async () => {
      venue.reset();
      const c = await oauth("guard");
      await ok(c.client, "set_preferences", pref);
      const plan = (await ok(c.client, "recommend_traders")).data.plan;
      const q = (await ok(c.client, "start_copy", reviewStart(plan))).data
        .proposal;
      venue.available.set(users.guard, "450");
      const balance = await human("guard", "confirm", {
        proposal_id: q.id,
        preview_hash: q.preview_hash,
      });
      assert.equal(balance.data.error?.code, "INSUFFICIENT_FUNDS");
      venue.available.delete(users.guard);
      await repo.transact(users.guard, async (s) => {
        s.proposals.find((p) => p.id === q.id)!.expires_at = 0;
      });
      const expired = await human("guard", "confirm", {
        proposal_id: q.id,
        preview_hash: q.preview_hash,
      });
      assert.equal(expired.data.error?.code, "PROPOSAL_EXPIRED");
      await repo.transact(users.guard, async (s) => {
        s.plans.find((p) => p.id === plan.id)!.expires_at = 0;
      });
      const stale = await tool(c.client, "start_copy", reviewStart(plan));
      assert.equal(stale.error?.code, "PLAN_EXPIRED");
      assert.equal(
        venue.submits.filter((s) => s.user === users.guard).length,
        0,
      );
      return {
        balance: balance.data.error.code,
        proposal: expired.data.error.code,
        plan: stale.error.code,
        submissions: 0,
      };
    },
  );
  await check(
    "24 每日复盘：风格变化和超过七天不活跃，复盘不自动交易",
    async () => {
      venue.reset();
      const state = await repo.transact(
        users.authority,
        async (s) => s.portfolios[0],
      );
      const trader = state.sleeves[0].trader;
      const i = venue.pool.findIndex((c) => c.id === trader.id);
      venue.pool[i] = {
        ...venue.pool[i],
        style: "changed_style",
        last_trade_at: now() - 8 * 86400000,
        scored_at: now(),
      };
      const inactiveSleeve = state.sleeves[1];
      const inactiveIndex = venue.pool.findIndex(
        (c) => c.id === inactiveSleeve.trader.id,
      );
      venue.pool[inactiveIndex] = {
        ...venue.pool[inactiveIndex],
        last_trade_at: now() - 8 * 86400000,
        scored_at: now(),
      };
      await repo.transact(users.authority, async (s) => {
        s.portfolios[0].sleeves[0].reviewed_at = 0;
        s.portfolios[0].sleeves[1].reviewed_at = 0;
      });
      await runner.tick(users.authority);
      const c = await oauth("authority");
      const before = venue.submits.length;
      const review = await ok(c.client, "review_portfolio");
      assert.ok(
        review.data.observations.some((o: any) => o.kind === "inactivity"),
      );
      const updates = (await ok(c.client, "get_updates")).data.updates;
      assert.ok(
        updates.some(
          (e: any) =>
            e.kind === "daily_review" &&
            e.data.current_style === "changed_style",
        ),
      );
      assert.equal(venue.submits.length, before);
      assert.ok(
        updates.some(
          (e: any) =>
            e.kind === "daily_review" &&
            e.data.copy_id === inactiveSleeve.copy_id &&
            e.data.inactive_days === 8,
        ),
      );
      return {
        inactivityDays: 8,
        inactivityEvent: true,
        changedStyleEvent: true,
        reviewOrders: 0,
      };
    },
  );
  await check(
    "25 后台重启：持久偏好和待退出仓位继续执行，源 trader 平仓后释放组合",
    async () => {
      venue.reset();
      const c = await oauth("windDown");
      await ok(c.client, "set_preferences", pref);
      const plan = (await ok(c.client, "recommend_traders")).data.plan;
      await approve(
        "windDown",
        (await ok(c.client, "start_copy", reviewStart(plan))).data.proposal,
      );
      await settle("windDown");
      const portfolio = (await ok(c.client, "get_portfolio")).data.portfolio;
      for (const s of portfolio.sleeves)
        await approve(
          "windDown",
          (await ok(c.client, "stop_copy", { copy_id: s.copy_id })).data
            .proposal,
        );
      const restoredRepo = new PgRepository(
        process.env.RIDE_AGENT_FUNCTIONAL_DATABASE_URL!,
      );
      try {
        const restored = new AgentService(
          restoredRepo,
          venue,
          base,
          new Cursor("r".repeat(32)),
        );
        const monitor = new AgentRunner(restored);
        assert.equal(
          (
            await restoredRepo.transact(
              users.windDown,
              async (s) => s.preferences!,
            )
          ).budget_usdc,
          "500",
        );
        venue.factor = "0";
        venue.sourceRev++;
        await monitor.tick(users.windDown);
        venue.fill(users.windDown);
        await monitor.tick(users.windDown);
        const ended = await ok(c.client, "get_portfolio");
        assert.equal(ended.data.portfolio.state, "closed");
        assert.ok(
          Object.values(venue.accountFor(users.windDown).positions).every((q) =>
            D(q).isZero(),
          ),
        );
        assert.ok(venue.releases > 0);
        return {
          restartedMonitor: true,
          state: "closed",
          flat: true,
          released: true,
        };
      } finally {
        await restoredRepo.close();
      }
    },
  );
  const predictionCandidates = (indices: number[]) =>
    indices.map((i) => ({
      ...candidate(i),
      market: "prediction" as const,
      assets: [i % 2 ? "EVENTA" : "EVENTB"],
      direction: "long" as const,
      venue_max_leverage: 1,
    }));
  const preparePredictionAccount = (user: string) => {
    const account = venue.accountFor(user);
    for (const c of venue.pool.filter((c) => c.market === "prediction")) {
      const key = "prediction:token_" + c.id;
      account.prices[key] = ".5";
      account.max_leverages[key] = 1;
      account.min_notionals[key] = "1";
      account.quantity_decimals![key] = 6;
    }
  };
  await check(
    "26 预测市场：杠杆固定 1、不同 outcome token 分开记账",
    async () => {
      venue.reset();
      venue.pool = predictionCandidates([1, 2, 3, 4, 5, 6]);
      preparePredictionAccount(users.prediction);
      const c = await oauth("prediction");
      await ok(c.client, "set_preferences", { ...pref, market: "prediction" });
      const plan = (await ok(c.client, "recommend_traders")).data.plan;
      assert.ok(plan.allocations.every((a: any) => a.leverage_cap === 1));
      await approve(
        "prediction",
        (await ok(c.client, "start_copy", reviewStart(plan))).data.proposal,
      );
      await settle("prediction");
      const portfolio = (await ok(c.client, "get_portfolio")).data.portfolio;
      assert.equal(portfolio.positions.length, 6);
      assert.ok(portfolio.positions.every((p: any) => D(p.quantity).gt(0)));
      assert.equal(portfolio.net_profit_usdc, "-0.300000");
      const invalid = await tool(c.client, "update_copy", {
        copy_id: portfolio.sleeves[0].copy_id,
        leverage_cap: 2,
      });
      assert.equal(invalid.error?.code, "INVALID_LEVERAGE");
      return {
        distinctTokens: 6,
        leverage: 1,
        netProfit: portfolio.net_profit_usdc,
      };
    },
  );
  await check(
    "27 两市场组合：每个市场分别校验余额，两类仓位共用组合管理",
    async () => {
      venue.reset();
      venue.pool = [
        ...[1, 2, 3].map(candidate),
        ...predictionCandidates([4, 5, 6]),
      ];
      preparePredictionAccount(users.both);
      const c = await oauth("both");
      await ok(c.client, "set_preferences", { ...pref, market: "both" });
      const plan = (await ok(c.client, "recommend_traders")).data.plan;
      const account = venue.accountFor(users.both);
      account.available_by_market = { perps: "300", prediction: "100" };
      const insufficient = await tool(
        c.client,
        "start_copy",
        reviewStart(plan),
      );
      assert.equal(insufficient.error?.code, "INSUFFICIENT_FUNDS");
      account.available_by_market.prediction = "300";
      await approve(
        "both",
        (await ok(c.client, "start_copy", reviewStart(plan))).data.proposal,
      );
      await settle("both");
      const portfolio = (await ok(c.client, "get_portfolio")).data.portfolio;
      assert.ok(
        portfolio.positions.some((p: any) => p.market === "prediction"),
      );
      assert.ok(portfolio.positions.some((p: any) => p.market === "perps"));
      assert.notEqual(portfolio.net_profit_usdc, null);
      return {
        separateBalanceCheck: insufficient.error.code,
        markets: [...new Set(portfolio.positions.map((p: any) => p.market))],
      };
    },
  );
  await check("28 零余额预览、编辑重算、充值后新确认", async () => {
    venue.reset();
    venue.pool = [1, 2, 3, 4, 5, 6].map(candidate);
    const c = await oauth("preview");
    const account = venue.accountFor(users.preview);
    account.available_usdc = "0";
    venue.available.set(users.preview, "0");
    const first = (
      await ok(c.client, "recommend_traders", { preferences: pref })
    ).data.plan;
    const denied = await tool(c.client, "start_copy", reviewStart(first));
    assert.equal(denied.error.code, "INSUFFICIENT_FUNDS");
    await repo.transact(users.preview, async (s) => {
      s.plans.find((p) => p.id === first.id)!.expires_at = 0;
    });
    const refreshed = (
      await ok(c.client, "recalculate_plan", { plan_id: first.id })
    ).data.plan;
    assert.notEqual(first.id, refreshed.id);
    const cross = await tool(bob.client, "recalculate_plan", {
      plan_id: first.id,
    });
    assert.equal(cross.error.code, "NOT_FOUND");
    account.available_usdc = "500";
    venue.available.set(users.preview, "500");
    const proposal = (await ok(c.client, "start_copy", reviewStart(refreshed)))
      .data.proposal;
    assert.equal(proposal.status, "requires_confirmation");
    await approve("preview", proposal);
    await settle("preview");
    return {
      previewBeforeFunding: true,
      newPlan: refreshed.id,
      confirmationRequired: true,
    };
  });
  await check(
    "29 持久化收益、跟单诊断和通知设置经过真实 MCP/HTTP",
    async () => {
      const c = await oauth("preview");
      const portfolio = (await ok(c.client, "get_portfolio")).data.portfolio;
      const history = (
        await ok(c.client, "get_performance", {
          portfolio_id: portfolio.id,
          period: "inception",
        })
      ).data.performance;
      assert.ok(history.points.length > 0);
      assert.notEqual(history.inception_net_profit_usdc, null);
      const diagnostic = (
        await ok(c.client, "diagnose_copy", {
          copy_id: portfolio.sleeves[0].copy_id,
          start_at: portfolio.ledger_started_at,
          end_at: now(),
        })
      ).data.diagnostic;
      assert.equal(diagnostic.profit_difference_usdc, null);
      const settings = (
        await ok(c.client, "set_notification_preferences", {
          daily_digest: true,
          local_time: "09:00",
          timezone: "Asia/Shanghai",
        })
      ).data.notification_preferences;
      assert.equal(settings.daily_digest, true);
      const stored = (await ok(c.client, "get_notification_preferences")).data
        .notification_preferences;
      assert.equal(stored.timezone, "Asia/Shanghai");
      const cliHistory = await cli(["performance", "--period", "inception"]);
      assert.ok("performance" in cliHistory.data);
      return {
        historicalPoints: history.points.length,
        diagnostic: diagnostic.source_coverage,
        settings: stored,
      };
    },
  );
  venue.reset();
  venue.pool = Array.from({ length: 24 }, (_, i) => candidate(i + 1));
  const v17 = await oauth("v17"),
    v17Pref = {
      ...pref,
      loss_trigger_pct: 40,
      portfolio_kind: "basket",
      basket_size: 4,
      risk_tolerance: "medium",
      asset_category: "crypto",
      copy_mode: "ride_recommends",
      loss_policy: "pause_then_exit",
      emergency_exit_pct: 70,
    };
  let v17Plan: any, v17Deposit: any;
  await check(
    "30 HTML 新偏好、2–8 人组合和独立风险偏好经真实 MCP",
    async () => {
      const response = await ok(v17.client, "recommend_traders", {
        preferences: v17Pref,
        batch_action: "first",
      });
      v17Plan = response.data.plan;
      assert.equal(v17Plan.allocations.length, 4);
      assert.ok(
        v17Plan.allocations.every(
          (a: any) =>
            a.leverage_cap === null &&
            a.leverage_mode === "follow_source" &&
            a.loss_policy === "pause_then_exit",
        ),
      );
      return {
        count: 4,
        copy_mode: v17Plan.allocations[0].copy_mode,
        loss_policy: v17Plan.allocations[0].loss_policy,
      };
    },
  );
  await check("31 兼容旧分页入口，保留编辑方案并移除免费次数限制", async () => {
    const edited = await ok(v17.client, "recalculate_plan", {
      plan_id: v17Plan.id,
      preferences: v17Pref,
      allocations: v17Plan.allocations.map((a: any) => ({
        trader_id: a.trader.id,
        amount_usdc: "100",
        leverage_cap: 3,
        stop_loss_pct: 25,
        loss_policy: "pause_then_exit",
        emergency_exit_pct: 70,
      })),
    });
    v17Plan = edited.data.plan;
    const next = await ok(v17.client, "recommend_traders", {
      preferences: v17Pref,
      batch_action: "next",
    });
    assert.equal(next.data.plan.id, v17Plan.id);
    const repeated = await tool(v17.client, "recommend_traders", {
      preferences: v17Pref,
      batch_action: "next",
    });
    assert.equal(repeated.error, undefined);
    assert.equal(
      repeated.data.recommendation_batches.preview_quota_applies,
      false,
    );
    const original = await ok(v17.client, "recommend_traders", {
      preferences: v17Pref,
      batch_action: "saved",
      batch_index: 0,
    });
    assert.equal(original.data.plan.id, v17Plan.id);
    return { plan_preserved: true, quota_removed: true };
  });
  await check("32 兼容性确认绑定当前方案，确认前不下单", async () => {
    const q = await ok(v17.client, "start_copy", {
      plan_id: v17Plan.id,
      compatibility_ack: (
        await import("../src/agent/conversational.js")
      ).compatibility(v17Plan).fingerprint,
    });
    assert.equal(q.status, "requires_confirmation");
    return { requires_human_confirmation: true };
  });
  await check(
    "33 充值渠道、所属账户地址和二维码、到账查询经真实 MCP",
    async () => {
      const routes = await ok(v17.client, "get_deposit_options", {});
      assert.ok(routes.data.deposit_options.routes.length);
      const address = await ok(v17.client, "get_deposit_address", {
        market: "perps",
        asset: "USDC",
        network: "Arbitrum",
      });
      v17Deposit = address.data.deposit;
      assert.ok(v17Deposit.qr_data_url.startsWith("data:image/png;base64,"));
      const state = await ok(v17.client, "check_deposit_status", {
        deposit_id: v17Deposit.id,
      });
      assert.equal(state.data.deposit_status.available_to_copy, false);
      const foreign = await tool(alice.client, "check_deposit_status", {
        deposit_id: v17Deposit.id,
      });
      assert.equal(foreign.error?.code, "NOT_FOUND");
      return {
        qr_generated: true,
        other_account_rejected: true,
        copy_ready: false,
      };
    },
  );
  await check(
    "34 单个 trader 和 Fixed 参数经 MCP 冻结，不改变已有组合",
    async () => {
      const single = await oauth("v17Single");
      const response = await ok(single.client, "recommend_traders", {
        preferences: {
          ...v17Pref,
          portfolio_kind: "single",
          basket_size: 1,
          copy_mode: "fixed",
          fixed_margin_usdc: "10",
        },
        trader_ids: [venue.pool[0].id],
      });
      const plan = response.data.plan;
      assert.equal(plan.allocations.length, 1);
      assert.equal(plan.allocations[0].fixed_margin_usdc, "10.000000");
      const q = await ok(single.client, "start_copy", reviewStart(plan));
      assert.equal(q.status, "requires_confirmation");
      return { single_trader: true, fixed_margin_frozen: true };
    },
  );
  await check("35 新充值与日报 CLI 命令使用相同 HTTP 合约", async () => {
    const r = await cli(["deposit", "options"]);
    assert.ok(r.data.deposit_options.routes.length);
    const daily = await cli(["daily", "--timezone", "Asia/Shanghai"]);
    assert.ok(daily.data.daily_checkin);
    return { cli_contracts: true };
  });
  await check("36 推荐缺失偏好返回问题，分次保存并保留已有答案", async () => {
    const user = await oauth("preferences");
    const first = await ok(user.client, "recommend_traders", {});
    assert.equal(first.status, "requires_preferences");
    assert.deepEqual(first.data.preference_collection.missing_fields, [
      "budget_usdc",
      "risk_tolerance",
    ]);
    await ok(user.client, "set_preferences", { budget_usdc: "500" });
    const partial = await ok(user.client, "get_preferences", {});
    assert.deepEqual(partial.data.preference_collection.missing_fields, [
      "risk_tolerance",
    ]);
    await ok(user.client, "set_preferences", {
      loss_trigger_pct: 20,
      market: "perps",
    });
    const plan = await ok(user.client, "recommend_traders", {});
    assert.equal(plan.data.plan.preferences.budget_usdc, "500");
    return {
      missing_questions: true,
      partial_persistence: true,
      no_repeated_budget: true,
    };
  });
  await check(
    "37 充值方案与人类签名入口隔离，真实 HTTP/Pg 并发只提交一次",
    async () => {
      const user = await oauth("funding");
      const deposit = (
        await ok(user.client, "get_deposit_address", {
          market: "perps",
          asset: "USDC",
          network: "Arbitrum",
        })
      ).data.deposit;
      let submits = 0,
        quotes = 0;
      venue.fundingOperation = async (operation, owner, input) => {
        assert.equal(owner, users.funding);
        if (operation === "submit") {
          submits++;
          return {
            submitted: true,
            transaction_hash: "0x" + "a".repeat(64),
            receipt_status: "0x1",
          };
        }
        quotes++;
        return {
          amount_usdc: input.amount_usdc,
          wallet: { master: deposit.address },
          requires_signature: true,
          typed_data: { message: { owner: deposit.address } },
          permit_nonce: "0",
          permit_deadline: Math.floor(now() / 1000) + 300,
        };
      };
      venue.depositStatus = async (deposit) => ({
        deposit_id: deposit.id,
        wallet_balance_usdc: "0",
        trading_balance_usdc: "36.279657",
        trading_account_mode: "unified",
        available_to_copy: true,
      });
      const insufficient = await user.client.callTool({
        name: "prepare_deposit",
        arguments: {
          deposit_id: deposit.id,
          amount_usdc: "10",
        },
      });
      assert.equal(
        (insufficient.structuredContent as any).error.code,
        "FUNDING_WALLET_INSUFFICIENT",
      );
      assert.equal(quotes, 0);
      assert.equal(submits, 0);
      const funded = await ok(user.client, "check_deposit_status", {
        deposit_id: deposit.id,
      });
      assert.equal(funded.data.deposit_status.available_to_copy, true);
      assert.equal(
        funded.data.deposit_status.trading_balance_usdc,
        "36.279657",
      );
      venue.depositStatus = async (deposit) => ({
        deposit_id: deposit.id,
        wallet_balance_usdc: "10",
        trading_balance_usdc: "0",
        trading_account_mode: "standard",
        available_to_copy: false,
      });
      const prepared = await ok(user.client, "prepare_deposit", {
        deposit_id: deposit.id,
        amount_usdc: "10",
      });
      assert.equal(prepared.status, "requires_confirmation");
      assert.equal(submits, 0);
      assert.equal(
        JSON.stringify(prepared).includes("signing_challenge"),
        false,
      );
      const view = await human("funding", "funding", {
        deposit_id: deposit.id,
      });
      assert.equal(view.status, 200);
      const body = {
        deposit_id: deposit.id,
        preview_hash: view.data.data.funding.preview_hash,
        signature: "0x" + "b".repeat(130),
      };
      const foreign = await human("bob", "funding_confirm", body);
      assert.equal(foreign.status, 404);
      const missing = await human("funding", "funding_confirm", {
        deposit_id: deposit.id,
        preview_hash: body.preview_hash,
      });
      assert.equal(missing.status, 409);
      const replies = await Promise.all(
        Array.from({ length: 4 }, () =>
          human("funding", "funding_confirm", body),
        ),
      );
      assert(replies.every((r) => r.status === 200));
      assert.equal(submits, 1);
      venue.depositStatus = async (deposit) => ({
        deposit_id: deposit.id,
        trading_balance_usdc: "10",
        available_to_copy: true,
        funding_credit_verified: true,
      });
      const credited = await ok(user.client, "check_deposit_status", {
        deposit_id: deposit.id,
      });
      assert.equal(credited.data.deposit_status.funding_status, "credited");
      return {
        owner_isolation: true,
        human_signature_required: true,
        submitted_once: true,
        verified_credit_state: true,
        existing_venue_funds_do_not_prepare_another_transfer: true,
      };
    },
  );
  await check(
    "38 新偏好默认不限；11 位单一市场候选生成 1/2/3/4 人方案",
    async () => {
      const user = await oauth("widget"),
        oldPool = venue.pool;
      widgetClient = user.client;
      const submits = venue.submits.length;
      try {
        venue.pool = Array.from({ length: 11 }, (_, i) => candidate(i + 1));
        const saved = await ok(user.client, "set_preferences", {
          budget_usdc: "200",
          market: "both",
          loss_trigger_pct: 10,
          risk_tolerance: "medium",
        });
        assert.equal(saved.data.preferences.asset_category, "any");
        assert.deepEqual(saved.data.preferences.assets, []);
        assert.equal(saved.data.preferences.allow_altcoins, true);
        for (const count of [1, 2, 3, 4]) {
          const v = await ok(user.client, "recommend_traders", {
            preferences: {
              portfolio_kind: count === 1 ? "single" : "basket",
              basket_size: count,
            },
          });
          assert.equal(v.data.candidates.length, 11);
          assert.equal(v.data.plan.allocations.length, count);
          assert.deepEqual(v.data.market_coverage.selected, ["perps"]);
          assert.equal(v.data.plan.preferences.risk_tolerance, "medium");
          assert.equal(v.data.plan.preferences.loss_trigger_pct, 10);
          assert.equal(
            cash(
              v.data.plan.allocations.reduce(
                (n: any, a: any) => n.plus(a.amount_usdc),
                D(0),
              ),
            ),
            "200.000000",
          );
        }
        assert.equal(venue.submits.length, submits);
        return {
          counts: [1, 2, 3, 4],
          eligible: 11,
          market: "perps",
          default_assets: "any",
          no_orders: true,
        };
      } finally {
        venue.pool = oldPool;
      }
    },
  );
  await check(
    "39 组合失败保留候选、诊断和同风险备选；余额缺失不冒充零",
    async () => {
      const user = { client: widgetClient },
        oldPool = venue.pool;
      try {
        venue.pool = [candidate(1), candidate(2)];
        const v = await tool(user.client, "recommend_traders", {
          preferences: { portfolio_kind: "basket", basket_size: 4 },
        });
        assert.equal(v.error.code, "NO_EXECUTABLE_PLAN");
        assert.equal(v.data.plan, null);
        assert.equal(v.data.candidates.length, 2);
        const d = v.data.recommendation_diagnostics;
        assert.equal(d.requested_basket_size, 4);
        assert.deepEqual(d.feasible_basket_sizes, [1, 2]);
        assert(
          d.rules.some(
            (r: any) => r.field === "basket_size" && r.current === 4,
          ),
        );
        const alternative = await ok(user.client, "recommend_traders", {
          preferences: d.adjustments.find((a: any) => a.required === 2)
            .preferences,
        });
        assert.equal(alternative.data.plan.allocations.length, 2);
        assert.equal(alternative.data.plan.preferences.loss_trigger_pct, 10);
        const account = await ok(user.client, "get_portfolio");
        assert.equal(
          account.data.account_balances.markets.perps.account_value_usd,
          null,
        );
        assert.equal(
          account.data.account_balances.summary.account_value_usd,
          null,
        );
        return {
          candidates: 2,
          requested: 4,
          feasible: [1, 2],
          missing_balance: null,
        };
      } finally {
        venue.pool = oldPool;
      }
    },
  );
  await check("41 对话只追问预算和风险，默认不限并同时返回两张表", async () => {
    await repo.transact(users.widget, async (state) => {
      for (const key of Object.keys(state)) delete (state as any)[key];
      Object.assign(state, {
        preferences: null,
        plans: [],
        portfolios: [],
        proposals: [],
        delegation: null,
        updates: [],
        checkpoints: [],
      });
    });
    venue.pool = Array.from({ length: 24 }, (_, i) => ({
      ...candidate(i + 1),
      source_roi_pct: i + 1,
    }));
    const first = await ok(widgetClient, "get_preferences");
    assert.deepEqual(first.data.preference_collection.missing_fields, [
      "budget_usdc",
      "risk_tolerance",
    ]);
    await ok(widgetClient, "set_preferences", { budget_usdc: "200" });
    const partial = await ok(widgetClient, "get_preferences");
    assert.deepEqual(partial.data.preference_collection.missing_fields, [
      "risk_tolerance",
    ]);
    await ok(widgetClient, "set_preferences", { risk_tolerance: "medium" });
    const d = (await ok(widgetClient, "recommend_traders")).data;
    assert.equal(d.recommended_portfolio.length, 4);
    assert.equal(d.candidate_table.length, 5);
    assert.equal(d.preferences.market, "both");
    assert.equal(d.preferences.asset_category, "any");
    assert.equal(
      d.preference_collection.sources.loss_trigger_pct,
      "recommended",
    );
    assert.equal(d.final_review.execution_authorized, false);
    const tools = (await widgetClient.listTools()).tools;
    for (const name of [
      "get_preferences",
      "recommend_traders",
      "browse_traders",
    ])
      assert.equal(
        tools.find((t) => t.name === name)?._meta?.["openai/outputTemplate"],
        undefined,
      );
    return {
      two_core_answers: true,
      two_chat_tables: true,
      initial_widget: false,
    };
  });
  await check("42 更多、全候选排序和比较保留方案，不重复候选", async () => {
    const first = (await ok(widgetClient, "browse_traders", { limit: 10 }))
      .data;
    const second = (
      await ok(widgetClient, "browse_traders", {
        limit: 10,
        cursor: first.candidates_meta.next_cursor,
      })
    ).data;
    const third = (
      await ok(widgetClient, "browse_traders", {
        limit: 10,
        cursor: second.candidates_meta.next_cursor,
      })
    ).data;
    assert.equal(
      new Set(
        [...first.candidates, ...second.candidates, ...third.candidates].map(
          (c) => c.id,
        ),
      ).size,
      24,
    );
    assert.equal(third.candidates_meta.has_more, false);
    const sorted = (
      await ok(widgetClient, "browse_traders", { sort_by: "roi" })
    ).data;
    assert.equal(sorted.candidates[0].id, venue.pool[23].id);
    const comparison = (
      await ok(widgetClient, "browse_traders", {
        compare_ids: venue.pool.slice(0, 2).map((c) => c.id),
      })
    ).data;
    assert.equal(comparison.comparison.rows.length, 2);
    assert.equal(comparison.candidates_meta.period_comparable, false);
    for (const d of [second, third, sorted, comparison])
      assert.equal(d.saved_plan_id, first.saved_plan_id);
    return {
      unique_candidates: 24,
      sort_scope: "full verified snapshot",
      plan_unchanged: true,
    };
  });
  await check(
    "43 自选交易员、修改分配和市场保留设置，资金核验后仅生成确认提案",
    async () => {
      const d = (
        await ok(widgetClient, "recommend_traders", {
          trader_ids: venue.pool.slice(0, 2).map((c) => c.id),
        })
      ).data;
      const edit = (
        await ok(widgetClient, "recalculate_plan", {
          plan_id: d.plan.id,
          allocations: d.plan.allocations.map((a: any) => ({
            trader_id: a.trader.id,
            amount_usdc: "90",
            leverage_cap: 3,
            stop_loss_pct: 25,
          })),
        })
      ).data;
      const changed = (
        await ok(widgetClient, "recommend_traders", {
          preferences: { market: "perps" },
        })
      ).data;
      assert.equal(changed.plan.allocations[0].amount_usdc, "90.000000");
      assert.equal(changed.plan.allocations[0].stop_loss_pct, 25);
      const before = venue.submits.length;
      const q = await ok(widgetClient, "start_copy", reviewStart(changed.plan));
      assert.equal(q.status, "requires_confirmation");
      assert.equal(venue.submits.length, before);
      assert.equal(edit.requires_new_confirmation, true);
      return {
        choice_and_amount_preserved: true,
        human_confirmation_required: true,
        no_submission: true,
      };
    },
  );
  await check(
    "44 自选人数 1/2/3/4 及真实最小金额阻碍仍显示完整候选",
    async () => {
      venue.pool = Array.from({ length: 11 }, (_, i) => candidate(i + 1));
      for (const count of [1, 2, 3, 4]) {
        const d = (
          await ok(widgetClient, "recommend_traders", {
            selection: "system",
            preferences: {
              budget_usdc: "200",
              portfolio_kind: count === 1 ? "single" : "basket",
              basket_size: count,
            },
          })
        ).data;
        assert.equal(d.plan.allocations.length, count);
        assert.equal(d.candidates.length, 11);
      }
      const failed = await tool(widgetClient, "recommend_traders", {
        preferences: {
          budget_usdc: "0.000001",
          basket_size: 4,
          portfolio_kind: "basket",
        },
      });
      assert.equal(failed.data.plan, null);
      assert.equal(failed.data.candidates.length, 11);
      assert.equal(
        failed.data.recommendation_diagnostics.blocker,
        "budget_minimums",
      );
      assert.equal(
        failed.data.planning_constraints.minimum_allocation_usdc,
        null,
      );
      return {
        exact_counts: [1, 2, 3, 4],
        failure_keeps_candidates: true,
        minimum_explained: true,
      };
    },
  );
} catch (e) {
  results.push({
    name: "Harness startup or critical journey prerequisite",
    status: "failed",
    error: e instanceof Error ? e.stack : String(e),
  });
  console.error(e);
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (gateway) {
    gateway.kill("SIGTERM");
    await new Promise<void>((r) => gateway!.once("exit", () => r()));
  }
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  await repo.pool
    .query("DELETE FROM ride_agent_state WHERE user_id=ANY($1::text[])", [
      Object.values(users),
    ])
    .catch(() => {});
  await repo.close();
  await rm(temp, { recursive: true, force: true });
  await mkdir(resolve("output/deployment"), { recursive: true });
  const report = {
    at: new Date().toISOString(),
    environment: "loopback + dedicated PostgreSQL",
    auth: "simulated Core identities; actual OAuth PKCE, gateway and CLI",
    venue: "simulated reads, fills, fees and funding; no exchange orders",
    passed: results.filter((x) => x.status === "passed").length,
    failed: results.filter((x) => x.status === "failed").length,
    results,
    requests,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      passed: report.passed,
      failed: report.failed,
      report: reportPath,
    }),
  );
  if (report.failed) process.exitCode = 1;
}
