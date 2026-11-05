# Independent Prediction inventory proof

This is a manual, bounded, read-only proof producer/reader. It repairs the missing
acquisition and resume path for independent outcome-token inventory. It does not
restore complete Prediction NAV, historical accounting, source sizing, binding,
or trading. No Agent, backend, bridge, monitor or migration starts it automatically.

## Scope and upstream evidence

The [official onchain guide](https://docs.polymarket.com/resources/onchain-position-data)
states that outcome balances live in two ERC-1155 ledgers. The
[official contract registry](https://docs.polymarket.com/resources/contracts)
identifies Polygon chain 137 Conditional Tokens
`0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` and the PositionManager proxy
`0x006F54F7f9A22e0000CC2AB60031000000ae9fEF`. Both were checked in the public
documentation on 2026-11-06. Module addresses do not replace the PositionManager
balance ledger. The producer checks code at both addresses at its target block.
This is a dated published-position-ledger scope, not an assertion that every
wallet asset, collateral balance, reserve, bridge, or future contract is covered.

The [Data API migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2)
retired the accounting snapshot without an equivalent export. A terminal v2
positions cursor still covers servable markets only. Neither those rows, known
execution/receipt IDs nor the local owned ledger can seed full token enumeration.

Adjacent `polymarket-rindexer` contains reusable ERC-1155 decoding and raw log
storage, but its current p0/p1 profiles omit TransferSingle/TransferBatch inventory
coverage. Its checkpoint stores a last block/object/count, without origin,
continuous interval manifest, filtering scope or canonical block hash. Current
cloud coverage is unverified. Such checkpoints cannot be imported as proof here.

## Acquisition and validation

The owner is bound to every checkpoint, query and balance call. A scan starts at
block **0** for each of the two fixed ledgers; no guessed deployment block is used.
The target is a fixed `finalized` block, also at least 128 blocks behind the head.
Missing finality/EIP-1898/archive support fails closed. Each advance performs only
one contiguous range or one balance batch. Incoming and outgoing queries include
both TransferSingle and TransferBatch; mint, burn and self-transfers are handled.
Both query halves must succeed before coverage moves. Returned logs must match
the ledger, owner topic, range, canonical block hash and event shape; conflicting
duplicates and removed logs are rejected. The relevant block headers and range
end are checked before advancing. Target/previous coverage anchors are rechecked
on each advance/read. A reorg preserves the old checkpoint and refuses it; create
a separate new proof path after diagnosing the provider/chain, keeping old evidence.

The RPC provider is a trust boundary. The operator must explicitly review and
configure `InventoryProviderPolicy` with a non-secret provider/plan ID, documentation
URL without credentials/query parameters, `get_logs_semantics: "complete_or_error"`,
`historical_logs: "genesis_to_finalized_complete_or_error"`, EIP-1898 support, a
conservative maximum logs per response and maximum block range. This asserts that
successful queries are complete over the requested historical range; paginated,
pruned, silently truncated or index-lagging success responses are unsuitable.
The reader cannot detect a provider that violates that contract below its declared
cap. Do not point a policy reviewed for one provider/plan at another endpoint.
Changing the policy invalidates old checkpoints instead of silently reusing them.

For example, [Alchemy's current Polygon reference](https://www.alchemy.com/docs/chains/polygon-pos/polygon-po-s-api-endpoints/eth-get-logs)
documents plan-dependent ranges and response limits. This repository does not infer
the operator's plan, archival retention or credentials from that public page.
No production provider policy is shipped or enabled.

At or above the configured log cap, the range shrinks without advancing or keeping
IDs from that response. Dense windows that would exhaust header-verification RPC
budget also shrink before advancing. A capped single block remains blocked. Other
RPC/timeout/response-cap failures roll back the transaction; the explicit `narrow`
command reduces the future range without changing coverage. No error text is
treated as proof that a partial response was complete.

Every enumerated token, including zero-balance tokens, is then checked with
`balanceOfBatch` at exactly the target block hash using
[`requireCanonical: true`](https://eips.ethereum.org/EIPS/eip-1898).
The proof becomes consumable only when both origin-to-target ranges and all balance
batches are complete. A later advance from a complete checkpoint extends both
ranges to a new finalized target and clears/rechecks **all** balances. A read
revalidates chain/canonicality and requires a target no older than 600 seconds
(the caller may choose a stricter limit). This proof age limit is independent of,
and does not relax, any production source/account freshness requirement.

Default per-invocation bounds are 40 RPC requests, 25 seconds, one window/batch,
20,000 token IDs per ledger, 50 balances per batch and 8 MiB per HTTP response.
Response-limit, token-limit or duration failures never advance coverage. A single
window too dense for the provider/budget cannot be called complete.

## Durable storage and trust

The local checkpoint is an HMAC-authenticated envelope; its separate random key and
checkpoint files must be owner-only 0600 regular files. Never commit or print either.
The key is a local integrity credential, **not** a wallet/signing key. Arbitrary JSON
or a third-party `complete` flag cannot be consumed as a trusted producer checkpoint.
Only this trusted producer/storage process and its operator may hold the key. A
compromised operator/provider is outside this local integrity guarantee; it is not
a cryptographic Ethereum receipt proof or a trustless inventory proof.

Exclusive local lock, content-and-revision compare-and-swap, file fsync, atomic
rename and directory fsync protect resume/concurrent writers. Writes exceeding the
16 MiB read cap are rejected before replacing the previous checkpoint. A crash can
leave a lock/temp file; no automatic timeout removes a lock held by another process.
An operator must first verify that no producer is running before moving a stale
lock aside. These semantics require a local filesystem, not a shared/network mount.
Preserve the checkpoint **and** separate key together in protected backups.

## Manual operation

Build with `npm run build`. Configure these variables through a trusted local
environment; keep the owner, endpoint and checkpoint contents out of shell history,
logs and Git:

- `RIDE_PREDICTION_INVENTORY_PROOF_ENABLED=true` (default false).
- `RIDE_PREDICTION_INVENTORY_RPC_URL`: dedicated Polygon archive RPC with an
  independently reviewed request budget; there is no shared production RPC fallback.
- `RIDE_PREDICTION_INVENTORY_OWNER`: the exact wallet to prove.
- `RIDE_PREDICTION_INVENTORY_CHECKPOINT`: absolute private local path outside Git.
- `RIDE_PREDICTION_INVENTORY_PROVIDER_POLICY`: local JSON path containing the
  reviewed `InventoryProviderPolicy` fields described above.

`npm run inventory:prediction -- advance` creates or advances one bounded step.
Repeat under an operator-approved total RPC/cost budget, rather than an unbounded
loop. `... -- narrow` reduces a blocked range without a network request or coverage
change. `... -- read` validates an existing proof. Output contains progress/counts
and fixed error codes, never owner IDs, token holdings, RPC URLs or secret errors.
Advance reports `inventory_scan_complete`; a separate successful read is required
for freshness/canonicality. Programmatic consumers use
`PredictionInventoryReader.read(owner)` with the trusted store and provider policy.

Historical work is proportional to both full chain ranges, even for an empty
wallet: at least `2 * ceil((target + 1) / window_span)` range steps plus balance
batches, with two log queries and several canonicality checks per range. This
change does not run a natural backfill or claim a real account proof. No live
producer, daemon, cloud storage or fee-generating resource was created.

## Remaining restoration work

The reader returns `inventory_complete: true` only for the named ledgers at the
named block, with `valuation_complete: false` and
`prediction_execution_ready: false`. A full token list is not a NAV. Each held
token still needs complete authoritative metadata, ledger/module identity,
onchain resolution/payout validation or a verified mark, plus collateral and
reserve accounting at a coherent time. Any missing v2 token reference remains
unknown; it is never assigned price zero. Historical PnL also needs complete
movements and independently verified accounting anchors.

Consequently this command is intentionally not wired into production
`PredictionVenue.source`, new account binds/claims, execution settlement or the
historical accounting-anchor callback. Existing RPC/receipt reads remain intact.
Those guards stay closed until complete fresh proof **and** independently complete
valuation/accounting coverage are available; this commit is not trading acceptance.

Connection/account acceptance is separate from this component's tests. Any
account-specific diagnostics stay in private workspace evidence, not this repo.
