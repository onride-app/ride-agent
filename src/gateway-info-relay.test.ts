import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { createRideHttpApp } from "./http_security.js";
import {
  gatewayInfoConfigFromEnv,
  parseGatewayPhysicalAuthority,
} from "./gateway-info-config.js";
import { createGatewayInfoClient } from "./gateway-info-client.js";
import {
  createGatewayInfoRelay,
  GatewayPendingCallers,
  type GatewayOfficialReply,
} from "./gateway-info-relay.js";
import {
  payloadHash,
  runtimeBindingId,
  signGatewayCapability,
  type GatewayCapability,
} from "./agent/dual-egress-contract.js";
import { coordinatedEvidence } from "./agent/venue-read-transport.js";

const token = "read-client-" + "r".repeat(40),
  key = Buffer.alloc(32, 0x6b);
const generation = randomUUID(),
  service = randomUUID(),
  deployment = randomUUID();
const authorityValue = {
  protocol_version: 3,
  binding_generation: generation,
  coordination_scope: "default",
  account_bank_id: "a".repeat(64),
  gateway_bank_id: "b".repeat(64),
  account_ipv4: ["8.8.8.8"],
  gateway_ipv4: ["9.9.9.9"],
  core_origin: "https://core.example",
  gateway_origin: "https://gateway.example",
  gateway_service_id: service,
  physical_manifest_sha256: "f".repeat(64),
  physical_verified: true,
  all_writers_verified: true,
  prior_gateway_drained: true,
};
const raw = JSON.stringify(authorityValue);
const config = () =>
  gatewayInfoConfigFromEnv({
    RIDE_AGENT_SOURCE_FORWARD_ENABLED: "true",
    RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON: raw,
    RAILWAY_SERVICE_ID: service,
    RAILWAY_DEPLOYMENT_ID: deployment,
    RIDE_AGENT_SOURCE_READ_CLIENT_TOKEN: token,
    RIDE_AGENT_SOURCE_FORWARD_KEY_HEX64: key.toString("hex"),
  })!;
