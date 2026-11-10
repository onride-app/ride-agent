# Readonly account, source and history resource progress

This R52 candidate changes the private `audit_source` operational window. Deployment and natural account acceptance remain separate release gates. It does not authorize financial execution or change provider/IP quotas, risk rules or evidence freshness.

## Independent pools

The single physical parent reserves three disjoint amounts:

- **A**: one complete account observation. Only this child claims/completes its existing durable generation and learns the account cost plan W.
- **S**: independent source capacity, initially120. It covers actual selected-source work, including authoritative RWA mode/taxonomy/scope reads. It does not consume A's unused amount or Fixed history capacity.
- **H**: initially240 for each distinct selected Fixed source. Only the existing guarded `userFillsByTime` history operation may use it. Each dispatch still reserves its entire conservative120, with real response settlement.

A warm W184 window with one Fixed source books184+120+240=544. A cold full-demand hint remains1000; its explicit account trial is `min(780, 900-S-sum(H))`, at least120. The initial one-Fixed cold trial is therefore A540/S120/H240, outer900, still `cold_trial` and not a promise of completeness. The account must finish every existing read before a complete result or cost hint can be published.

The total is always bounded by the unchanged Core900 and Node1000 gates. A known warm W is never shortened to fit. A total above capacity, or a cold residual below120, is unsupported/fail closed before booking. A/S/H cannot borrow one another's credit. Unused A may remain booked until the parent ends; it is not a source or history allowance.

## Bounded operational growth

Only an owned local child reaching its actual capacity boundary can record a larger reservation requirement. The requirement is previous real committed weight plus the next full conservative request reservation, across all children using that same S pool or that same source's H pool. The current physical parent and its meter never grow. A subsequent fresh episode may book the larger requirement if the entire total still fits.

These are resource hints, not source snapshots, successful-completeness claims or financial proofs. They contain only an opaque stable window binding, weights and age; they do not accept remote `error.details` as authority. Generated plan snapshots are frozen and branded by their originating Budget instance. A stale or foreign plan cannot admit a new local bundle.

Hints have an original ten-minute lifetime, with no renewal from peeking, and are bounded to512 bindings and eight history entries per binding. They never replace the A cost plan. Actual paid charges, uncertain holds and excess debt retain their original accounting and rolling expiry even when a child fails or closes. A lost/closed child cannot publish a new resource hint from a late result.

## Complete history remains mandatory

The existing inclusive cursor, fixed end timestamp, conflict checks,500-element/block continuation, page limit, source-position continuity and complete-history requirement remain enforced. H240 can fund a500-row page (actual45) and a final empty page (actual20), or a2000-row page (actual120) and its empty tail. Every page independently needs120 before dispatch.

Two full2000-row responses consume240. If another page is required, the current attempt fails before dispatch; a private hint can request H360 for a later episode. No partial result, truncated fill list or provisional cursor is reused. The next episode starts from the original cursor and obtains the complete range again, with fresh current evidence. Only the original Runner strategy can advance the durable cursor after all original guards succeed.

Arbitrarily large histories are not guaranteed to fit. A learned requirement exceeding the physical total remains unsupported/fail closed. This change neither expands the upstream history-retention horizon nor treats an unavailable old range as complete.

## Time, scope and diagnostics

The FIRST granted parent lease continues to bound all work to its original20seconds; each wire remains at most12seconds and within the original parent/caller cutoff. Source and every source position must still be at most5seconds old at use, and account evidence at most30seconds old. Waiting, growth, pagination, cache hits and completed reads do not renew or relabel those timestamps.

Capacity diagnostics retain their existing code, `READ_FRAME_CAPACITY` reason, retry and status. The authenticated managed channel may additionally carry only `read_stage` (`account`, `source`, `history`), `requested_weight` and `remaining_weight`. Public errors and public portfolio/update projections omit these new counters, preserving their previous shapes. Durable internal diagnostics remain available. These counters never establish financial acceptance, absence, retry authority or retirement.

The default `audit_submit` contract retains its existing paired scopes and A-unused source behavior. Financial Fixed pairing remains unsupported. Readonly capabilities still reject preparation, binding and new submission; original outboxed/uncertain recovery and owned risk controls retain their existing identities and rules.
