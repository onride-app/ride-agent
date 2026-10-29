# Rider 当前状态与接手顺序

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

- 多monitor scheduler lease与跨进程Hyperliquid IP-weight限流预算；同进程加权gate已由`a4402eb`实现，不能再列为完全未实现。
- 数据量增长时JSONB用户state、长事务/外部网络等待的拆分设计；维护graceful shutdown，不删除原记录来排障。
- 自动prediction redemption未实现；ambiguous receipts、merge/redeem classification、dust可持续attention。不能显示为完成。
- Unified/RWA/portfolio margin有明确支持边界；看Core和部署flags，不以UI选项推断任意账户可执行。
- pinned旧客户端迁移/版本兼容、外网issuer/Privy redirects、各宿主inline funding能力需独立检查。
- 产品负责人、值班、备份恢复、告警和真实验收的owner/截止日期：TBD – confirm。
