import assert from "node:assert/strict";
import { it } from "node:test";
import { CoreBridge } from "./core_bridge.js";

it("durable cost owners bind the freshly resolved account, master, agent, generation and request protocol before the first venue read", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture-token",
    "postgresql://127.0.0.1:1/unused",
    "fixture-salt-".repeat(4),
    "mainnet",
  );
  const stub = bridge as any;
  const seen: string[] = [];
  const identity = {
    account_id: "account-fixture",
    master: "0x" + "1".repeat(40),
    agent: "0x" + "2".repeat(40),
    wallet_generation: 1,
    network: 2,
    status: "active",
  };
  let bound = false;
  stub.venueReads.bindAccountCostPlan = (key: string) => {
    bound = true;
    seen.push(key);
  };
  stub.core = async () => identity;
  stub.info = async () => {
    assert.equal(bound, true);
    throw new Error("fixture stops before venue transport");
  };
  const portfolio = {
    account_id: "account-fixture",
    ledger_started_at: 100,
    sleeves: [],
    executions: [],
  };
  try {
    const sample = async () => {
      bound = false;
      await assert.rejects(
        bridge.perpsAccount("user-fixture", portfolio as any),
        /fixture stops/,
      );
    };
    await sample();
    await sample();
    assert.equal(seen[0], seen[1]);
    identity.master = "0x" + "3".repeat(40);
    await sample();
    identity.agent = "0x" + "4".repeat(40);
    await sample();
    identity.wallet_generation++;
    await sample();
    portfolio.ledger_started_at++;
    await sample();
    assert.equal(new Set(seen.slice(1)).size, 5);
    assert.ok(seen.every((owner) => /^[0-9a-f]{64}$/.test(owner)));
  } finally {
    await bridge.close();
  }
});

it("unbound or incomplete Core account identities cannot import a durable plan", async () => {
  const bridge = new CoreBridge(
    "https://core.test",
    "fixture-token",
    "postgresql://127.0.0.1:1/unused",
    "fixture-salt-".repeat(4),
    "mainnet",
  );
  const stub = bridge as any;
  let disabled = 0;
  stub.venueReads.bindAccountCostPlan = () =>
    assert.fail("Missing resolved generation never restores a durable plan");
  stub.venueReads.disableAccountCostPlan = () => {
    disabled++;
  };
  let identity: any = {
    master: "0x" + "1".repeat(40),
    agent: "0x" + "2".repeat(40),
    network: 2,
    status: "active",
  };
  stub.core = async () => identity;
  stub.info = async () => {
    throw new Error("fixture stops before venue transport");
  };
  try {
    await assert.rejects(bridge.perpsAccount("fixture", null), /fixture stops/);
    await assert.rejects(
      bridge.perpsAccount("fixture", {
        account_id: "account-fixture",
        sleeves: [],
        executions: [],
      } as any),
      /fixture stops/,
    );
    for (const network of ["mainnet", "2", 1, null]) {
      identity = {
        ...identity,
        account_id: "account-fixture",
        wallet_generation: 1,
        network,
      };
      await assert.rejects(
        bridge.perpsAccount("fixture", {
          account_id: "account-fixture",
          sleeves: [],
          executions: [],
        } as any),
        /fixture stops/,
      );
    }
    assert.equal(disabled, 6);
  } finally {
    await bridge.close();
  }
});
