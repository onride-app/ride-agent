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
