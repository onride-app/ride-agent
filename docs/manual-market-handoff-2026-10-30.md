# Same-account native Perps manual takeover

The user rejected an extra account selector and explicitly chose market-level
manual control: a manual action takes over that coin, copying stops tracking it,
and the remaining coins continue. Wallet, balance and trading entry stay on the
original account. The server protocol is in Predictly Core
`docs/MANUAL_MARKET_HANDOFF_20261030.md`; no App release or package-version bump
is required.

## Trusted boundary and accounting

Core returns an immutable `manual_markets` journal from `perps_account`, with
handoff ID, binding ID, canonical coin, exchange time, observed price/quantity,
master/agent/network and wallet generation. The bridge validates complete
identity and requires recorded markers to remain unchanged. Missing/malformed
ownership is never reinterpreted as a fresh empty account.

Before consuming a handoff, the bridge recovers queued/uncertain original
execution IDs through read-only `perps_execution_lookup`. Only explicit
`found:false` proves absence; unknown/old-Core failures retain the original ID.
Core task enum 6 (superseded) is terminal only with both settlement flags false;
7 (reconcile-only) remains unresolved. Known task IDs cannot disappear or change.
All verified copy fills are imported before transferring virtual ownership.

The transfer journal closes copy lots at the observed price without inventing a
venue fill/fee, and carries their exact net size/basis into `manual_ledger`.
Subsequent eligible manual fills, fees and funding stay in that ledger. Funding
uses historical ownership checkpoints, including the handoff. Ambiguous equal-time
events, unseen late copy history and unexplained deltas fail closed.
Copy+manual quantities and unrounded PnL must conserve the actual account after
real external flows. Only copy returns drive portfolio/sleeve performance and
copy loss controls. A coexistence account with unknown cash attribution cannot
start a new target; durable reconciliation continues on existing execution IDs.

A handed-over key is persistently excluded from source intents, Fixed targets
and submission. Its real source cursor still advances. Manual orders require
an exact earlier handoff and a valid nonfuture timestamp; unknown orders keep
the old conservative barriers. Closing copying can leave verified manual
positions/orders; copy cancellation/exit never claims them.

## Compatibility and rollout

This rollout permits native Perps handoff only. Shared Agent foreign DEX/RWA
handoff is rejected by Core/API: there is no immutable initial-scope cash baseline
to prove an arbitrary new DEX belongs in initial equity. Existing Unified/RWA,
full history, freshness, risk and external Strategy restrictions remain.
The first handoff conservatively requires the market's prior orders and all
uncertain strategy execution/settlement to finish; no forced cancel is performed.

Install Core's additive SQL explicitly, then deploy both Core roles. Deploy this
handoff-aware bridge/backend and the private Core API before the public API can
create a first marker. Old Core/schema fails closed. Reverting the reader after
manual activity can halt monitoring, so keep the journal-aware reader and DB
guards during rollback; never delete ownership evidence to resume copying.
No financial execution gate, epoch, existing proposal or user setting is changed
by delivery. No real order, transfer, signature or activation was used in tests.

## Local evidence

On 2026-10-30: 902 tests passed with a new isolated loopback PostgreSQL database,
0 failed/0 skipped; 53 functional journeys passed using simulated Core/venue
responses. Typecheck, build and package verification passed (104 packaged files,
private history absent). Fifty-three new cases cover journal/Bridge/real Runner
behavior, source advancement, funding/fees/flip, mixed Prediction+Perps,
original-ID recovery, restart, closing, malformed history and cash failure gating.
Production deployment and original-account acceptance must be recorded separately.
