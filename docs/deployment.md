# Deploying Rider

## Hosted App-owned runtime

The reviewed live module is Node `18826aa6945239205a29bf6df6bccc7c4534b828`; the App integration/streaming source is `4ffc2965575d9c23a2812f0f8425f990c16a7d62`. Production completion is recorded only in [status](status.md) after actual cutover evidence. Client installation, package publication, source merge, image build and production activation are separate.

Hosted routing is `mcp.onride.me` gateway → App public API `89a5768e…` → App private API `ae126414…` → one loopback Node business module. The gateway uses `RIDE_AGENT_BACKEND_URL`, `RIDE_AGENT_APP_SESSION_URL` and the dedicated `RIDE_AGENT_APP_SESSION_TOKEN`; it does not receive direct Agent PG/Redis credentials. Issuer, redirects, user JWTs, human-cookie/cursor keys and trader-ID salt retain their existing values. Backend identity uses the original public `RIDE_GRAPHQL_URL`; the internal-only private API does not expose GraphQL.

The private owner requires the three explicit `RIDE_AGENT_APP_RUNTIME_ENABLED=true`, `RIDE_AGENT_INTERNAL_ONLY=true` and `RIDE_AGENT_ENABLED=true` gates. Optional App session RPC requires its separate explicit gate and App Redis credentials. Node listeners stay on `127.0.0.1:3344/3355/3366` regardless of public `HOST/PORT`. Agent state/outbox/history live in the App cluster's independent `ride_agent_app` database under the dedicated runtime role; Core's database and workers retain their roles.

Use the App repository's [versioned build/lifecycle contract](https://github.com/onride-app/predictly_server/blob/edf2eb19ea55106b517ac31cbe80a19db34d93b5/deploy/agent-runtime/README.md) and [full migration/backup/reverse-restore runbook](https://github.com/onride-app/predictly_server/blob/edf2eb19ea55106b517ac31cbe80a19db34d93b5/scripts/ride-agent-migration/README.md). The owner Git/autodeploy trigger stays disabled. Each owner update is controlled stop → backend/bridge/session drain → monitor process gone and PG lock released → start reviewed owner; use 60-second Railway draining to contain the Node45/Rust47-second boundaries. First cutover must stop old standalone writers too, since they do not implement the new lock. Old services stop with rollback volumes retained; do not start an old `8b906c4` binary against stripped hot JSON.

Tool/Human replies stream with backpressure; the request slot remains held until EOF/drop, without the previous 4MB history-response rejection. Session RPC remains bounded and separately authenticated. No proxy supplies human approval, retries a financial POST or bypasses Core ownership/epoch/market/read-only checks.

Preserve the original complete `RIDE_AGENT_CORE_URL`: its origin/path participate in `CoreBridge.perpsCostOwner`. Do not replace it with a loopback Core URL. Only backend→bridge uses in-process `127.0.0.1:3355`. Rust business relay keeps a 130-second deadline for the existing 120-second human funding boundary; malformed/unavailable replies preserve unknown-result/status-first behavior instead of replaying the request.

## Performance-history codec upgrade

Node `18826aa6945239205a29bf6df6bccc7c4534b828` / archive `36b7dd7309957d27d097147cf5a89d5022cbd48e266e7eaaf0f86c5aed8d789a` is live on the verified owner deployment `cae47a83-d72d-4b3c-898e-9f58e1113e69`; all 82 compiled module files, package lock, Node22.23.4, fixed API4ffc/8b identity, gates and loopback health/readiness match the reviewed build. See [bounded production evidence](status.md). The three-table codec retains every original point, owner-wide ordinal and full report/coverage behavior. It migrates on an owner's next transaction rather than forcing inactive accounts through an operation.

Rollback must use the latest complete reverse snapshot and a performance-aware binary. `dd6dacd` / `0e13ef3` understand earlier updates/decisions tables but cannot read the stripped performance state. Keep all new tables and post-upgrade writes; never regenerate unknown execution IDs.

## Standalone/self-hosted compatibility

## Gateway

- `PUBLIC_BASE_URL`: HTTPS OAuth issuer, for example `https://mcp.onride.me`.
- `RIDE_GRAPHQL_URL`: Ride Core GraphQL endpoint for authenticated login and identity.
- `PRIVY_APP_ID`, optional `PRIVY_CLIENT_ID`: approved Privy application.
- `REDIS_URL`: direct durable OAuth store for standalone hosting. App-owned production uses `RIDE_AGENT_APP_SESSION_URL` + `RIDE_AGENT_APP_SESSION_TOKEN` instead and does not pass Redis credentials to the gateway.
- `RIDE_AGENT_BACKEND_URL`: private control service URL.
- `RIDE_AGENT_HUMAN_COOKIE_KEY`: at least 32-byte independent cookie encryption secret.
- `RIDE_PUBLIC_SUBMISSION_MODE=true`: eight read tools, no machine write or browser confirmation routes.
  Read-only CLI query routes remain available. Trading requests return `READ_ONLY`.

The native App sends its existing Core JWT directly to `/agent/human/*`. OAuth machine tokens cannot confirm, authorize or revoke. The browser human surface signs in through Privy and uses encrypted, HttpOnly, SameSite cookies plus origin checks.

## Agent service

