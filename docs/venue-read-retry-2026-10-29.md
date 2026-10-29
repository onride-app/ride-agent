# Venue read retry scheduling

The monitor used to store `retry_after_ms` from a venue budget rejection or HTTP 429, then restart the same full account observation on its regular five-second cycle. With many Perps DEX scopes, these premature attempts could spend remaining capacity on partial account reads and fail before collecting complete evidence.

The runner now honors a positive, bounded (at most 60 seconds) retry hint for retryable `VENUE_READ_BUDGET_EXHAUSTED` and `VENUE_RATE_LIMITED` observations. It reads the existing persisted error, so restarting the runner does not erase the wait. It preserves the error, last snapshot, intents, and source cursors while waiting. The separate phase for reconciling unknown submissions and delivering pending notifications still runs. When the delay expires, account and source evidence must be read and validated again before planning can resume.

Budget rejection advice now accounts for the full denied request reservation. The first small charge expiring is insufficient if the larger request still cannot fit. Response-contract quarantine also remains part of the retry time. The rolling weight cap, response surcharges, unknown-response debt, evidence freshness, supported scopes, transport deadlines, and risk settings are unchanged.

Validation on an isolated local PostgreSQL database:

- `npm run check` and `npm run build` passed.
- `npm test`: 621 passed, zero failed or skipped.
- `npm run verify:package` passed.
- `npm run test:functional`: 53 passed, zero failed. The journey uses local services and simulated Core/venue responses; it is not real customer trading acceptance.
- New regressions cover sufficient-weight retry advice, quarantine, restart-persistent waiting for both throttle codes, exact retry expiry, preservation of evidence and cursors, continued unknown-submission reconciliation and notifications, and rejection of invalid/unrelated retry hints.

This change requires an Agent backend/bridge release before it affects hosted monitoring. It does not establish continuous production scheduling or a successful customer order. A genuine asset concentration rejection remains a risk rejection; this fix does not change the approved portfolio to make it pass.
