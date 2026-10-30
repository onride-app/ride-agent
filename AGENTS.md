# Rider / Ride Agent 接手指南

本指南核对日期：2026-10-29。本地源码基线：`f20f87ef38ad1623346f601894b97d3f1377f960`；已fetch远程`main`并核对最新`a4402ebbff6bda296a318de93030775692b4d246`，本PR以远程最新为基础。这是源码交接快照；线上部署 SHA、账号权限、真实设备/交易验收分别核对，见 [status](docs/status.md)。

## 项目与仓库边界

Rider 是 Ride 的 AI 跟单入口，提供 OAuth MCP、`ride` CLI、安装器、可更新工作流 Skill、投资组合预览、人类确认、独立后台监控及交易证据/账本。产品名称 Rider，npm 包 `@onride/agent`，命令 `ride`，GitHub 仓库 `onride-app/ride-agent`；本机目录名 `ride-mcp-public` 是历史名称。包版本见 `package.json`，当前 `0.5.3`，不能据此推定 npm latest 或线上源码。

此仓不包含私有 Ride Core、原生 App、交易签名 worker。Core 对接位于相邻 `predictly_server` 仓库；App 位于 `predictly_app`。相邻 `ride_mcp` 是另一套较早的 GraphQL MCP 实现，工具名、状态模型和启动方式不同，不能互换部署。两仓文档都保留 `mcp.onride.me`，2026-10-29只读部署元数据确认该域名绑定的服务源是`onride-app/ride-agent`。

技术栈：Node.js >=20、TypeScript strict/NodeNext/ES2022、MCP SDK、Express 5、Zod、PostgreSQL (`pg`)、Redis、ethers、decimal.js、QR code；测试用 Node test runner + tsx。

## 先读这些文档

- [架构和数据流](docs/architecture.md)：三进程、信任边界、状态和交易生命周期。
- [技术决策](docs/decisions.md)：选择原因与已修复事件。
- [基础设施和账号](docs/infra.md)、[环境变量全集](docs/env-inventory.md)：只列名称与用途，秘密从受控配置取得。
- [交接进度](docs/status.md)：完成、缺口和下一步。
- [部署细节](docs/deployment.md)、[迁移与发布](docs/ride-agent-migration.md)、[V17 行为](docs/conversational-v17.md)。

## 目录和修改入口

| 路径 | 职责 |
|---|---|
| `src/server.ts` | HTTP MCP/OAuth gateway、工作流读取、账户读取、确认页面代理 |
| `src/backend.ts`, `src/agent/backend.ts` | durable Agent service 启动、身份验证和后台 runner |
| `src/bridge.ts`, `src/agent/core_bridge.ts` | 私有执行适配、Core S2S、公开行情读取、通知 |
| `src/agent/contracts.ts`, `domain.ts`, `service.ts` | 工具 schemas、领域对象、业务状态迁移与风险校验 |
| `src/agent/repository.ts`, `ledger.ts`, `analytics.ts` | PostgreSQL 用户状态、归属账本、收益快照 |
| `src/agent/runner.ts` | 持续跟踪、执行/对账、风控和通知调度 |
| `src/agent/source-*`, `venue-reads.ts`, `risk-*` | 来源证据、限流、候选和风险选择 |
| `src/agent/prediction*.ts`, `perps_account.ts`, `deposits.ts` | 各市场证据、账户/资金准备 |
| `src/oauth.ts`, `auth_exchange.ts`, `http_security.ts` | OAuth PKCE、Privy/Core 登录交换、HTTP 边界 |
| `src/cli.ts`, `src/cli/*`, `src/mcp-cli.ts` | CLI、安装/迁移、客户端配置、私有本地 session |
| `public/agent-view.js`, `agent-host.js`, `agent.css`, `scripts-build-ui.mjs` | MCP 卡片源文件与构建；`agent.html` 为打包结果 |
| `public/confirm*`, `fund*`, `src/agent/human*.ts` | 人类审核、资金卡片、会话恢复 |
| `skills/ride/`, `src/guide.ts` | 安装 Skill 与服务器实时工作流 |
| `scripts/`, `.github/workflows/` | 功能验证、预览、打包和发布检查 |
| `dist/`, `node_modules/`, `output/` | 编译产物、依赖、测试/预览输出；不当作源码真相 |

