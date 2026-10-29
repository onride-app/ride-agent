# 环境变量逐键目录

核对日期2026-10-29。扫描已跟踪的运行源码、启动/部署脚本、配置模板和CI；只记录键名、用途与读取来源，不复制任何实际值。标准平台/SDK隐式配置另列。动态未知provider配置仍须向owner确认。

| 变量 | 用途 | 保密类别 | 读取/配置来源 |
|---|---|---|---|
| `CODEX_HOME` | 安装器查找Codex配置/Skill根目录 | 配置/公开标识；URL含凭据时按秘密 | [src/cli/clients.ts:35](../src/cli/clients.ts#L35)、[src/cli/setup.ts:167](../src/cli/setup.ts#L167) |
| `FCM_SERVICE_ACCOUNT_JSON` | legacy raw FCM服务账号JSON，内含私钥 | 秘密/可能含凭据；实际值走受控渠道 | [src/agent/firebase.ts:16](../src/agent/firebase.ts#L16) |
| `FCM_SERVICE_ACCOUNT_JSON_BASE64` | 仅bridge使用的base64 Firebase服务账号JSON，内含私钥 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:26](../.env.example#L26)、[src/agent/firebase.ts:17](../src/agent/firebase.ts#L17) |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | legacy raw Firebase服务账号JSON，内含私钥 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:24](../.env.example#L24)、[src/agent/firebase.ts:15](../src/agent/firebase.ts#L15) |
| `GITHUB_REF` | 发布检查当前tag/ref，CI注入 | 配置/公开标识；URL含凭据时按秘密 | [scripts/verify-release.mjs:28](../scripts/verify-release.mjs#L28) |
| `GITHUB_REPOSITORY` | 发布仓库identity，CI注入 | 配置/公开标识；URL含凭据时按秘密 | [scripts/verify-release.mjs:26](../scripts/verify-release.mjs#L26) |
| `HOST` | HTTP监听地址；本地loopback/容器0.0.0.0 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:2](../.env.example#L2)、[railway.json:8](../railway.json#L8)、[src/agent/backend.ts:345](../src/agent/backend.ts#L345)（另2处） |
| `HTTP_TRUST_PROXY_HOPS` | 信任反向代理跳数；必须匹配实际ingress防IP spoof | 配置/公开标识；URL含凭据时按秘密 | [src/http_security.ts:55](../src/http_security.ts#L55) |
| `PATH` | 安装器/测试查找客户端可执行文件，标准系统环境 | 配置/公开标识；URL含凭据时按秘密 | [scripts/functional-acceptance.ts:481](../scripts/functional-acceptance.ts#L481)、[scripts/verify-package.mjs:138](../scripts/verify-package.mjs#L138)、[src/cli/clients.ts:48](../src/cli/clients.ts#L48) |
| `PORT` | 进程HTTP端口，按角色独立设置 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:3](../.env.example#L3)、[src/agent/backend.ts:351](../src/agent/backend.ts#L351)、[src/agent/core_bridge.ts:1983](../src/agent/core_bridge.ts#L1983)（另1处） |
| `POSTGRES_DB` | GitHub CI disposable PostgreSQL数据库名 | 配置/公开标识；URL含凭据时按秘密 | [.github/workflows/ci.yml:14](../.github/workflows/ci.yml#L14)、[.github/workflows/publish.yml:21](../.github/workflows/publish.yml#L21) |
| `POSTGRES_PASSWORD` | GitHub CI disposable PostgreSQL密码（fixture，非线上） | 秘密/可能含凭据；实际值走受控渠道 | [.github/workflows/ci.yml:13](../.github/workflows/ci.yml#L13)、[.github/workflows/publish.yml:20](../.github/workflows/publish.yml#L20) |
| `POSTGRES_USER` | GitHub CI disposable PostgreSQL用户 | 配置/公开标识；URL含凭据时按秘密 | [.github/workflows/ci.yml:12](../.github/workflows/ci.yml#L12)、[.github/workflows/publish.yml:19](../.github/workflows/publish.yml#L19) |
| `PRIVY_APP_ID` | Privy application公开ID | 配置/公开标识；URL含凭据时按秘密 | [.env.example:6](../.env.example#L6)、[src/server.ts:60](../src/server.ts#L60) |
| `PRIVY_CLIENT_ID` | Privy Web client公开ID，可选，不用mobile client替代 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:7](../.env.example#L7)、[src/server.ts:61](../src/server.ts#L61) |
| `PRIVY_JS_SDK_URL` | 浏览器Privy SDK URL覆盖 | 配置/公开标识；URL含凭据时按秘密 | [src/server.ts:63](../src/server.ts#L63) |
| `PUBLIC_BASE_URL` | OAuth issuer与人类页面HTTPS基地址；loopback开发例外 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:4](../.env.example#L4)、[src/agent/backend.ts:339](../src/agent/backend.ts#L339)、[src/server.ts:43](../src/server.ts#L43) |
| `RAILWAY_ENVIRONMENT_ID` | Railway注入，用于默认trust-proxy判定 | 配置/公开标识；URL含凭据时按秘密 | [src/http_security.ts:56](../src/http_security.ts#L56) |
| `REDIS_URL` | OAuth/handoff Redis连接串 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:8](../.env.example#L8)、[src/server.ts:52](../src/server.ts#L52) |
| `RIDE_AGENT_ARBITRUM_RPC_URL` | 充值/USDC证据RPC URL，可含key；可使用公开fallback | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:31](../.env.example#L31)、[src/agent/deposits.ts:118](../src/agent/deposits.ts#L118) |
| `RIDE_AGENT_BACKEND_URL` | gateway到backend私有base URL | 配置/公开标识；URL含凭据时按秘密 | [.env.example:9](../.env.example#L9)、[src/server.ts:44](../src/server.ts#L44) |
| `RIDE_AGENT_CORE_SERVICE_TOKEN` | bridge/Core独立S2S秘密 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:18](../.env.example#L18)、[src/agent/core_bridge.ts:1936](../src/agent/core_bridge.ts#L1936) |
| `RIDE_AGENT_CORE_URL` | bridge到Core internal Agent API基地址 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:17](../.env.example#L17)、[src/agent/core_bridge.ts:1935](../src/agent/core_bridge.ts#L1935) |
| `RIDE_AGENT_CURSOR_KEY` | backend用户绑定cursor签名秘密，>=32字符 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:14](../.env.example#L14)、[src/agent/backend.ts:340](../src/agent/backend.ts#L340) |
| `RIDE_AGENT_DATABASE_URL` | 独立Agent PostgreSQL连接串 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:13](../.env.example#L13)、[src/agent/backend.ts:330](../src/agent/backend.ts#L330)、[src/agent/core_bridge.ts:1937](../src/agent/core_bridge.ts#L1937) |
| `RIDE_AGENT_ENABLED` | backend显式启动开关，必须true才能启动 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:11](../.env.example#L11)、[src/agent/backend.ts:323](../src/agent/backend.ts#L323) |
| `RIDE_AGENT_EXECUTOR_TOKEN` | backend/bridge共享executor S2S秘密，>=32字符 | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:16](../.env.example#L16)、[src/agent/backend.ts:336](../src/agent/backend.ts#L336)、[src/agent/core_bridge.ts:1942](../src/agent/core_bridge.ts#L1942) |
| `RIDE_AGENT_EXECUTOR_URL` | backend到私有bridge URL | 配置/公开标识；URL含凭据时按秘密 | [.env.example:15](../.env.example#L15)、[src/agent/backend.ts:335](../src/agent/backend.ts#L335) |
| `RIDE_AGENT_FCM_PROJECT_ID` | 可选expected Firebase project，credential mismatch拒绝 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:27](../.env.example#L27)、[src/agent/firebase.ts:32](../src/agent/firebase.ts#L32) |
| `RIDE_AGENT_FUNCTIONAL_DATABASE_URL` | functional本地旅程的一次性PostgreSQL连接串 | 秘密/可能含凭据；实际值走受控渠道 | [scripts/functional-acceptance.ts:37](../scripts/functional-acceptance.ts#L37) |
| `RIDE_AGENT_HUMAN_COOKIE_KEY` | gateway人类浏览器cookie加密秘密，独立>=32byte | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:10](../.env.example#L10)、[src/server.ts:112](../src/server.ts#L112) |
| `RIDE_AGENT_NETWORK` | Perps network，mainnet显式选择，其他值默认testnet | 配置/公开标识；URL含凭据时按秘密 | [.env.example:20](../.env.example#L20)、[src/agent/core_bridge.ts:1939](../src/agent/core_bridge.ts#L1939) |
| `RIDE_AGENT_POLYGON_RPC_URL` | prediction链上证据RPC URL，可含provider key | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:22](../.env.example#L22)、[src/agent/core_bridge.ts:77](../src/agent/core_bridge.ts#L77) |
| `RIDE_AGENT_PREDICTION_ENABLED` | bridge/Core显式prediction开关；无paper模式 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:21](../.env.example#L21)、[src/agent/core_bridge.ts:250](../src/agent/core_bridge.ts#L250) |
| `RIDE_AGENT_PRIVATE_HTTP_HOST` | backend允许的精确Railway internal bridge HTTP host | 配置/公开标识；URL含凭据时按秘密 | [src/agent/backend.ts:337](../src/agent/backend.ts#L337) |
| `RIDE_AGENT_READ_ONLY` | backend/Core只读与暂停trading runner，各层独立配置 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:12](../.env.example#L12)、[src/agent/backend.ts:346](../src/agent/backend.ts#L346) |
| `RIDE_AGENT_RWA_ENABLED` | bridge RWA功能开关；受支持边界独立校验 | 配置/公开标识；URL含凭据时按秘密 | [.env.example:30](../.env.example#L30)、[src/agent/core_bridge.ts:261](../src/agent/core_bridge.ts#L261) |
| `RIDE_AGENT_TEST_DATABASE_URL` | 真实durability/timeout tests的一次性PostgreSQL连接串 | 秘密/可能含凭据；实际值走受控渠道 | [src/agent/durability.test.ts:19](../src/agent/durability.test.ts#L19)、[src/agent/order-precheck.test.ts:481](../src/agent/order-precheck.test.ts#L481)、[src/agent/repository-timeouts.test.ts:16](../src/agent/repository-timeouts.test.ts#L16) |
| `RIDE_AGENT_TRADER_ID_SALT` | bridge稳定public trader-ID盐，>=32字符，轮换影响旧ID | 秘密/可能含凭据；实际值走受控渠道 | [.env.example:19](../.env.example#L19)、[src/agent/core_bridge.ts:1938](../src/agent/core_bridge.ts#L1938) |
| `RIDE_AGENT_UNIFIED_ENABLED` | bridge及Core/worker unified USDC执行支持开关，不做账户转换/转账 | 配置/公开标识；URL含凭据时按秘密 | [src/agent/core_bridge.ts:910](../src/agent/core_bridge.ts#L910)、[src/agent/deposits.ts:353](../src/agent/deposits.ts#L353) |
| `RIDE_CONFIG_DIR` | CLI私有session目录覆盖（目录内容含token） | 配置/公开标识；URL含凭据时按秘密 | [src/cli/session.ts:57](../src/cli/session.ts#L57) |
| `RIDE_CONFIRM_PREVIEW_PORT` | 独立确认卡片fixture预览port | 配置/公开标识；URL含凭据时按秘密 | [scripts/confirmation-preview.ts:8](../scripts/confirmation-preview.ts#L8) |
| `RIDE_FUNDING_PREVIEW_PORT` | 独立资金卡片fixture预览port | 配置/公开标识；URL含凭据时按秘密 | [scripts/funding-preview.ts:12](../scripts/funding-preview.ts#L12) |
| `RIDE_GRAPHQL_URL` | Ride Core GraphQL endpoint | 配置/公开标识；URL含凭据时按秘密 | [.env.example:5](../.env.example#L5)、[src/agent/backend.ts:344](../src/agent/backend.ts#L344)、[src/server.ts:45](../src/server.ts#L45) |
| `RIDE_MCP_URL` | CLI默认MCP server URL覆盖 | 配置/公开标识；URL含凭据时按秘密 | [src/cli/commands.ts:166](../src/cli/commands.ts#L166) |
| `RIDE_PREVIEW_POOL_SIZE` | 预览fixture候选池数量 | 配置/公开标识；URL含凭据时按秘密 | [scripts/conversational-preview.ts:16](../scripts/conversational-preview.ts#L16) |
| `RIDE_PREVIEW_PORT` | 综合卡片fixture预览port | 配置/公开标识；URL含凭据时按秘密 | [scripts/conversational-preview.ts:73](../scripts/conversational-preview.ts#L73) |
| `RIDE_PREVIEW_WIDGET_REGRESSIONS` | 预览卡片regression fixture开关 | 配置/公开标识；URL含凭据时按秘密 | [scripts/conversational-preview.ts:83](../scripts/conversational-preview.ts#L83) |
| `RIDE_PUBLIC_SUBMISSION_MODE` | 只读展示模式；true隐藏/拒绝machine写路径与对应UI | 配置/公开标识；URL含凭据时按秘密 | [.env.example:23](../.env.example#L23)、[src/server.ts:86](../src/server.ts#L86) |
| `RIDE_SERVICE_ENTRYPOINT` | server/backend/bridge进程选择，不能混用service role | 配置/公开标识；URL含凭据时按秘密 | [railway.json:8](../railway.json#L8)、[src/start.ts:3](../src/start.ts#L3) |

共 50 个显式支持的键。每组服务owner见[infra](infra.md)；未确认的最终账号/email统一“TBD – confirm”。

## 跨仓Core协作变量（本仓文档描述，不由本进程直接读取）

| 键 | 配置方/用途 | 秘密 |
|---|---|---|
| `RIDE_AGENT_CORE_ENABLED` | Core开启Agent internal API | 否 |
| `RIDE_AGENT_MAINNET_ENABLED` | Core显式mainnet执行开关 | 否 |
| `RIDE_AGENT_NETWORK`, `RIDE_AGENT_READ_ONLY`, `RIDE_AGENT_PREDICTION_ENABLED`, `RIDE_AGENT_UNIFIED_ENABLED` | Core/worker与bridge/backend对应network/feature/read-only必须一致 | 否 |
| `STRATEGY_CONTROL_PLANE_SERVICE_TOKEN` | Core API/gRPC/worker控制平面凭据，区别于Node S2S token | 是 |

CI使用GitHub OIDC trusted publishing；平台注入的OIDC/GitHub runner变量不需要手工复制。没有新增长期npm publish key要求。
