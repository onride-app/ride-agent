import { it } from "node:test";
import assert from "node:assert/strict";
import { Interface, solidityPackedKeccak256 } from "ethers";
import { D } from "./domain.js";
import {
  historicalMark,
  canonicalOutcomeSlot,
  explicitCollateralTransfer,
  collateralConversion,
  inventoryAt,
  equityMetrics,
  PredictionEquityHistory,
  type Movement,
} from "./prediction_equity_history.js";

it("rebuilds cash, fee and redeemed outcome inventory from raw integer transfers", () => {
  const current = new Map([
    ["cash", 1000n],
    ["outcome", 0n],
  ]);
  const movements: Movement[] = [
    {
      at: 10,
      block: 10,
      asset: "cash",
      amount: -501n,
      hash: "buy",
      kind: "cash",
    },
    {
      at: 10,
      block: 10,
      asset: "outcome",
      amount: 1000n,
      hash: "buy",
      kind: "outcome",
    },
    {
      at: 20,
      block: 20,
      asset: "outcome",
      amount: -1000n,
      hash: "redeem",
      kind: "outcome",
    },
    {
      at: 20,
      block: 20,
      asset: "cash",
      amount: 500n,
      hash: "redeem",
      kind: "cash",
    },
  ];
  assert.equal(inventoryAt(current, movements, 5).get("cash"), 1001n);
  assert.equal(inventoryAt(current, movements, 15).get("outcome"), 1000n);
  assert.throws(
    () =>
      inventoryAt(
        current,
        [...movements, { ...movements[0], amount: 99999n }],
        5,
      ),
    /incomplete_transfer_inventory/,
  );
});
it("never values earlier inventory with a future bucket or prematurely applies a settlement payout", () => {
  const prices = [
    { timestamp: 100, resolution_seconds: 10800, price: 0.4 },
    { timestamp: 11000, resolution_seconds: 0, price: 0.6 },
  ];
  assert.throws(
    () => historicalMark(prices, 10900 - 1),
    /missing_historical_price/,
  );
  assert.equal(historicalMark(prices, 10900), 0.4);
  assert.equal(historicalMark(prices, 11500, { at: 12000, price: 1 }), 0.6);
  assert.equal(historicalMark(prices, 12000, { at: 12000, price: 1 }), 1);
  assert.throws(
    () => historicalMark(prices, 50000),
    /missing_historical_price/,
  );
});
it("derives the payout slot from the actual token ID rather than inverted outcome labels", () => {
  const collateral = "0x0000000000000000000000000000000000000010";
  const collections = [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`];
  const token = BigInt(
    solidityPackedKeccak256(
      ["address", "bytes32"],
      [collateral, collections[1]],
    ),
  ).toString();
  assert.equal(canonicalOutcomeSlot(token, collections, [collateral]), 1);
  assert.throws(
    () => canonicalOutcomeSlot("1", collections, [collateral]),
    /unverified_ctf_token_identity/,
  );
});
it("fills missing capital transfers only from exact ERC20 calls and Safe CALLs", () => {
  const wallet = "0x0000000000000000000000000000000000000001",
    other = "0x0000000000000000000000000000000000000002",
    token = "0x0000000000000000000000000000000000000010";
  const erc20 = new Interface([
    "function transfer(address,uint256) returns(bool)",
  ]);
  const safe = new Interface([
    "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) returns(bool)",
  ]);
  const transfer = erc20.encodeFunctionData("transfer", [
    other,
    20_000_000000n,
  ]);
  const movement: Movement = {
    at: 1,
    block: 1,
    asset: `cash:${token}`,
    amount: -20_000_000000n,
    hash: "confirmed",
    kind: "cash",
    from: wallet,
    to: other,
  };
  assert(
    explicitCollateralTransfer(
      { to: token, from: wallet, input: transfer, value: "0x0" },
      movement,
    ),
  );
  const safeTx = (operation: number) => ({
    to: wallet,
    from: other,
    value: "0x0",
    input: safe.encodeFunctionData("execTransaction", [
      token,
      0,
      transfer,
      operation,
      0,
      0,
      0,
      token,
      other,
      "0x",
    ]),
  });
  assert(explicitCollateralTransfer(safeTx(0), movement));
  assert.equal(explicitCollateralTransfer(safeTx(1), movement), false);
  assert.equal(
    explicitCollateralTransfer(safeTx(0), { ...movement, amount: -1n }),
    false,
  );
  assert.equal(
    explicitCollateralTransfer(safeTx(0), { ...movement, to: wallet }),
    false,
  );
  assert.equal(
    explicitCollateralTransfer({ ...safeTx(0), input: "0x" }, movement),
    false,
  );
});
it("recognizes complete internal collateral wrap/unwrap receipts without treating them as capital flows", () => {
  const wallet = "0x0000000000000000000000000000000000000001",
    pusd = "0x0000000000000000000000000000000000000010",
    usdce = "0x0000000000000000000000000000000000000011",
    zero = "0x0000000000000000000000000000000000000000";
  const p: Movement = {
    at: 1,
    block: 1,
    asset: `cash:${pusd}`,
    amount: 20_000_000000n,
    from: zero,
    to: wallet,
    hash: "wrap",
    kind: "cash",
  };
  const u: Movement = {
    ...p,
    asset: `cash:${usdce}`,
    amount: -p.amount,
    from: wallet,
    to: pusd,
  };
  assert(collateralConversion([p, u], wallet, pusd, usdce));
  assert(
    collateralConversion(
      [
        { ...p, from: p.to, to: p.from, amount: -p.amount },
        { ...u, from: u.to, to: u.from, amount: -u.amount },
      ],
      wallet,
      pusd,
      usdce,
    ),
  );
  const vault = "0x0000000000000000000000000000000000000020";
  assert(
    collateralConversion(
      [
        { ...p, from: wallet, to: pusd, amount: -p.amount },
        { ...u, from: vault, to: wallet, amount: -u.amount },
      ],
      wallet,
      pusd,
      usdce,
      vault,
    ),
  );
  assert(
    collateralConversion(
      [
        { ...p, from: wallet, to: pusd, amount: -p.amount },
        { ...u, from: pusd, to: wallet, amount: -u.amount },
      ],
      wallet,
      pusd,
      usdce,
    ),
  );
  assert.equal(
    collateralConversion(
      [p, { ...u, amount: u.amount + 1n }],
      wallet,
      pusd,
      usdce,
    ),
    false,
  );
  assert.equal(
    collateralConversion([p, { ...u, to: wallet }], wallet, pusd, usdce),
    false,
  );
  assert.equal(collateralConversion([p], wallet, pusd, usdce), false);
});
it("computes sampled equity drawdown without needing lifetime PnL or an initial deposit event", () => {
  const points = Array.from({ length: 30 }, (_, i) => ({
    at: 86400 * (i + 1),
    equity: i < 10 ? "1000" : i < 15 ? "2000" : "1800",
  }));
  const provenance = {
    source: "polygon_transfers_and_polymarket_historical_marks",
    sampling: "daily" as const,
    estimated: true,
    cashflow_adjusted: true,
    flow_timing: "deposits_at_start_withdrawals_at_end",
    reconciliation_difference_pct: 0,
  };
  const result = equityMetrics(
    points,
    [{ at: points[10].at, amount: 1000 }],
    provenance,
  );
  assert.equal(result.source_drawdown_pct, 10);
  assert.equal(result.source_roi_pct, -10);
  assert.throws(
    () => equityMetrics(points.slice(0, 10), [], provenance),
    /insufficient_equity_history/,
  );
});

it("reads archive boundaries and whole inventories even when PnL funding/history is unavailable", async (t) => {
  const wallet = "0x0000000000000000000000000000000000000001";
  const cash = "0x0000000000000000000000000000000000000010",
    wrapped = "0x0000000000000000000000000000000000000011",
    ctf = "0x0000000000000000000000000000000000000012";
  const end = Date.UTC(2026, 9, 15, 12) / 1000,
    start = Math.floor(end / 86400) * 86400 - 29 * 86400;
  const single = new Interface([
    "function balanceOf(address) view returns(uint256)",
  ]);
  const multi = new Interface([
    "function balanceOfBatch(address[],uint256[]) view returns(uint256[])",
    "function payoutDenominator(bytes32) view returns(uint256)",
    "function payoutNumerators(bytes32,uint256) view returns(uint256)",
    "function getCollectionId(bytes32,bytes32,uint256) view returns(bytes32)",
  ]);
  const conditionLive = `0x${"1".repeat(64)}`,
    conditionLost = `0x${"2".repeat(64)}`;
  const collection = (condition: string, index: bigint) =>
    `0x${(BigInt(condition) * 4n + index).toString(16).padStart(64, "0")}`;
  const tokenLive = BigInt(
    solidityPackedKeccak256(
      ["address", "bytes32"],
      [cash, collection(conditionLive, 1n)],
    ),
  ).toString();
  const tokenLost = BigInt(
    solidityPackedKeccak256(
      ["address", "bytes32"],
      [cash, collection(conditionLost, 1n)],
    ),
  ).toString();
  let boundaryCalls = 0,
    badPage = false,
    futureHistoricalPoint = false,
    resolveDuringWindow = false,
    allowClobFallback = false;
  const asOfReads: number[] = [];
  t.mock.method(Date, "now", () => end * 1000 + 2000);
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, init?: RequestInit) => {
      if (String(url) === "https://rpc.test/") {
        const body = JSON.parse(String(init!.body));
        const respond = (body: any) => {
          let result: any;
          const [input, tag] = body.params;
          if (body.method === "eth_chainId") result = "0x89";
          else if (body.method === "eth_blockNumber")
            result = `0x${(end / 2 + 6).toString(16)}`;
          else if (body.method === "eth_getBlockByNumber")
            result = {
              timestamp: `0x${(Number(BigInt(input)) * 2).toString(16)}`,
              hash: "fixed",
            };
          else if (body.method === "alchemy_getAssetTransfers")
            result = {
              transfers: [],
              ...(badPage ? { pageKey: "broken" } : {}),
            };
          else if (body.method === "eth_call") {
            if (Number(BigInt(tag)) < end / 2) boundaryCalls++;
            if (input.to === cash || input.to === wrapped)
              result = single.encodeFunctionResult("balanceOf", [
                input.to === cash ? 1000_000000n : 0n,
              ]);
            else {
              const call = multi.parseTransaction({ data: input.data })!;
              if (call.name === "balanceOfBatch")
                result = multi.encodeFunctionResult(call.name, [
                  call.args[1].map((id: bigint) =>
                    id.toString() === tokenLive ? 500_000000n : 100_000000n,
                  ),
                ]);
              else if (call.name === "payoutDenominator")
                result = multi.encodeFunctionResult(call.name, [
                  call.args[0] === conditionLost &&
                  (!resolveDuringWindow ||
                    Number(BigInt(tag)) * 2 >= start + 15 * 86400)
                    ? 1n
                    : 0n,
                ]);
              else if (call.name === "getCollectionId")
                result = multi.encodeFunctionResult(call.name, [
                  collection(call.args[1], call.args[2]),
                ]);
              else result = multi.encodeFunctionResult(call.name, [0n]);
            }
          } else assert.fail(body.method);
          return { jsonrpc: "2.0", id: body.id, result };
        };
        return Response.json(
          Array.isArray(body) ? body.map(respond) : respond(body),
        );
      }
      const u = new URL(url);
      if (u.hostname === "clob.polymarket.com") {
        const at = Number(u.searchParams.get("endTs"));
        return Response.json({
          history: allowClobFallback
            ? [
                { t: at - 7200, p: 0.5 + (at - start) / 86400 / 60 },
                { t: end + 86400, p: 1 },
              ]
            : [],
        });
      }
      const page = (data: unknown[]) =>
        Response.json({
          data,
          pagination: { has_more: false, next_cursor: null },
        });
      if (u.pathname === "/v2/positions")
        return page([
          {
            proxy_wallet: wallet,
            token_id:
              u.searchParams.get("status") === "OPEN" ? tokenLive : tokenLost,
            current_size: 100,
          },
        ]);
      if (u.pathname === "/v2/activity") return page([]);
      if (u.pathname === "/v2/tokens")
        return Response.json({
          data: [tokenLive, tokenLost].map((id) => ({
            token_id: id,
            condition_id: id === tokenLive ? conditionLive : conditionLost,
            module: "v1_ctf",
            outcome_index: 0,
            resolved: id === tokenLost,
          })),
        });
      if (u.pathname === "/v2/resolutions")
        return Response.json({
          data: [
            {
              condition_id: conditionLost,
              status: "resolved",
              resolved_block: (start + 5 * 86400) / 2,
            },
          ],
        });
      if (u.pathname === "/v2/prices-history")
        return page(
          u.searchParams.has("as_of")
            ? (() => {
                const at = Number(u.searchParams.get("as_of"));
                asOfReads.push(at);
                return [
                  {
                    timestamp:
                      at < end && futureHistoricalPoint ? at + 1 : at - 1,
                    resolution_seconds: 0,
                    price: at < end ? 0.5 + (at - start) / 86400 / 60 : 1,
                  },
                ];
              })()
            : [
                ...Array.from({ length: 30 }, (_, i) => ({
                  timestamp: start + i * 86400 - 10800,
                  resolution_seconds: 10800,
                  price: 0.5 + i / 60,
                })).filter((_point, i) => i !== 10),
                { timestamp: end - 1, resolution_seconds: 0, price: 1 },
              ],
        );
      assert.fail(`Unexpected source ${u.pathname}`);
    },
  );
  const reader = new PredictionEquityHistory(
    "https://rpc.test/",
    async () => ({
      collateral: cash,
      wrapped_collateral: wrapped,
      conditional_tokens: ctf,
    }),
    async (owner) => {
      assert.equal(owner, wallet);
      return { wallet: owner, equity: D(1500), at: end * 1000 };
    },
  );
  const result = await reader.load(wallet);
  assert.equal(result.metrics.source_drawdown_pct, 0);
  assert.equal(result.metrics.source_roi_pct, 20);
  assert(asOfReads.includes(start + 10 * 86400));
  assert(boundaryCalls >= 3);
  assert.equal(
    result.metrics.metric_provenance?.inventory_end_block_hash,
    "fixed",
  );
  futureHistoricalPoint = true;
  await assert.rejects(reader.load(wallet), /missing_historical_price/);
  allowClobFallback = true;
  const retained = await reader.load(wallet);
  assert.equal(retained.metrics.source_roi_pct, 20);
  assert(
    retained.metrics.metric_provenance!.fallback_price_sources!.includes(
      "polymarket_clob_prices_history",
    ),
  );
  allowClobFallback = false;
  futureHistoricalPoint = false;
  badPage = true;
  await assert.rejects(reader.load(wallet), /incomplete_chain_transfer_pages/);
  badPage = false;
  resolveDuringWindow = true;
  const transition = await reader.load(wallet);
  const curve = (transition.evidence as any).curve;
  assert(Math.abs(Number(curve[10].equity) - 1400) < 1e-9);
  assert.equal(Number(curve[15].equity), 1375);
});

it("does not request a retired archive or scan chain history without an independent accounting anchor", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    assert.fail("Unanchored reconstruction must stop before HTTP"),
  );
  const reader = new PredictionEquityHistory("https://rpc.test", async () =>
    assert.fail("No unanchored scan"),
  );
  await assert.rejects(
    reader.load("0x" + "a".repeat(40)),
    /accounting_snapshot_retired/,
  );
});
