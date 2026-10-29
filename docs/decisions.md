# Rider 技术决策记录

核对日期 2026-10-29，源码以远程 `a4402eb` 为准（本地工作树 `f20f87e`，差异已核对）。以下依据源码、Git 提交和已有仓库文档；“推断”明确标识，不冒充当时讨论。历史验收结果只适用于记录中的范围。

| 决策 | 原因、代价与证据 |
|---|---|
| 公司分发统一为 Rider / `@onride/agent` / `onride-app/ride-agent` | 原个人包命名与公司所有权脱节；迁移保留 `ride` CLI、MCP key、URL 与用户 OAuth 配置，减少破坏。旧 pinned installer 无法远程修改电脑，仍需一次迁移。详见 [迁移记录](ride-agent-migration.md)。 |
| 三个 Node 进程 + 私有 Core/worker | gateway 处理客户端/OAuth，backend 持久化与调度，bridge 接 Core。签名在既有 workers，S2S 密钥分层。隔离信任与部署职责是依据代码的设计理由推断；私有 Core 为外部依赖，不能只部署本仓就得到完整执行。 |
| machine trade scope 只创建 frozen proposal | 对话授权与实际资金动作分离；proposal owner/revision/hash/expiry 防止过期/跨用户/被修改的确认。人类 Core session 和可撤销 bounded grant 是执行门槛；不能通过改 SDK annotations 绕过。见 `contracts.ts`, `human.ts`, `service.ts`。 |
| PostgreSQL JSONB 用户状态 + 行锁事务 | 每用户多类状态一起原子迁移；避免偏好、提案、账本互相不一致（理由为实现推断）。代价是大 state 读会占行锁，monitor 暂仅单实例，后续可能需拆状态/leases。见 `repository.ts`。 |
| stable outbox + unknown reconciliation | 网络超时不能证明未下单；同 execution ID、payload、有效期和 policy revision 对账，避免新 ID 重放。部分成交、pending 和 settlement 独立。见 `core_bridge.ts`, `execution-recovery.test.ts`。 |
| 独立 owned sleeve ledger | 总账户净仓不能证明每个跟单 sleeve 的所有权；对冲净额与 gross exposure、fees/funding、external flow 分开，未知收益 `null`。见 `ledger.ts`, `analytics.ts`, `prediction.ts`。 |
| 公开源采样与 follower account 读取分离 | 公开 source 保持独立 5 秒 fresh 观察，account lane 保留容量，减少 follower request 占满所有槽；失败不以陈旧快照掩盖。`a4402eb`进一步引入共享滚动加权预算、response surcharge/unknown debt、公平队列和完整证据deadline。仍未实现跨pod/fleet的IP总预算。见 `source-feed.ts`, `venue-reads.ts`。 |
| 风险系统重选生成新 immutable preview | 显式 system reselect 才重选，保留 sleeve 金额/数量及 copy controls，手动/legacy选择受保护；减少“改风险”悄悄改变用户金额和选择。见 `plan-reselection.ts`, `risk-selection.ts`, `risk-reselection.test.ts`。 |
| 固定金额模式须证明 required margin 与最小订单 | 小预算可预览，不能保证每个订单满足 venue minimum；对话必填信息明确、margin证据不足不得暗中补假设。见 `d9e59c3`、`docs/confirmation-cards.md`、`order-precheck.ts`。 |
| fresh execution evidence 与 unused suppressed shadow recovery | 早期被入场偏差抑制的 shadow 不应要求不存在的 follower close；只在完整 source/fill 负证据且无任何 owned历史时清除。旧 outbox 未知结果仍不能换 ID。见 `4eaa8fc`、[修复记录](copy-execution-evidence-2026-10-28.md)。 |
| Fixed source market scope 和 fill ordering 严格验证 | 不同 source市场/未知时间顺序不能被当成完整 fill coverage；同结构revision的重新观察也有时序边界。见 `93668cf`、[scope记录](source-fill-scope-and-order-2026-10-28.md)。 |
| shutdown 先关闭 pre-callback reader，失败连接销毁 | 旧 session 在大 JSONB `ClientWrite` 卡住持锁；先等 runner 再关库会永远等不到。20s/25s deadlines+45s drain 限制挂起，已进入 callback 的外部副作用继续 durable对账。见 `d318719`、[事件与真实PG验证](repository-clientwrite-shutdown-2026-10-28.md)。 |
| 动态 guide +稳定 Skill 安装入口 | 服务器工作流升级不要求所有用户手动重装 Skill；在线guide不可用时新财务提案等恢复。guide不授予权限、运行中tool catalog可能需重连。见 `guide.ts`, `skills/ride/SKILL.md`。 |
| OAuth Redis 持久化；loopback内存例外 | 外网进程重启不应丢 client/code/session；本地开发可简化。Hosted issuer 强制 HTTPS/Redis。见 `server.ts`, `oauth.ts`。 |
| npm OIDC trusted publish + exact version/tag验证 | 避免长期 npm publish token，绑定公司仓库、workflow、环境和reviewed tag；本地pack成功不证明registry可下载。见 `.github/workflows/publish.yml`, `scripts/verify-release.mjs`。 |
| 同进程滚动加权Hyperliquid read gate | `a4402eb`（远程main，PR#30）把所有生产VenueReads实例/两个HL hosts共用60秒预算，按method base/response surcharge核算；未知rows独占预留且不截断真实debt，最长12秒deadline、lane/owner公平排队。原因是简单并发限制不能代表provider按weight计费，避免后台源查询挤掉账户证据。范围仍限同进程，不宣称全fleet。见`venue-read-budget.ts`、`venue-read-cost.ts`及对应tests。 |

## 最新提交与未决事项

本地`f20f87e`统一 Rider 登录和跟单 sizing 文案；远程最新`a4402eb`新增上述weighted budget；两者都不提供任意真实账户的成交证明。未决项包括跨 monitor lease、跨进程交易所限流预算、未知 prediction/redemption/dust 恢复、没有信号的硬杀断联处理和各宿主真实登录/卡片验收。具体负责人与排期：TBD – confirm。

未来改决策时保留触发问题、备选方案、接受的代价、数据迁移/兼容影响和验证范围；不要用历史记录推定当前线上状态。
