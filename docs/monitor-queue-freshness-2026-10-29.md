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

Before the first venue request, a complete account observation may now wait
locally for a valid short budget hint. The cumulative wait is at most one
second, inside the original 20-second account scope; longer or invalid hints
return the existing typed error immediately. Parallel first reads share one
admission promise. Every wakeup checks cancellation, the original scope
boundary, the fixed local-wait boundary, FIFO order, provider cooldown and full
real capacity again. No frame or provisional weight is held during that wait.
Admission is revalidated before even cached metadata can be returned.

This avoids losing a near-ready slot to an entire subsequent reconciliation
cycle. Account pacing still starts from actual admission, and source reads keep
their original deadlines. Financial timestamps remain the earliest actual
evidence time, excluding the local queue wait. Idle time grants no pacing
credit; neither unknown-response charges nor completed evidence are refunded.

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

## Hosted follow-up on 2026-10-29

At revision `6b29e41`, all 812 isolated-PostgreSQL tests, 53 functional
checks, type verification, package verification and the exact-revision CI run
passed. The hosted acceptance still failed the unchanged 30-second snapshot
requirement. After a bridge-only static outbound assignment and redeployment
of the same tested build, five complete warm quota windows had genuine reads
and no 429, deadline or transport failures. This is an observed recovery, not
proof of a dedicated address or the earlier external 429's cause; the platform
may share static outbound addresses, and the new bridge's live outbound hash
could not be checked because management SSH failed.

The complete eight-minute observation retained all 96 samples. Both original
anonymized portfolios produced at least 15 new complete snapshots, but their
maximum published ages were 31.543 and 28.735 seconds. Around the failure, the
first portfolio's financial timestamps were 29.036 seconds apart; publication
latency can carry that gap across the 30-second limit. A nearby anonymous audit
published at age 2.591 seconds, including a 499 ms database commit. Its owner is
not logged, so that timing cannot be assigned conclusively to the failing
portfolio. Earlier failed windows remain evidence and are not discarded after
recovery. Lark stays DOING while this production acceptance is incomplete.

## Bounded admission wait validation

The account side of the sustained-load fixture now uses real
`VenueReads.observeAccount`, `read`, cancellation and financial evidence
stamps, as its public source side already did. It retains the six 300 ms venue
stages, full 164 actual weight per frame, exclusive unknown funding before
bounded history, complete history reservations, original source and account
deadlines, and the existing durable reconciliation workload. Added read,
commit and private-Core delays remain inside their actual transaction or
observation boundaries. A synthetic publication tail of about 3.5 seconds
covers the measured hosted upper tail without attributing its unmeasured
contributors to Core.

All 21 load cases passed: 18 production-policy cases and three diagnostic
controls. Production-policy published age stayed at or below 28.53 seconds,
rolling actual weight at or below 948, and both source cursors continued
advancing. The original three phase variants reached 26.4 seconds. A separate
old-fast-gate comparison also passed, so this is regression coverage and a
phase-specific improvement, not a reproduced hosted failure turning green.
The whole local isolated-PostgreSQL suite passed 849 tests with zero skips.
These results do not replace the next complete hosted acceptance window.
