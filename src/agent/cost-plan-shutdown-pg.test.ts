import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import pg from "pg";
import { AccountObservationPlans } from "./account-observation-plans.js";

const database = process.env.RIDE_AGENT_TEST_DATABASE_URL;
const options = { skip: !database, timeout: 35000 };
const script = `
import http from 'node:http';
import { AccountObservationPlans } from './src/agent/account-observation-plans.ts';
import { CoreBridge } from './src/agent/core_bridge.ts';
import { VenueReadBudget } from './src/agent/venue-read-budget.ts';
import { VenueReads } from './src/agent/venue-reads.ts';
import { drainBridge } from './src/agent/bridge-shutdown.ts';
const bridge = new CoreBridge('https://core.test','fixture',process.env.RIDE_AGENT_TEST_DATABASE_URL,'s'.repeat(32),'mainnet');
const store = new AccountObservationPlans(bridge.pool);
await store.migrate();
const reads = new VenueReads(async (_url,init)=>{
  const payload=JSON.parse(String(init.body));
  if(payload.type==='userFillsByTime'){
    process.send({type:'wire'});
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  return Response.json([]);
},Date.now,2,{budget:new VenueReadBudget(),observationPlans:store});
bridge.venueReads=reads;
const server=http.createServer(async (_req,res)=>{
  try{
    if(process.env.COST_PLAN_FIXTURE_PHASE==='resume')
      for(let i=0;i<6;i++) await reads.read('https://fixture.invalid/info',{type:'clearinghouseState',user:'fixture-source-'+i},0,'source');
    await reads.observeAccount(()=>reads.read('https://fixture.invalid/info',{type:'userFillsByTime'}),process.env.COST_PLAN_FIXTURE_OWNER);
    res.end(JSON.stringify({ok:true}));
  }catch{res.statusCode=503;res.end(JSON.stringify({ok:false}));}
});
server.listen(0,'127.0.0.1',()=>process.send({type:'ready',port:server.address().port}));
let stopping=false;
process.on('SIGTERM',()=>{
  if(stopping)return;stopping=true;
  void drainBridge(server,bridge).then(()=>{
    process.send({type:'stopped',cost_plans:reads.diagnostics().cost_plans},()=>process.disconnect());
  }).catch(()=>process.exit(1));
});
`;

function fixture(
  owner: string,
  phase: "learn" | "resume",
  source = script,
  extraEnv: Record<string, string> = {},
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        COST_PLAN_FIXTURE_OWNER: owner,
        COST_PLAN_FIXTURE_PHASE: phase,
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const messages: any[] = [];
  child.on("message", (message) => messages.push(message));
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    exit,
    async wait(type: string) {
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const found = messages.find((message) => message?.type === type);
        if (found) return found;
        if (child.exitCode !== null || child.signalCode !== null)
          assert.fail(
            "Fixture process exited before its bounded lifecycle event",
          );
        await delay(5);
      }
      assert.fail("Fixture process did not emit its bounded lifecycle event");
    },
  };
}

const productionStopScript = `
import pg from 'pg';
const { startCoreBridge }=await import(process.env.COST_PLAN_FORCE_MODULE??'./src/agent/core_bridge.ts');
const timeout=globalThis.setTimeout,clear=globalThis.clearTimeout;
let forceHandle,forceCallback,forceCancelled=false;
globalThis.setTimeout=(callback,ms,...args)=>{
  const handle=timeout(callback,ms,...args);
  if(ms===45000){forceHandle=handle;forceCallback=()=>callback(...args);}
  return handle;
};
globalThis.clearTimeout=(handle)=>{
  if(forceHandle!==undefined&&handle===forceHandle)forceCancelled=true;
  return clear(handle);
};
const end=pg.Pool.prototype.end;
pg.Pool.prototype.end=function(...args){
  return Promise.resolve(end.apply(this,args)).then(value=>{
    process.send({type:'pool_closed'});return value;
  });
};
const url=new URL(process.env.RIDE_AGENT_TEST_DATABASE_URL);
url.searchParams.set('options','-c search_path='+process.env.COST_PLAN_FIXTURE_SCHEMA);
Object.assign(process.env,{
  RIDE_AGENT_CORE_URL:'http://127.0.0.1:1',
  RIDE_AGENT_CORE_SERVICE_TOKEN:'s'.repeat(32),
  RIDE_AGENT_DATABASE_URL:url.toString(),
  RIDE_AGENT_TRADER_ID_SALT:'s'.repeat(32),
  RIDE_AGENT_EXECUTOR_TOKEN:'s'.repeat(32),
  RIDE_AGENT_NETWORK:'mainnet',
  RIDE_AGENT_INFO_READ_ROUTE:'official',PORT:'0',HOST:'127.0.0.1'
});
await startCoreBridge();
// Represents a non-account 90s operation after its socket has closed. No
// financial handler, signing, external endpoint or business timeout is used.
timeout(()=>{},90000);
process.on('message',message=>{
  if(message?.type==='advance_force_boundary')
    process.send({type:'force_boundary',cancelled:forceCancelled,registered:!!forceCallback},()=>{
      if(!forceCancelled&&forceCallback)forceCallback();
    });
});
process.send({type:'ready'});
`;