- `RIDE_AGENT_DATABASE_URL`: separate Agent PostgreSQL database.
- `RIDE_AGENT_CURSOR_KEY`: at least 32 characters for user-bound update cursors.
- `RIDE_GRAPHQL_URL`: authenticated Core identity validation.
- `RIDE_AGENT_EXECUTOR_URL`, `RIDE_AGENT_EXECUTOR_TOKEN`: private bridge URL and service token.
- `RIDE_AGENT_PRIVATE_HTTP_HOST`: optional exact bridge hostname ending in `.railway.internal` when using Railway's encrypted private network over HTTP. Public executor connections require HTTPS.
- `PUBLIC_BASE_URL`: matching Ride human review base.
- `RIDE_AGENT_ENABLED=true`: explicit service activation.
- `RIDE_AGENT_READ_ONLY=true`: reject backend machine writes and human confirmation/grant operations; suspend the background trading monitor. Pair with the gateway read-only flag for initial production rollout.

State and ledger records persist in PostgreSQL; each user transition locks its row and rolls back failed confirmation. The monitor starts with the service and polls independently of MCP clients. Keep one monitor per Agent database. The App-owned runtime now holds a dedicated PG session lease; standalone binaries do not implement that protocol and must never overlap the managed owner.

## Private execution bridge and Core

- `RIDE_AGENT_CORE_URL`: private Core base URL with `/internal/agent-core/:operation`.
- `RIDE_AGENT_CORE_SERVICE_TOKEN`: Core S2S token, at least 32 characters.
- `RIDE_AGENT_DATABASE_URL`: Agent database for stable outbox and opaque outcome metadata.
- `RIDE_AGENT_TRADER_ID_SALT`: stable, private trader-ID salt; changing it invalidates old public IDs.
- `RIDE_AGENT_EXECUTOR_TOKEN`: separate token used by the Agent service.
- `RIDE_AGENT_NETWORK=testnet|mainnet`: Perps execution network; default testnet.
- `RIDE_AGENT_UNIFIED_ENABLED=true`: opt in to core/USDC unified accounts on the independent bridge and Strategy worker. Default off. The worker additionally requires Agent V3 metadata; legacy Strategy validation remains Standard-only. Unified USDC is read once from spot state, subtracts verified holds for available margin, and rejects other DEX exposure/orders. Portfolio margin and unified RWA execution remain unsupported. This flag does not change the user's account mode or transfer funds.
- `RIDE_AGENT_PREDICTION_ENABLED=true` plus `RIDE_AGENT_POLYGON_RPC_URL`: explicit prediction activation on Polygon. Prediction has no paper-trading mode in this integration.
- `FCM_SERVICE_ACCOUNT_JSON_BASE64`: reuse the existing Ride Firebase service account on `agent-bridge` only. Legacy raw `FIREBASE_SERVICE_ACCOUNT_JSON` / `FCM_SERVICE_ACCOUNT_JSON` remains supported. Never ship service-account credentials to clients.
- `RIDE_AGENT_FCM_PROJECT_ID`: optional expected Firebase project; a mismatch fails closed. Existing Ride production uses `ride-fiamma`.

## App daily-report links (0.3.1)

FCM data preserves `type=ride_agent` and includes `event_id`, `event_kind` and, when present, `portfolio_id`. New App builds route a validated event ID to `/agent/reports/:eventId`; existing notification types retain their routes. The page reads `POST /agent/human/update` with `{ "event_id": "update_..." }` using the existing Core bearer session. OAuth MCP tokens cannot read this native endpoint. Missing and foreign reports both return 404. Reports preserve their generated snapshot, including incomplete coverage and null profit; they do not change a portfolio.

Keep financial Core/worker authority and the Firebase credential source unchanged. In hosted deployment, bridge/backend are one frozen App-owned module; verify that owner before routing the gateway. The separate bridge→backend→gateway deployment order applies to standalone compatibility. Verify each terminal deployment and the gateway release independently. A Firebase API acceptance is provider acceptance; simulator injection verifies navigation, and neither establishes physical-device delivery.

Core requires `RIDE_AGENT_CORE_ENABLED=true`, the same Core S2S token, and explicit `RIDE_AGENT_PREDICTION_ENABLED=true` for prediction execution. Set `RIDE_AGENT_NETWORK` consistently in Core and bridge; mainnet also requires Core `RIDE_AGENT_MAINNET_ENABLED=true`. The API and gRPC execution gateway must share their existing `STRATEGY_CONTROL_PLANE_SERVICE_TOKEN`; this is separate from the Node-to-Core token. Existing mainnet execution epoch controls continue to apply. Signing remains in existing workers. Apply all three additive migrations from the private implementation: execution mode/quantity, prediction ownership, and archived account reuse. Legacy mode retains its original policy caps.

Perps account preparation and prediction wallet funding occur through Ride. A combined portfolio checks each market's funds independently and performs no implicit bridge/transfer. Core ownership blocks conflicting legacy writers while Agent owns the account. Release requires complete position and pending-order reconciliation.

Initial production query deployments must also set `RIDE_AGENT_READ_ONLY=true` in Core, with mainnet and prediction execution disabled. The private Core read-only allowlist rejects account and order mutations even with a valid service token.

## Acceptance before activation

Validate OAuth from each supported host, native App proposal hash/owner/revision checks, dedicated account conflicts, unknown-submit restart recovery, partial fill and zero-fill cancellation, real funding/fee reconciliation, hedge removal and gap exits, notification delivery and rollback. Offline test success does not establish venue or deployed App acceptance. Preserve attention states for unresolved prediction redemption, ambiguous receipts and venue dust.
