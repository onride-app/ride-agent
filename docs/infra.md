# Rider 基础设施、账号与密钥目录


下列原账号/服务表是 2026-10-29 历史交接快照；托管角色增量见下节，实际状态按迁移凭据填写。此文件只列标识、用途和所有权线索，绝不保存 secret 值。依据为源码、部署配置和仓库历史文档；账号所有权未通过控制台重新审计；已进行下述Railway只读CLI身份与部署元数据核对。`TBD – confirm` 表示新接手人必须向拥有者核实。

## 托管角色与存储（2026-11-09 切换记录）

生产切换核对至：`2026-11-09 07:32 Asia/Shanghai（2026-11-08 23:32 UTC，核对时点）`。实际运行/停止凭据与有界观察：private owner 部署 `e17afed2-d5a9-48a2-94e0-66fd53bc2acc`、public relay `206149…`、gateway `697bb9f5-702b-449a-9c60-08182191be35` 均 SUCCESS。API 实际源码 `4ffc2965575d9c23a2812f0f8425f990c16a7d62`，binary SHA256 `8b1e64aed7be686749ce86446c2f4ac25ef0d202126c366daeeb76fbb90c0b63`；Node 模块 `dd6dacd0159b8dd83c320b163d74864befc96fa0`，archive SHA256 `17efdef46bbd01a19e4750bef56eefe0e54274240df7b11eae3a5bbdf0555544`，81 个 compiled module 哈希全部核验。gateway 实际源码 `26a6a94`，已切换 App URLs，无直连 PG/Redis、Core/executor token；外部 health/guide 200，OAuth issuer 保持原值。App health/ready/runtime-ready 均 200，已迁移 OAuth registration 读取 200/no-store。恢复后启用前 PG 全量 46,275 行/7 表 fingerprint 一致，OAuth 74 个记录恢复并验证；启用后 old backend/bridge active=0、gateway=1、public Node=0/private Node=1/唯一 PG monitor lease=1，旧 PG read-only 且无业务连接。旧 PG/两个 Redis 的停止指令均成功，连同旧 backend/bridge 合计 5 个旧计算服务退役；卷和已验证备份保留。脱敏记录：`owner-api-module-verified.json`、`gateway-live-http.json`、`postcutover-owner-boundary.json`、`old-ride-decommission-readonly.json`、`old-store-compute-stop.json`。这些证明运行/迁移边界，不代表宿主自然 refresh/CAS、原账号签名/真实成交或真机推送验收。

| 角色 | 精确定位 | 切换后的职责 |
|---|---|---|
| 轻量 MCP gateway | ride-mcp project，service `38891061-9d74-47e6-821e-d4429cb15b6d`；`mcp.onride.me` | 仅 HTTP 访问 App Agent/session RPC；不配置 Agent PG/Redis 直连凭据，issuer/redirects/human cookie key 保留 |
| App public relay | App project `c172400f-357a-429a-b6c6-43cabe396515`，production `32e1546f-a50d-4fbd-be2c-211680fc58ce`，service `89a5768e-f8d0-49dd-b63f-87f0ab4036d7` | 保持 public GraphQL；透传 Agent Tool/Human 与独立 Session RPC |
| App private owner | 同项目/环境，service `ae126414-21a9-4795-9a38-5fcd144fd4ea` | 监督固定 Node `dd6dacd0159b8dd83c320b163d74864befc96fa0` 模块，loopback `3344/3355/3366`；一个 monitor/PG session lease |
| Agent PostgreSQL | App PG service `5faaa2c7-6706-4080-8f69-e4998b0cabe1` | 独立 DB `ride_agent_app`、专用 `ride_agent_runtime` role；全表/函数/序列及冷历史备份，Core DB 不变 |
| OAuth / handoff Redis | App Redis service `d807b568-c244-48d6-9df8-d69b5109795e` | 原 namespace/opaque records/CAS/TTL；网关通过固定 HTTP RPC，不接收 Redis 凭据 |
| 旧 backend/bridge | `02b43ebe…` / `b51736db…` | 已停止，无 active/pending deployment；禁止与新 owner 同时启动 |
| 旧 Agent PG / 两个 Redis | `5d650bf2…`、`52f7bcff…` / `ee96261d…` | 计算已停止，卷与已验证备份保留；旧 PG 停前 read-only 且无业务连接，回退需兼容 binary |

