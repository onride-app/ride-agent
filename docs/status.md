# Rider 当前状态与接手顺序

## 2026-11-09 App 托管及 performance 升级（有界验收）

生产首次托管切换在 07:32（Asia/Shanghai）完成；performance 升级部署 `cae47a83-d72d-4b3c-898e-9f58e1113e69` 于 07:57:35 SUCCESS。Node 业务源码 `18826aa6945239205a29bf6df6bccc7c4534b828`（PR #39，main `60f9993a…`）、archive SHA256 `36b7dd7309957d27d097147cf5a89d5022cbd48e266e7eaaf0f86c5aed8d789a`，全部 **82 个** compiled module 的实际文件哈希与已验证 builder 一致，Node `v22.23.4`。新实例前后均为唯一 active SUCCESS/RUNNING 实例，PID 1 API/唯一 managed Node、四个 gates、loopback 三监听及 health/ready/runtime-ready 全部通过。详见脱敏 `performance-owner-runtime-verified.json`。

API binary 仍来自 `4ffc2965575d9c23a2812f0f8425f990c16a7d62`，SHA256 `8b1e64aed7be686749ce86446c2f4ac25ef0d202126c366daeeb76fbb90c0b63`；public relay 为 `206149…`。轻量 gateway 部署 `697bb9f5-702b-449a-9c60-08182191be35` 的实际 caller 源码是 `26a6a94157e4d3ce47a03ddd88d3cbd4b1048a50`，保留 `mcp.onride.me` issuer，经 App HTTP 调业务及 session RPC，无直连 PG/Redis、Core/executor token。源码/Git 文档提交、API binary、Node module pin 和云部署身份分别记录；配套 build/pin 由 App PR #51 交付，不拿分支 HEAD 替代运行证明。

当前路径为 gateway → App public `89a5768e…` relay → private `ae126414…` owner 的版本化 Node 模块。Agent DB 是 App PG 集群内独立 `ride_agent_app`；OAuth/handoff 是 App Redis。原完整 `RIDE_AGENT_CORE_URL` 保留，因为其 origin/path 参与读取预算 owner 指纹；只有 backend→bridge 使用进程内 `127.0.0.1:3355`。原用户 JWT、人工确认、Core ownership/epoch、市场/网络/read-only gates 保留。owner 自动触发禁用，平台 60 秒 drain 包容 Node45/Rust47 秒边界；升级使用 controlled stop/drain/start。

迁移恢复后启用前，PG 全量 46,275 行/7 表 fingerprint 一致，OAuth 74 个记录恢复并验证。既有 OAuth registration 读取、无效凭据 guard、health/ready/runtime-ready 与 no-store 边界通过；唯一 PG monitor lease=1，public Node=0/private Node=1。旧 backend/bridge/PG/两个 Redis 共 5 个旧计算服务已停止，卷与已验证备份保留。原 outbox/NULL/unknown、稳定 ID 与 opaque OAuth bytes/TTL 不重建。脱敏记录包括 `performance-live-http-verification.json`、`performance-owner-active-boundary.json`、`old-ride-decommission-readonly.json`、`old-store-compute-stop.json`。

performance 升级前封存的 12 个 owner 共 **34,161 个旧点全部保留**，original/payload/active/ordinal/head/index 检查通过。3 个 eligible owner 的 34,117 个旧点已入冷表；9 个懒迁移 owner 中仅 1 个仍有 44 个 inline 点，保持完整，不为验收强制迁移。采样时冷表为 34,135 行，全部 active 且 payload=original；新增点也保留，不能把它误读为只保留最后一点。完整 daily/weekly/inception 报表、baseline/连续性/null coverage 与原始历史保持，monitor 只取最新 head，日报到期时按需读取准确窗口。详见 `performance-prefix-after-summary.json`。

