import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import {
  appSessionStoreApp, remoteOAuthStateStore, remoteHumanHandoffs,
} from "./app_session_store.js";
import { InMemoryOAuthStateStore } from "./oauth.js";
import { MemoryHumanHandoffs } from "./agent/human_handoffs.js";

const token = "fixture-app-session-service-token-0123456789";
async function listen(app: express.Express) {
  const server = await new Promise<Server>((resolve) => {
    const server=app.listen(0,"127.0.0.1",()=>resolve(server));
  });
  return {server,url:"http://127.0.0.1:"+(server.address() as AddressInfo).port};
}
async function close(server:Server) { await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve())); }

test("App storage preserves OAuth records, URL fields, stable clients and atomic refresh generations",async()=>{
  const store=new InMemoryOAuthStateStore();
  const {server,url}=await listen(appSessionStoreApp({token,store,handoffs:new MemoryHumanHandoffs()}));
  try {
    const remote=remoteOAuthStateStore({url,token});
    const client={client_id:"registered-before-migration",redirect_uris:["https://client.example/callback"]};
    assert.deepEqual(await remote.clientsStore.registerClient!(client),client);
    assert.deepEqual(await remote.clientsStore.getClient(client.client_id),client);
    const access={clientId:client.client_id,scopes:["ride:read"],rideAuthToken:"fixture-core-user-credential",identity:{subject:"fixture-user"},expiresAt:Date.now()+60000,resource:new URL("https://mcp.example/mcp")};
    await remote.setAccessToken("opaque-existing-access",access);
    const read=await remote.getAccessToken("opaque-existing-access");
    assert.equal(read?.rideAuthToken,access.rideAuthToken);
    assert.ok(read?.resource instanceof URL);
    assert.equal(read.resource.toString(),access.resource.toString());
    const code={client,params:{redirectUri:client.redirect_uris[0],scopes:["ride:read"],codeChallenge:"fixture-pkce",resource:new URL("https://mcp.example/mcp")},rideAuthToken:access.rideAuthToken,identity:access.identity,expiresAt:access.expiresAt};
    await remote.setAuthorizationCode("old-code",code);
    assert.equal((await remote.getAuthorizationCode("old-code"))?.params.resource?.toString(),code.params.resource.toString());
    await remote.deleteAuthorizationCode("old-code");
    assert.equal(await remote.getAuthorizationCode("old-code"),undefined);
    await remote.setRefreshToken("opaque-existing-refresh",access);
    const expected=(await remote.getRefreshToken("opaque-existing-refresh"))!;
    const winners=await Promise.all([remote.consumeRefreshToken("opaque-existing-refresh",expected),remote.consumeRefreshToken("opaque-existing-refresh",expected)]);
    assert.deepEqual(winners.sort(),[false,true]);
    await remote.setRefreshToken("rotated-refresh",access);
    const stale=(await remote.getRefreshToken("rotated-refresh"))!;
    await remote.setRefreshToken("rotated-refresh",{...access,expiresAt:access.expiresAt+1000});
    assert.equal(await remote.consumeRefreshToken("rotated-refresh",stale),false);
    assert.ok(await remote.getRefreshToken("rotated-refresh"));
    assert.equal((await remote.getStats!()).registeredClients,1);
    await remote.deleteAccessToken("opaque-existing-access");
    await remote.deleteRefreshToken("rotated-refresh");
    assert.equal(await remote.getAccessToken("opaque-existing-access"),undefined);
  } finally {await close(server);}
});

test("human handoff is single-use through the App transport",async()=>{
  const {server,url}=await listen(appSessionStoreApp({token,store:new InMemoryOAuthStateStore(),handoffs:new MemoryHumanHandoffs()}));
  try {
    const remote=remoteHumanHandoffs({url,token});
    const value={session:"fixture-encrypted-human-session",challenge:"fixture-challenge",proposal_id:"same-proposal-id",expires_at:Date.now()+60000};
    const ticket=await remote.issue(value);
    assert.deepEqual(await remote.consume(ticket),value);
    assert.equal(await remote.consume(ticket),undefined);
  }finally{await close(server);}
});

test("unknown operations and wrong credentials cannot access storage",async()=>{
  const store=new InMemoryOAuthStateStore();
  const {server,url}=await listen(appSessionStoreApp({token,store,handoffs:new MemoryHumanHandoffs()}));
  try{
    const noAuth=await fetch(url+"/internal/rider-session/stats",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    assert.equal(noAuth.status,401);
    const unknown=await fetch(url+"/internal/rider-session/eval",{method:"POST",headers:{"authorization":"Bearer "+token,"content-type":"application/json"},body:"{}"});
    assert.equal(unknown.status,404);
    const wrong=remoteOAuthStateStore({url,token:"another-dedicated-fixture-service-token"});
    await assert.rejects(async () => await wrong.clientsStore.getClient("secret-client"),/temporarily unavailable/);
    assert.equal((await store.getStats()).registeredClients,0);
  }finally{await close(server);}
});

test("remote transport rejects credential URLs and public plaintext origins",()=>{
  for(const url of ["http://example.com/","https://user:secret@example.com/","https://example.com/path","https://example.com/?token=secret","https://example.com/#x"]){
    assert.throws(()=>remoteOAuthStateStore({url,token}));
  }
});

test("App outage, timeout, redirect and oversized responses fail closed without fallback",async()=>{
  for(const mode of ["failure","timeout","redirect","large"]){
    let calls=0;const app=express();
    app.post("/internal/rider-session/client_get",(_req,res)=>{
      calls++;
      if(mode==="timeout")return;
      if(mode==="redirect"){res.redirect(307,"https://external.invalid/");return;}
      if(mode==="large"){res.set("content-type","application/json");res.write('{"value":"');res.end("x".repeat(200000)+'"}');return;}
      res.status(503).json({error:"not available"});
    });
    const {server,url}=await listen(app);
    try{
      const remote=remoteOAuthStateStore({url,token,timeoutMs:100});
      await assert.rejects(async () => await remote.clientsStore.getClient("not-in-memory"),/temporarily unavailable/);
      assert.equal(calls,1);
    }finally{server.closeAllConnections();await close(server);}
  }
});
