import { it } from "node:test";
import assert from "node:assert/strict";
import { AgentService } from "./service.js";
import { FundingService } from "./funding.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter } from "./fixtures.js";
import { uid, now } from "./domain.js";
import { publicResult } from "./contracts.js";
import { recommend } from "./domain.js";

function fixture() {
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  const api = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("test".repeat(12)),
  );
  const funding = new FundingService(repository, adapter, "https://ride.test");
  const deposit = {
    id: uid("deposit"),
    market: "perps" as const,
    asset: "USDC" as const,
    network: "Arbitrum",
    address: "0x" + "5".repeat(40),
    provider: "wallet" as const,
    created_at: now(),
  };
  let calls = 0;
  adapter.depositStatus = async () => ({
    trading_balance_usdc: "0",
    wallet_balance_usdc: "10",
    trading_account_mode: "standard",
    available_to_copy: false,
  });
  adapter.fundingOperation = async (operation, _user, input) => {
    if (operation === "submit") {
      calls++;
      return {
        submitted: true,
        transaction_hash: "0x" + "a".repeat(64),
        receipt_status: "0x1",
      };
    }
    return {
      amount_usdc: input.amount_usdc,
      wallet: { master: deposit.address, status: "approval_required" },
      requires_signature: true,
      typed_data: { message: { owner: deposit.address } },
      permit_nonce: "0",
      permit_deadline: Math.floor(now() / 1000) + 300,
    };
  };
  return { repository, adapter, api, funding, deposit, calls: () => calls };
}
it("recovers already answered preferences from an older saved preview without asking them again", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.plans.push(
      recommend(
        {
          budget_usdc: "500",
          loss_trigger_pct: 25,
          market: "perps",
          assets: ["BTC", "ETH"],
          allow_altcoins: false,
        },
        f.adapter.pool,
      ),
    );
    assert.equal(s.preferences, null);
  });
  const out = await f.api.tool("alice", "get_preferences", {});
  assert.equal(out.status, "ok");
  assert.deepEqual((out.data.preference_collection as any).missing_fields, []);
  assert.equal(
    (out.data.preference_collection as any).answers.budget_usdc,
    "500",
  );
});
it("keeps trading credit separate from sufficient funds for the saved plan", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
    s.plans.push(
      recommend(
        {
          budget_usdc: "500",
          loss_trigger_pct: 25,
          market: "perps",
          assets: ["BTC", "ETH"],
          allow_altcoins: false,
        },
        f.adapter.pool,
      ),
    );
  });
  f.adapter.depositStatus = async () => ({
    trading_balance_usdc: "10",
    available_to_copy: true,
  });
  const status = (
    await f.api.tool("alice", "check_deposit_status", {
      deposit_id: f.deposit.id,
    })
  ).data.deposit_status as any;
  assert.equal(status.trading_account_ready, true);
  assert.equal(status.available_to_copy, false);
  assert.equal(status.saved_plan_shortfall_usdc, "490.000000");
});
it("returns only missing preference questions without reading candidate data, preserves partial answers and account isolation", async () => {
  const f = fixture();
  let reads = 0;
  f.adapter.candidates = async () => {
    reads++;
    return f.adapter.pool;
  };
  const first = await f.api.tool("alice", "recommend_traders", {});
  assert.equal(first.status, "requires_preferences");
  assert.equal(reads, 0);
  assert.deepEqual((first.data.preference_collection as any).missing_fields, [
    "budget_usdc",
    "risk_tolerance",
  ]);
  await f.api.tool("alice", "set_preferences", { budget_usdc: "500" });
  const partial = await f.api.tool("alice", "get_preferences", {});
  assert.deepEqual((partial.data.preference_collection as any).missing_fields, [
    "risk_tolerance",
  ]);
  await f.api.tool("alice", "set_preferences", {
    loss_trigger_pct: 25,
    market: "perps",
  });
  assert.equal(
    (
      await f.api
        .tool("alice", "get_preferences", {})
        .then((x) => (x.data.preference_collection as any).answers)
    ).budget_usdc,
    "500",
  );
  assert.equal(
    (await f.api.tool("bob", "get_preferences", {})).status,
    "requires_preferences",
  );
  assert.equal(reads, 0);
});
it("asks only the conditional Fixed amount and does not require an upfront basket count", async () => {
  const f = fixture();
  const out = await f.api.tool("alice", "set_preferences", {
    budget_usdc: "500",
    loss_trigger_pct: 30,
    market: "perps",
    portfolio_kind: "basket",
    copy_mode: "fixed",
  });
  assert.deepEqual((out.data.preference_collection as any).missing_fields, [
    "fixed_margin_usdc",
  ]);
});
it("prepares owned exact amounts without moving funds, keeps challenges off MCP and rejects another owner", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  const out = await f.funding.prepare("alice", f.deposit.id, "10");
  assert.equal(out.status, "requires_confirmation");
  assert.equal(f.calls(), 0);
  publicResult(out);
  assert.equal(JSON.stringify(out).includes(f.deposit.address), false);
  await assert.rejects(f.funding.read("bob", f.deposit.id), /not found/);
  const human = await f.funding.read("alice", f.deposit.id);
  assert.equal((human.data.funding as any).signing_wallet, f.deposit.address);
});
it("requires fresh displayed parameters and wallet signature, executes once under concurrent confirmations", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  const q = (await f.funding.prepare("alice", f.deposit.id, "10")).data
    .funding as any;
  await assert.rejects(
    f.funding.confirm("alice", f.deposit.id, "f".repeat(64), "0xsig"),
    /parameters changed/,
  );
  await assert.rejects(
    f.funding.confirm("alice", f.deposit.id, q.preview_hash),
    /signature/,
  );
  await Promise.all(
    Array.from({ length: 8 }, () =>
      f.funding.confirm("alice", f.deposit.id, q.preview_hash, "0xsig"),
    ),
  );
  assert.equal(f.calls(), 1);
});
it("does not prepare or quote another transfer when funds are already at the venue and the funding wallet is empty", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  let quoteCalls = 0;
  f.adapter.fundingOperation = async () => {
    quoteCalls++;
    throw Error("must not reach the funding boundary");
  };
  f.adapter.depositStatus = async () => ({
    trading_balance_usdc: "36.279657",
    trading_account_mode: "unified",
    wallet_balance_usdc: "0.000000",
    available_to_copy: true,
  });
  await assert.rejects(
    f.funding.prepare("alice", f.deposit.id, "10"),
    (error: any) => {
      assert.equal(error.code, "FUNDING_WALLET_INSUFFICIENT");
      assert.match(error.message, /36.279657/);
      assert.match(error.message, /No new funding was prepared/);
      return true;
    },
  );
  assert.equal(quoteCalls, 0);
  await f.repository.transact("alice", async (s) => {
    assert.equal(s.deposits![0].funding, undefined);
  });
});
it("fails closed before quoting when funding balances are missing, malformed or unreadable", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  let quoteCalls = 0;
  f.adapter.fundingOperation = async () => {
    quoteCalls++;
    throw Error("must not quote");
  };
  for (const observation of [
    { trading_balance_usdc: "36" },
    { trading_balance_usdc: "36", wallet_balance_usdc: "NaN" },
    { trading_balance_usdc: "-1", wallet_balance_usdc: "10" },
    { trading_balance_usdc: "unknown", wallet_balance_usdc: "10" },
  ]) {
    f.adapter.depositStatus = async () => observation;
    await assert.rejects(
      f.funding.prepare("alice", f.deposit.id, "10"),
      (error: any) => {
        assert.match(error.code, /^FUNDING_.*UNAVAILABLE$/);
        return true;
      },
    );
  }
  f.adapter.depositStatus = async () => {
    throw Error("read timeout");
  };
  await assert.rejects(
    f.funding.prepare("alice", f.deposit.id, "10"),
    /read timeout/,
  );
  assert.equal(quoteCalls, 0);
  await f.repository.transact("alice", async (s) => {
    assert.equal(s.deposits![0].funding, undefined);
  });
});
it("freezes the Unified balance baseline and reuses the same unexpired exact-amount preview", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  f.adapter.depositStatus = async () => ({
    wallet_balance_usdc: "10",
    trading_balance_usdc: "36.279657",
    trading_account_mode: "unified",
  });
  const first = (await f.funding.prepare("alice", f.deposit.id, "10")).data
    .funding as any;
  f.adapter.depositStatus = async () => {
    throw Error("reuse does not start a second preparation");
  };
  const second = (await f.funding.prepare("alice", f.deposit.id, "10")).data
    .funding as any;
  assert.deepEqual(second, first);
  assert.equal(f.calls(), 0);
  await f.repository.transact("alice", async (s) => {
    const quote = s.deposits![0].funding!.quote;
    assert.equal(quote.baseline_trading_available_usdc, "36.279657");
    assert.equal(quote.baseline_trading_account_mode, "unified");
  });
});
it("persists uncertain submission and blocks replacement even if the boundary times out", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  const original = f.adapter.fundingOperation!;
  let calls = 0;
  f.adapter.fundingOperation = async (op, user, input) => {
    if (op === "submit") {
      calls++;
      throw Error("timeout after broadcast");
    }
    return original(op, user, input);
  };
  const q = (await f.funding.prepare("alice", f.deposit.id, "10")).data
    .funding as any;
  assert.equal(
    (await f.funding.confirm("alice", f.deposit.id, q.preview_hash, "0xsig"))
      .status,
    "uncertain",
  );
  await f.funding.confirm("alice", f.deposit.id, q.preview_hash, "0xsig");
  const d2 = { ...f.deposit, id: uid("deposit") };
  await f.repository.transact("alice", async (s) => {
    s.deposits!.push(d2);
  });
  await assert.rejects(
    f.funding.prepare("alice", d2.id, "10"),
    /earlier funding/,
  );
  assert.equal(calls, 1);
});
it("marks funding credited only from verified credit evidence, never from wallet receipt", async () => {
  const f = fixture();
  await f.repository.transact("alice", async (s) => {
    s.deposits = [f.deposit];
  });
  const q = (await f.funding.prepare("alice", f.deposit.id, "10")).data
    .funding as any;
  await f.funding.confirm("alice", f.deposit.id, q.preview_hash, "0xsig");
  f.adapter.depositStatus = async () => ({
    wallet_balance_usdc: "10",
    trading_balance_usdc: "0",
    available_to_copy: false,
  });
  const wallet = await f.api.tool("alice", "check_deposit_status", {
    deposit_id: f.deposit.id,
  });
  assert.equal((wallet.data.deposit_status as any).funding_status, "submitted");
  f.adapter.depositStatus = async () => ({
    trading_balance_usdc: "10",
    available_to_copy: true,
    funding_credit_verified: true,
  });
  const credit = await f.api.tool("alice", "check_deposit_status", {
    deposit_id: f.deposit.id,
  });
  assert.equal((credit.data.deposit_status as any).funding_status, "credited");
});
