# Snapshot monitor correlation

This diagnostic candidate adds three fields to existing `agent_monitor_timing`
records. It does not change the financial monitor, account evidence, database
transactions, retries, budget, risk checks or publication order.

- `account_observed_at_ms`: the original positive safe-integer snapshot time,
  present only on `account_age`. It is never rounded or reconstructed from age.
- `account_stage`: the existing fixed `returned` or `published` argument, present
  only on `account_age`.
- `emitted_at_ms`: a positive safe-integer wall-clock time on every emitted record.
  Account age uses one captured time for both this field and its original
  `max(0, capturedAt - observedAt)` calculation.

Invalid timestamps or stages and failures of the new clock capture or reporter
silently omit diagnostics. Successful work and original business exceptions are
preserved. Future observations retain their original value and the previous
zero-clamped age; consumers must reject them as proof of freshness. Durations,
the 250ms threshold and random per-tick references retain their existing
monotonic-clock semantics. Wall-clock movement must not alter scheduling.

The current PostgreSQL wrapper already distinguishes returned records through
`phase=db_callback, parent_phase=audit_control`, while publication uses
`phase=audit_control, parent_phase=tick`. The new enum makes that meaning explicit
and independent of repository wrappers; it does not correct a proven labeling
error in the previous PostgreSQL implementation.

An authorized consumer may join an original snapshot timestamp to one unique
financial `tick_ref` containing both matching stages. It must independently
confirm one nonclosed portfolio per user and the frozen sleeve mapping. Exact
timestamp collisions, multiple references, missing or truncated logs, unknown
COMMIT acknowledgments and unclear deployment boundaries remain ambiguous.
Duplicate log delivery is not another audit. Approximate platform log times,
age subtraction or neighboring anonymous traces cannot establish ownership.

A returned snapshot precedes later validation. Publication follows the audit
transaction's successful acknowledgment, and does not establish B/C completion,
execution or the latest writer of a state retaining the same snapshot. An
account failure before a new snapshot returns still cannot be assigned to its
owner by this successful-snapshot join. Notification delivery keeps its separate
reference. Missing fast phases cannot be filled with zero durations; a phase
returning normally may also contain caught portfolio errors.

No stable identity, account, portfolio, trader, amount, symbol, URL or raw payload
is added. Exact times do increase correlation for an operator already holding a
private snapshot; raw joins remain within existing operational evidence access.
Public status updates should use aggregate conclusions. Collectors must use an
explicit whitelist and retain the old sealed parsers and failed windows.

The complete `53a2240` natural window still failed strict freshness at four
post-boundary observations. This candidate collects attribution evidence; it is
not a freshness repair or a reason to move that boundary. Local PostgreSQL and
functional fixture checks remain distinct from original-account acceptance.
There is no App or npm release in this change.
