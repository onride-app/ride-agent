import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentError } from "./contracts.js";
import { readCost, responseCost } from "./venue-read-cost.js";

it("charges only the six official cheap info methods at weight two", () => {
  for (const method of ["l2Book", "allMids", "clearinghouseState", "orderStatus", "spotClearinghouseState", "exchangeStatus"])
    assert.deepEqual(readCost({ type: method }), { method, base: 2, reserve: 2 });
  assert.deepEqual(readCost({ type: "userRole" }), { method: "userRole", base: 60, reserve: 60 });
});

it("charges ordinary documented methods including both open order forms at twenty", () => {
  for (const method of ["meta", "spotMeta", "metaAndAssetCtxs", "spotMetaAndAssetCtxs", "perpDexs", "perpCategories", "userAbstraction", "userDexAbstraction", "frontendOpenOrders", "openOrders", "userNonFundingLedgerUpdates", "maxBuilderFee", "userRateLimit"]) {
    const cost = readCost({ type: method });
    assert.deepEqual(cost, { method, base: 20, reserve: 20 });
    // Cost accounting must not reinterpret or hide an order payload. Its
    // semantic validation and ownership checks belong to the account reader.
    assert.equal(responseCost(cost, [{ isTrigger: true, oid: 1 }]), 20);
  }
});

it("reserves the full explicit fill and order response bound and settles every partial group conservatively", () => {
  for (const method of ["userFills", "userFillsByTime", "historicalOrders", "userTwapSliceFills"]) {
    const cost = readCost({ type: method });
    assert.deepEqual(cost, { method, base: 20, reserve: 120, rows: { maximum: 2000, divisor: 20 } });
    for (const [length, weight] of [[0, 20], [1, 21], [19, 21], [20, 21], [21, 22], [1999, 120], [2000, 120]])
      assert.equal(responseCost(cost, Array(length).fill({})), weight, `${method}:${length}`);
  }
});

it("reserves all five thousand candles and rounds a partial sixty-candle group up", () => {
  const cost = readCost({ type: "candleSnapshot" });
  assert.deepEqual(cost, { method: "candleSnapshot", base: 20, reserve: 104, rows: { maximum: 5000, divisor: 60 } });
  for (const [length, weight] of [[0, 20], [1, 21], [59, 21], [60, 21], [61, 22], [5000, 104]])
    assert.equal(responseCost(cost, Array(length).fill({})), weight);
});

it("rejects malformed or oversized bounded responses rather than settling a cheaper empty result", () => {
  for (const method of ["userFillsByTime", "candleSnapshot"]) {
    const cost = readCost({ type: method });
    for (const data of [null, {}, "[]", { length: 0 }, Array(cost.rows!.maximum! + 1).fill({})])
      assert.throws(() => responseCost(cost, data), (error) => error instanceof AgentError && error.code === "VENUE_RESPONSE_INVALID" && error.httpStatus === 503);
  }
});

it("rejects unknown methods without exposing request fields", () => {
  for (const payload of [null, undefined, [], "allMids", {}, { type: 2 }, { type: "" }, { type: "futureType", user: "private-user" }]) {
    assert.throws(() => readCost(payload), (error) => error instanceof AgentError && error.code === "VENUE_READ_UNSUPPORTED" && error.httpStatus === 503 && !error.message.includes("private-user"));
  }
});

it("marks documented unbounded surcharges explicitly and accounts for every actual row without a guessed raw maximum", () => {
  for (const method of ["recentTrades", "fundingHistory", "userFunding", "nonUserFundingUpdates", "twapHistory", "userTwapSliceFillsByTime", "delegatorHistory", "delegatorRewards", "validatorStats"]) {
    const cost = readCost({ type: method });
    assert.deepEqual(cost, { method, base: 20, reserve: 20, rows: { divisor: 20 }, unknownSurcharge: true });
    for (const [length, actual] of [[0, 20], [1, 21], [20, 21], [21, 22], [501, 46], [20001, 1021], [24001, 1221]])
      assert.equal(responseCost(cost, Array(length).fill({})), actual, `${method}:${length}`);
    assert.ok(responseCost(cost, Array(24001).fill({})) > cost.reserve);
    for (const data of [null, {}, "[]", { length: 0 }])
      assert.throws(() => responseCost(cost, data), (error) => error instanceof AgentError && error.code === "VENUE_RESPONSE_INVALID" && error.httpStatus === 503);
  }
});

it("returns independent row contracts so one caller cannot mutate future reservations", () => {
  const cost = readCost({ type: "userFillsByTime" });
  cost.rows!.maximum = 1;
  assert.equal(readCost({ type: "userFillsByTime" }).reserve, 120);
  assert.equal(readCost({ type: "userFillsByTime" }).rows!.maximum, 2000);
});