type Harness = Awaited<ReturnType<typeof harness>>;
async function harness(
  t: TestContext,
  changes: {
    redeem?: (body: any, h: { now: number }) => Response | Promise<Response>;
    official?: (
      json: string,
      signal: AbortSignal,
    ) => Promise<GatewayOfficialReply>;
  } = {},
) {
  const c = config(),
    clock = { now: 1000 },
    calls = { redeem: 0, official: 0 };
  const pending = new GatewayPendingCallers(undefined, () => clock.now);
  const spent = new Set<string>();
  const relay = createGatewayInfoRelay({
    template: c.relay,
    readClientToken: token,
    forwardKey: c.forwardKey,
    pendingCallers: pending,
    monotonic: () => clock.now,
    requestToCore: (async (url: any, init: RequestInit) => {
      assert.equal(
        String(url),
        "https://core.example/internal/ride-info/redeem",
      );
      assert.equal(
        new Headers(init.headers).get("authorization"),
        `Bearer ${token}`,
      );
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      calls.redeem++;
      const body = JSON.parse(String(init.body));
      if (changes.redeem) return changes.redeem(body, clock);
      if (spent.has(body.read_id))
        return Response.json({ error: "used" }, { status: 409 });
      spent.add(body.read_id);
      const { capability: _, ...cap } = body;
      return Response.json({ ...cap, accepted: true, remaining_ms: 12000 });
    }) as typeof fetch,
    officialRequest: async (json, signal) => {
      calls.official++;
      return changes.official
        ? changes.official(json, signal)
        : {
            upstream_status: 200,
            body_json: '{"balances":[]}',
            retry_after: null,
          };
    },
  });
  const app = createRideHttpApp("127.0.0.1", 0);
  app.use(relay.router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });
  const binding = {
    protocol_version: 3 as const,
    authority_id: c.authorityId,
    binding_id: runtimeBindingId(c.authorityId, pending.bootNonce),
    binding_generation: generation,
    gateway_boot_nonce: pending.bootNonce,
    account_bank_id: authorityValue.account_bank_id,
    gateway_bank_id: authorityValue.gateway_bank_id,
  };
  return { c, clock, calls, pending, relay, origin, binding };
}
function envelope(
  h: Harness,
  request: unknown = { type: "meta" },
  stage: GatewayCapability["stage"] = "source",
  caller: string | null = null,
) {
  const request_json = JSON.stringify(request);
  const cap: GatewayCapability = {
    protocol_version: 3,
    binding_id: h.binding.binding_id,
    binding_generation: generation,
    gateway_boot_nonce: h.pending.bootNonce,
    read_id: randomUUID(),
    bank_id: authorityValue.gateway_bank_id,
    stage,
    deadline_ms: 1_800_000_000_000,
    payload_sha256: payloadHash(request_json),
    caller_id: caller,
  };
  return { ...cap, request_json, capability: signGatewayCapability(cap, key) };
}
const post = (h: Harness, body: unknown) =>
  fetch(`${h.origin}/internal/ride-info/forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function rawForward(
  h: Harness,
  initial: { aborted?: boolean; destroyed?: boolean } = {},
) {
  const req = Object.assign(new EventEmitter(), {
    body: envelope(h),
    headers: {},
    aborted: initial.aborted ?? false,
    socket: { destroyed: false },
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: initial.destroyed ?? false,
    writableEnded: false,
    headersSent: false,
    set() {
      return this;
    },
    status() {
      return this;
    },
    json() {
      this.writableEnded = true;
      return this;
    },
  });
  const layer = (h.relay.router as any).stack.find(
    (entry: any) => entry.route?.path === "/internal/ride-info/forward",
  );
  assert.ok(layer, "Exercise the actual mounted forward handler");
  return {
    req,
    res,
    run: () => layer.route.stack[0].handle(req, res) as Promise<void>,
  };
}

test("Gateway does not redeem or start a provider read for an already disconnected request", async (t) => {
  const h = await harness(t);
  await rawForward(h, { aborted: true }).run();
  await rawForward(h, { destroyed: true }).run();
  assert.deepEqual(h.calls, { redeem: 0, official: 0 });
});

test("Gateway disconnect during redeem consumes no new official request", async (t) => {
  let destroyed: { destroyed: boolean };
  const h = await harness(t, {
    redeem: async (body) => {
      destroyed.destroyed = true;
      const { capability: _, ...cap } = body;
      return Response.json({ ...cap, accepted: true, remaining_ms: 12000 });
    },
  });
  const raw = rawForward(h);
  destroyed = raw.res;
  await raw.run();
  assert.deepEqual(h.calls, { redeem: 1, official: 0 });
});

test("Gateway defaults off; enabled config binds actual service, uses decoded key and keeps authority stable across deployments", () => {
  assert.equal(
    gatewayInfoConfigFromEnv({
      RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON: "bad",
    }),
    undefined,
  );
  const c = config();
  assert.deepEqual(c.forwardKey, key);
  const another = gatewayInfoConfigFromEnv({
    RIDE_AGENT_SOURCE_FORWARD_ENABLED: "true",
    RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON: raw,
    RAILWAY_SERVICE_ID: service,
    RAILWAY_DEPLOYMENT_ID: randomUUID(),
    RIDE_AGENT_SOURCE_READ_CLIENT_TOKEN: token,
    RIDE_AGENT_SOURCE_FORWARD_KEY_HEX64: key.toString("hex"),
  })!;
  assert.equal(c.authorityId, another.authorityId);
  assert.notEqual(
    c.relay.gateway_deployment_id,
    another.relay.gateway_deployment_id,
  );
  for (const patch of [
    { gateway_ipv4: ["8.8.8.8"] },
    { physical_verified: false },
    { gateway_ipv4: ["127.0.0.1"] },
    { gateway_origin: "https://gateway.example/path" },
    { extra: true },
  ])
    assert.throws(() =>
      parseGatewayPhysicalAuthority(
        JSON.stringify({ ...authorityValue, ...patch }),
      ),
    );
  assert.throws(() =>
    gatewayInfoConfigFromEnv({
      RIDE_AGENT_SOURCE_FORWARD_ENABLED: "true",
      RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON: raw,
      RAILWAY_SERVICE_ID: randomUUID(),
      RAILWAY_DEPLOYMENT_ID: deployment,
      RIDE_AGENT_SOURCE_READ_CLIENT_TOKEN: token,
      RIDE_AGENT_SOURCE_FORWARD_KEY_HEX64: key.toString("hex"),
    }),
  );
});

test("Gateway authenticated status reports actual boot and deployment without provider or quota activity", async (t) => {
  const h = await harness(t);
  assert.equal(
    (await fetch(`${h.origin}/internal/ride-info/status`)).status,
    401,
  );
  const r = await fetch(`${h.origin}/internal/ride-info/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(await r.json(), {
    protocol_version: 3,
    authority_id: h.c.authorityId,
    gateway_boot_nonce: h.pending.bootNonce,
    gateway_service_id: service,
    gateway_deployment_id: deployment,
    forward_enabled: true,
  });
  assert.deepEqual(h.calls, { redeem: 0, official: 0 });
});

