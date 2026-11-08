# Agent hot state and durable history

The App-owned Node runtime keeps the existing Agent domain, account locks and
execution lifecycle. This storage change removes historical updates and decision
arrays from the JSON read by each monitor turn. It does not change observation
freshness, venue quotas, transaction authorization or unknown-execution recovery.

## Storage and compatibility

`ride_agent_state.state` holds the current portfolio, owned ledger, executions,
funding evidence, proposals and other current fields. Its `updates` array is an
empty structural placeholder; portfolio `decisions` are stored separately.

Six additional tables are part of the same database and backup boundary:

| Table | Purpose |
| --- | --- |
| `ride_agent_history_migrations` | Atomic, per-owner legacy migration marker |
| `ride_agent_history_schema` | Committed schema-ready version; warm process startup avoids DDL locks |
| `ride_agent_updates` | Stable event ID, original ordinal, indexed delivery metadata, current payload and immutable original payload |
| `ride_agent_decisions` | Stable per-portfolio ordinal, current decision payload and immutable original payload |
| `ride_agent_history_heads` | Monotonic ordinal/version and absent-versus-empty decisions metadata |
| `ride_agent_decision_evidence` | Latest decision ordinal and any historical non-null target by copy/market, including a zero target |

`Repository.read` and `transact` still return complete active history. A read uses
one PostgreSQL MVCC statement, so a committed hot state cannot be paired with
another transaction's history. Public update ordering and signed `(at,id)`
cursors keep their existing meaning. The monitor-only optional transaction
interface is used by the runner and notification dispatcher; other Repository
implementations retain the original interface and behavior.

On the first transaction for an existing owner, the original arrays are copied
to their tables inside PostgreSQL, without transferring them to Node. Original
event IDs, event order, decision order and original JSON payloads are retained.
Only after successful copies are the arrays removed from the hot JSON and the
migration marker committed. Copying, business changes and history changes all
hold the existing owner row lock in one transaction. A failure rolls everything
back. Replacing/removing history through a full Repository callback logically
retires old rows; their original payloads remain stored.

The native `ride_agent_state.monitor_eligible` boolean and its partial index
replace repeated JSON expansion during user discovery. Existing rows are
backfilled once. It is maintained transactionally from nonclosed portfolios,
daily-digest preferences and **any** active pending notification in cold storage,
including future deferred and claimed deliveries. A NULL imported/legacy row
uses the previous predicate until its transaction initializes the projection.

Initial schema DDL takes the state-table lock before history-table locks, matching
the business transaction order. The committed schema-ready marker lets later
processes initialize with metadata reads instead of repeating DDL while a
financial callback holds its row lock. Decision-head ordinals and the update
ordinal index avoid scanning full histories to fetch the latest decision or
allocate a new event ordinal.

## Monitor projection and delivery

Each monitor transaction reads:

- At most 256 recent, visible update payloads for the one-hour duplicate check.
- The earliest four due, unclaimed notifications, selected independently.
- Exact IDs whose delivery results need acknowledgement, selected independently.
- Pending daily digests, including those requiring cancellation after a preference/day change.
- The latest decision per copy/market, admission-evidence guards, and a durable
  history version included in phase fingerprints.

The 256 bound affects duplicate suppression only. A forgotten older duplicate
may produce an extra event; it cannot remove due delivery, an exact ACK, a
financial/unknown execution or any authorization/risk evidence. Runner update
reads are limited to duplicate suppression and notification handling; execution
recovery uses the complete current portfolio and original execution IDs. The
internal decision guards/version are not sent across the bridge or returned by
the complete public Repository view.

Notification claims, stable IDs, per-device receipts, expiry, retry backoff and
token-matched acknowledgements retain their previous meanings. Prepared delivery
revalidates its exact claimed IDs through a small ordinary read, instead of
loading complete user history. No user row lock crosses push I/O.

## Repeated observations

New budget/rate observations share an event within the existing one-hour
suppression window only when kind, portfolio and complete data are identical
after removing `diagnostics.retry_after_ms`. All other diagnostic, scope,
operation, execution and financial identities remain significant. The first
event's ID, timestamp, data and delivery state stay stable; a bounded
`observation_episode` records first/last observation, count and latest data.
An already delivered event is not requeued just because its countdown changed.
Unknown execution and financial/risk events use the existing exact-data rules.

The one-time legacy migration also collapses redundant **pending delivery** of
pure budget/rate messages with identical kind, portfolio, message and normalized
data. The latest stable event ID represents delivery and carries first/last/count;
other duplicates become cancelled and point to it through
`notification_superseded_by`. Every original row/payload remains available for
audit. Any event with a notification claim, even an expired claim, is excluded.
Different diagnostic/execution IDs, scope or portfolio are never merged.
Execution uncertainty, funding and risk messages are never part of this merge.

Exactly equal decision business fields can summarize repeated observations with
first/last/count. Changes to source revision/quantity/entry, mark, target, reason
or sleeve configuration create another decision. No receipt, funding record,
owned lot, execution, order ID or financial quantity is coalesced. Diagnostic
window queries include an episode when its observation interval overlaps the
requested window; the episode count describes its whole interval.

Unchanged projected records are not rewritten. The hot JSON is updated only
when its serialized contents change; eligibility is updated only when its
boolean changes. Histories still grow for distinct business events. Existing
checkpoints, performance, configurations, receipts and financial evidence remain
in the current schema; this change does not claim to bound every future field.

## Rollback and validation

The old `8b906c4` binary cannot safely interpret a stripped hot state by itself.
Rollback must use a history-aware compatible binary and the complete database,
or explicitly materialize the legacy full-state representation into an isolated
restored database before starting the old binary. Never start an old monitor
against the new hot JSON, omit cold tables from migration/backup, reuse new IDs
for unknown executions, or run old and new monitors concurrently.

The SQL uses PostgreSQL 17-compatible syntax. `cold-history.test.ts` uses an
independent local PostgreSQL URL to verify lazy migration/rollback, original
payload preservation, row locks, history-version invalidation, absent/empty
compatibility, old claimed notification ACK/restart, exact legacy alert identity,
9,000-row bounded projection with complete public pagination, and native
eligibility for deferred/claimed/digest/attention states. These fixtures do not
call production handlers or establish real-trade acceptance. Darwin skips the
existing kernel TCP_USER_TIMEOUT proofs because PostgreSQL reports effective
zero; that limitation must remain explicit.