## 安装、构建和本地启动

需要 Node >=20 和 npm；CI 使用 Node 22，发布使用 Node 24。先确认当前工作树并保留本地改动：

```sh
git status --short
node --version
npm ci
npm run check
npm run build
```

`npm ci` 的 prepare 和 `npm run build` 会执行 UI 构建与 tsc。不要直接编辑 `dist/`。用户安装器 `npx -y @onride/agent` 会写 AI 客户端配置并触发登录，开发编译无需运行安装器。

准备独立本地 PostgreSQL、Redis 和 `.env`（从 `.env.example` 复制并填入本地/测试配置）。gateway 必须有 `PUBLIC_BASE_URL`、`RIDE_AGENT_BACKEND_URL`、`RIDE_GRAPHQL_URL`、`PRIVY_APP_ID`。本地 loopback issuer 可用内存 OAuth store；外网 issuer 必须 HTTPS + Redis。普通 gateway 还要求独立 `RIDE_AGENT_HUMAN_COOKIE_KEY`；read-only submission 模式不挂确认入口。

三进程在不同终端启动；各进程应得到自己的 env 配置。默认监听 loopback，端口分别为 3333/3344/3355：

```sh
npm start
npm run start:backend
npm run start:bridge
```

`npm start` 执行 `dist/start.js`，由 `RIDE_SERVICE_ENTRYPOINT=server|backend|bridge` 选择进程，默认 server。selector在各角色载入dotenv之前读取，切换入口要使用平台/进程环境变量（例如`RIDE_SERVICE_ENTRYPOINT=backend npm start`），不能只放入`.env`。`npm run dev` 只跑源码 gateway，不自动启动依赖。backend 要显式 `RIDE_AGENT_ENABLED=true`；开发/初次接管先配 `RIDE_PUBLIC_SUBMISSION_MODE=true` 和 backend/Core `RIDE_AGENT_READ_ONLY=true`，且保留真实交易开关关闭。完整 Core 未配置时，进程启动不代表功能完整；可先使用离线测试与卡片预览。

卡片预览 `npm run preview:cards`；预览代码使用匿名 fixture，不提供真实交易验收。不要将本地预览 URL 当生产确认页。

## 验证

```sh
npm run check
npm test
npm run build
npm run verify:package
```

- `npm test` 含 schemas、账户隔离、OAuth、权限、会计、UI 与恢复测试；未设隔离数据库时部分 PostgreSQL 测试会 skip。阅读汇总中的 skip 数，不把全绿等同完整 durability 检查。
- 设置 `RIDE_AGENT_TEST_DATABASE_URL` 为一次性独立 PostgreSQL，再运行测试，可覆盖真实 row-lock/超时/关闭路径。该测试 URL 不能指向线上数据库。
- `RIDE_AGENT_FUNCTIONAL_DATABASE_URL=<isolated-db> npm run test:functional` 启动真实本地 MCP/backend/OAuth/CLI 旅程，但 Core 身份和交易所响应使用模拟；不能当真实登录/签名/成交。
- `verify:package` 会构建、打包并在隔离目录验证安装文件/配置。打包发布与服务器部署是两个流程。
- 修改卡片应从 JS/CSS 源构建并检查旧资源 aliases；现资源为 `ui://ride/agent-v10-compact-confirmation.html`，旧 v3–v9 兼容入口存在。

## 部署与回退

Railway 使用 `railway.json`：Railpack 构建 `npm run build`，运行 `HOST=${HOST:-0.0.0.0} node dist/${RIDE_SERVICE_ENTRYPOINT:-server}.js`。一个服务一个入口；gateway 公网，backend/bridge 私网。`/health` 检查各服务角色/版本，不能验证订单或终端用户登录。

