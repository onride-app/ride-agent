import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { coreDualBindingReader } from "./core-dual-binding.js";
import { CoreBridge } from "./core_bridge.js";
import { payloadHash, runtimeBindingId } from "./dual-egress-contract.js";

const generation = randomUUID(),
  service = randomUUID();
const authority = {
  protocol_version: 3,
  binding_generation: generation,
  coordination_scope: "default",
  account_bank_id: "c".repeat(64),
  gateway_bank_id: "d".repeat(64),
  account_ipv4: ["8.8.8.8"],
  gateway_ipv4: ["9.9.9.9"],
  core_origin: "https://core.fixture",
  gateway_origin: "https://gateway.fixture",
  gateway_service_id: service,
  physical_manifest_sha256: "f".repeat(64),
  physical_verified: true,
  all_writers_verified: true,
  prior_gateway_drained: true,
};
const raw = JSON.stringify(authority),
  env = {
    RIDE_AGENT_INFO_FRAME_V3_ENABLED: "true",
    RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON: raw,
  };
const bind = (nonce = randomUUID()) => ({
  protocol_version: 3 as const,
  authority_id: payloadHash(raw),
  binding_id: runtimeBindingId(payloadHash(raw), nonce),
  binding_generation: generation,
  gateway_boot_nonce: nonce,
  account_bank_id: authority.account_bank_id,
  gateway_bank_id: authority.gateway_bank_id,
});

test("App dual binding is default off and rejects wrong network, origin or direct transport before any request", () => {
  assert.equal(
    coreDualBindingReader("invalid", "token", "mainnet", "official", {}),
    undefined,
  );
  assert.throws(() =>
    coreDualBindingReader(
      authority.core_origin,
      "token",
      "testnet",
      "core",
      env,
    ),
  );
  assert.throws(() =>
    coreDualBindingReader(
      authority.core_origin,
      "token",
      "mainnet",
      "official",
      env,
    ),
  );
  assert.throws(() =>
    coreDualBindingReader(
      "https://other.fixture",
      "token",
      "mainnet",
      "core",
      env,
    ),
  );
});

test("App binding discovery is one bounded read-only authenticated GET and validates each new boot", async () => {
  let calls = 0;
  const first = bind(),
    second = bind();
  const reader = coreDualBindingReader(
    authority.core_origin,
    "app-core-test-token",
    "mainnet",
    "core",
    env,
    (async (url: any, init: RequestInit) => {
      assert.equal(
        String(url),
        authority.core_origin + "/internal/ride-info/binding-status",
      );
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.equal(init.body, undefined);
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer app-core-test-token",
      );
      assert.ok(init.signal);
      return Response.json({ binding: ++calls === 1 ? first : second });
    }) as typeof fetch,
  )!;
  assert.deepEqual(
    await reader.currentBinding(new AbortController().signal),
    first,
  );
  assert.deepEqual(
    await reader.currentBinding(new AbortController().signal),
    second,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(reader.currentBinding(abort.signal));
  assert.equal(calls, 2);
});

test("App binding rejects mismatched authority, extra fields and oversized replies", async () => {
  for (const value of [
    { binding: { ...bind(), authority_id: "e".repeat(64) } },
    { binding: bind(), extra: true },
    { padding: "x".repeat(4100) },
  ]) {
    const reader = coreDualBindingReader(
      authority.core_origin,
      "token",
      "mainnet",
      "core",
      env,
      (async () => Response.json(value)) as typeof fetch,
    )!;
    await assert.rejects(reader.currentBinding(new AbortController().signal));
  }
});