热状态文本总量由原始 **81,916,180 B** 降为 **2,827,642 B（2.827642 MB，96.55%）**。3 个 eligible owner 的 inline performance 为 0 点/0 B；其余热字段和懒迁移的 44 点仍在。优化的是持续 monitor 数据路径，显式完整历史读取仍可处理大历史，未删除收益点或宣称系统不再处理 JSON。

进程自然采样为 UTC 2026-11-08 23:58:26.599–23:59:11.641（45.041 秒）：Node 平均 **0.08170 vCPU**、末 RSS **202.74 MiB**。PG 计数窗口 54.309 秒，cold performance 4 INSERT / 0 UPDATE / 0 DELETE、state 17 UPDATE，说明窗口内确有自然活动。第一阶段短样本 0.31059 vCPU / RSS443.37 MiB 属于不同负载窗口，不能据此归一化节省率或推算月费。见 `performance-postcutover-profile-45s.json`。

6 组财务/身份指纹与冻结源及采样前后完全一致，1,203 个 execution、其中 5 个 uncertain、36 个 outbox 和 2 个 NULL response 保留。此项证明迁移保留边界，不代表 uncertain 已解决、真实签名/成交成功或真机推送已验收。宿主自然 refresh/CAS、长期负载、峰值与实际月费仍需分别观察。

离线验证按版本区分：冷热存储/App 初版 `0e13ef3` 的 PG17 全套 1326 项（1324 passed / 0 failed / 2 Darwin TCP kernel proofs skipped）、cold-history9/9、模拟 Core/venue 的 functional53/53；gateway caller `26a6a94` 的显式 clean-env check/build 及 1331 项（1268 passed / 0 failed / 63 可选 PG/runtime skipped）；App relay/lifecycle targeted12/12。本次 performance 源码交付与验证见 Node PR #39；这些均不替代原账户金融验收。

`dd6dacd` / `0e13ef3` 虽支持此前 updates/decisions 冷表，却不能读取已剥离 performance 的热状态。回退必须先停并 drain owner，保留升级后当前完整数据库的最新 reverse snapshot，以 performance-aware binary 恢复；不能丢弃新写入或换 execution ID 重试。

