# WebSocket timeout diagnostics

`venue_order_snapshots` adds six fixed fields. They contain no account, order,
balance, address, provider payload, or stable owner identifier.

| Field                                | Meaning                                                                                                                                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read_kind`                          | `orders`, `account`, or `abstraction`, selected from the existing collection mode.                                                                                                                                                                         |
| `socket_opened`                      | Whether this one-use socket reached its existing `open` callback.                                                                                                                                                                                          |
| `control_messages`                   | Number of parsed `webData3` messages received by an abstraction-only read, including messages that subsequently fail validation.                                                                                                                           |
| `stale_control_messages`             | Subset that passed every existing owner, explicit-false, shape, timestamp and dispatch check, but had `serverTime` before the required history-completion boundary.                                                                                        |
| `first_stale_control_after_start_ms` | Optional nonnegative safe integer, using the first valid-old message's existing receive clock minus the existing collection start. If that first difference is invalid, this field stays absent for the entire session; a later message cannot replace it. |
| `max_stale_control_fence_gap_ms`     | Optional positive safe integer, the maximum history boundary minus `serverTime` among valid-old messages.                                                                                                                                                  |

The two optional fields are emitted only when `stale_control_messages > 0` and
their values are valid. Missing values stay absent instead of becoming zero.
They reuse existing timestamps and add no clock reads. The first-message delay
includes handshake and delivery time; the fence gap is not an exact network
latency or proof of any owner's timeout cause.

`requested_scopes` remains the requested DEX count. A zero-scope abstraction read
can open and receive control messages; zero does not prove a failed handshake.
The counters distinguish an unopened socket, silence after opening, and valid
control messages that predate the required history fence. They do not identify
an owner or establish that an observed timeout caused any account's delay.

The original control wait, 3000 ms timeout, native and foreign scope validation,
REST fallback, provider credits, history fence and evidence timestamps remain
unchanged. The implementation adds no clock calls or business-return changes.
Reporting stays inside the existing isolated diagnostic `try`/`catch`.

This is diagnostic work. It does not repair or reclassify the failed natural
freshness windows, prove source consumption or execution, or include the rejected
early-control REST prototype. Historical parser versions remain sealed; a new
decoder and strict sanitizer must explicitly retain these six fields.
