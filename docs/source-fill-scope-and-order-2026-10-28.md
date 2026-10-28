# Fixed source history: observed market scope and same-time ordering

A read-only investigation after the earlier evidence-recovery deployment found
two additional causes of `SOURCE_FILL_EVIDENCE_MISSING`. A native-Perps source
snapshot was paired with a mixed-market history containing eight HIP3 fills
outside the observed source scope. All eight fills shared a millisecond. The
runner sorted those fills by opaque hashed IDs, producing a non-flat terminal
position although their position transitions form a unique chain ending flat.
The failed trial left the entire basket waiting for source evidence.

## Scope evidence

- Source snapshots now declare `perps_dexes`; the empty string denotes native
  Perps. HIP3 scopes are added only when the existing RWA switch, source category,
  taxonomy and successful USDC clearinghouse reads already permit them. Nonzero
  source positions outside the declared scopes fail closed.
- `source_fills` uses that fresh, complete source observation. Explicit official
  Spot identifiers (`PURR/USDC` and `@{index}`) and valid HIP3 identifiers outside
  the observed scopes are excluded. Unsupported or malformed identities and
  timestamps reject the evidence, including malformed rows outside the requested
  half-open `[start, end)` window. Current asset metadata is not a symbol
  allowlist: a closed or delisted native asset must retain its history.
- History completeness still comes from pagination over the full response. An
  empty result after scope filtering cannot turn incomplete history complete.
  Duplicate raw identities with conflicting content are rejected.

## Position-chain ordering

Fill IDs remain deduplication identities, not order evidence. For each asset, the
runner walks timestamp groups backwards from the current complete source
position. Within a group, exactly one remaining fill must end at each expected
quantity. Each preceding group must connect, and any stored prior source
quantity must match the reconstructed beginning. An untracked beginning is not
assumed to be zero. Missing starts, broken links, branches, cycles, conflicting
duplicates or mismatched endpoints fail before targets or cursors commit.

The proven chain is then applied in its chronological order using the existing
Fixed target calculation. This does not create one follower order per historic
fill. Existing suppression, ownership and closing-evidence guards remain in
place. In particular, removing foreign history cannot clear an already tracked
foreign target without the existing closing evidence.

## Validation and boundaries

Anonymous tests cover the eight-fill shape through the actual Bridge operation
and runner, unique supported-scope chains, identity permutations, mixed markets,
RWA flag/category/collateral combinations, incomplete coverage, malformed rows,
ambiguous chains and unchanged cursor/target behavior on failure. The private
original state was also exercised only against mock reads and submissions;
source cursor advancement produced zero executions, receipts or submissions.
Private portfolio data is not a test fixture in this repository.

Validation: `npm run check`, `npm run build` and the full suite passed (575
passed, two optional PostgreSQL tests skipped). Independent review reran 105
focused tests and the private original-case mock replay. The chain selector is
iterative, uses indexed endpoints and rejects ambiguity without searching fill
permutations; tests include 2,000 fills sharing one timestamp.

No portfolio configuration, funds, signing, historical replay, price-deviation
threshold or venue risk limit is changed. This patch does not extend supported
markets or resolve ambiguous histories. The conservative expired-outbox and
shared-admission limits documented in
[the earlier recovery note](copy-execution-evidence-2026-10-28.md) remain.
Local replay is not production acceptance; the original portfolio must be
checked read-only after deployment.

Protocol references: Hyperliquid's [Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
documents mixed Perps/Spot history and Spot coin identifiers;
[Asset IDs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids)
defines HIP3 names as `{dex}:{coin}`. Neither reference supplies a guarantee that
hashed IDs or trade IDs order fills within a millisecond.
