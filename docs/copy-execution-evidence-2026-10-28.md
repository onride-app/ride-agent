# Copy execution evidence recovery

An initial entry rejected by the entry-deviation rule can leave a theoretical
Fixed target in `fixed_targets` and `source_quantities`, while the asset remains
suppressed and never receives an intent, lot or execution. If that source
position later disappears, treating the shadow as an owned follower position
requires closing fills for a trade the follower never admitted. The exception
aborts planning for the entire basket.

The runner now retires this shadow only after a fresh complete source snapshot
shows the asset absent and its source-fill history window reports complete.
The asset must still be suppressed, with no intent or lot object, no receipt,
no admitted decision, and no execution allocation or unfilled allocation for
that sleeve/asset in any status. Even a zero-valued historical lot or allocation
prevents this exception. The change records no follower close or fill, preserves
other active suppressions, and leaves the existing basket risk and funding
checks in place. Sources, amounts, controls and history are not replaced.

Additional recovery corrections:

- A fresh observation can retain the same structural source revision while an
  old intent timestamp expires. Before a new outbox entry, the bridge now proves
  the equivalent current source position using fresh complete source evidence.
  The original target quantity and frozen 0.2% reference price remain unchanged;
  account ownership, collateral, order minimum and leverage checks still apply.
- Reusing an already verified Fixed snapshot does not query an empty fill-time
  window. Backwards time or a different revision at the same timestamp still
  fails closed. A newer observation still needs complete fill evidence.
- An expired target cannot create a new outbox entry. An uncertain target is
  expired only after reconciliation returns a definite failed result; unknown
  acceptance remains unresolved. Existing outbox retries retain the same
  execution identifier, payload, expiry and policy revision, including accepted
  orders whose response was lost.
- Completed executions retain their first `unfilled_allocations` record on
  later monitor ticks instead of overwriting historical attribution with `{}`.

Source fill counts are observations, not executable-order counts. Existing entry
suppression or risk rules can legitimately leave a portfolio with zero fills.
Tests therefore distinguish retiring an unused shadow from admitting a future
independently verified target; they do not turn historical source fills into
follower orders.

Validation uses anonymous synthetic fixtures only. Full test suite: 518 passed,
2 optional PostgreSQL tests skipped. TypeScript checking and build also pass.
No original portfolio was executed, no transaction was signed or submitted, and
no App release is part of this change.

Limitations: `VenueReads` keeps its existing bounded lanes and shared 429
cooldown; this change does not implement a fleet-wide Hyperliquid IP-weight
budget. An expired outbox whose Core acceptance cannot be established remains
unresolved rather than being replaced under a new identifier.
