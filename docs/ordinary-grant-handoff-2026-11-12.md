# Ordinary account grant handoff

This local candidate starts at Node main `ceb91aff1831c4a726c3816e34ab6bc12257cc69`.
It uses the existing server-owned `RIDE_AGENT_PREPARED_PROMOTION_V1_ENABLED`
gate and requires the validated V3 dual-egress configuration. The default-off
path keeps its existing admission and waiting behavior. No new wire fields,
provider budgets, soft pacing rates or financial permissions are introduced.

An ordinary complete account observation still polls its existing v1 Core FIFO
ticket before taking local observation interest. After a strictly verified
HTTP 200 grant, the enabled path makes one synchronous local booking attempt.
A privately branded local admission deferral ends this scope immediately and
schedules exact cleanup of its unused Core reservation. It does not wait out
the original 20-second caller window while holding unused Core capacity. The
original local error/retry reason is retained. No pre-Core skip is added: the
R60 case in which a skipped pending head blocks another frame stays on its
original poll path.

Only the exact lease object issued by this coordinator, with unchanged ID and
expiry and a live, nonpolling Frame, may opt into retained cleanup. A clone,
non-200 response, pending pin, expired/closed lease or any previous unverified
BEGIN response cannot opt in. BEGIN transport/JSON/abort uncertainty is sticky
for this Frame, even if a later poll receives a grant. Those uncertain cases
keep the earlier conservative behavior; this candidate does not claim all
ordinary post-grant waits disappear.

Retiring state is installed before removing the live Frame or sending END.
An unknown or timed-out END retains the original Frame, owner, UUID, weight,
mode and FIRST until a strict positive same-ID END acknowledgement. Only one
bounded local END attempt per Frame is tracked at a time. A timed-out remote
request may still complete; a retry remains idempotent on the same original ID.
Later calls confirm that exact END before any new BEGIN; neither active expiry
nor FIRST expiry means the reservation is closed.
After a positive END, the original episode is terminal. A subsequent normal
monitor call may begin an independent episode; it cannot resume the closed
ticket with a pending continuation. Live opted-in grants reserve cleanup slots,
bounded at 64 together with already-retiring frames. Default-off frame-table
admission keeps its existing 64-entry limit.

END releases only unused capacity. Paid and unknown read charges keep their
existing bank, fees, settlement and retention rules. Cleanup never declares
old paid/unknown work UNSENT. Ordinary A makes no Gateway binding/status request
and is independent of Gateway cold/availability; V2 remains opt-in separately.
Prepared parents, their two-child audit-submit books, fresh-submit permits and
`waitForFrameAdmission` financial paths retain their existing behavior.

The observed production snapshot was non-atomic: its first v1 learned-184
grant was already 5.978 seconds old at the snapshot start, and was later read
with zero charge and its full hold. This supports investigating unused-grant
waiting, not an atomic 14-second measurement or proof that this change alone
restores account freshness. Local tests, real Core-bank interoperability and
natural A/P/financial acceptance remain separate gates.
