# Account observation queue and wire deadlines

The deployed retry-window fix `d9c529f` did not establish continuous healthy scheduling. A bounded natural-log sample still showed local budget pressure, deadlines, and one unknown funding response. Those counters did not establish a malformed upstream response or successful customer copy execution.

Two avoidable defects were reproduced locally:

1. The previous 12-second read deadline included budget queueing. A funding read admitted after 11,999 milliseconds could have only one millisecond left for HTTP/JSON, so even a healthy five-millisecond response was classified unknown and quarantined the shared budget.
2. The scheduler evaluated candidates before checking an in-flight unknown-response exclusive hold. Its temporary reservation could look like the owner had spent a full window and switch its turn before the real small response fee was settled and refunded.

Perps account observations now have an explicit 20-second total scope, matching the existing bridge transport boundary. Queueing, all observation stages, and Core reads share that deadline. HTTP/JSON work has a maximum 12-second wire timer starting after admission, also capped by the remaining frame time. Unscoped reads keep their prior total bound. A failed frame cancels its unsent queued siblings; already-sent reads may settle within their existing deadlines. Scoped in-flight keys prevent one failed caller from canceling another caller's queued read. Account turns use the same 20-second frame bound; source turns remain 12 seconds.

Candidate selection now waits until an existing unknown exclusive hold is settled and released. Real unknown/invalid responses, their full response costs and debt, rolling quotas, cooldowns, quarantine, all DEX scopes, freshness checks, risk rules, and stable execution identifiers remain protected. No whole-frame headroom estimate, new account cache, or concurrency increase was added.

Regression coverage includes queued-then-healthy funding reads, 20-second total and 12-second wire limits, real unknown quarantine, sibling cancellation without charging unsent work, independent callers, refund/owner continuation, timer wakeup, full response debt, and rolling-budget limits.

Local validation used Node 25.8 and an isolated PostgreSQL 14.19 database: typecheck/build passed, full tests passed 629/629 with zero skips, functional journeys passed 53/53, and package verification passed. These local fixtures do not establish customer signatures, orders, or production scheduling acceptance. CI separately uses Node 22/PostgreSQL 17.

The original one-millisecond high-load test still exercises three accounts and six continuous sources. A separate 500-millisecond wire test uses bounded offered load: account starts at 0/50/100 seconds, with a 150-second interval after successful frames and bounded retries after failures. It verified progress for all three accounts and complete ten-DEX snapshots within 16.5 seconds. It does **not** establish recovery for three simultaneous 500-millisecond account pipelines repeatedly requested every five seconds. Saturated provider or local capacity still fails closed; production scheduling and customer execution require independent acceptance.

The upstream funding-array and surcharge contract was checked against [Hyperliquid's Perps info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) and [rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits). The healthy-response reproducer proves an avoidable local path, not the cause of an individual production timeout.
