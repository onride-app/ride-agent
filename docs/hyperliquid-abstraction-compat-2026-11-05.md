# Rider upstream reads and Core session compatibility

Local repair based on `1f20830`, 2026-11-05. No deployment, App/npm
release, account mode change or financial operation has been performed.

The read-only investigation reproduced official mainnet `/info` returning 422
for `userDexAbstraction` while `userAbstraction` returned an explicit enum. The
current public `webData3` response also omitted `dexAbstractionEnabled`. These
public-address probes establish response contracts, not original-account copying
acceptance. The [official Info documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
still lists both requests and documents the new enum; the observed rejection
must not be replaced by an assumption that the older request remains available.

The bridge now uses explicit `userAbstraction` values: `default`/`disabled`
are Standard, `unifiedAccount` is Unified, and `dexAbstraction`,
`portfolioMargin` and unknown data remain distinct unsupported states. Standard
RWA checks and selected-source previews no longer require the legacy boolean
request. Unified observations retain the strict optional WebSocket proof; an
absent field never becomes false. Their REST fallback re-reads the current enum
through the existing account budget and original deadline after history and
requires it still to be Unified. Original financial evidence times, foreign-DEX
guards, complete histories, risk checks and final mode revalidation remain.

The request graph change increments the operational cost-plan contract to
`perps-cost-plan-v2`. Existing v1 rows remain stored; the new opaque owner and
contract require natural fresh learning instead of restoring older metadata.
Cold-start timing and original-account freshness need a new natural observation
window after any separately authorized deployment.

An independent Core session defect was also found: GraphQL emits its specific
`TokenValidation::error_code` values, while Rider recognized only generic
`UNAUTHENTICATED`/`UNAUTHORIZED`. The identity guard now maps the explicit Core
token-failure allowlist to 401 with a safe `reason_code`; `UPGRADE_REQUIRED`
remains a distinct 403. Network failures, invalid responses and resolver outages
remain 503, and both identity and summary checks remain mandatory. Portfolio
aggregation preserves the underlying error and an explicit expired-session result
no longer claims authentication succeeded. A separate read-only production probe
confirmed one active outer OAuth session whose stored Core JWT had expired:
the fixed identity query returned HTTP 200 with `ACCESS_TOKEN_EXPIRED`, without
either required identity field. No token, account identity or raw query response
is recorded here.

OAuth stores no Core refresh credential. A trusted stored Core JWT's expired
`exp` now denies the outer token at the HTTP bearer middleware, producing the
existing 401 challenge without a Core request on every tool call. Decoded claims
never grant scopes or identity; unknown expiry shapes retain the Core guard.
OAuth refresh revalidates the same Core subject before rotating its opaque grant.
Expired Core credentials return `invalid_grant` so the host can reconnect through
the existing human flow. Real outages preserve the grant and return a temporary
failure. Memory and Redis consume the validated generation atomically, preventing
double refresh or deletion of a replacement record. No live session, plan or
portfolio record was changed during this work.

`core_identity_failure` diagnostics retain only a generated request ID, fixed
category/reason/error codes and numeric upstream status. HTTP failure, invalid
JSON, resolver failure and missing identity/summary remain distinguishable without
tokens, account data, URLs, query documents, response bodies or original messages.

## Prediction read coverage

Active Node position reads now use `/v2/positions`, preserve wallet and cohort
filters across opaque cursors, and walk both OPEN and REDEEMABLE_LOST. Missing
pagination, repeated cursors, caps, conflicting rows/aliases, foreign wallets and
unknown economics fail closed. Even terminal v2 walks omit inactive markets.
Account reads therefore expose verified cash and servable holdings as subtotals;
complete Prediction equity remains unavailable. Source completeness, flatness and
new ownership binding are not inferred from that partial inventory. Already
owned RPC balances, quantities and receipt reconciliation remain independently
available, with full coverage explicitly false. This does not restore Node
Prediction's real execution.

Both historical metric paths depended on the retired `/v1/accounting/snapshot`.
They no longer call it or substitute v2 positions for the missing accounting
anchor. Existing still-fresh verified history remains readable; new metrics stay
unavailable as `accounting_snapshot_retired`. The existing Polygon reconstruction
algorithm is retained behind an independent wallet-bound accounting-anchor
provider, but production has no fabricated replacement and starts no unanchored
history scan. Historical pure archive parsers remain available for supplied data.

Validation uses the exact lockfile in an isolated worktree. Typechecking and the
complete non-PostgreSQL suite passed: 1200 pass, 53 PostgreSQL skips, 0 fail.
Tests include all current enum shapes, unknown/DEX/portfolio modes, missing WS
fields, post-history REST fallback, unchanged financial timestamps and guards,
Core token failures, genuine outages, aggregated error preservation, actual HTTP
401/refresh behavior and v2 coverage boundaries. An isolated real Redis test with
two independent connections verified one successful rotation per grant and
preservation of replaced records. Fixtures use simulated identities and venues.
Skipped PostgreSQL cases and simulated venue contracts do not establish live
durability, natural monitor freshness or real fills.
