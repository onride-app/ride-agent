# R64 已知读取费用的保留时间

本修订为显式语义版本 `known-paid-fee-expiry-v1`。共同附注 `r64-known-paid-expiry-contract-r0.json` 的 SHA-256 为 `df0b9bb552e37c30c135a3f775b477174cb920f6d3072faed5ab7863dff806e7`。它修改已确认费用的过期策略；R63 原合同、源码与失败窗口保留，不能将本修订描述为原合同已有行为。

`VenueReads` 只有在完整响应 JSON 和真实费用分类通过后才调用正数 `ticket.settle(actual)`。此路径保留全部 actual weight 和已知完成时刻 `charge.at`，清除该票此前的未来未知保留上界，使实际费用按原有滚动规则保留至完成后 60 秒。收到对应完整响应的时刻晚于其实际发出时刻，因此此边界仍覆盖真实发出后的完整 60 秒。费用超出预订或上限仍全部计入 debt。

`uncertain()`、release、abort、finally、END、无效费用、严格 UNSENT 的零费用分支和重复结算不获得该已知证明。未决或结果未知的请求继续保留原最晚发出截止后 60 秒。`settled` 这个内部标记也会用于未知保守记账，不能据此批量缩短费用；若 Core 已知成功但返回 Node 的响应丢失，Node 仍维持未知边界。

跨仓配对的 Core 修订仅在可信完整响应及费用分类后收紧 paid event score；原 claim deadline、retain_until、read receipt、claim GC、单次 redeem、原 UUID/FIRST/active20 和 replay/fence 元数据不变。Node 的已知费用采用自身完成时钟，原相对 `retainFor` 接口不会把 wall clock 时间戳混入 performance clock。

此策略不改变实际费用、provider cooldown、配额上限、账本身份、FIFO、source/history 完整性、账户新鲜度、风控、游标或交易路径。默认关闭的原读取路径没有新增远程保留期限。启用前仍须配对源码与所有 writer 的兼容性核验；V3 ACK 本身不证明全服务已采用该策略。已知读取费用结算也不等于完整账户证据、完整规划或成交成功。

本地针对性验证覆盖 wall/performance 两种时钟的 known60/unknown72、非法与重复结算、未截断的 late actual5000/debt，以及原 provider cooldown。R63 双门失败不被这些单元测试覆盖或改写；后续联合窗口与生产验收须独立进行。
