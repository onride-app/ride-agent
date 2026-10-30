import assert from "node:assert/strict";
import { it } from "node:test";
import { CoreBridge } from "./core_bridge.js";
import { D, now } from "./domain.js";
import type { SourceFill, SourceSnapshot } from "./adapter.js";
import {
  inObservedPerpsScope,
  orderedSourceFills,
  scopedSourceFills,
} from "./source-fill-evidence.js";

const start = 1000,
  at = 1001,
  end = 2000,
  key = "perps:BTC";
function source(quantity = "0"): SourceSnapshot {
  return {
    observed_at: end,
    revision: "current",
    account_value_usdc: "100",
    complete: true,
    positions:
      quantity === "0"
        ? []
        : [
            {
              key,
              asset: "BTC",
              market: "perps",
              quantity,
              price: "100",
              source_leverage: 1,
              source_entry_price: "100",
              observed_at: end,
              source_revision: "current",
            },
          ],
  };
}
function fill(
  id: string,
  before: string,
  after: string,
  time = at,
): SourceFill {
  return {
    id,
    key,
    start_quantity: before,
    quantity: D(after).minus(before).toString(),
    price: "100",
    fee_usdc: "0",
    realized_usdc: "0",
    at: time,
  };
}
function ordered(
  fills: SourceFill[],
  snapshot = source(),
  prior: Record<string, string> = {},
) {
  return orderedSourceFills(fills, snapshot, start, end, prior, []);
}
function raw(coin: unknown = "BTC", time: unknown = at) {
  return {
    coin,
    time,
    tid: 1,
    oid: 2,
    startPosition: "2",
    sz: "2",
    side: "A",
    px: "100",
    feeToken: "USDC",
    fee: "0",
    closedPnl: "0",
  };
}

it("reconstructs eight same-millisecond reductions from position evidence independently of opaque ID order", () => {
  const quantities = [
    "-80",
    "-77",
    "-61",
    "-60",
    "-42",
    "-25",
    "-20",
    "-7",
    "0",
  ];
  const chronological = quantities
    .slice(1)
    .map((quantity, index) =>
      fill(`opaque_${8 - index}`, quantities[index], quantity),
    );
  for (const input of [
    chronological,
    [...chronological].reverse(),
    [
      chronological[3],
      chronological[1],
      chronological[7],
      chronological[4],
      chronological[0],
      chronological[6],
      chronological[2],
      chronological[5],
    ],
  ]) {
    assert.deepEqual(
      ordered(input, source(), { [key]: "-80" }).map((f) => f.id),
      chronological.map((f) => f.id),
    );
  }
});

it("connects timestamp buckets to the current snapshot and known prior while keeping independent asset chains", () => {
  const first = fill("z", "4", "2"),
    last = fill("a", "2", "0", at + 1);
  const other = { ...fill("other", "9", "0"), key: "perps:ETH" };
  assert.deepEqual(
    ordered([last, other, first], source(), { [key]: "4" }).map((f) => f.id),
    ["z", "other", "a"],
  );
});

it("does not assume an untracked source position started at zero", () => {
  assert.equal(ordered([fill("unknown-baseline-close", "3", "0")]).length, 1);
});

it("handles a 2000-fill same-time group with linear chain selection and immediately rejects 2000-way ambiguity", () => {
  const count = 2000;
  const chain = Array.from({ length: count }, (_, index) =>
    fill(
      `fill_${count - index}`,
      String(count - index),
      String(count - index - 1),
    ),
  );
  const result = ordered([...chain].reverse(), source(), {
    [key]: String(count),
  });
  assert.equal(result.length, count);
  assert.deepEqual(
    result.map((f) => f.id),
    chain.map((f) => f.id),
  );
  const branching = Array.from({ length: count }, (_, index) =>
    fill(`branch_${index}`, String(index + 1), "0"),
  );
  assert.throws(() => ordered(branching), /incomplete or ambiguous/);
});

it("deduplicates only identical evidence, never using IDs to infer chronology", () => {
  const close = fill("same", "2", "0");
  assert.equal(ordered([close, { ...close }]).length, 1);
  assert.throws(
    () => ordered([close, { ...close, price: "101" }]),
    /conflicting evidence/,
  );
});

