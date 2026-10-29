import WebSocket from "ws";
import { readTimers, type BudgetTimers } from "./venue-read-budget.js";

// WS has separate provider limits from REST. Keep conservative process-wide
// headroom across both hosts and every reader instance. No account data lives
// in this gate; even failures consume their connection/message attempt credit.
export class OrderSnapshotBudget {
  private active = 0;
  private attempts: { at: number; user: string; messages: number }[] = [];
  constructor(private readonly clock = () => performance.now()) {}
  acquire(user: string, subscriptions: number): (() => void) | undefined {
    const now = this.clock();
    this.attempts = this.attempts.filter((entry) => entry.at > now - 60000);
    const users = new Set(this.attempts.map((entry) => entry.user));
    if (
      this.active >= 2 ||
      this.attempts.length >= 20 ||
      (!users.has(user) && users.size >= 8) ||
      this.attempts.reduce((sum, entry) => sum + entry.messages, 0) +
        subscriptions +
        1 >
        1000
    )
      return;
    this.attempts.push({ at: now, user, messages: subscriptions + 1 });
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
}
const sharedOrderSnapshotBudget = new OrderSnapshotBudget();
export type ForeignAccountRead = {
  orders: Map<string, unknown[]>;
  states: Map<string, unknown>;
};

export class VenueOrderSnapshots {
  constructor(
    private readonly network: "mainnet" | "testnet",
    private readonly options: {
      connect?: (url: string) => WebSocket;
      budget?: OrderSnapshotBudget;
      timers?: BudgetTimers;
      clock?: () => number;
      report?: (record: Record<string, unknown>) => void;
    } = {},
  ) {}
  async read(
    user: string,
    dexes: string[],
    signal: AbortSignal,
  ): Promise<Map<string, unknown[]> | undefined> {
    return (await this.collect(user, dexes, signal, false))?.orders;
  }
  async readAccount(
    user: string,
    dexes: string[],
    signal: AbortSignal,
  ): Promise<ForeignAccountRead | undefined> {
    return this.collect(user, dexes, signal, true);
  }
  private async collect(
    user: string,
    dexes: string[],
    signal: AbortSignal,
    includeStates: boolean,
  ): Promise<ForeignAccountRead | undefined> {
    const scopes = new Set(dexes);
    if (
      signal.aborted ||
      !/^0x[0-9a-f]{40}$/i.test(user) ||
      !scopes.size ||
      scopes.size !== dexes.length ||
      scopes.size > 64 ||
      dexes.some(
        (dex) => typeof dex !== "string" || !dex.trim() || dex.length > 64,
      )
    )
      return;
    const release = (this.options.budget ?? sharedOrderSnapshotBudget).acquire(
      user.toLowerCase(),
      scopes.size * (includeStates ? 2 : 1),
    );
    if (!release) return;
    const timers = this.options.timers ?? readTimers;
    const clock = this.options.clock ?? Date.now;
    const started = clock();
    const report =
      this.options.report ?? ((record) => console.info(JSON.stringify(record)));
    return new Promise((resolve) => {
      const rows = new Map<string, unknown[]>();
      const states = new Map<string, unknown>();
      let socket: WebSocket | undefined,
        settled = false,
        timer: unknown;
      const listeners: { event: string; run: (...args: any[]) => void }[] = [];
      const listen = (event: string, run: (...args: any[]) => void) => {
        listeners.push({ event, run });
        socket!.on(event, run);
      };
      const finish = (outcome: string, value?: ForeignAccountRead) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) timers.clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        if (socket) {
          for (const { event, run } of listeners) socket.off(event, run);
          // terminate() during handshake can emit a late error; its contents
          // are never logged or allowed to escape as an unhandled event.
          socket.on("error", () => {});
          socket.terminate();
        }
        release();
        try {
          report({
            event: "venue_order_snapshots",
            outcome,
            requested_scopes: scopes.size,
            received_scopes: rows.size,
            state_scopes: states.size,
            duration_ms: Math.max(0, clock() - started),
          });
        } catch {
          /* diagnostic only */
        }
        resolve(value);
      };
      const aborted = () => finish("aborted");
      timer = timers.setTimeout(() => finish("timeout"), 3000);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) {
        aborted();
        return;
      }
      try {
        const url =
          this.network === "mainnet"
            ? "wss://api.hyperliquid.xyz/ws"
            : "wss://api.hyperliquid-testnet.xyz/ws";
        socket =
          this.options.connect?.(url) ??
          new WebSocket(url, {
            handshakeTimeout: 3000,
            maxPayload: 1024 * 1024,
            perMessageDeflate: false,
            followRedirects: false,
          });
        listen("open", () => {
          try {
            for (const dex of scopes) {
              socket!.send(
                JSON.stringify({
                  method: "subscribe",
                  subscription: { type: "openOrders", user, dex },
                }),
              );
              if (includeStates)
                socket!.send(
                  JSON.stringify({
                    method: "subscribe",
                    subscription: { type: "clearinghouseState", user, dex },
                  }),
                );
            }
          } catch {
            finish("unavailable");
          }
        });
        listen("message", (message, binary) => {
          if (settled) return;
          let parsed: any;
          try {
            const bytes = Array.isArray(message)
              ? Buffer.concat(message)
              : Buffer.isBuffer(message)
                ? message
                : Buffer.from(message);
            if (binary || bytes.byteLength > 1024 * 1024) {
              finish("invalid");
              return;
            }
            parsed = JSON.parse(bytes.toString());
          } catch {
            finish("invalid");
            return;
          }
          if (
            parsed?.channel === "subscriptionResponse" ||
            parsed?.channel === "pong"
          )
            return;
          const data = parsed?.data;
          // A subscription acknowledgment, incremental orderUpdates, missing
          // scope, or silence cannot establish that a DEX has no open orders.
          if (
            ![
              "openOrders",
              ...(includeStates ? ["clearinghouseState"] : []),
            ].includes(parsed?.channel) ||
            !data ||
            typeof data.user !== "string" ||
            data.user.toLowerCase() !== user.toLowerCase() ||
            typeof data.dex !== "string" ||
            !scopes.has(data.dex)
          ) {
            finish("invalid");
            return;
          }
          if (parsed.channel === "openOrders") {
            if (!Array.isArray(data.orders)) {
              finish("invalid");
              return;
            }
            rows.set(data.dex, data.orders);
          } else {
            const state = data.clearinghouseState;
            if (
              !state ||
              !Array.isArray(state.assetPositions) ||
              !state.marginSummary ||
              state.marginSummary.accountValue == null ||
              state.withdrawable == null
            ) {
              finish("invalid");
              return;
            }
            states.set(data.dex, state);
          }
          if (
            rows.size === scopes.size &&
            (!includeStates || states.size === scopes.size)
          )
            finish("complete", { orders: rows, states });
        });
        listen("error", () => finish("unavailable"));
        listen("close", () => finish("closed"));
      } catch {
        finish("unavailable");
      }
    });
  }
}
