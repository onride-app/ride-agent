# First submission failure diagnostic

An execution may retain `first_submission_failure` after its first observed
`adapter.submit` exception. Only that call's nested catch records the packet;
account reads, preceding reconciliation, later recovery and retirement do not
create or replace it. Old records remain compatible and are not backfilled.
Causes already lost when a historical generic error was overwritten cannot be
reconstructed by this change.

The packet contains only fixed-whitelist `code` and `reason_code`, a strict
`retryable` boolean, diagnostic `at`, and monotonic `elapsed_ms` capped at 60,000.
Unrecognized/untrusted codes or reasons become `OTHER`. `retryable=false` means
that no trusted `retryable=true` flag was captured; it does not prove financial
non-retryability. Invalid diagnostic clocks fall back to zero, not invented
evidence times. No raw message, stack, arbitrary details, address, identifier,
quantity, price, URL, token or upstream payload is copied into the packet.

The original packet survives persisted-state reload, reconciliation and typed
permanent retirement. It is omitted from bridge requests and public execution
views, without mutating the stored portfolio or frozen execution fields.
Existing records without this field keep their existing wire representation.

This field is diagnosis only. No acceptance, execution status, original-ID
absence, retirement, retry, refund, timestamp freshness, fingerprint or signed
payload decision reads it. Even a diagnostic `READ_LOCAL_BUDGET_UNSENT` concerns
one rejected read and cannot prove that a financial action was not accepted.
Transport-level `EXECUTOR_UNAVAILABLE` remains that observed boundary category;
message parsing or elapsed time does not reconstruct a lower-level root cause.

Local whole-account BEGIN refusals distinguish busy work, live FIFO, pacing,
quota, exclusive unknown response and quarantine with fixed diagnostic reasons.
Only internally branded BEGIN refusals may be rechecked, before a local ticket
or any provider read, while the existing Core grant and original caller,
execution, wall-clock and monotonic deadlines all remain valid. Every attempt
rechecks the original gates. A known retry outside the remaining window fails
closed; no paid charge, unknown debt, cooldown or quota is forgiven.

Core-mode local FIFO interests exist only for live post-grant admissions. Each
scope cancels its own opaque reference, preserving other live references and
legacy FIFO expiry. Uncoordinated reads keep their original one-second wait.
`READ_LOCAL_TICKET_STALE` and authenticated `READ_CORE_BUDGET_SENT` remain
fail-only read diagnostics. Neither can authorize a BEGIN wait, retry a sent
read or establish acceptance or absence of a financial action. Completed
account evidence is never reused by this scheduling change.

Only a new Perps execution without a frozen outbox opts into bounded Core-frame
pending polling. This is an internal submit-preflight option, not request JSON.
Normal monitoring still performs one poll and preserves its original pending
episode. Private preflight can continue a verified pending receipt only with
an opaque capability bound to the same factory frame, UUID, owner, weight,
mode and first queue deadline. Removal, replacement or changed identity fails
closed without allocating another frame. Each await revalidates that binding.

Pending polling consumes the existing 20-second caller/execution/monotonic
window; a grant does not renew it or the 12-second provider wire limit. No
local ticket, venue request or financial submission exists before a grant.
Authenticated 503 local-budget receipts must explicitly say the upstream read
was not sent. Remote errors cannot forge the local capability. A peer-owned
grant reports `READ_FRAME_IN_USE`; local polling, queue capacity and changed
identity have distinct fixed reasons. Cancelling one waiter never releases
another caller's grant. These are read-capacity diagnostics, never financial
acceptance, absence or retry authorization.
