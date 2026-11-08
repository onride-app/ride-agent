# Rider 当前状态与接手顺序

## 2026-11-09 App 托管生产切换（有界观察）

代码交付：Node PR #35 的冷热存储/App 模块、PR #36 的轻量 gateway caller 修复、PR #37 的 PID 1 兼容均已合并，Node main `24743b4ed2bc68a307278bcf444851426dd46bf2`。实际业务模块 pin `dd6dacd0159b8dd83c320b163d74864befc96fa0`；App runtime/relay/迁移工具及流式响应修复已合并，final Rust 代码 `4ffc2965575d9c23a2812f0f8425f990c16a7d62`，App #50 merge `539be13`。轻量 gateway 的 caller-only 修复单独记录部署 SHA，不修改固定业务模块。App 版本化包的 pin 与 docs-only commit 分开；不由 Git 合并、镜像构建或默认 off 的健康探针推定生产已经切换。

运行身份分别核对：轻量 gateway 是 caller 源码 `26a6a94157e4d3ce47a03ddd88d3cbd4b1048a50`；App API binary 来自 `4ffc296`，Node 模块来自 `dd6dacd`。Git main/文档提交、API binary 与 Node 模块 archive 不互相替代。后续配套 pin/schema 硬化见 App PR #51；实际生产证明以以下运行标识为准。

生产切换已验证至：`2026-11-09 07:32 Asia/Shanghai（2026-11-08 23:32 UTC，核对时点）`。private owner 部署 `e17afed2-d5a9-48a2-94e0-66fd53bc2acc`、public relay `206149…`、gateway `697bb9f5-702b-449a-9c60-08182191be35` 均 SUCCESS。API 实际源码 `4ffc2965575d9c23a2812f0f8425f990c16a7d62`，binary SHA256 `8b1e64aed7be686749ce86446c2f4ac25ef0d202126c366daeeb76fbb90c0b63`；Node 模块 `dd6dacd0159b8dd83c320b163d74864befc96fa0`，archive SHA256 `17efdef46bbd01a19e4750bef56eefe0e54274240df7b11eae3a5bbdf0555544`，81 个 compiled module 哈希全部核验。gateway 实际源码 `26a6a94`，已切换 App URLs，无直连 PG/Redis、Core/executor token；外部 health/guide 200，OAuth issuer 保持原值。App health/ready/runtime-ready 均 200，已迁移 OAuth registration 读取 200/no-store。恢复后启用前 PG 全量 46,275 行/7 表 fingerprint 一致，OAuth 74 个记录恢复并验证；启用后 old backend/bridge active=0、gateway=1、public Node=0/private Node=1/唯一 PG monitor lease=1，旧 PG read-only 且无业务连接。旧 PG/两个 Redis 的停止指令均成功，连同旧 backend/bridge 合计 5 个旧计算服务退役；卷和已验证备份保留。脱敏记录：`owner-api-module-verified.json`、`gateway-live-http.json`、`postcutover-owner-boundary.json`、`old-ride-decommission-readonly.json`、`old-store-compute-stop.json`。这些证明运行/迁移边界，不代表宿主自然 refresh/CAS、原账号签名/真实成交或真机推送验收。

已切换角色：轻量 `mcp.onride.me` gateway → App public `89a5768e…` relay → private `ae126414…` owner 的固定 Node 模块；Agent DB 为 App 集群独立 `ride_agent_app`，OAuth/handoff 为 App Redis；旧 backend/bridge 已无 active deployment；旧 PG/两个 Redis 计算已停止，原卷保留，停前旧 PG 已 read-only 且无业务连接。owner 自动触发禁用、60 秒平台 drain、一次一个 monitor/session lease。

离线验证按版本区分：冷热存储/App 初版 `0e13ef3` 的 PG17 全套 1326 项，1324 passed / 0 failed / 2 Darwin TCP kernel proofs skipped，cold-history 专项 9/9，loopback OAuth/MCP/CLI/HTTP+PG functional 53/53（Core/venue 模拟）；gateway caller `26a6a94` 的显式 clean-env check/build 和全套 1331 项通过（1268 passed / 0 failed / 63 可选 PG/runtime skipped）；App runtime/relay targeted 12/12。不能据此宣称原账户真实登录刷新、自然 reconciliation、成交或真机推送已验收。自然流量已发生与仍未观察到的项目在切换凭据中明确列出。

后续运维按 [部署](deployment.md)、[冷热历史与旧 binary 回退边界](agent-history-storage.md) 及 [App runtime](https://github.com/onride-app/predictly_server/blob/665468cc49aaa3cc4b7b50a6831d984e9f91221b/deploy/agent-runtime/README.md)。原用户/钱包/portfolio/proposal/execution ID、未知结果、ownership/epoch、市场/网络/read-only gates 保持，未决交易不换 ID 重试。首次有界汇总比较：6 组财务/身份指纹一致，1,203 个 execution 和其中 5 个 uncertain 状态保留；热状态文本总量从 81.916 MB 降为 33.880 MB（58.64%），见脱敏 `postcutover-aggregate-comparison.json`。这是惰性迁移后的该时点体积，不代表所有历史已迁出，也不代表 uncertain 已解决。剩余热状态中 performance 历史约 31.09 MB（91.8%，34,145 个点），用于 daily/weekly/inception 报表及覆盖连续性；当前 monitor 仍读取并随热状态变化重写它，不能宣称已消除全部大 JSON 搬运。后续 performance cold-store 优化正在隔离实现，尚未发布；历史点不删除，完整读取/coverage 需保持。CPU/RAM/月费节省仍需后续实际计量窗口确认。

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
