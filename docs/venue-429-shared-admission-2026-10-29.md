# Hyperliquid 429 admission and recovery

The bridge and gateway could send some Hyperliquid reads without the shared
weighted gate. `DepositReads.tradingInfo` used raw HTTP, and gateway account
balances did the same for spot state and valuation metadata. A local gate
showing less than 1000 weight therefore did not account for every request sent
by those processes.

An isolated reproduction filled the bridge gate to 1000, then called the real
deposit-status path with fixture ownership and RPC responses. Its unmetered
reads raised the simulated provider's weight to 1230 and produced 429 while
the gate still reported 1000. This proves a source defect, not the attribution
of every production 429 to deposit polling.

Both paths now use `VenueReads`. CoreBridge injects its existing reader into
DepositReads; direct DepositReads construction also shares the process budget.
Gateway readers retain their authenticated ownership checks, 22-second overall
deadline and 10-second HTTP bound. A constructor-bound cancellation signal
applies to admission, HTTP and JSON reads. Completed account balances are not
cached. Non-Hyperliquid RPC, GraphQL and Prediction requests retain their paths.

A separate recovery defect allowed a no-header 429 to resume after one second.
An intervening success reset the failure count; even uninterrupted exponential
backoff stopped at sixteen seconds. A 429 now blocks both lanes for at least a
full 60-second quota window, or a longer provider Retry-After. An in-flight
success cannot reopen that window. The configured weight ceiling, response
surcharges, uncertain-response isolation, account scopes and risk checks remain.

The [official rate-limit documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)
describes the per-IP, one-minute REST quota. This is still a process-wide gate,
not a cross-pod or exclusive-IP guarantee. Railway outbound IPs can be shared;
repeated provider 429 must be evaluated with actual post-rollout windows rather
than explained away by a healthy local ledger or a successful low-cost probe.

Regression coverage includes full-budget zero dispatch, mainnet/testnet hosts,
mode rechecks, shared cooldown across funding/source/gateway reads, unavailable
instead of zero balances, long Retry-After, short or absent Retry-After, late
successes and cancellation while queued or parsing JSON. Local tests and
production acceptance are recorded separately in the task's redacted receipts.

Local validation: isolated PostgreSQL full suite 646/646, zero failures/skips;
functional journeys 53/53; TypeScript, build and package verification passed.
One existing recovery test now also verifies that a five-second Retry-After
does not dispatch another request before the full minute has expired.

No App release, signing, transfer, strategy activation or portfolio-setting
change is part of this delivery.
