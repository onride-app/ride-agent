# 原执行 ID 的只读恢复

`CoreBridge.execution` 遇到 Perps execution 没有本地 outbox 时，通过 Core 的
`perps_execution_recovery` 请求原 task 的正证据。请求只携带热状态已保存的
`user_id/account_id/execution_id/fingerprint/asset/target_quantity/created_at/expires_at`。
原数量和时间直接保留；不从当前价格、余额或配置补算缺失的 submit payload。

Core 必须在与提交一致的锁边界内核验用户、账户、网络、原 intent/task、原数量、
wallet generation 和 execution epoch。Node 要求 v1 `accepted/ORIGINAL_TASK_FOUND`
证明，八个原身份字段精确回显，非空原 intent/task UUID，原 generation/epoch 与当前
受验证身份相符，显式 serialization 标记，以及不超过 30 秒的观察时效。generation
必须是正整数。Core 不能只回显输入就声称完成这些校验。

缺少原数量、原 generation、原 epoch 或其他必要证据，`unknown/not_found`、旧 Core
不支持、超时、错账户或陈旧证明都继续保留 uncertain。空仓、过期、本地 outbox 缺失
以及查询不到记录，均不是“从未提交”的证明。这个只读 recovery 协议只有正证据；
永久退休原 ID 使用下述独立写协议。

恢复成功只取原 task，继续读取同一 task 的状态和新鲜账户证据。accepted 不代表
成交；原 task ID 保存及重启后，每次 Perps 状态响应仍须精确返回该 task ID 和有效
状态枚举，缺失或不匹配时保持 unknown。
终态需要 Core 明确给出两个 settlement 标记，仍有待结算标记时保留 settling。
两个标记明确解除后才接受 completed/failed/superseded；已接受但失败的 task 保留
原 task ID 并结束该执行，不进入再次 submit。
缺失 outbox 不会被补建，原金融身份与冻结字段不被重写。既有用户行锁事务负责保存
恢复后的 task/status，没有新增 Node 恢复状态表。

## 永久拒绝已证明未受理的原 ID

`perps_execution_retirement` 是明确的 Core 写操作，不在 Core 的只读 allowlist 中。
Node 只在 `RIDE_AGENT_READ_ONLY=false` 明确设置、mainnet、原执行到期且没有 task 的
uncertain 对账中调用；true 或未设置均不调用。这个操作不下单、签名、合成冻结
target percentage/leverage/policy，也不解除仍有交易证据的 unknown。

Core 在同一 epoch/account/writer 锁边界检查原用户全部历史 binding 的完整
intent/task/leg 证据图。只有确认原 ID 没有受理证据、没有冲突且原目标已到期，才
建立永久拒绝 tombstone；数据库插入 guard 同时约束旧、新写入方。未来同用户的
同原 ID 即使换 account 或 fingerprint 也不能晚到提交。已有原 intent、部分交易、
冲突或证据不足时继续 unknown。数据库历史权威边界和升级 barrier 由 Core 实现
验证，不能从当前空仓或本地缺 outbox 推断。

Node 只接受 `original_absence_retired/ORIGINAL_ABSENCE_PERMANENTLY_RETIRED`：原八字段
精确匹配、30 秒内新鲜观察、非空 tombstone UUID/current epoch/retirement epoch、
`retired_at` 在原 expiry 与观察时间之间，以及三个显式的 serialized/permanent/
historical-bindings 标记。退休时的 epoch 可以不同于重复查询时的当前 epoch；原
拒绝 fence 永久有效，不借当前 epoch 伪造旧 epoch。

完整 typed receipt 保存在原 `Execution.retirement`，由 runner 在原用户事务内
二次验证后与原 execution 的 failed 状态一起提交。它只表示原目标未受理且该 ID
永久拒绝，不是 fill、收益或结算证据。持久 receipt 可在重启后直接验证消费，
无需每 30 秒重做写操作；保存丢失或响应超时则仍 uncertain，下次以同一 ID 幂等
确认同一 fence。任何带退休元数据的旧 ID 均不得进入 submit，异常元数据保持
fail closed。退休代码不修改 portfolio/sleeve 状态、预算、风控、授权或新目标。

有完整冻结 outbox、但 response 为 NULL 的执行继续使用原
`perps_execution_acceptance` 协议恢复 accepted 原 task。旧 v1 `not_accepted_expired`
仅作只读观察，本次 Node 统一要求新的永久拒绝 receipt 才能将无 task 的 Perps
unknown 转终态；新写协议不支持或证明不足时保持 unknown。没有完整原字段不能
把它替换成猜测的 payload。两条路径都
不创建新 execution ID、不重放下单、不签名、不取消保护或修改策略。

发布顺序是 Core 所需数据库 guard 与 RPC/API 先上线，再更新 App owner 的固定 Node 模块。切换仍须
保留唯一 monitor、原 gates、原数据库和 drain 边界。上线后核验原 ID、Core task、
自然新鲜观察及实际 venue fill；运行健康或隔离测试不代表真实账户成交验收。
特别是旧记录缺少原始锚点时，部署新代码后仍会保持 uncertain。

永久退休协议还须先应用 Core 的
`deploy/sql/agent_original_execution_retirement.sql`（含旧 writer barrier、插入 guard
和独立 schema receipt，不加入全局 SQLx migrations），再部署 Core RPC/API，最后
更新 Node。operator 必须核实实役 runtime/writer roles 的表权限。回退必须保留已产生的 tombstone 和
数据库 guard，不能用旧快照覆盖永久拒绝证据。

本地回归：

```sh
npx tsx --test src/agent/execution-core-recovery.test.ts src/agent/execution-acceptance.test.ts
npx tsx --test src/agent/execution-retirement.test.ts
RIDE_AGENT_TEST_DATABASE_URL=<isolated-loopback-postgres> npx tsx --test src/agent/execution-core-recovery-pg.test.ts
```

真实 PostgreSQL 回归使用独立随机 schema，覆盖缺 outbox/重启/账户读取失败、NULL
response 原冻结 payload 不变、同一原 task，以及 pending/failed/superseded 状态。
还覆盖退休响应丢失、同 fence 重试、runner 事务持久化及重启、read-only、不改风险
参数和 Node 拒绝退休原 ID 的晚到 submit。Core 的实际数据库 insert guard/旧 writer
竞争另由 Core 仓的真实 PostgreSQL 测试验证。
Core 和 venue 响应是明确的隔离 fixture，不是真实交易或生产未知执行的解除证据。