it(
  "PostgreSQL actual startCoreBridge SIGTERM retains its unref force boundary after pool drain while unrelated work still holds a reference",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 2 });
    const schema = "cost_force_" + randomBytes(12).toString("hex");
    await pool.query(`CREATE SCHEMA ${schema}`);
    const processFixture = fixture(
      randomBytes(32).toString("hex"),
      "learn",
      productionStopScript,
      { COST_PLAN_FIXTURE_SCHEMA: schema },
    );
    try {
      await processFixture.wait("ready");
      processFixture.child.kill("SIGTERM");
      await processFixture.wait("pool_closed");
      processFixture.child.send({ type: "advance_force_boundary" });
      const boundary = await processFixture.wait("force_boundary");
      assert.equal(boundary.registered, true);
      assert.equal(
        boundary.cancelled,
        false,
        "A completed HTTP/PG drain must not cancel the remaining process deadline",
      );
      assert.deepEqual(await processFixture.exit, { code: 0, signal: null });
    } finally {
      processFixture.child.kill("SIGKILL");
      await processFixture.exit;
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  },
);

it(
  "PostgreSQL real mid-wire SIGTERM drains the original generation and the same image actually restores it with six source charges already paid",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 3 });
    const owner = randomBytes(32).toString("hex");
    const first = fixture(owner, "learn");
    let second: ReturnType<typeof fixture> | undefined;
    try {
      const ready = await first.wait("ready");
      const response = fetch(`http://127.0.0.1:${ready.port}/read`);
      await first.wait("wire");
      const original = (
        await pool.query(
          "SELECT generation::text,dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0];
      assert.equal(original.dirty, true);
      first.child.kill("SIGTERM");
      assert.deepEqual(await (await response).json(), { ok: true });
      assert.deepEqual(await first.exit, { code: 0, signal: null });
      assert.equal((await first.wait("stopped")).cost_plans.persisted, 1);
      assert.deepEqual(
        (
          await pool.query(
            "SELECT generation::text,dirty FROM ride_agent_account_cost_plans WHERE owner_key=$1",
            [owner],
          )
        ).rows[0],
        { generation: original.generation, dirty: false },
      );
      second = fixture(owner, "resume");
      const resumed = await second.wait("ready");
      const next = fetch(`http://127.0.0.1:${resumed.port}/read`);
      await second.wait("wire");
      second.child.kill("SIGTERM");
      assert.deepEqual(await (await next).json(), { ok: true });
      assert.deepEqual(await second.exit, { code: 0, signal: null });
      const counters = (await second.wait("stopped")).cost_plans;
      assert.equal(counters.restored_admitted, 1);
      assert.equal(counters.persisted, 1);
    } finally {
      first.child.kill("SIGKILL");
      second?.child.kill("SIGKILL");
      await Promise.allSettled([first.exit, ...(second ? [second.exit] : [])]);
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);

it(
  "PostgreSQL real mid-wire SIGKILL leaves a bounded dirty lease and never fabricates a recovered plan after actual expiry",
  options,
  async () => {
    const pool = new pg.Pool({ connectionString: database, max: 3 });
    const owner = randomBytes(32).toString("hex");
    const processFixture = fixture(owner, "learn");
    try {
      const ready = await processFixture.wait("ready");
      const response = fetch(`http://127.0.0.1:${ready.port}/read`).catch(
        () => null,
      );
      await processFixture.wait("wire");
      processFixture.child.kill("SIGKILL");
      assert.deepEqual(await processFixture.exit, {
        code: null,
        signal: "SIGKILL",
      });
      await response;
      const store = new AccountObservationPlans(pool);
      await assert.rejects(store.read(owner, new AbortController().signal), {
        code: "VENUE_COST_PLAN_UNAVAILABLE",
      });
      const row = (
        await pool.query(
          "SELECT dirty,ceil(extract(epoch FROM lease_until-clock_timestamp())*1000)::int AS remaining FROM ride_agent_account_cost_plans WHERE owner_key=$1",
          [owner],
        )
      ).rows[0];
      assert.equal(row.dirty, true);
      assert.ok(row.remaining > 0 && row.remaining <= 20000);
      await delay(row.remaining + 30);
      assert.equal(
        (await store.read(owner, new AbortController().signal)).plan,
        null,
      );
    } finally {
      processFixture.child.kill("SIGKILL");
      await processFixture.exit;
      await pool.query(
        "DELETE FROM ride_agent_account_cost_plans WHERE owner_key=$1",
        [owner],
      );
      await pool.end();
    }
  },
);
