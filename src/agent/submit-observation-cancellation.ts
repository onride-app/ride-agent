import type { Request, Response } from "express";
import { AgentError } from "./contracts.js";
import { readTimers, type BudgetTimers } from "./venue-read-budget.js";

/** Server-owned lifetime for fresh pre-outbox reads; never cancels an action. */
export function submitObservationCancellation(
  req: Request,
  res: Response,
  clock = Date.now,
  timers: BudgetTimers = readTimers,
) {
  const controller = new AbortController();
  const deadlineMs = clock() + 20000;
  const abort = () =>
    controller.abort(
      new AgentError(
        "VENUE_READ_DEADLINE",
        "Fresh submission evidence caller is no longer available.",
        true,
        503,
      ),
    );
  const closed = () => {
    if (!res.writableEnded) abort();
  };
  const timer = timers.setTimeout(abort, 20000);
  req.once("aborted", abort);
  res.once("close", closed);
  if (req.aborted) abort();
  return {
    signal: controller.signal,
    deadlineMs,
    close() {
      timers.clearTimeout(timer);
      req.off("aborted", abort);
      res.off("close", closed);
    },
  };
}
