import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { it } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import {
  OrderSnapshotBudget,
  VenueOrderSnapshots,
} from "./venue-order-snapshots.js";

const user = "0x" + "a".repeat(40);
class Socket extends EventEmitter {
  sent: any[] = [];
  terminated = 0;
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  terminate() {
    this.terminated++;
  }
  message(data: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(data)), false);
  }
  snapshot(dex: string, orders: unknown = [], owner = user) {
    this.message({ channel: "openOrders", data: { dex, user: owner, orders } });
  }
  state(
    dex: string,
    value: unknown = {
      assetPositions: [],
      marginSummary: { accountValue: "0" },
      withdrawable: "0",
    },
  ) {
    this.message({
      channel: "clearinghouseState",
      data: { dex, user, clearinghouseState: value },
    });
  }
}
function fixture(network: "mainnet" | "testnet" = "mainnet") {
  let at = 0,
    expired!: () => void;
  const sockets: Socket[] = [],
    urls: string[] = [],
    reports: any[] = [];
  const budget = new OrderSnapshotBudget(() => at);
  const reads = new VenueOrderSnapshots(network, {
    budget,
    clock: () => at,
    timers: {
      setTimeout(run) {
        expired = run;
        return 1;
      },
      clearTimeout() {},
    },
    connect(url) {
      const socket = new Socket();
      sockets.push(socket);
      urls.push(url);
      return socket as unknown as WebSocket;
    },
    report(row) {
      reports.push(row);
    },
  });
  return {
    reads,
    budget,
    sockets,
    urls,
    reports,
    expire: () => expired(),
    advance(ms: number) {
      at += ms;
    },
  };
}
const signal = () => new AbortController().signal;

it("requires fresh complete snapshots for every foreign scope on a new connection for each frame", async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const work = f.reads.read(user, ["xyz", "flx"], signal());
    const socket = f.sockets[attempt];
    socket.emit("open");
    assert.deepEqual(
      socket.sent.map((x) => x.subscription.dex),
      ["xyz", "flx"],
    );
    socket.snapshot("flx");
    socket.snapshot("xyz", attempt ? [{ coin: "xyz:BTC" }] : []);
    const result = await work;
    assert.equal(result?.size, 2);
    assert.equal(result?.get("xyz")?.length, attempt);
    assert.equal(socket.terminated, 1);
  }
  assert.equal(
    f.sockets.length,
    2,
    "completed account evidence is never reused",
  );
});

it("does not turn subscription acknowledgments, pong, or silence into an empty scope", async () => {
  const f = fixture(),
    work = f.reads.read(user, ["xyz"], signal()),
    socket = f.sockets[0];
  socket.emit("open");
  socket.message({ channel: "subscriptionResponse", data: {} });
  socket.message({ channel: "pong" });
  f.expire();
  assert.equal(await work, undefined);
  assert.equal(f.reports.at(-1).outcome, "timeout");
  assert.equal(socket.terminated, 1);
});

for (const issue of [
  "owner",
  "dex",
  "missing dex",
  "orders",
  "incremental",
  "json",
  "binary",
])
  it(`discards the entire order batch for invalid ${issue} without leaking payloads`, async () => {
    const f = fixture(),
      work = f.reads.read(user, ["xyz", "flx"], signal()),
      socket = f.sockets[0];
    socket.emit("open");
    socket.snapshot("xyz");
    const row: any = {
      channel: "openOrders",
      data: { user, dex: "flx", orders: [] },
    };
    if (issue === "owner") row.data.user = "private-wrong-owner";
    if (issue === "dex") row.data.dex = "unrequested";
    if (issue === "missing dex") delete row.data.dex;
    if (issue === "orders") row.data.orders = {};
    if (issue === "incremental") row.channel = "orderUpdates";
    if (issue === "json")
      socket.emit("message", Buffer.from("private-not-json"), false);
    else if (issue === "binary")
      socket.emit("message", Buffer.from("private-binary"), true);
    else socket.message(row);
    assert.equal(await work, undefined);
    assert.doesNotMatch(JSON.stringify(f.reports), /private-|aaaaa|xyz|flx/);
  });

it("discards a partial batch when the connection closes and cannot stitch it into a later frame", async () => {
  const f = fixture(),
    first = f.reads.read(user, ["xyz", "flx"], signal());
  f.sockets[0].emit("open");
  f.sockets[0].snapshot("xyz");
  f.sockets[0].emit("close");
  assert.equal(await first, undefined);
  const second = f.reads.read(user, ["xyz", "flx"], signal());
  f.sockets[1].emit("open");
  f.sockets[1].snapshot("flx");
  f.expire();
  assert.equal(await second, undefined);
});

it("cancels a handshake and leaves no listeners that can start subscriptions after the frame expired", async () => {
  const f = fixture(),
    controller = new AbortController();
  const work = f.reads.read(user, ["xyz"], controller.signal);
  controller.abort();
  assert.equal(await work, undefined);
  f.sockets[0].emit("open");
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.sockets[0].terminated, 1);
  assert.equal(f.sockets[0].listenerCount("message"), 0);
  assert.equal(await f.reads.read(user, ["xyz"], controller.signal), undefined);
  assert.equal(f.sockets.length, 1);
});

it("selects the matching network and conservatively bounds invalid addresses or excessive scopes before connecting", async () => {
  const f = fixture("testnet");
  for (const [owner, dexes] of [
    ["invalid", ["xyz"]],
    [user, ["xyz", "xyz"]],
    [user, [""]],
    [user, Array.from({ length: 65 }, (_, i) => String(i))],
  ] as [string, string[]][])
    assert.equal(await f.reads.read(owner, dexes, signal()), undefined);
  assert.equal(f.sockets.length, 0);
  const work = f.reads.read(user, ["xyz"], signal());
  assert.equal(f.urls[0], "wss://api.hyperliquid-testnet.xyz/ws");
  f.sockets[0].emit("error", Error("private error"));
  assert.equal(await work, undefined);
  assert.doesNotMatch(JSON.stringify(f.reports), /private error/);
});

