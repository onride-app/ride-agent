import assert from "node:assert/strict";
import { it } from "node:test";
import { capabilityBytes, parseDualPhysicalAuthority, payloadHash, runtimeBindingId, signGatewayCapability, validateDualRuntimeBinding, verifyGatewayCapability, type GatewayCapability } from "./dual-egress-contract.js";
import { PhysicalVenueBudgetRegistry } from "./physical-venue-budgets.js";
import { SourceReservation } from "./source-reservation.js";
import { VenueReadBudget } from "./venue-read-budget.js";

const signal = () => new AbortController().signal;
function bank() {
  let at = 1000;
  return { budget: new VenueReadBudget({ clock: () => at }), advance: (ms: number) => { at += ms; }, clock: () => at };
}
const ids = { a: "1".repeat(64), g: "2".repeat(64), authority: "3".repeat(64), generation: "11111111-1111-4111-8111-111111111111", boot: "22222222-2222-4222-8222-222222222222" };

it("V3 actual Node capability encoding matches the independent exact-byte reference", () => {
  const json = '{"type":"userFillsByTime","user":"0x4444444444444444444444444444444444444444","startTime":1794410000000,"endTime":1794419999999,"aggregateByTime":false}';
  const cap: GatewayCapability = { protocol_version: 3, binding_id: ids.a, binding_generation: ids.generation, gateway_boot_nonce: ids.boot, read_id: "33333333-3333-4333-8333-333333333333", bank_id: ids.g, stage: "history", deadline_ms: 1794420000123, payload_sha256: payloadHash(json), caller_id: null };
  const key = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
  assert.equal(capabilityBytes(cap).length, 343);
  const expected = "yRQTAC10dF-C2hm7BUKZv-75qeyNctMFbzTxiVH5bWQ";
  assert.equal(signGatewayCapability(cap, key), expected);
  assert.equal(verifyGatewayCapability(cap, expected, key), true);
  for (const last of ["R", "S", "T"])
    assert.equal(verifyGatewayCapability(cap, expected.slice(0, -1) + last, key), false, "noncanonical low padding bits are not a valid wire MAC");
  for (const mutation of [{ bank_id: ids.a }, { stage: "source" }, { payload_sha256: ids.a }, { gateway_boot_nonce: ids.generation }])
    assert.equal(verifyGatewayCapability({ ...cap, ...mutation } as GatewayCapability, expected, key), false);
});

it("runtime binding requires exact authority and actual boot digest without becoming a bank key", () => {
  const expected = { authority_id: ids.authority, binding_generation: ids.generation, account_bank_id: ids.a, gateway_bank_id: ids.g };
  const value = { protocol_version: 3, ...expected, gateway_boot_nonce: ids.boot, binding_id: runtimeBindingId(ids.authority, ids.boot) };
  assert.deepEqual(validateDualRuntimeBinding(value, expected), value);
  assert.throws(() => validateDualRuntimeBinding({ ...value, gateway_boot_nonce: ids.generation }, expected));
  assert.throws(() => validateDualRuntimeBinding({ ...value, authority_id: ids.a }, expected));
  assert.throws(() => validateDualRuntimeBinding({ ...value, caller: "untrusted" }, expected));
});

it("physical banks keep distinct actual fees and cannot reset by alias or IP reassignment", async () => {
  const a = bank(), registry = new PhysicalVenueBudgetRegistry({ accountBudget: a.budget, clock: a.clock });
  const metadata = { account_bank_id: ids.a, gateway_bank_id: ids.g, account_ipv4: ["8.8.8.8"], gateway_ipv4: ["1.1.1.1"] };
  const pair = registry.register(metadata), charge = await pair.gateway.acquire("source", 20, "one", signal(), true);
  charge.sent(); charge.settle(640); charge.release();
  assert.equal(pair.gateway.snapshot().used, 640);
  assert.equal(pair.account.snapshot().used, 0);
  assert.equal(registry.register({ ...metadata }).gateway, pair.gateway);
  assert.throws(() => registry.register({ ...metadata, gateway_bank_id: "4".repeat(64) }));
  assert.throws(() => registry.register({ ...metadata, account_ipv4: metadata.gateway_ipv4, gateway_ipv4: metadata.account_ipv4 }));
  assert.throws(() => registry.register({ ...metadata, gateway_ipv4: ["pretend-source-scope"] }));
});

