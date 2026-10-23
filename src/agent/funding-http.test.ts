import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import { backendApp } from "./backend.js";
import { AgentService } from "./service.js";
import { MemoryRepository, Cursor } from "./repository.js";
import { FakeAdapter } from "./fixtures.js";

it("human quote renewal returns its signing challenge while MCP prepare remains public and no transfer is submitted", async () => {
  const repository = new MemoryRepository(),
    adapter = new FakeAdapter();
  const deposit = {
    id: "deposit_" + "a".repeat(32),
    market: "perps" as const,
    asset: "USDC" as const,
    network: "Arbitrum",
    address: "0x" + "5".repeat(40),
    provider: "wallet" as const,
    created_at: Date.now(),
  };
  await repository.transact("alice", async (s) => {
    s.deposits = [deposit];
  });
  adapter.depositStatus = async () => ({
    wallet_balance_usdc: "30",
    trading_balance_usdc: "0",
    available_to_copy: false,
  });
  let submits = 0;
  adapter.fundingOperation = async (operation, _user, input) => {
    if (operation === "submit") submits++;
    return {
      amount_usdc: input.amount_usdc,
      wallet: { master: deposit.address },
      requires_signature: true,
      typed_data: { message: { owner: deposit.address } },
      permit_deadline: Math.floor(Date.now() / 1000) + 300,
    };
  };
  const service = new AgentService(
    repository,
    adapter,
    "https://ride.test",
    new Cursor("f".repeat(32)),
  );
  const server = backendApp(service, async () => "alice", "127.0.0.1").listen(
    0,
    "127.0.0.1",
  );
  await once(server, "listening");
  const post = (path: string) =>
    fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer fixture",
      },
      body: JSON.stringify({ deposit_id: deposit.id, amount_usdc: "30" }),
    });
  try {
    const machine = await post("/agent/v1/prepare_deposit");
    assert.equal(machine.status, 200);
    assert(!JSON.stringify(await machine.json()).includes("signing_challenge"));
    await repository.transact("alice", async (s) => {
      s.deposits![0].funding!.expires_at = Date.now() - 1;
    });
    const human = await post("/agent/human/funding_prepare");
    assert.equal(human.status, 200);
    const value = (await human.json()).data.funding;
    assert.equal(value.requires_signature, true);
    assert.equal(value.signing_wallet, deposit.address);
    assert.equal(value.signing_challenge.message.owner, deposit.address);
    assert(value.expires_at > Date.now());
    assert.equal(submits, 0);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