it("retains failed connection and message costs, bounds simultaneous sessions and rolls over after a minute", () => {
  let at = 0;
  const budget = new OrderSnapshotBudget(() => at);
  const a = budget.acquire(user, 1)!,
    b = budget.acquire(user, 1)!;
  assert.equal(budget.acquire(user, 1), undefined);
  a();
  a();
  b();
  for (let i = 0; i < 18; i++) {
    const release = budget.acquire(user, 1);
    assert.ok(release);
    release();
  }
  assert.equal(
    budget.acquire(user, 1),
    undefined,
    "failed attempts retain their rolling connection charge",
  );
  at = 60000;
  assert.equal(typeof budget.acquire(user, 1), "function");
});

it("bounds unique user and outbound subscription totals across every session", () => {
  const users = new OrderSnapshotBudget();
  for (let i = 0; i < 8; i++) users.acquire(String(i), 1)!();
  assert.equal(users.acquire("ninth", 1), undefined);
  const messages = new OrderSnapshotBudget();
  for (let i = 0; i < 15; i++) messages.acquire(user, 64)!();
  assert.equal(messages.acquire(user, 64), undefined);
});

it("requires a new complete state and orders message for each DEX, without stitching partial state batches", async () => {
  const f = fixture();
  const first = f.reads.readAccount(user, ["xyz", "flx"], signal());
  const a = f.sockets[0];
  a.emit("open");
  assert.equal(a.sent.length, 4);
  a.state("xyz");
  a.snapshot("xyz");
  a.snapshot("flx");
  f.expire();
  assert.equal(await first, undefined);
  const second = f.reads.readAccount(user, ["xyz", "flx"], signal());
  const b = f.sockets[1];
  b.emit("open");
  b.state("flx");
  b.snapshot("xyz");
  b.snapshot("flx");
  f.expire();
  assert.equal(await second, undefined);
  const third = f.reads.readAccount(user, ["xyz", "flx"], signal());
  const c = f.sockets[2];
  c.emit("open");
  c.state("xyz");
  c.snapshot("flx");
  c.state("flx");
  c.snapshot("xyz");
  const result = await third;
  assert.equal(result?.orders.size, 2);
  assert.equal(result?.states.size, 2);
});

for (const issue of ["owner", "dex", "wrapper", "positions", "balance"])
  it(`rejects invalid ${issue} in a foreign state even if every orders scope arrived`, async () => {
    const f = fixture(),
      work = f.reads.readAccount(user, ["xyz"], signal()),
      socket = f.sockets[0];
    socket.emit("open");
    socket.snapshot("xyz");
    const value: any = {
      channel: "clearinghouseState",
      data: {
        dex: "xyz",
        user,
        clearinghouseState: {
          assetPositions: [],
          marginSummary: { accountValue: "0" },
          withdrawable: "0",
        },
      },
    };
    if (issue === "owner") value.data.user = "wrong";
    if (issue === "dex") value.data.dex = "unrequested";
    if (issue === "wrapper") delete value.data.clearinghouseState;
    if (issue === "positions")
      value.data.clearinghouseState.assetPositions = {};
    if (issue === "balance") delete value.data.clearinghouseState.marginSummary;
    socket.message(value);
    assert.equal(await work, undefined);
  });

it("uses the actual ws client against a loopback peer for complete out-of-order state and nonempty order snapshots", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let opened = 0;
  server.on("connection", (peer) => {
    opened++;
    peer.on("message", (raw) => {
      const { subscription: s } = JSON.parse(raw.toString());
      peer.send(
        JSON.stringify({
          channel: "subscriptionResponse",
          data: { method: "subscribe", subscription: s },
        }),
      );
      peer.send(
        JSON.stringify({
          channel: s.type,
          data:
            s.type === "openOrders"
              ? {
                  user: s.user,
                  dex: s.dex,
                  orders: [{ coin: "xyz:BTC", oid: 1 }],
                }
              : {
                  user: s.user,
                  dex: s.dex,
                  clearinghouseState: {
                    assetPositions: [],
                    marginSummary: { accountValue: "0" },
                    withdrawable: "0",
                  },
                },
        }),
      );
    });
  });
  const reads = new VenueOrderSnapshots("mainnet", {
    connect: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
    budget: new OrderSnapshotBudget(),
    report: () => {},
  });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await reads.readAccount(user, ["xyz", "flx"], signal());
      assert.equal(result?.orders.size, 2);
      assert.equal(result?.states.size, 2);
      assert.equal(result?.orders.get("xyz")?.length, 1);
    }
    assert.equal(opened, 2);
  } finally {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("terminates an actual ws handshake on account abort and handles its late error safely", async () => {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const upgraded = once(server, "upgrade");
  const controller = new AbortController();
  let client!: WebSocket;
  const reads = new VenueOrderSnapshots("mainnet", {
    connect: () => (client = new WebSocket(`ws://127.0.0.1:${address.port}`)),
    budget: new OrderSnapshotBudget(),
    report: () => {},
  });
  const work = reads.readAccount(user, ["xyz"], controller.signal);
  const [, socket] = await upgraded;
  const closed = new Promise<void>((resolve) =>
    client.once("close", () => resolve()),
  );
  controller.abort();
  assert.equal(await work, undefined);
  await closed;
  socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