it("S/H consume only their independent pools, refund only actual fees, and never learn or pace A", async () => {
  const a = bank(), g = bank();
  const seed = await g.budget.acquire("source", 20, "one", signal(), true);
  seed.sent(); seed.settle(640); seed.release(); g.advance(12000); a.advance(12000);
  const plan = a.budget.preparedSupplementPlan("one-source", ["fixed"]);
  const parent = new SourceReservation(g.budget, plan, 20000, (source, weight) => a.budget.recordSourceReservationNeed(plan, source, weight));
  assert.equal(parent.weight, 360);
  assert.equal(g.budget.sourceCapacityReady(1), false);
  const h = parent.fills("fixed");
  for (const [reserve, actual] of [[120, 100], [120, 43]]) {
    const ticket = await g.budget.acquireSource(h, "source", reserve, "one", signal());
    ticket.sent(); ticket.settle(actual); ticket.release(); g.advance(3); a.advance(3);
  }
  h.close(true);
  const s = parent.source();
  for (let n = 0; n < 3; n++) {
    const ticket = await g.budget.acquireSource(s, "source", 2, "one", signal());
    ticket.sent(); ticket.settle(2); ticket.release(); g.advance(3); a.advance(3);
  }
  s.close(true);
  assert.equal(g.budget.snapshot().used, 789);
  assert.equal(g.budget.sourceCapacityReady(1), false);
  parent.close(true);
  assert.equal(g.budget.sourceCapacityReady(211), true);
  assert.equal(a.budget.snapshot().used, 0);
  assert.equal(a.budget.snapshot().observation_pacing_ms, 0);
  assert.equal(a.budget.snapshot().observations.started, 0);
  assert.equal(g.budget.snapshot().observations.started, 0);
});

it("unknown/late source actuals after close keep full debt without an A sample or a renewed parent", async () => {
  const a = bank(), g = bank(), plan = a.budget.preparedSupplementPlan("late-source", []);
  const parent = new SourceReservation(g.budget, plan, 20000, (source, weight) => a.budget.recordSourceReservationNeed(plan, source, weight));
  const s = parent.source(), ticket = await g.budget.acquireSource(s, "source", 20, "one", signal(), true);
  ticket.retainFor!(72000); ticket.sent(); s.close(false); parent.close(false);
  g.advance(100000); a.advance(100000);
  assert.throws(() => ticket.settle(5000)); ticket.release();
  assert.equal(g.budget.snapshot().used, 5000);
  assert.equal(g.budget.snapshot().debt, 4000);
  assert.equal(a.budget.preparedSupplementPlan("late-source", []).sourceWeight, 5000);
  assert.equal(a.budget.snapshot().observations.started, 0);
  assert.equal(a.budget.snapshot().observation_pacing_ms, 0);
  assert.throws(() => parent.source());
  g.advance(60001);
  assert.equal(g.budget.snapshot().used, 0);
});

it("a known remote fee cannot expire before the original last-possible-dispatch plus60s", async () => {
  const g = bank(), ticket = await g.budget.acquire("source", 2, "one", signal());
  ticket.retainFor!(72000); ticket.sent(); ticket.settle(2); ticket.release();
  g.advance(60001);
  assert.equal(g.budget.snapshot().used, 2);
  g.advance(11999);
  assert.equal(g.budget.snapshot().used, 0);
});

it("source capacity cannot report success with an unsettled read and fabricates no A completion", async () => {
  const a = bank(), g = bank(), plan = a.budget.preparedSupplementPlan("pending-source", []);
  const parent = new SourceReservation(g.budget, plan, 20000, (source, weight) => a.budget.recordSourceReservationNeed(plan, source, weight));
  const s = parent.source(), ticket = await g.budget.acquireSource(s, "source", 2, "one", signal());
  assert.throws(() => s.close(true));
  parent.close(false); ticket.release();
  assert.equal(g.budget.snapshot().used, 0);
  assert.equal(a.budget.snapshot().observations.completed, 0);
});

it("physical authority parses the full writer union and agrees on public/doc IPv4 boundaries", () => {
  const authority = { protocol_version: 3, binding_generation: ids.generation, coordination_scope: "default", account_bank_id: ids.a, gateway_bank_id: ids.g,
    account_ipv4: Array.from({ length: 32 }, (_, i) => `8.8.4.${i + 1}`).sort(), gateway_ipv4: ["9.9.9.9"],
    core_origin: "https://core.fixture", gateway_origin: "https://gateway.fixture", gateway_service_id: ids.boot,
    physical_manifest_sha256: ids.authority, physical_verified: true, all_writers_verified: true, prior_gateway_drained: true };
  assert.equal(parseDualPhysicalAuthority(JSON.stringify(authority)).authority.account_ipv4.length, 32);
  assert.deepEqual(parseDualPhysicalAuthority(JSON.stringify({ ...authority, account_ipv4: ["192.0.10.1"] })).authority.account_ipv4, ["192.0.10.1"]);
  for (const ip of ["192.0.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "100.64.0.1", "198.18.0.1"])
    assert.throws(() => parseDualPhysicalAuthority(JSON.stringify({ ...authority, account_ipv4: [ip] })));
  const tooMany = Array.from({ length: 257 }, (_, i) => `8.8.${Math.floor(i / 250)}.${i % 250 + 1}`).sort();
  assert.throws(() => parseDualPhysicalAuthority(JSON.stringify({ ...authority, account_ipv4: tooMany })));
});