for (const issue of [
  "missing start",
  "broken link",
  "ambiguous predecessor",
  "cycle",
  "wrong current",
  "wrong prior",
  "out of window",
  "invalid time",
  "empty key",
  "spot key",
  "zero quantity",
  "invalid price",
])
  it(`rejects ${issue} without guessing fill order`, () => {
    let fills = [fill("first", "4", "2"), fill("last", "2", "0")],
      snapshot = source(),
      prior: Record<string, string> = {};
    if (issue === "missing start") delete fills[0].start_quantity;
    if (issue === "broken link") fills[0] = fill("first", "4", "3");
    if (issue === "ambiguous predecessor") fills.push(fill("branch", "1", "0"));
    if (issue === "cycle")
      fills = [fill("out", "0", "1"), fill("back", "1", "0")];
    if (issue === "wrong current") snapshot = source("1");
    if (issue === "wrong prior") prior[key] = "7";
    if (issue === "out of window") fills[0].at = end;
    if (issue === "invalid time") fills[0].at = at + 0.1;
    if (issue === "empty key") fills[0].key = "perps:";
    if (issue === "spot key") fills[0].key = "perps:@1";
    if (issue === "zero quantity") fills[0].quantity = "0";
    if (issue === "invalid price") fills[0].price = "NaN";
    assert.throws(() => ordered(fills, snapshot, prior), {
      code: "SOURCE_FILL_EVIDENCE_MISSING",
    });
  });

it("includes native symbols even after closure and includes only explicitly observed HIP3 dex scopes", () => {
  assert.equal(inObservedPerpsScope("DELISTED", [""]), true);
  assert.equal(inObservedPerpsScope("xyz:UNKNOWN", ["", "xyz"]), true);
  assert.equal(inObservedPerpsScope("xyz:CL", [""]), false);
  for (const coin of ["@0", "@107", "PURR/USDC"])
    assert.equal(inObservedPerpsScope(coin, ["", "xyz"]), false);
  const result = scopedSourceFills(
    [raw("BTC"), raw("xyz:CL"), raw("@107"), raw("PURR/USDC")],
    "fixture",
    [""],
    start,
    end,
  );
  assert.deepEqual(
    result.map((f) => f.key),
    [key],
  );
});

for (const coin of [
  undefined,
  null,
  "",
  12,
  "@01",
  "@-1",
  "@@1",
  "BTC/USDC",
  "xyz::CL",
  "xyz:",
  ":CL",
  "xyz:CL/USDC",
  " BTC",
  "#100",
])
  it(`fails closed for malformed or unsupported source identity ${JSON.stringify(coin)}`, () => {
    const row = raw();
    row.coin = coin;
    assert.throws(() => scopedSourceFills([row], "fixture", [""], start, end), {
      code: "SOURCE_FILL_EVIDENCE_MISSING",
    });
  });

for (const time of [undefined, null, "1001", 1001.5, NaN, Infinity, -1])
  it(`does not silently drop an invalid history timestamp ${String(time)}`, () => {
    const row = raw();
    row.time = time;
    assert.throws(() => scopedSourceFills([row], "fixture", [""], start, end), {
      code: "SOURCE_FILL_EVIDENCE_MISSING",
    });
  });

it("keeps the half-open cursor window and validates identities even outside the window", () => {
  assert.equal(
    scopedSourceFills(
      [raw("BTC", start), raw("BTC", end)],
      "fixture",
      [""],
      start,
      end,
    ).length,
    1,
  );
  assert.throws(() =>
    scopedSourceFills([raw("bad/identity", end)], "fixture", [""], start, end),
  );
  // A known foreign scope can be classified without parsing its finance data.
  assert.deepEqual(
    scopedSourceFills(
      [{ coin: "xyz:CL", time: at }],
      "fixture",
      [""],
      start,
      end,
    ),
    [],
  );
});

for (const dexes of [[], ["xyz"], ["", ""], ["", "bad:scope"], ["", null]])
  it(`requires explicit valid observed scopes ${JSON.stringify(dexes)}`, () => {
    assert.throws(
      () => scopedSourceFills([], "fixture", dexes as string[], start, end),
      { code: "SOURCE_FILL_EVIDENCE_MISSING" },
    );
  });

