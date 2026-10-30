import type { Request, Response } from "express";

/** Notification-only: a completely received request body is not cancellation. */
export function notificationCancellation(req: Request, res: Response) {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(
      new DOMException("Notification caller disconnected", "AbortError"),
    );
  const closed = () => {
    if (!res.writableEnded) abort();
  };
  req.once("aborted", abort);
  res.once("close", closed);
  if (req.aborted) abort();
  return {
    signal: controller.signal,
    close() {
      req.off("aborted", abort);
      res.off("close", closed);
    },
  };
}