test("Gateway requires real redeem ACK and carries complete official status/body/Retry-After", async (t) => {
  const h = await harness(t, {
    official: async () => ({
      upstream_status: 429,
      body_json: '{"error":"limited"}',
      retry_after: "7",
    }),
  });
  const body = envelope(h);
  const r = await post(h, body);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    protocol_version: 3,
    read_id: body.read_id,
    binding_id: body.binding_id,
    bank_id: body.bank_id,
    upstream_status: 429,
    body_json: '{"error":"limited"}',
    retry_after: "7",
  });
  assert.deepEqual(h.calls, { redeem: 1, official: 1 });
  assert.equal((await post(h, body)).status, 503);
  assert.equal(h.calls.official, 1, "A replay cannot be sent a second time");
});

test("Gateway rejects wrong authority/boot/bank/hash/key and action fields before redeem", async (t) => {
  const h = await harness(t);
  const base = envelope(h);
  const cases = [
    { ...base, binding_id: "d".repeat(64) },
    { ...base, gateway_boot_nonce: randomUUID() },
    { ...base, bank_id: "a".repeat(64) },
    { ...base, request_json: '{"type":"spotMeta"}' },
    { ...base, capability: signGatewayCapability(base, Buffer.alloc(32, 1)) },
    { ...base, url: "https://other.example/exchange" },
    envelope(h, { type: "order", action: {} }),
    envelope(h, { type: "meta", action: { type: "order" } }),
  ];
  for (const body of cases) assert.equal((await post(h, body)).status, 503);
  assert.deepEqual(h.calls, { redeem: 0, official: 0 });
});

test("Gateway denies false/mutated redeem replies and subtracts entire redeem RTT", async (t) => {
  const bad = await harness(t, {
    redeem: async (body) => {
      const { capability: _, ...cap } = body;
      return Response.json({
        ...cap,
        accepted: true,
        remaining_ms: 12000,
        read_id: randomUUID(),
      });
    },
  });
  assert.equal((await post(bad, envelope(bad))).status, 503);
  assert.equal(bad.calls.official, 0);
  const slow = await harness(t, {
    redeem: async (body, clock) => {
      clock.now += 12001;
      const { capability: _, ...cap } = body;
      return Response.json({ ...cap, accepted: true, remaining_ms: 12000 });
    },
  });
  assert.equal((await post(slow, envelope(slow))).status, 503);
  assert.equal(slow.calls.official, 0);
});

test("Gateway balance forward needs the exact active same-boot original local caller", async (t) => {
  const h = await harness(t);
  const request = {
    type: "spotClearinghouseState",
    user: "0x" + "1".repeat(40),
  };
  assert.equal(
    (await post(h, envelope(h, request, "gateway_balance", randomUUID())))
      .status,
    503,
  );
  const signal = new AbortController();
  const caller = h.pending.register(
    payloadHash(JSON.stringify(request)),
    h.clock.now + 10000,
    signal.signal,
  );
  h.clock.now += 10001;
  assert.equal(
    (await post(h, envelope(h, request, "gateway_balance", caller))).status,
    503,
  );
  assert.deepEqual(h.calls, { redeem: 0, official: 0 });
  h.pending.remove(caller);
  assert.equal(h.pending.size, 0);
});

test("Gateway balance client joins real local forward, preserves evidence start and sends only narrow credential", async (t) => {
  const h = await harness(t);
  let gatewayReads = 0;
  const client = createGatewayInfoClient({
    coreOrigin: "https://core.example",
    readClientToken: token,
    pendingCallers: h.pending,
    monotonic: () => h.clock.now,
    wallClock: () => 1_800_000_000_000,
    currentBinding: async () => h.binding,
    requestToCore: (async (url: any, init: RequestInit) => {
      gatewayReads++;
      assert.equal(
        String(url),
        "https://core.example/internal/ride-info/gateway-read",
      );
      assert.equal(
        new Headers(init.headers).get("authorization"),
        `Bearer ${token}`,
      );
      assert.ok(!JSON.stringify(init).includes("user-session-secret"));
      const q = JSON.parse(String(init.body));
      const f = envelope(h, q.request, "gateway_balance", q.caller_id);
      const forwarded = await post(h, f);
      assert.equal(forwarded.status, 200);
      const value = (await forwarded.json()) as any;
      return Response.json({
        data: JSON.parse(value.body_json),
        observed_at: 1_800_000_000_100,
        bank_id: value.bank_id,
        read_id: value.read_id,
        retain_until_ms: 1_800_000_070_000,
      });
    }) as typeof fetch,
  });
  const r = await client(
    "https://api.hyperliquid.xyz/info",
    {
      method: "POST",
      headers: { Authorization: "Bearer user-session-secret" },
      body: JSON.stringify({
        type: "spotClearinghouseState",
        user: "0x" + "1".repeat(40),
      }),
    },
    { deadline_ms: 1_800_000_010_000 },
  );
  assert.deepEqual(await r.json(), { balances: [] });
  assert.equal(coordinatedEvidence(r), 1_800_000_000_000);
  assert.equal(gatewayReads, 1);
  assert.deepEqual(h.calls, { redeem: 1, official: 1 });
  assert.equal(h.pending.size, 0);
});

