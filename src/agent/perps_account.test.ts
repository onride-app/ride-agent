import { it } from "node:test";
import assert from "node:assert/strict";
import {
  perpsAbstractionState,
  perpsAccountMode,
  unifiedUsdc,
} from "./perps_account.js";

it("maps every current userAbstraction enum explicitly and never treats unknown data as Standard", () => {
  for (const [value, expected] of [
    ["default", "standard"],
    ["disabled", "standard"],
    ["unifiedAccount", "unified"],
    ["dexAbstraction", "dex_abstraction"],
    ["portfolioMargin", "portfolio_margin"],
  ])
    assert.equal(perpsAbstractionState(value), expected);
  for (const value of [
    null,
    undefined,
    false,
    true,
    0,
    {},
    [],
    "",
    "futureMode",
    "d-i-s-a-b-l-e-d",
  ])
    assert.equal(perpsAbstractionState(value), "unknown");
  for (const value of ["dexAbstraction", "portfolioMargin", "futureMode", null])
    assert.equal(perpsAccountMode(value), "unsupported");
  for (const value of [
    { abstraction: "default", mode: "portfolioMargin" },
    { abstraction: "default", response: { mode: "dexAbstraction" } },
    { abstraction: "default", userAbstraction: "futureMode" },
    { abstraction: null, response: "default" },
  ]) {
    assert.equal(perpsAbstractionState(value), "unknown");
    assert.equal(perpsAccountMode(value), "unsupported");
  }
  assert.equal(
    perpsAbstractionState({ abstraction: "disabled", mode: "default" }),
    "standard",
  );
});

it("counts unified USDC once and deducts all spot holds", () => {
  assert.deepEqual(
    unifiedUsdc({
      balances: [
        { coin: "USDC", token: 0, total: "36.302807", hold: "6.1" },
        { coin: "HYPE", token: 150, total: "9999", hold: "0" },
      ],
    }),
    { equity: "36.302807", available: "30.202807" },
  );
  assert.equal(
    perpsAccountMode({ response: { abstraction: "unifiedAccount" } }),
    "unified",
  );
  assert.equal(perpsAccountMode("disabled"), "standard");
  assert.equal(perpsAccountMode("portfolioMargin"), "unsupported");
  assert.equal(perpsAccountMode({}), "unsupported");
});

it("refuses missing, duplicate, negative, nonfinite and inconsistent unified balances", () => {
  const row = { coin: "USDC", token: 0, total: "36.302807", hold: "0" };
  for (const balances of [
    undefined,
    [],
    [row, row],
    [{ ...row, token: 1 }],
    [{ ...row, total: "NaN" }],
    [{ ...row, total: "Infinity" }],
    [{ ...row, total: "-1" }],
    [{ ...row, hold: "-1" }],
    [{ ...row, hold: "40" }],
    [{ ...row, hold: undefined }],
  ]) {
    assert.throws(() => unifiedUsdc({ balances }), /could not be verified/);
  }
});
