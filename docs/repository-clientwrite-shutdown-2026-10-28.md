# Bound repository reads and close pre-callback readers during shutdown

After the source-history fix, a retired backend PostgreSQL session remained
`active / ClientWrite` in the repository's `SELECT state ... FOR UPDATE`. Its
connection start matched the removed deployment, its address differed from the
new backend, and the reported user's row `xmax` matched that session's exclusive
transaction lock. The complete saved state was about 5.55 MB. The read had not
returned, so this transaction's business callback had not started.

The removed deployment's resolved Railway configuration had a 30-second drain
window, with no draining/overlap environment overrides. Its old SIGTERM handler
aborted future runner loops, but awaited the blocked runner before closing the
repository. That close could therefore never start before platform termination.
This was not a zero-second drain configuration in the observed deployment.

## Changes

- Each repository connection uses a 20-second PostgreSQL statement deadline and
  a 25-second driver query deadline. A failed transaction destroys its connection
  instead of queueing `ROLLBACK` behind an unfinished response or returning the
  unknown session to the pool. Checked-out connection errors are captured even
  between queries while a callback awaits external evidence; a failed session
  cannot commit that callback's state.
- SIGTERM/SIGINT starts repository closing immediately and rejects new
  transactions. Tracked clients still awaiting the initial state read are ended
  immediately. Closing is checked again after that read, before the callback can
  run. An already-entered callback may have external effects; shutdown lets it
  finish through the existing durable execution/outbox path.
- The runner starts no next user or scheduler delay after abort. Backend cleanup
  also closes the repository if the runner exits unexpectedly. Railway code
  configuration explicitly allows a 45-second drain window.

No portfolio, target, risk limit, signature or trading retry policy changes.
An unknown external submission remains subject to the existing same-identifier
reconciliation; shutdown does not prove cancellation or authorize a fresh replay.

## Real PostgreSQL validation

Tests use unique disposable rows in an isolated PostgreSQL database, not mocked
lock behavior. The incident-sized 5.55 MB response was first reproduced locally;
the repeatable test uses 24 MiB to exceed Linux Docker forwarding buffers. The
response is deliberately paused on the client socket until PostgreSQL reports
`ClientWrite` and a second connection confirms the same row is locked. Closing
before the driver deadline releases that lock
and destroys the database session without running the state callback. A separate
driver-deadline test disables the server statement deadline to prove failed
connections are destroyed and another client can acquire the row. Another test
proves an already-entered callback can commit once while shutdown rejects new
transactions.

Validation passed `npm run check`, `npm run build` and the full suite with a real
isolated PostgreSQL 18 database (zero skips). Timeout/shutdown tests also cover a
checked-out connection terminated while its callback waits, with no unhandled
client error or state commit. An additional independent boundary injection closed the
repository immediately after the state read resolved and verified that its
callback still did not run or change the stored state.

PostgreSQL 18 experiments also showed that `statement_timeout` and
`transaction_timeout` can defer cancellation while output is blocked in
`ClientWrite`. A responsive-client test verifies the ordinary SQL deadline, but
this patch does not claim that a database statement deadline alone handles a
dead pod. No database-global or TCP settings are changed. An unannounced hard
kill without a shutdown signal still depends on server/network disconnect
detection; the measured shutdown fix relies on the configured drain window.

The reported portfolio's abandoned session was separately removed by an exact
single-session operational guard. Three subsequent natural scheduler
observations showed no source-evidence error or abandoned lock and no orders or
receipts. A new HYPE target was correctly blocked because it represented 100%
of proposed exposure against the existing basket limit of 60%. Risk-rejected
planning deliberately leaves the Fixed cursor uncommitted; cursor advancement
is not an acceptance requirement for that legitimate risk-blocked state.
