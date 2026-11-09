# Reconsidering an unsent source prefetch

A source prefetch can fail on admission while a complete follower audit waits.
After that same audit succeeds and the existing portfolio fingerprint still
matches, planning may reconsider that original prefetch once through the normal
source reader. It requires a retryable `VENUE_READ_BUDGET_EXHAUSTED` error with
`details.reason_code=READ_LOCAL_BUDGET_UNSENT`.

Only a local pre-dispatch budget rejection or the authenticated Core Info
receipt with `upstream_request_sent=false` produces this marker. A budget code
alone, an unknown/sent receipt, provider 429, cooldown, invalid evidence and
account-frame reason codes do not qualify. The marker describes the rejected
read only: other reads in the same source collection may already have occurred.
It is never evidence that a financial action was not accepted.

The retry uses existing SourceFeed cache, joins and failure backoff. It does not
force refresh, wait through cooldown or increase quota. One promise per original
prefetched trader prevents duplicate retries within the planning pass. A stale
retry result cannot invoke the older aged-prefetch refresh a second time.
Lazy source collection created after the audit is not retried by this rule.

All source and position observations must still satisfy the existing five-second
checks, and the complete account must remain within thirty seconds. Failed
audits, changed portfolio fingerprints, stale/incomplete results and repeated
read failures keep increasing execution blocked. Frozen execution identity,
unknown classification, preflight evidence and financial controls are unchanged.
Local fixtures establish these boundaries; natural production acceptance remains
a separate observation.
