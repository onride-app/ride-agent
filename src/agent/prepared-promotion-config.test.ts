import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { CoreBridge } from "./core_bridge.js";

const authority = {
  protocol_version: 3, binding_generation: randomUUID(), coordination_scope: "default",
  account_bank_id: "a".repeat(64), gateway_bank_id: "b".repeat(64),
  account_ipv4: ["8.8.8.8"], gateway_ipv4: ["9.9.9.9"],
  core_origin: "https://core.fixture", gateway_origin: "https://gateway.fixture",
  gateway_service_id: randomUUID(), physical_manifest_sha256: "c".repeat(64),
  physical_verified: true, all_writers_verified: true, prior_gateway_drained: true,
};
const flag = "RIDE_AGENT_PREPARED_PROMOTION_V1_ENABLED";
const keys = [flag, "RIDE_AGENT_INFO_FRAME_V3_ENABLED", "RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON"];

test("App promotion flag is strict, defaults off, and reaches the actual VenueReads constructor", async () => {
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  const originalPool = pg.Pool, originalFetch = globalThis.fetch;
  let pools = 0, ended = 0, requests = 0;
  (pg as any).Pool = class {
    constructor() { pools++; }
    async end() { ended++; }
    query() { assert.fail("No PG query is authorized by configuration validation"); }
  };
  globalThis.fetch = (async () => { requests++; assert.fail("No network call during configuration validation"); }) as typeof fetch;
  const bridge = (network: "mainnet" | "testnet" = "mainnet", route: "core" | "official" = "core", origin = authority.core_origin) =>
    new CoreBridge(origin, "local-fixture-core-token-" + "x".repeat(32), "postgresql://postgres@127.0.0.1:1/not-used", "s".repeat(40), network, { infoReadRoute: route });
  try {
    for (const k of keys) delete process.env[k];
    for (const value of [undefined, "false", "True", "1", ""]) {
      if (value === undefined) delete process.env[flag]; else process.env[flag] = value;
      const b = bridge();
      assert.equal((b as any).venueReads.preparedPromotionV1, false);
      await b.close();
    }
    process.env[flag] = "true";
    const before = pools;
    assert.throws(() => bridge(), /validated dual reads/);
    assert.equal(pools, before, "Missing V3 must reject before allocating a pool");
    process.env.RIDE_AGENT_INFO_FRAME_V3_ENABLED = "true";
    process.env.RIDE_AGENT_INFO_FRAME_V3_AUTHORITY_JSON = JSON.stringify(authority);
    const invalidRoutes: readonly ["mainnet" | "testnet", "core" | "official", string?][] = [
      ["testnet", "core"], ["mainnet", "official"], ["mainnet", "core", "https://wrong.fixture"],
    ];
    for (const [network, route, origin] of invalidRoutes) {
      assert.throws(() => bridge(network, route, origin));
      assert.equal(pools, before, "Invalid dual routing must reject before allocating a pool");
    }
    const active = bridge();
    assert.equal((active as any).venueReads.preparedPromotionV1, true);
    await active.close();
    delete process.env[flag];
    const unchanged = bridge();
    assert.equal((unchanged as any).venueReads.preparedPromotionV1, false, "V3 does not implicitly enable promotion changes");
    await unchanged.close();
    assert.equal(ended, pools);
    assert.equal(requests, 0);
  } finally {
    (pg as any).Pool = originalPool;
    globalThis.fetch = originalFetch;
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
