# Account cost-plan PostgreSQL round trips

This change reduces the database round trips required for operational account
read-cost metadata. It does not cache account evidence, change venue requests,
raise the venue budget, or relax source/account freshness checks.

A warm admission previously used five queries to read a hint and seven to claim
its generation. It now uses three and four respectively:

- Send the existing `BEGIN ISOLATION LEVEL READ COMMITTED` and
  `SET LOCAL statement_timeout = '20s'` together as one constant, parameter-free
  simple query. The transaction still waits for both commands to finish.
- Materialize the original `SELECT ... FOR UPDATE`, then evaluate
  `clock_timestamp()` in its dependent outer projection. The clock is evaluated
  after lock acquisition and any EvalPlanQual row replacement. An empty result
  retains a separate clock query; missing or malformed clock values fail closed.
- Skip `INSERT ... ON CONFLICT DO NOTHING` only when the caller supplies an
  expected generation string. The locked row must still match its generation
  and exact plan and must not have a live dirty lease. A missing expected row
  fails closed. Existing generation `"0"` remains supported; null or absent
  generation hints retain cold initialization.

Row locking, generation checks, plan validation, the ten-minute learned-plan TTL,
the original 20-second abort/statement/lease bounds, and connection destruction
on failure remain in place. A lost COMMIT acknowledgment does not return a lease
or completion success, fabricate rollback, or replay an operation. The same
helpers also reduce a successful completion from six queries to four.

## Validation and limits

Real PostgreSQL tests measured the warm path changing from 12 queries to 7.
A local TCP fixture that explicitly injected 50ms in each direction measured
1313ms before and 781ms after; these are synthetic RTT measurements, not
production latency or account-SLO acceptance.

The frozen candidate passed 21 targeted checks on Linux Node 22/PostgreSQL 17,
including the existing shutdown tests, and the same eight new cases on
PostgreSQL 18. The cases cover lock waits across TTL/lease expiry, updated and
deleted rows, generation/plan races, invalid clocks, cancellation, socket/SQL
failure, and injected acknowledgment loss after actual database commits.

The fixed 60-pair performance model had eight strict-30-second failures become
passes and no passing case become a failure. Eleven pairs had worse maximum
ages: nine failed on both versions and two passed on both. A separate model using the actual
four-query completion retained those results. These counterexamples remain
part of the evidence; this change is not a general cold-start or steady-state
30-second guarantee.

Full tests, functional acceptance, Git/CI, deployment, and a new natural
original-account observation window remain separate gates. Existing failed
windows, unknown executions, and pending source-consumption/real-fill acceptance
must be preserved. No App or npm release is implied.
