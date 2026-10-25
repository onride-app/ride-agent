# Connection failure diagnostics

The October 26 follow-up did not reproduce the historical host transport failure: eight authenticated CLI reads and three MCP reads succeeded. CLI reads took 3.4–21.2 seconds. These samples do not prove the earlier incident's cause or that it cannot recur.

## Recovery behavior

- Explicitly allowlisted reads retry once for recognized socket/DNS/connect errors before response headers arrive, within the original 25-second deadline.
- HTTP errors, response-body failures, certificate failures and expired deadlines are not automatically retried.
- Recommendations retain PREVIEW_RESULT_UNKNOWN and saved-plan recovery.
- Other state changes and proposal operations return REQUEST_RESULT_UNKNOWN with retryable=false on an ambiguous transport failure. Query existing state before deciding what to do next; do not submit again automatically.
- This handles Ride's own outgoing requests. A client-to-gateway TLS/DNS failure occurs outside this code and cannot be repaired by a server-side retry.

## Evidence to collect

Gateway and backend emit ride_request_started / ride_request_finished with a generated request ID, route category, elapsed time, HTTP status and completed/disconnected outcome. Responses carry X-Ride-Request-Id. An agent_connection_failure includes the current local request ID, operation, connection/response_body stage and a fixed reason code. Logs intentionally omit tokens, OAuth codes, raw URLs, bodies, account IDs and upstream error text.

1. Record the failed client's timestamp and whether it received an HTTP response.
2. Compare Railway edge HTTP logs with gateway start/finish records. Absence in a limited log window is not proof the request never arrived.
3. A start without finish across a deployment suggests process interruption; a disconnected outcome shows the response connection closed before completion, not necessarily which peer caused it.
4. Match local request IDs to outgoing failure events. Compare backend timing to separate slow identity/source reads from client disconnects. Gateway and backend IDs are independent.
5. Never treat HTTP 200 alone as tool success: inspect the structured tool status/error and saved plan.

## Automated new-user coverage

src/cli/oauth-flow.test.ts starts with an isolated credential directory and empty Agent repository. It exercises SDK client registration, PKCE, rejected callback state, code exchange, authenticated HTTP gateway/backend calls, missing budget/risk questions, partial answers, recommendation/comparison alignment, zero execution and token refresh.

External Google/Privy identity, Core user creation and venue data are fixtures. This does not replace testing a genuinely new Google account, access-code acceptance, browser wallet creation or first-user registration in production. The user deferred that live test.
