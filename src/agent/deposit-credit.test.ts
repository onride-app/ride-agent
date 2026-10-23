import { it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { id as eventId } from "ethers";
import { DepositReads, type Deposit } from "./deposits.js";
import { now, uid } from "./domain.js";
it("separates wallet receipt, account activation, contract receipt and verified trading credit", async () => {
  const owner = "0x" + "5".repeat(40),
    bridge = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
    tx = "0x" + "a".repeat(64);
  let receipt: any = null,
    active = false,
    trading = "0",
    incomplete = false;
  const app = express();
  app.use(express.json());
  app.post("/", (req, res) => {
    const answer = (m: any) => ({
      jsonrpc: "2.0",
      id: m.id,
      result:
        m.method === "eth_chainId"
          ? "0xa4b1"
          : m.method === "eth_getTransactionReceipt"
            ? receipt
            : "0x" + 10000000n.toString(16).padStart(64, "0"),
    });
    res.json(Array.isArray(req.body) ? req.body.map(answer) : answer(req.body));
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const before = process.env.RIDE_AGENT_ARBITRUM_RPC_URL;
  process.env.RIDE_AGENT_ARBITRUM_RPC_URL = url;
  const request: typeof fetch = async (input, init) =>
    String(input).includes("hyperliquid.xyz")
      ? new Response(
          JSON.stringify(
            JSON.parse(String(init?.body)).type === "userAbstraction"
              ? "disabled"
              : incomplete
                ? {}
                : {
                    withdrawable: trading,
                    marginSummary: { accountValue: trading },
                    assetPositions: [],
                  },
          ),
          { status: 200 },
        )
      : fetch(input, init);
  const reads = new DepositReads(
    async () => ({
      master: owner,
      status: active ? "active" : "approval_required",
    }),
    "mainnet",
    request,
  );
  const d: Deposit = {
    id: uid("deposit"),
    market: "perps",
    asset: "USDC",
    network: "Arbitrum",
    address: owner,
    provider: "wallet",
    created_at: now(),
    baseline_wallet_usdc: "0",
    funding: {
      id: uid("funding"),
      amount_usdc: "10",
      created_at: now(),
      expires_at: now() + 300000,
      preview_hash: "b".repeat(64),
      status: "submitted",
      transaction_hash: tx,
      quote: { baseline_trading_available_usdc: "0" },
    },
  };
  try {
    const wallet = await reads.status(d, "alice");
    assert.equal(wallet.status, "wallet_balance_increased");
    assert.equal(wallet.available_to_copy, false);
    assert.equal(wallet.funding_credit_verified, false);
    trading = "10";
    const activation = await reads.status(d, "alice");
    assert.equal(activation.status, "activation_required");
    assert.equal(activation.available_to_copy, false);
    active = true;
    const pending = await reads.status(d, "alice");
    assert.equal(pending.available_to_copy, true);
    assert.equal(pending.funding_credit_verified, false);
    receipt = { transactionHash: tx, to: bridge, status: "0x1", logs: [] };
    assert.equal(
      (await reads.status(d, "alice")).funding_credit_verified,
      false,
    );
    receipt.logs = [
      {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        topics: [
          eventId("Transfer(address,address,uint256)"),
          "0x" + owner.slice(2).padStart(64, "0"),
          "0x" + bridge.slice(2).padStart(64, "0"),
        ],
        data: "0x" + 10000000n.toString(16).padStart(64, "0"),
      },
    ];
    const credit = await reads.status(d, "alice");
    assert.equal(credit.funding_receipt, "confirmed");
    assert.equal(credit.funding_credit_verified, true);
    assert.equal(credit.trading_balance_usdc, "10.000000");
    incomplete = true;
    await assert.rejects(reads.status(d, "alice"), /incomplete/);
  } finally {
    if (before == null) delete process.env.RIDE_AGENT_ARBITRUM_RPC_URL;
    else process.env.RIDE_AGENT_ARBITRUM_RPC_URL = before;
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("reads Unified USDC once, respects holds and verifies funding against the same account mode", async (t) => {
  const owner = "0x" + "5".repeat(40),
    bridge = "0x2df1c51e09aecf9cacb7bc98cb1742757f163df7",
    tx = "0x" + "a".repeat(64);
  let mode: any = "unifiedAccount",
    secondMode: any = undefined,
    modeReads = 0,
    spot: any,
    rpcChain = "0xa4b1",
    rpcFailed = false,
    infoFailed = false,
    infoMalformed = false;
  const infoTypes: string[] = [];
  const app = express();
  app.use(express.json());
  app.post("/", (req, res) => {
    const answer = (m: any) =>
      rpcFailed
        ? {
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32000, message: "RPC unavailable" },
          }
        : {
            jsonrpc: "2.0",
            id: m.id,
            result:
              m.method === "eth_chainId" ? rpcChain : "0x" + "0".repeat(64),
          };
    res.json(Array.isArray(req.body) ? req.body.map(answer) : answer(req.body));
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const beforeRpc = process.env.RIDE_AGENT_ARBITRUM_RPC_URL,
    beforeUnified = process.env.RIDE_AGENT_UNIFIED_ENABLED;
  process.env.RIDE_AGENT_ARBITRUM_RPC_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  const receipt = {
    transactionHash: tx,
    to: bridge,
    status: "0x1",
    logs: [
      {
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        topics: [
          eventId("Transfer(address,address,uint256)"),
          "0x" + owner.slice(2).padStart(64, "0"),
          "0x" + bridge.slice(2).padStart(64, "0"),
        ],
        data: "0x" + 10000000n.toString(16).padStart(64, "0"),
      },
    ],
  };
  const request: typeof fetch = async (_input, init) => {
    const input = JSON.parse(String(init?.body));
    if (input.method === "eth_getTransactionReceipt")
      return Response.json({ result: receipt });
    infoTypes.push(input.type);
    if (infoFailed) throw Error("venue timeout");
    if (infoMalformed) return new Response("invalid JSON");
    if (input.type === "userAbstraction") {
      modeReads++;
      return Response.json(
        modeReads === 2 && secondMode !== undefined ? secondMode : mode,
      );
    }
    if (input.type === "spotClearinghouseState") return Response.json(spot);
    if (input.type === "clearinghouseState")
      return Response.json({
        withdrawable: "0.0",
        marginSummary: { accountValue: "900" },
        assetPositions: [],
      });
    throw Error("unexpected venue read");
  };
  const reads = new DepositReads(
    async () => ({ master: owner, status: 4 }),
    "mainnet",
    request,
  );
  const d: Deposit = {
    id: uid("deposit"),
    market: "perps",
    asset: "USDC",
    network: "Arbitrum",
    address: owner,
    provider: "wallet",
    created_at: now(),
    amount_usdc: "10",
    baseline_wallet_usdc: "0",
  };
  const reset = () => {
    mode = "unifiedAccount";
    secondMode = undefined;
    modeReads = 0;
    spot = {
      balances: [{ coin: "USDC", token: 0, total: "40.279657", hold: "4" }],
    };
    infoTypes.length = 0;
    rpcChain = "0xa4b1";
    rpcFailed = infoFailed = infoMalformed = false;
    process.env.RIDE_AGENT_UNIFIED_ENABLED = "true";
    delete d.funding;
  };
  try {
    await t.test(
      "already funded Unified account is ready even with empty wallet and legacy withdrawable zero",
      async () => {
        reset();
        const status = await reads.status(d, "alice");
        assert.equal(status.wallet_balance_usdc, "0.000000");
        assert.equal(status.trading_balance_usdc, "36.279657");
        assert.equal(status.trading_account_mode, "unified");
        assert.equal(
          status.trading_balance_basis,
          "spot_usdc_total_minus_hold",
        );
        assert.equal(status.status, "trading_ready");
        assert.equal(status.available_to_copy, true);
        assert.equal(status.funding_credit_verified, false);
        assert.equal(status.funding_status, null);
        assert.deepEqual(infoTypes, [
          "userAbstraction",
          "spotClearinghouseState",
          "userAbstraction",
        ]);
        assert.doesNotMatch(status.next_action, /Use prepare_deposit/);
      },
    );
    await t.test(
      "known balance does not bypass disabled Unified execution",
      async () => {
        reset();
        delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
        const status = await reads.status(d, "alice");
        assert.equal(status.trading_balance_usdc, "36.279657");
        assert.equal(status.available_to_copy, false);
        assert.equal(status.account_mode_supported, false);
        assert.equal(status.status, "account_mode_unsupported");
        assert.match(status.next_action, /do not repeat funding/);
      },
    );
    await t.test("holds are not available collateral", async () => {
      reset();
      spot.balances[0].hold = spot.balances[0].total;
      const status = await reads.status(d, "alice");
      assert.equal(status.trading_balance_usdc, "0.000000");
      assert.equal(status.available_to_copy, false);
      assert.equal(status.sufficient_for_amount, false);
    });
    await t.test("unknown modes and changing modes fail closed", async () => {
      reset();
      mode = "portfolioMargin";
      await assert.rejects(reads.status(d, "alice"), {
        code: "TRADING_ACCOUNT_MODE_UNAVAILABLE",
      });
      reset();
      secondMode = "disabled";
      await assert.rejects(reads.status(d, "alice"), {
        code: "TRADING_BALANCE_UNAVAILABLE",
      });
    });
    await t.test(
      "invalid Unified evidence is unavailable rather than zero",
      async () => {
        for (const invalid of [
          {},
          { balances: [{ coin: "USDC", token: 0, total: "40", hold: "41" }] },
          { balances: [{ coin: "USDC", token: 0, total: "NaN", hold: "0" }] },
          { balances: [{ coin: "USDC", token: 1, total: "40", hold: "0" }] },
        ]) {
          reset();
          spot = invalid;
          await assert.rejects(reads.status(d, "alice"), {
            code: "ACCOUNT_STALE",
          });
        }
      },
    );
    await t.test(
      "venue transport or invalid JSON errors remain retryable balance errors",
      async () => {
        for (const malformed of [false, true]) {
          reset();
          infoFailed = !malformed;
          infoMalformed = malformed;
          await assert.rejects(reads.status(d, "alice"), {
            code: "TRADING_BALANCE_UNAVAILABLE",
            retryable: true,
          });
        }
      },
    );
    await t.test(
      "RPC failure is not a zero wallet balance and a wrong chain remains rejected",
      async () => {
        reset();
        rpcFailed = true;
        await assert.rejects(reads.status(d, "alice"), {
          code: "FUNDING_WALLET_READ_UNAVAILABLE",
          retryable: true,
        });
        reset();
        rpcChain = "0x1";
        await assert.rejects(reads.status(d, "alice"), {
          code: "DEPOSIT_NETWORK_MISMATCH",
        });
      },
    );
    await t.test(
      "existing Unified balance cannot credit a legacy or different-mode transfer",
      async () => {
        reset();
        d.funding = {
          id: uid("funding"),
          amount_usdc: "10",
          created_at: now(),
          expires_at: now() + 300000,
          status: "submitted",
          preview_hash: "b".repeat(64),
          transaction_hash: tx,
          quote: { baseline_trading_available_usdc: "0" },
        };
        let status = await reads.status(d, "alice");
        assert.equal(status.funding_receipt, "confirmed");
        assert.equal(status.funding_credit_verified, false);
        d.funding.quote.baseline_trading_account_mode = "standard";
        modeReads = 0;
        assert.equal(
          (await reads.status(d, "alice")).funding_credit_verified,
          false,
        );
        d.funding.quote.baseline_trading_account_mode = "unified";
        d.funding.quote.baseline_trading_available_usdc = "36.279657";
        modeReads = 0;
        assert.equal(
          (await reads.status(d, "alice")).funding_credit_verified,
          false,
        );
        spot.balances[0].total = "50.279657";
        modeReads = 0;
        status = await reads.status(d, "alice");
        assert.equal(status.trading_balance_usdc, "46.279657");
        assert.equal(status.funding_credit_verified, true);
      },
    );
  } finally {
    if (beforeRpc == null) delete process.env.RIDE_AGENT_ARBITRUM_RPC_URL;
    else process.env.RIDE_AGENT_ARBITRUM_RPC_URL = beforeRpc;
    if (beforeUnified == null) delete process.env.RIDE_AGENT_UNIFIED_ENABLED;
    else process.env.RIDE_AGENT_UNIFIED_ENABLED = beforeUnified;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
