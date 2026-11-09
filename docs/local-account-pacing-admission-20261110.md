# Local account admission after a Core grant

Core admission and the Node ledger remain separate gates. A granted frame may
wait before its first provider request only for the typed local pacing delay,
and only when quota, FIFO, exclusivity and quarantine are otherwise ready.
Every retry re-enters the same local gate. Other denials release unused Core
credit immediately; a pacing wait never allocates another frame or increases
the local reservation.

The original account scope, its monotonic deadline and the granted Core expiry
continue to run during the wait. The wire timeout remains at most 12 seconds
and cannot exceed the remaining scope. Fresh Perps submission evidence also
consumes the original execution expiry and a server-owned 20-second HTTP caller
lifetime. Disconnect, expiry and shutdown cancel waiting reads. A fresh
submission checks that caller lifetime again before its first outbox INSERT.
Already frozen or accepted actions retain their original outbox and recovery
path; a read cancellation does not cancel or replay an action.

An 80-weight audit followed immediately by a fresh preflight can therefore wait
the existing six-second pacing interval and then read again within the original
deadlines. Completed account data is not reused. History completeness, source
and account freshness, financial checks, quotas and sent-unknown accounting are
unchanged. These scheduling tests are local fixtures, not real-trade acceptance.