Node 模块、App API 与云部署身份分别记录。源码 pin 不随 docs-only commit 重冻。owner Git/自动部署触发器保持禁用；平台 draining 为 60 秒，升级执行 controlled stop/drain/start。参考 [App runtime](https://github.com/onride-app/predictly_server/blob/665468cc49aaa3cc4b7b50a6831d984e9f91221b/deploy/agent-runtime/README.md)、[完整迁移与兼容回退](https://github.com/onride-app/predictly_server/blob/665468cc49aaa3cc4b7b50a6831d984e9f91221b/scripts/ride-agent-migration/README.md)。

保留原 `RIDE_AGENT_CORE_URL` 完整值，其 origin/path 是读取预算 owner 指纹的一部分；不要把 Core URL 改为 loopback。进程内 loopback 仅用于 backend→bridge（`127.0.0.1:3355`）。轻量 gateway caller-only 修复的发布 SHA 另外记录，App Node 模块当前 pin `dd6dacd0159b8dd83c320b163d74864befc96fa0`。

## 服务、账号和需要的权限

| 服务/账号 | 用途/资源 | owner / email 与证据 | 接手权限/缺口 |
|---|---|---|---|
| GitHub `onride-app/ride-agent` | 源码、CI、release、issues | 组织 `onride-app`；[2026-10-17迁移记录](ride-agent-migration.md)记载 `Glen-yang` 为 Owner、`admin@onride.me` 为组织billing email；当前成员 TBD – confirm | repo write；发布需要 tag/workflow及`npm-production`环境权限 |
| npm `onride`, `@onride/agent` | 公开CLI/Skill分发 | 2026-10-29只读`npm owner ls @onride/agent`返回`yovela <yovelaluo@gmail.com>`与`glenyang <admin@onride.me>`；组织Owner/2FA以迁移记录为历史，当前规则TBD – confirm | package team和trusted-publisher配置；旧`@glenyang/ride-cli`仍独立 |
| Railway | project `ride-mcp`，production gateway/backend/bridge、Postgres 18、两个Redis 8.2.9服务 | 当前CLI身份`glenyang1260@gmail.com`，workspace显示`yovelaluo-blip's Projects`；这不证明billing/最终owner，TBD – confirm | 2026-10-29读元数据：三个Node服务source均ride-agent、`a4402eb`/SUCCESS；secret引用、实际flags/private networking仍待核 |
| `onride.me` DNS/TLS | `mcp.onride.me`公有issuer/资源 | 域名registrar、DNS账号/email：TBD – confirm | 2026-10-29Railway元数据证实绑定ride-agent源的`ride-mcp`服务targetPort8080；DNS控制台权限仍待交接 |
| Ride Core GraphQL/API/gRPC/worker | 身份、账户归属、执行与签名 | 公司`onride-app/predictly_server`代码；服务运维owner/email TBD – confirm | Core部署/迁移和只读故障排查权限；密钥在Core/worker持有 |
| Privy application | Google/Apple等登录、钱包身份/会话恢复 | app ID由部署注入；Privy dashboard owner/email TBD – confirm | approved origins、OAuth redirects、Web client配置；无须给客户端Privy服务秘密 |
| PostgreSQL Agent DB | 用户状态、outbox、prediction辅助数据 | 提供商/DB role/备份owner/email TBD – confirm | 独立DB访问、备份恢复权限；不要与Core DB或测试DB混淆 |
| Redis | OAuth state与human handoffs | 实例/owner/email TBD – confirm | 私网读写、保留策略；该数据包含可用session/token，不能公开dump |
| Hyperliquid mainnet/testnet | 公共行情/source和owned账户证据；交易经Core workers | public info API无静态API key；真实钱包owner由Ride Core确定，具体账户 TBD – confirm | 文档/只读验收不授权真实交易或钱包操作 |
| Polymarket Data/CLOB/Bridge | prediction资料、订单簿、资金准备和回执证据 | public reads无此仓静态key；交易/Builder/钱包配置归Core，owner/email TBD – confirm | venue可用性/账户eligibility和资金分别核验 |
| Polygon RPC provider | prediction chain evidence | `RIDE_AGENT_POLYGON_RPC_URL` provider及账号/email TBD – confirm | RPC URL可能含API key；配额/chain一致性 |
| Arbitrum RPC provider | 充值/USDC证据 | 可默认公开Arbitrum RPC；自有key provider账号/email TBD – confirm | `RIDE_AGENT_ARBITRUM_RPC_URL`的权限/配额 |
| Firebase / Google OAuth | FCM daily reports/risk notifications | `docs/deployment.md`记载expected production project `ride-fiamma`；2026-10-29 gcloud ACTIVE身份为`glenyang1260@gmail.com`，不等于项目/billing owner；service-account owner/email TBD – confirm | bridge-only服务账号，Firebase messaging scope；真机delivery单独验证 |
| PublicNode Polygon fallback | `account_balances.ts`的公开Polygon RPC余额读取 | 公共服务，无本仓key；自有替代provider/owner TBD – confirm | `polygon-bor-rpc.publicnode.com`可用性/额度，不能把fallback当付费SLA |
| `docs.fiammalabs.io` | OAuth/confirm/funding页面的法律/说明链接 | 文档站点owner/email TBD – confirm | 不是交易执行API；内容/URL可用性需维护 |
| Browser SDK CDN `esm.sh` | Privy JS SDK loader | 第三方公共CDN，无本仓账号；版本见`server.ts` | 可用性/CSP/版本变更需同步验证 |
| AI客户端（Codex/Claude/Cursor/ChatGPT等） | MCP宿主/安装配置 | 用户自己的账户；公司订阅/管理员email TBD – confirm | native OAuth与CLI session独立，不把CLI登录视为宿主已授权 |

## 配置与密钥归属

历史静态键名见 [env-inventory](env-inventory.md)；新增托管 runtime/session 配置以 [App runtime](https://github.com/onride-app/predictly_server/blob/665468cc49aaa3cc4b7b50a6831d984e9f91221b/deploy/agent-runtime/README.md) 为准。`.env.example` 是开发起点，不能替代逐服务生产引用核对。

| 配置组 | 配置方 | 秘密/轮换影响 |
|---|---|---|
| Gateway issuer/backend/Core URL、Privy app/client、trust-proxy | gateway运维 | URL不一定秘密，但连接串/API-key-bearing URL按秘密；issuer改变需重新OAuth |
| `REDIS_URL`, `RIDE_AGENT_DATABASE_URL` | App private owner 运维 | 指向 App Redis / 独立 Agent DB；托管 gateway 不持有；含凭据，备份不能放 Git |
| `RIDE_AGENT_APP_SESSION_URL`, `RIDE_AGENT_APP_SESSION_TOKEN` | gateway 与 App session RPC | HTTPS App 入口与独立 S2S token；不等同 Core 用户 JWT/执行 token |
| `RIDE_AGENT_HUMAN_COOKIE_KEY` | gateway | 独立>=32-byte秘密；变更会使浏览器human session失效 |
| `RIDE_AGENT_CURSOR_KEY` | backend | 独立>=32字符签名key；轮换会影响旧cursor |
| `RIDE_AGENT_EXECUTOR_TOKEN` | backend与bridge | 独立>=32字符S2S秘密，只分配对应服务 |
| `RIDE_AGENT_CORE_SERVICE_TOKEN` | bridge与Core | 另一独立S2S秘密；不能与executor/控制平面token互代 |
| `RIDE_AGENT_TRADER_ID_SALT` | bridge | >=32字符长期秘密；变更会使旧public trader IDs失效 |
| FCM service-account JSON/base64 | bridge | 内含私钥；base64只是编码；只给bridge，不能给gateway/client |
| Polygon/Arbitrum RPC URL | bridge | URL可内嵌API key；日志和错误信息需要脱敏 |
| `RIDE_CONFIG_DIR`或默认私有用户目录 | CLI用户 | OAuth token/session由CLI保存，目录0700/文件0600；无需写入client config |
| Core flags、Core S2S、`STRATEGY_CONTROL_PLANE_SERVICE_TOKEN` | Core API/gRPC/worker运维 | 本仓只消费既有契约，不在客户端保管签名密钥 |
| GitHub/npm trusted publisher | release maintainer | workflow用OIDC，无需新增长期 npm token；当前publisher绑定/审批规则 TBD – confirm |

## 环境与交接步骤

- 本地：loopback HTTP +独立DB/Redis；fixture/functional test只使用一次性数据库。
- CI：GitHub Actions PostgreSQL 17服务，Node 22检查；发布workflow Node 24/OIDC；测试凭据只是CI fixture，不作为任何线上凭据。
- Hosted：gateway public HTTPS → App public relay → private owner 的 loopback Node 模块；session RPC/用户 JWT/Core S2S token 分离。独立 self-hosting 的 private HTTP hostname allowlist 继续兼容。
- 网络：bridge默认testnet；prediction无paper模式。`enabled`/read-only/mainnet/unified/RWA/prediction flags必须按各层分别核实。
- 接手时逐项邀请独立账号，记录实际owner、资源ID和服务目标，将秘密通过密码管理器/平台secret共享。当前缺失owner不能用Git作者或本机已登录账号推断。
- 备份/恢复频率、RPO/RTO、Redis持久化、监控告警、provider billing owner、on-call负责人：TBD – confirm。

原 2026-10-29 交接只读核对身份与部署元数据。新增生产迁移/停机事实只能引用本节实际凭据；文档不保存秘密值或私人数据库内容。

## 已核对的Railway资源定位（2026-10-29只读快照）

- Project `799f56cf-00ff-47ee-a0ea-2b18e0056499`，production environment `9f7f6143-3a48-4afd-9345-0bf5eaa55a0e`。
- Gateway service `ride-mcp` / `38891061-9d74-47e6-821e-d4429cb15b6d`；backend `02b43ebe-be40-443c-acc2-831f2aee14aa`；bridge `b51736db-73eb-4a13-bd47-c642675de365`。
- 三个service的override start command均`npm start`，角色仍依赖各服务的`RIDE_SERVICE_ENTRYPOINT`；此次没有导出实际变量值。
- Postgres服务`5d650bf2-a028-4d9c-8248-fff303bc30a0`；Redis服务`52f7bcff-8e8e-40da-ad88-148ccfab07fa`、`Redis-2WdR`服务`ee96261d-36a6-48ea-957e-d6c024e1b0ac`；哪一实例被各连接串引用需在受控平台核实。