运维入口：[部署](deployment.md)、[冷热历史/回退契约](https://github.com/onride-app/ride-agent/blob/18826aa6945239205a29bf6df6bccc7c4534b828/docs/agent-history-storage.md)。

以下旧日期内容保留为历史证据；不能当作新的生产现状。


日期：2026-10-29。本地分支`main`为`f20f87ef38ad1623346f601894b97d3f1377f960`；已fetch并核对远程`main`最新`a4402ebbff6bda296a318de93030775692b4d246`。本PR以远程最新为基础，不重置本地代码。本交接编辑开始前该仓工作树干净。本地SHA/干净状态本身不证明线上或npm registry版本；下文另记录只读核验的部署SHA。

## 已在代码中完成

- Rider安装器/CLI/Skill、native HTTP与stdio MCP、OAuth PKCE/Redis、Privy/Core登录、账号读取、卡片和实时guide。
- durable Agent backend、独立execution bridge、不可变preview/proposal、人类确认、bounded delegation、后台monitor、owned ledger与报告/推送路径。
- Fixed/比例跟单、资金准备、required margin/最小订单检查、风险重选/证据分析及候选过滤；执行仍受Core/账户/资金/venue约束。
- 10/23 compact confirmation和双语证据/只读order previews；当前资源v10且旧alias兼容。
- 10/28 suppressed Fixed shadow/fresh evidence恢复（`4eaa8fc`）、source market scope/fill ordering（`93668cf`）、PG大状态reader shutdown修复（`d318719`）。
- 本地`f20f87e`调整登录、账户/复制sizing相关文案。细节看`git show`和[决策](decisions.md)。

- 远程最新`a4402eb`（PR#30）实现同进程共享venue weighted budget、method/response cost、未知surcharge/debt与deadline/fairness校验，源码差异已核对；相应production部署元数据见下。

## 验证证据与适用范围

| 证据 | 能证明的内容 | 不能推定 |
|---|---|---|
| 源码tests/CI配置 | schemas、权限、恢复/会计/卡片等有可运行校验入口 | 当前本机全套检查已运行或当前CI通过 |
| [10/28 execution recovery记录](copy-execution-evidence-2026-10-28.md) | 当时匿名fixture检查518 passed/2 optional PG skipped | 原账户真实执行、签名或App release |
| [10/28 PG关闭事件记录](repository-clientwrite-shutdown-2026-10-28.md) | 当时真实隔离PG锁/ClientWrite/关闭边界验证；原异常session另有操作记录 | 任意硬杀均立即释放锁、当前线上无任何问题 |
| 本次文档整理 | 对源码、配置、提交历史、文档和变量名的静态核对 | 新的部署、OAuth登录、钱包/成交/真机推送验收 |

## 在进行与待确认

交接文档是本次工作。除此之外，无法仅从Git判断当前负责人正在执行哪些任务；进行中的PR、产品排期、owner：TBD – confirm。

2026-10-29只读Railway部署元数据确认：project `ride-mcp`（workspace显示`yovelaluo-blip's Projects`），production服务`ride-mcp`、`agent-backend`、`agent-bridge`的source均为`onride-app/ride-agent`，最新部署均`a4402eb`/SUCCESS，createdAt为2026-10-28 22:59:50（Asia/Shanghai）。`mcp.onride.me`绑定`ride-mcp`，targetPort 8080。实际Core SHA、服务变量/read-only与执行flags、npm latest、OAuth宿主功能、真实账户/订单/推送验收仍TBD – confirm；部署元数据不能替代这些验收。保持既有proposal/outbox/资金状态，不以重放来“验证”。

## 下一步（按顺序）

1. 获取[infra](infra.md)缺失的组织/服务权限，核对每个service角色、环境、源码SHA、网络和secret来源，记录在受控运维清单。
2. 用Node 22和隔离PostgreSQL运行`npm run check`、`npm test`、`npm run verify:package`；检查optional skip。对新的逻辑变更再运行functional journey。
3. 对支持的MCP宿主逐一验证只读OAuth、`get_ride_guide`、实际tools/list、App/Agent账户区分、卡片/CLI一致性。
4. 明确具体用户账户、预算、市场和允许的操作后再做资金/确认/成交验收；不能将只读登录或部署任务扩大为交易授权。
5. 分别安排真实App确认、断网恢复、未知提交对账、partial/zero-fill、资金费用、通知真机接收和回退验收，保留原始证据/不确定性。

## 已知缺口/后续工程

- 历史缺口更新：App 受管 monitor 已有数据库 session lease；旧 standalone 仍不遵守该协议。跨进程 Hyperliquid IP-weight 预算仍需独立核实，同进程 weighted gate 保留。
- 历史缺口更新：updates/decisions 已有冷表及 eligibility/latest 投影；其余财务证据、checkpoint/configuration 的增长与长事务边界继续观察。保留原始 audit，不删账务/未知执行来排障。
- 自动prediction redemption未实现；ambiguous receipts、merge/redeem classification、dust可持续attention。不能显示为完成。
- Unified/RWA/portfolio margin有明确支持边界；看Core和部署flags，不以UI选项推断任意账户可执行。
- pinned旧客户端迁移/版本兼容、外网issuer/Privy redirects、各宿主inline funding能力需独立检查。
- 产品负责人、值班、备份恢复、告警和真实验收的owner/截止日期：TBD – confirm。

## 2026-10-30 同账户手动币种接管

已实现[手动接管协议](manual-market-handoff-2026-10-30.md)：native Perps 手动币不再被copy target覆盖，其他币继续；copy/manual账本与收益分开，全账户仍须守恒。
本轮隔离PG 902/902（0skip）、functional53/53、typecheck/build/package通过。
代码推送、各角色部署及原账号真实金融验收另记录；App不发新版，不以fixture代替真实成交。
