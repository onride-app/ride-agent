import type { Server } from "node:http";

export interface BridgeDrain {
  drainAccounts(): Promise<void>;
  close(): Promise<void>;
}

/** Stop admission first. Existing account scopes retain their original 20s. */
export async function drainBridge(
  listener: Server,
  bridge: BridgeDrain,
): Promise<void> {
  const scopes = bridge.drainAccounts();
  const handlers = new Promise<void>((resolve) =>
    listener.close(() => resolve()),
  );
  listener.closeIdleConnections();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([handlers, scopes]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 40000);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    listener.closeAllConnections();
    await bridge.close();
  }
}