async function withBridge(
  dual: boolean,
  run: (
    bridge: any,
    state: { binding: ReturnType<typeof bind>; gets: number; calls: any[] },
  ) => Promise<void>,
) {
  const keys = Object.keys(env),
    previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  for (const key of keys) delete process.env[key];
  if (dual) Object.assign(process.env, env);
  const state = { binding: bind(), gets: 0, calls: [] as any[] };
  globalThis.fetch = (async (url: any, init: RequestInit) => {
    const u = new URL(String(url));
    assert.equal(
      u.origin,
      authority.core_origin,
      "No provider or unrelated destination is allowed",
    );
    if (u.pathname === "/internal/ride-info/binding-status") {
      state.gets++;
      return Response.json({ binding: state.binding });
    }
    const body = JSON.parse(String(init.body));
    state.calls.push({ path: u.pathname, body });
    if (u.pathname === "/internal/agent-core/perps_info_v3_read") {
      if (body.binding_id !== state.binding.binding_id)
        return Response.json(
          { error: { code: "unavailable", upstream_request_sent: true } },
          { status: 503 },
        );
      return Response.json({
        data: { assetPositions: [], marginSummary: { accountValue: "100" } },
        observed_at: Date.now(),
        bank_id:
          body.stage === "account"
            ? authority.account_bank_id
            : authority.gateway_bank_id,
        read_id: randomUUID(),
        retain_until_ms: body.deadline_ms + 60000,
      });
    }
    assert.equal(u.pathname, "/internal/agent-core/perps_info_read");
    return Response.json({
      data: { assetPositions: [], marginSummary: { accountValue: "100" } },
      observed_at: Date.now(),
    });
  }) as typeof fetch;
  const bridge = new CoreBridge(
    authority.core_origin,
    "local-core-service-token",
    "postgresql://postgres@127.0.0.1:1/never-used",
    "local-trader-salt-" + "s".repeat(32),
    "mainnet",
    { infoReadRoute: "core" },
  );
  try {
    await run(bridge, state);
  } finally {
    await bridge.close();
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("App default-off source reads use the unchanged legacy Core route without Gateway discovery", async () => {
  await withBridge(false, async (bridge, state) => {
    await bridge.info(
      { type: "clearinghouseState", user: "0x" + "1".repeat(40) },
      true,
    );
    assert.equal(state.gets, 0);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].path, "/internal/agent-core/perps_info_read");
  });
});

test("App public source reads use G and one binding per complete observation; ordinary A stays on legacy A", async () => {
  await withBridge(true, async (bridge, state) => {
    await bridge.venueReads.runPublicSource(async () => {
      await bridge.info(
        { type: "clearinghouseState", user: "0x" + "1".repeat(40) },
        true,
      );
      await bridge.info(
        { type: "clearinghouseState", user: "0x" + "2".repeat(40) },
        true,
      );
    });
    assert.equal(state.gets, 1);
    assert.equal(state.calls.length, 2);
    for (const call of state.calls) {
      assert.equal(call.body.stage, "source");
      assert.equal(call.body.binding_id, state.binding.binding_id);
      assert.equal(call.body.frame_id, undefined);
    }
    await bridge.info(
      { type: "clearinghouseState", user: "0x" + "3".repeat(40) },
      false,
    );
    assert.equal(state.gets, 1);
    assert.equal(state.calls[2].path, "/internal/agent-core/perps_info_read");
  });
});

test("App in-progress source observation cannot adopt another boot or fall back to A after a stage fails", async () => {
  await withBridge(true, async (bridge, state) => {
    let old = "";
    await assert.rejects(
      bridge.venueReads.runPublicSource(async () => {
        await bridge.info(
          { type: "clearinghouseState", user: "0x" + "4".repeat(40) },
          true,
        );
        old = state.binding.binding_id;
        state.binding = bind();
        await bridge.info(
          { type: "clearinghouseState", user: "0x" + "5".repeat(40) },
          true,
        );
      }),
    );
    assert.equal(state.gets, 1);
    assert.equal(state.calls.length, 2);
    assert.equal(state.calls[1].body.binding_id, old);
    assert.ok(
      state.calls.every(
        (call) => call.path === "/internal/agent-core/perps_info_v3_read",
      ),
    );
    await bridge.info(
      { type: "clearinghouseState", user: "0x" + "6".repeat(40) },
      true,
    );
    assert.equal(state.gets, 2);
    assert.equal(state.calls[2].body.binding_id, state.binding.binding_id);
  });
});