test("Gateway client cannot accept fabricated success without original forward or renew after initial-hop delay", async (t) => {
  const h = await harness(t);
  const client = createGatewayInfoClient({
    coreOrigin: "https://core.example",
    readClientToken: token,
    pendingCallers: h.pending,
    monotonic: () => h.clock.now,
    wallClock: () => 1_800_000_000_000,
    currentBinding: async () => {
      h.clock.now += 9000;
      return h.binding;
    },
    requestToCore: (async (_url: any, init: RequestInit) => {
      const q = JSON.parse(String(init.body));
      assert.equal(q.remaining_ms, 1000);
      h.clock.now += 1001;
      const f = await post(
        h,
        envelope(h, q.request, "gateway_balance", q.caller_id),
      );
      assert.equal(f.status, 503);
      return Response.json({
        data: {},
        observed_at: 1_800_000_000_000,
        bank_id: h.binding.gateway_bank_id,
        read_id: randomUUID(),
        retain_until_ms: 1_800_000_070_000,
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    client(
      "https://api.hyperliquid.xyz/info",
      {
        method: "POST",
        body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
      },
      { deadline_ms: 1_800_000_010_000 },
    ),
  );
  assert.equal(h.calls.official, 0);
  assert.equal(h.pending.size, 0);
});

test("Gateway client preserves only authenticated typed provider cooldown and never refunds a denied read", async (t) => {
  const h = await harness(t);
  const cases = [
    {
      status: 503,
      body: {
        error: {
          code: "data_provider_rate_limited",
          upstream_request_sent: true,
          retry_after_ms: 2000,
        },
      },
      expected: "VENUE_RATE_LIMITED",
    },
    {
      status: 503,
      body: {
        error: {
          code: "data_provider_rate_limited",
          upstream_request_sent: false,
          retry_after_ms: 2000,
        },
      },
      expected: "VENUE_RATE_LIMITED",
    },
    {
      status: 503,
      body: {
        error: {
          code: "data_provider_rate_limited",
          upstream_request_sent: true,
          retry_after_ms: 60001,
        },
      },
      expected: "VENUE_UNAVAILABLE",
    },
    {
      status: 503,
      body: {
        error: {
          code: "read_unknown",
          upstream_request_sent: true,
          retry_after_ms: 1000,
        },
      },
      expected: "VENUE_UNAVAILABLE",
    },
    {
      status: 429,
      body: {
        error: {
          code: "data_provider_rate_limited",
          upstream_request_sent: true,
          retry_after_ms: 2000,
        },
      },
      expected: "VENUE_UNAVAILABLE",
    },
    {
      status: 503,
      body: {
        error: {
          code: "data_provider_rate_limited",
          upstream_request_sent: true,
          retry_after_ms: 2000,
          extra: true,
        },
      },
      expected: "VENUE_UNAVAILABLE",
    },
  ];
  for (const control of cases) {
    const client = createGatewayInfoClient({
      coreOrigin: "https://core.example",
      readClientToken: token,
      pendingCallers: h.pending,
      currentBinding: async () => h.binding,
      monotonic: () => h.clock.now,
      wallClock: () => 1_800_000_000_000,
      requestToCore: (async () =>
        Response.json(control.body, {
          status: control.status,
        })) as typeof fetch,
    });
    await assert.rejects(
      client(
        "https://api.hyperliquid.xyz/info",
        {
          method: "POST",
          body: JSON.stringify({ type: "spotMetaAndAssetCtxs" }),
        },
        { deadline_ms: 1_800_000_010_000 },
      ),
      (error: any) => {
        assert.equal(error.code, control.expected);
        assert.equal(error.upstreamRequestSent, true);
        if (control.expected === "VENUE_RATE_LIMITED")
          assert.equal(error.details.retry_after_ms, 2000);
        return true;
      },
    );
    assert.equal(h.pending.size, 0);
  }
  assert.deepEqual(h.calls, { redeem: 0, official: 0 });
});