先确认目标 Railway project/environment/service、记录各服务旧 deployment/SHA 和数据库备份，再依次部署 bridge、backend、gateway，Core migrations/开关须配套。此仓启动时会创建 Agent/bridge 自有表；私有 Core 的 additive migration 在 Core 仓，不能用这里的建表替代。至少保持 backend 45 秒 graceful drain（配置已在 railway.json）和每个 Agent DB 一个 monitor 实例。回退必须同时考虑已创建的不可变 proposal/outbox 和兼容 schema，不能通过删除状态或新 ID 重试未知订单回退。已核对的production三服务均为`a4402eb`/SUCCESS，具体快照见[status](docs/status.md)；Core版本/实际执行开关仍TBD – confirm。

npm 发布通过 `.github/workflows/publish.yml` 的手动 tag workflow：Node 24、`npm-production` 环境、OIDC trusted publishing、版本/tag/仓库验证；发布会产生外部变更，按具体发布任务授权执行。不要因文档 PR 自动触发发布、部署或交易开关。

## 代码规范与必须保留的架构约束

- ESM + TypeScript strict；内部相对 imports 使用编译后的 `.js` 后缀；避免绕开 Zod 输入/输出 contracts。新增行为先找同模块既有测试和错误代码格式。
- 金额/数量遵守现有 decimal/integer micro-USDC 处理，不用浮点隐式四舍五入改财务结果。
- OAuth `ride:trade` 只允许创建提案。人类确认使用 Ride Core session；MCP machine token 不能确认、授权或撤销人类 grant。用户读/预览/部署授权不能推断为签名、转账、激活或下单授权。
- 预览与 proposal 冻结 owner、revision、hash、金额及有效期；编辑生成新对象。所有执行继续走 Core ownership、风控和 worker，不从 gateway 直接签名。
- pending/partial/unknown/settled/completed 各有含义；未知提交先原 execution ID 对账，不能生成新 ID 重放。无法证明的收益用 `null`、不可用或 attention，不能补零或用交易员收益代替。
- PostgreSQL 按用户事务加行锁；异常连接要销毁。关闭流程必须先关闭尚未进入业务 callback 的 reader；已有外部副作用保留 durable outbox 对账路径。
- account evidence 与 public-source sampling 分开；429 cooldown 和完整性检查不能被缓存绕开。风控正常拒绝新目标时，不为“让 cursor 前进”放宽 basket/资金限制。
- 持久化账本和更新可含敏感用户数据。日志只保留安全诊断；不要提交 `.env`、本地 `.ride` session、真实账户 dump 或 `output` 证据中的隐私。

## 已知问题、陷阱和接手优先级

- `docs/deployment.md` 部分工具数量描述早于当前 contracts，判断工具集合看 `src/agent/contracts.ts` 和实际 `tools/list`。
- `npm start` 默认 gateway，`RIDE_SERVICE_ENTRYPOINT` 配错会部署错误角色。多个服务都 SUCCESS 不证明各服务同源码版本。
- `a4402eb`已新增同进程所有`VenueReads`实例与两个Hyperliquid host共享60秒加权预算（默认1000、代码上限1200）、响应附加费用及未知响应隔离；仍不是跨pod/fleet/IP总额度，扩容前须解决跨进程预算及调度leases。
- 手动/旧版本安装不是全自动升级；固定 GitHub/global npm 安装保留版本，迁移检查见 migration 文档。
- 同账户 native Perps 手动接管使用 [Core handoff + manual ledger](docs/manual-market-handoff-2026-10-30.md)。不可只删除全账户 ownership fence，也不可把手动盈亏计入 copy；foreign DEX handoff 仍拒绝，未知执行保留原 ID。
- 不支持自动 prediction redemption；未知 receipt、未分类 merge/redemption 和 venue dust 留 attention；真实 production acceptance 不能由 fixture 补足。
- Unified/RWA/Prediction 支持和 feature flags 分开；统一保证金/RWA 的限制看部署文档与 Core，实现存在不等于允许任意账户模式。
- `SIGKILL` 无 shutdown signal 的断联检测仍依赖服务端/网络；已有 graceful drain 修复不能证明任意硬杀均无遗留锁。
- 下一步按 [status](docs/status.md) 先核对部署与账号，再做明确授权的只读功能验收，最后安排具体账户/设备/市场的独立验收。
