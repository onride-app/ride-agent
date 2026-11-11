# R65 prepared 请求的零额度晋升仲裁

默认关闭 `RIDE_AGENT_PREPARED_PROMOTION_V1_ENABLED`。只有严格 `true` 且 V3 双物理账本配置有效时启用；配置错误在创建 PG pool 前拒绝。不接受公开请求参数，不缓存账户证据，不更改费用。

同一个真实 A budget 共用至多64项、仅存在于当前准备调用中的本地仲裁。已有 continuation 必须是 coordinator 私有验证的 pending UUID/FIRST，才在 metadata IO 前注册；新 episode 在严格200零 hold ACK 后注册。排序使用原 FIRST、同期限按本地注册顺序，仅决定当前合格 prepared 调用的本地晋升次序，不声称改变 Core 全局 FIFO。

尚在验证的旧调用只能在原 wall/monotonic20秒、caller signal、原 FIRST100 内保留位置，当前 A soft/BUSY/FIFO 与 G hard gate 都合格时才阻止较新 prepared 晋升。失败、取消、超期或完成准备即撤销注册；休眠旧票不注册，也不会成为永久头部。

一次晋升权只跨一个 ready Core RPC、严格完整 ACK、一次无 await 的 G/A 同步建账。随后立即释放，不等待子读取、PG claim、source/history 或金融执行。已知 G partial/pending 或 ACK unknown 立即释放本地权，不取消/park 真实 Core 票以释放额度，原 UUID/FIRST/control_seq、partial hold 和真实费用仍保留。未知 intent 的后续 pending 不足以清除未知；只有严格 park ACK 才能隔离先前可能晚到的 ready 请求。

普通 A 和独立 fresh-submit 继续 R61/R64 原路径，不受此 prepared 仲裁阻塞。如果它们在 Core await 期间占用了本地 A，prepared 完整 grant 只尝试一次本地建账，失败则回滚本次未用 G、本地 interest，并 END 原 frame；END unknown 仍由原 retiring 机制保留，不换 UUID/FIRST 或重新获得20秒。已发送、已付或未知旧工作不能被称为本次 UNSENT 或退款。

此优化只覆盖当前已验证 prepared 调用之间的次序和竞态。未知协议状态保留原保守协调路径，不能据此宣称所有 grant→wire 等待都消失。audit_submit 仍在同一父预约中完整建两份 A，不增加子读取之间等待。原 A/G1000、Core900、800 soft allowance、FIRST100/active20、A30/source5/provider12、完整 H、游标、风控与未知 execution 原 ID 均不变。

读取费用继续采用 R64 `known-paid-fee-expiry-v1`，共同附注 SHA256 `df0b9bb552e37c30c135a3f775b477174cb920f6d3072faed5ab7863dff806e7`。本地控制、源码检查和 Linux 组件构建分别记录；它们不能替代原 A/P 联合窗口、物理出口、真实 provider 或成交验收。
