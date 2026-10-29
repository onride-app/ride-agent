# Monitor queue admission and snapshot publication

The October 29 read-only production investigation found two separate delays:

- A bounded request's unsettled reservation could advise a whole minute of
  waiting even when its response refunded enough capacity within milliseconds.
- A complete follower observation could return approximately 1.5 seconds old,
  then wait another 5.8–6.4 seconds for public source evidence in the same state
  transaction. Scheduling another five seconds after that entire tick finished
  could also miss the next complete-observation turn.

## Budget advice

Unsettled holds remain fully charged for admission. If removing only those
provisional holds would make the requested observation fit, a denial advises
a local recheck within one second. The recheck still has to pass the entire
weighted budget and FIFO gate before sending any request. Completed or
uncertain requests keep their real rolling-window charges. A real earlier
expiry, response quarantine, and the provider's full 429 cooldown retain their
existing deadlines.

While no account frame is active and a learned FIFO head is still waiting for
its pacing time, a bounded public request may use otherwise idle capacity when
existing retained public charges are below 20% of the local limit and the new
request's complete reservation is at most that share. One bounded request may
cross this soft share; further exceptions stop while the held or paid public
weight remains at or above it. No response refund is assumed before dispatch.
Unknown response surcharges cannot use this exception. Once the head's
pacing time arrives, its normal reservation protection applies again. Every
dispatch still reserves its full weight under the same hard global ceiling.
Cold or full-window account reservations keep their complete protection.
This is a bounded fairness exception, not a guarantee that real public fees
cannot delay a later account observation. Ordinary admission retains its
existing rules rather than gaining a separate hard public-lane limit.

## Monitor transaction boundaries

The monitor separates account publication from public-source planning:

1. `audit_control` reads the owned account, reconciles existing execution status,
   fills, funding, flows and quantities, records performance, and performs the
   portfolio and all sleeve loss/closing controls. It commits that observation
   before waiting for public source planning. A prior planning error remains
   visible until planning actually succeeds.
2. `observe_plan` locks and reads the current state again. Only portfolios that
   completed the first phase and still match its full in-memory portfolio
   fingerprint may use the observation. Any intervening edit skips this planning
   attempt. Source/profile/fill checks, target construction, release and proposal
   completion otherwise retain their existing checks and ordering.
3. `durable_notify` reconciles existing frozen execution identifiers and delivers
   durable notifications through the existing outbox path.

Normal scheduling measures the five-second cadence from the start of a tick;
a long, completed tick can therefore join the next turn immediately. The same
user never overlaps ticks, and both later phases must finish before another
tick starts. An uncaught transaction failure retains a five-second backoff from
completion. Persisted, validated venue retry hints remain effective across all
phases and restarts. When the next account retry is within one normal interval,
the next tick aligns to that deadline instead of starting a skipped audit just
before it and draining reconciliation across the available slot. Longer waits
continue normal durable-work cycles; expired hints can retry immediately.

Public local-budget retry state is stored independently from account-read
errors. A public-read cooldown suppresses the corresponding planning request
while account audits and durable reconciliation continue. An account failure
cannot erase that public retry. Replaying a pending public error retains its
original timestamp; it never renews the wait on each tick. Public awaits are
identified at their call sites, so a release's account read is not mislabeled
as a source read. A provider 429 still applies globally, and legacy unscoped
errors keep their conservative account-read behavior. Closing paths that do
not need public evidence continue through their existing control suffix.

The account freshness limit remains 30 seconds and public source/position
freshness remains 5 seconds. Public reads keep their existing deadlines and
completion semantics. No source timeout is converted to empty positions, and no
completed follower-account chunks are reused to manufacture a new observation.
These changes do not raise the weighted limit, remove scope/history checks,
replace unknown execution identifiers, or change the backend's graceful drain.

## Diagnostics and acceptance

`agent_monitor_timing` records random per-tick references, fixed phase/operation
labels, numeric duration/age and fixed error categories. It contains no owner,
wallet, amount, request payload or original error message. Late public prefetch
records retain their original tick reference; their duration alone does not
prove that the state transaction waited for them.

Local regression tests and production acceptance are recorded separately. The
local isolated-PostgreSQL suite passed 812 tests with no skips; the functional
journey passed 53 checks, and type/package verification passed. Three six-minute
load phases retained the original 12-second venue/20-second transport deadlines:
both published account ages stayed at or below 28.8 seconds, source cursors kept
advancing, and actual rolling provider weight stayed below 1000. These fixture
results do not establish production or trade acceptance.

The
production check uses the original two anonymized portfolios under their natural
monitor schedule after old deployments have drained and the old weighted window
has expired. Snapshot age, audit coverage, 429/deadline counters, exact runtime
revision, single-monitor deployment and CI are checked independently. This is
not authorization or evidence for a manual order, transfer, signature, strategy
activation, or real-device acceptance. No App version or release is part of
this change.

The limiter is process-local. Multiple pods or other callers sharing the venue
IP still require fleet-level coordination; these fixes do not establish a
shared distributed budget or monitor lease.
