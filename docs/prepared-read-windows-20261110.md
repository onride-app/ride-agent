# Prepared Perps read windows

This change is a local implementation and test result. It does not establish a deployed revision or successful natural trading.

The ordinary Runner previously completed its financial audit, created new execution IDs, and then queued a separate complete account read for each new execution. A valid account audit does not guarantee that the next read can enter the same full sliding window within its original 20 seconds. Read admission failures could therefore create new uncertain execution IDs without reaching the financial Core outbox.

The optional prepared path applies only to one initialized, active Perps portfolio with no prior nonterminal executions. Other portfolios, mixed markets, fixed-copy source-fill pipelines, old queued/uncertain/outboxed work, managed risk exits, and unsupported transports retain their existing paths. A known single-scope hint above 450 and at most 900 is not eligible for a paired booking; the paired optimization returns unsupported before booking and the normal complete-read path remains available. A larger single-scope demand is never clamped into the existing fleet capacity.

## Sequence and authority

1. A committed operational routing projection selects a candidate. Preparation makes one bounded metadata poll per normal callback, independently of financial audit success. The Core UUID and first queue deadline are pinned across polls; no execution ID or financial timestamp is created while pending.
2. A cold operational plan may book the existing explicit 780 trial for one full audit. It must complete the entire original account graph and clean its real cost-plan generation. Cold callbacks cannot prepare new executions.
3. A warm plan books twice the existing single-scope hint under the same Core 900 and local 1000 ceilings. Both Core and local gates must be admitted before the callback runs. The original Core grant starts one 20-second window; subsequent stages only consume its remaining time.
4. The first child performs the original full fresh account audit. Its own actual and peak costs are learned independently. The cost-plan claim happens only immediately before a new provider dispatch, not for unused credit or a metadata cache hit. Its real PostgreSQL clean CAS must complete before an audit success is returned.
5. Normal fresh source planning may consume only the first completed child's proven unused credit. With a 184 child and actual audit cost 84, this supplement is at most 100 across all selected source reads. The complete second 184 remains protected. Supplement fees are real global fees and parent pacing costs; they are not samples for the account cost plan.
6. The private service verifies the successful audit hash, operational identity and one exact proposal binding. Before reporting proposal readiness it also checks that the just-learned single-scope hint still fits the complete reserved second child. A first audit that raises164 to184 therefore defers before creating an ID rather than failing later inside submission. Only then may the Runner create one original execution ID with its ordinary 60-second target lifetime and commit it before submission.
7. The second child performs another full fresh account preflight. Account history, ownership, wallet generation, source positions, original observation timestamps, leverage, funds, Core policy and the frozen 0.2% price deviation gate remain unchanged. The read window is stopped and unused-credit release is initiated before the first durable outbox write. An already-outboxed financial POST is not cancelled or retried by a read-window timer.

Two 12-second reads cannot both be guaranteed to fit a 20-second parent. Slow reads, unknown surcharges, changed identities, insufficient source surplus, stale source evidence and expired windows continue to fail closed. No quota, evidence freshness, provider cooldown, debt expiry, original execution identity or risk limit is relaxed.

## Private transport and lifecycle

`withPreparedPortfolio` keeps the handle in an asynchronous call context. Only the authenticated private bridge receives `x-ride-read-window`; request JSON cannot supply a substitute. The handle never enters portfolio state, execution records, frozen financial payloads, public responses or logs.

Preparation uses a compact metadata projection rather than copying historical executions, decisions, fills or account snapshots into new RPCs. Exact proposal binding adds only hashes of the successful audit and write-sensitive state. History-fold bookkeeping and `last_source_at`, a public observation marker, do not change this authority hash. Source revision, actual intent timestamps, quantities, prices, controls and other financial state remain bound.

The registry is bounded to 64 entries. Pending creation is serialized before the first asynchronous identity lookup. Foreign, changed, expired or already consumed capabilities cannot fall back into the prepared path. Cancellation, failed database commits, caller abort and drain invalidate only the owning capability and release its unused credit. A committed routing change may cancel its exact old pending interest even during the first identity lookup or while a pending receipt is in flight. Metadata cancellation and changed/fixed metadata cannot terminate an already ready peer; that capability remains owned by its handle until finish, expiry or drain. Sent and unknown fees remain in the original rolling ledgers. Core end acknowledgements are bounded and tracked for drain; invalidating a local capability does not claim that the remote release acknowledgement has already arrived.

SourceFeed retains its existing freshness, cache, single-flight, cooldown and background cadence. The supplemental context wraps only a newly started on-demand fetch. It does not wrap timer creation or adopt an already queued/background flight. A failure still respects ordinary backoff; it is not force-refreshed to obtain credit.

## Validation scope

Local tests exercise the actual Runner, PostgreSQL state/history commits, BridgeAdapter, authenticated managed HTTP handler, CoreBridge, full Standard and unified/WS account graphs, VenueReads, local budget and Core frame factory with isolated provider/Core transports. Separate tests cover a full 900 bank, independent child costs, selected-source surplus, real cost-plan generations, concurrent preparation, identity/proposal mutation, cold and unsupported paths, original deadlines, late cancellation and an already-outboxed response across parent expiry. Existing wire, recovery, retirement and PostgreSQL shutdown regressions remain required.

These fixtures do not sign or place real orders. Production acceptance still needs the original accounts' naturally occurring execution IDs, durable Core tasks and actual venue receipts. Read grants and clean cost plans alone are not financial acceptance.

## Bounded private history projection

The private bridge still accepts at most 1 MiB. A growing collection of permanent original-ID retirement receipts can exceed that limit and prevent reconciliation of a different, still-unknown execution. An HTTP 413 is a transport failure; it provides no financial absence evidence and never authorizes retirement by itself.

Only the private `portfolio.executions` transport view may omit a history entry satisfying **all** of these conditions: Perps key, failed status, task ID strictly null, observed quantity null, the original 60-second frozen identity and fingerprint recompute exactly, and the complete permanent retirement receipt validates for the same user and actual Perps account. The separately supplied `input.execution` and its same-ID portfolio entry remain complete. All unknown, task-bearing, Prediction, contradictory, missing-proof and other history stays in the transport view.

This projection does not delete or update a database row, execution ID, retirement receipt, fence, allocation or frozen payload. The Runner keeps its complete durable history. Prepared proposal hashes use the same user/account canonical view on both sides, so transport omission cannot manufacture a changed financial fingerprint or a new execution ID.

The owning private read graph uses nonterminal executions for handoff recovery, task-bearing Perps history for fill attribution, and task-bearing Prediction history for settlement ownership. Permanently rejected taskless Perps entries cannot participate in those paths. Standalone recovery and retirement continue to receive and validate the complete original execution.

Local tests use an oversized fixture body and the real unchanged Express limit: the unprojected request receives 413 without a Core call; the projected original-ID recovery traverses the authenticated handler, typed retirement validator and real PostgreSQL state commit. All historical IDs, the original frozen fields and the first 413 diagnostic remain durable, and no order, task or submit is manufactured. A separate full prepared Runner/HTTP/PG test retains its old permanent IDs while matching the canonical binding for one new target.

Retained task, Prediction or unknown history can still exceed 1 MiB. Such requests remain fail closed. This narrow projection does not claim unlimited history support and does not raise the body limit.
