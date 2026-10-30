# Native Unified account evidence and source budget turnover

The bound, native-only Unified portfolio path discovers the complete market list before financial reads. One new WebSocket session requests explicit `dex: ""` native state/orders and both channels for every foreign DEX. Spot USDC and mids remain independently metered REST reads. All selected native financial responses finish before the unchanged full-history start/end fence. Account mode, DEX abstraction, complete foreign scope, orders, positions, coverage and reconciliation checks remain mandatory.

Native WebSocket orders replace `frontendOpenOrders` only for an explicit complete empty array. Nonempty native orders, incomplete batches or missing/invalid dispatch evidence discard the entire batch and retain native plus every foreign REST state/order read. They do not open a second late financial session or reuse another account frame. Standard, unbound, new-account and explicitly foreign-asset paths retain their existing transport rules.

Each financial channel carries its actual subscribe-dispatch timestamp. The account observation retains the earliest original REST/native evidence. Finite native numeric zero is accepted only as an explicitly present value and converted to its decimal string representation. Missing, null, boolean, empty or invalid balances cause complete REST fallback; no zero default is manufactured. Unified equity still comes from the observed spot USDC balance.

Complete bounded fill history precedes funding and ledger reads. Every original page, event, scope and shared frozen history fence remains present. This reduces overlap between the bounded response reservation and other histories' already charged fees. Incomplete coverage remains incomplete; required read failures cannot publish complete financial evidence.

## Independent control after history

At the original posthistory control point, a second new WebSocket session may prove explicitly disabled DEX abstraction from `webData3.userState`. The user must match the original master, the flag must be literal `false`, and the original server time must be a positive safe integer, nonfuture and at most five seconds old. It must also be no earlier than the instant every complete history read returned, recorded as `historyCompletedAt`. The earlier frozen history request end is not sufficient.

A same-user, explicitly false snapshot older than that completion boundary may be ignored while waiting within the same original three-second session deadline. No reconnect, time relabel or deadline reset occurs. True, missing, invalid or unavailable evidence retains the original REST control gate. CoreBridge independently checks the boundary even if an older helper ignores its minimum-time argument. The snapshot keeps original control dispatch/server time in its minimum evidence time; account mode still receives its original REST checks before and after the observation, and worker checks remain unchanged.

Both connections share the existing two-active, twenty-attempts/minute, eight-user and message bounds. Failures and REST fallback retain their connection attempt charges.

## Metered turnover headroom

The weighted budget preserves the original 1000-per-minute ledger, FIFO account admission, full learned frame reservation, twenty-weight margin, source share/loan policy, response costs and unknown-charge retention. Only launch pacing may add soft spacing.

A metering scope returning normally is a cost observation, not financial coverage or reconciliation acceptance. New cost learning requires known settled tickets. Unknown charges, zero-cost Core `no_upstream` reads, unsent releases, swallowed admission/owner-limit/cancellation/rate-limit rejections and unresolved queued work disqualify that new sample. The existing planning peak continues to determine full admission demand. A separate admitted measured peak records only actual ticket allocation, using the existing measured base for unbounded response holds rather than calling their exclusive free-budget reservation a measured fee.

Extra spacing applies only when a recent qualifying same-frame observation proves both that its admitted measured peak exceeded its final paid ledger cost and that a real source bounded hold is larger than that same frame's paid cost. Without other available capacity, expiry of one such cheap frame may be insufficient to replace one full source hold. A larger paid frame keeps the original pacing policy.

The account turnover difference uses that same frame's learned full admission demand minus its paid cost. It never combines different owners' maxima and minima. The source bound comes from a real sent, positive-cost source charge and expires according to that original charge's sixty-second clock. Cache hits, unsent cancellation and proven zero-upstream Core hops create no source pressure sample. Actual fee settlement remains authoritative: a real 380-row response costs 39 after parsing, while a sent unknown retains its full 120 bound.

The proposed allowance is the original eighty-percent account pacing allowance minus those two turnover amounts. If it is nonpositive, or would introduce spacing beyond the greater of the original spacing and the real sixty-second window, the original policy applies. Hard admission remains authoritative. Existing scheduled spacing retains its original `Math.max` behavior: sample expiry changes later calculations, without claiming to shorten a previously scheduled interval immediately.

A bounded source row read still reserves one second of its unchanged twelve-second operation deadline for wire work. A late admission ticket is released before HTTP dispatch. That queue timer is cleared after admission; real sent timeouts remain fully charged as unknown.

## Validation boundary

The unchanged six-source load uses the original full fixed-history range, 380 response rows and a fifteen-second attempt grid. With simulated 500ms REST latency, the candidate reached account ages 27.900/28.878 seconds, twenty successful fixed-history reads, four complete steady minutes with four such reads each, all six sources progressing and a maximum 840-weight actual rolling provider window. The 300ms case reached 27.100/27.306 seconds and a maximum 867-weight window. Original runner workload and strict freshness assertions remain intact; the original two-source ten-DEX workload now explicitly requires a fresh financial session and a separate posthistory control session per frame.

These are local transport/load results. They do not establish a general latency guarantee, real provider utilization or natural financial acceptance. Production still needs the original account window, actual source consumption, publication/audit freshness and complete active budget windows.

Failed forecast-loan, unconditional padding, prefix/tail cache and early-control alternatives remain in the external evidence directory. Native WS spot/mids replacement and WS Info-post quota exemptions were not adopted. Existing full-history rereads and cursor commit rules remain intact. No history cache, forced cursor advancement, quota increase, risk relaxation, App release or npm release is included.

Protocol references: [WebSocket subscriptions](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions), [Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint), [rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).