it("uses precisely the native / RWA scopes observed by readSource, including successful USDC scopes only", async (context) => {
  const before = process.env.RIDE_AGENT_RWA_ENABLED;
  context.after(() => {
    if (before === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = before;
  });
  for (const enabled of [false, true])
    for (const tagged of [false, true]) {
      process.env.RIDE_AGENT_RWA_ENABLED = String(enabled);
      const bridge = new CoreBridge(
          "https://core.test",
          "fixture",
          "postgresql://localhost/unused",
          "s".repeat(32),
          "mainnet",
        ),
        stub = bridge as any;
      const reads: string[] = [],
        time = now() - 100;
      stub.resolve = async () => ({
        address: "0x" + "a".repeat(40),
        tags: tagged ? ["category:stocks_rwa"] : [],
      });
      stub.info = async (input: any, isSource: boolean) => {
        assert.equal(isSource, true);
        reads.push(input.type + ":" + (input.dex ?? ""));
        if (input.type === "clearinghouseState")
          return { marginSummary: { accountValue: "100" }, assetPositions: [] };
        if (input.type === "userAbstraction") return "standard";
        if (input.type === "userDexAbstraction") return false;
        if (input.type === "perpCategories")
          return [
            ["xyz:CL", "commodities"],
            ["cash:TSLA", "stocks"],
          ];
        if (input.type === "meta")
          return { collateralToken: input.dex === "cash" ? 1 : 0 };
        if (input.type === "userFillsByTime")
          return [
            raw("BTC", time),
            { ...raw("xyz:CL", time), tid: 3, oid: 4 },
            { ...raw("cash:TSLA", time), tid: 5, oid: 6 },
          ];
        assert.fail("Unexpected read " + input.type);
      };
      stub.infoWithEvidence = async (input: any, isSource: boolean) => ({
        value: await stub.info(input, isSource),
        observed_at: now(),
      });
      try {
        if (tagged && !enabled) {
          await assert.rejects(bridge.source("fixture"), {
            code: "SOURCE_SCOPE_UNAVAILABLE",
          });
          continue;
        }
        const observation = await bridge.source("fixture");
        const scopes = enabled && tagged ? ["", "xyz"] : [""];
        assert.deepEqual(observation.perps_dexes, scopes);
        const history = (await bridge.operation("source_fills", {
          trader_id: "fixture",
          market: "perps",
          start_at: time - 1,
          end_at: time + 1,
        })) as any;
        assert.equal(history.complete, true);
        assert.deepEqual(
          history.fills.map((f: SourceFill) => f.key),
          enabled && tagged ? [key, "perps:xyz:CL"] : [key],
        );
        assert.equal(reads.includes("perpCategories:"), enabled && tagged);
        stub.paged = async () => ({
          events: [raw("xyz:CL", time)],
          complete: false,
        });
        assert.equal(
          (
            (await bridge.operation("source_fills", {
              trader_id: "fixture",
              market: "perps",
              start_at: time - 1,
              end_at: time + 1,
            })) as any
          ).complete,
          false,
        );
      } finally {
        await bridge.close();
      }
    }
});

it("rejects missing scope metadata and conflicting raw identities rather than claiming complete source history", async () => {
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any,
    time = now() - 100;
  stub.resolve = async () => ({ address: "fixture" });
  stub.source = async () => ({ ...source(), observed_at: now() });
  const input = {
    trader_id: "fixture",
    market: "perps",
    start_at: time - 1,
    end_at: time + 1,
  };
  try {
    await assert.rejects(
      bridge.operation("source_fills", input),
      /scopes are unavailable/,
    );
    stub.source = async () => ({
      ...source(),
      observed_at: now(),
      perps_dexes: [""],
    });
    stub.info = async () => [
      raw("BTC", time),
      { ...raw("BTC", time), sz: "3" },
    ];
    await assert.rejects(
      bridge.operation("source_fills", input),
      /conflicting history/,
    );
  } finally {
    await bridge.close();
  }
});

it("does not use the global RWA switch as evidence that a crypto source observed a foreign position", async (context) => {
  const before = process.env.RIDE_AGENT_RWA_ENABLED;
  process.env.RIDE_AGENT_RWA_ENABLED = "true";
  context.after(() => {
    if (before === undefined) delete process.env.RIDE_AGENT_RWA_ENABLED;
    else process.env.RIDE_AGENT_RWA_ENABLED = before;
  });
  const bridge = new CoreBridge(
      "https://core.test",
      "fixture",
      "postgresql://localhost/unused",
      "s".repeat(32),
      "mainnet",
    ),
    stub = bridge as any;
  stub.resolve = async () => ({ address: "fixture", tags: [] });
  stub.info = async (input: any) => {
    assert.equal(input.type, "clearinghouseState");
    return {
      marginSummary: { accountValue: "100" },
      assetPositions: [
        {
          position: {
            coin: "xyz:OIL",
            szi: "1",
            positionValue: "100",
            entryPx: "100",
            leverage: { value: 1 },
          },
        },
      ],
    };
  };
  stub.infoWithEvidence = async (input: any, isSource: boolean) => ({
    value: await stub.info(input, isSource),
    observed_at: now(),
  });
  try {
    await assert.rejects(bridge.source("fixture"), { code: "SOURCE_STALE" });
  } finally {
    await bridge.close();
  }
});
