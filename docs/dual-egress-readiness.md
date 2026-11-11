# 双物理出口只读协调（默认关闭）

这是在 R61 基线上的本地实现；没有叠加 R62 的双 soft-clock/75秒策略。配置、源码测试、真实物理出口、生产运行及成交验收是独立门。当前代码和协议本身不证明存在两个独立出口，不授权分配 IP、改云配置或下单。

稳定 authority 必须覆盖所有可能实际发送 Hyperliquid REST 的 A writers 完整出口并集，以及 Gateway 全部出口；两者都须是完整、非空、互不重叠的已证明公共 IPv4 集合。不同地域、URL、scope 字符串、secret/status/epoch 回显不是 NAT 证明。未证明动态 writer、存活退休 IP 债务、混合旧 Lua writers 或多活路由时，不得开启。

## 一套父窗口、两个真实账本

Core A/G 各900，Node 各真实物理 bank1000；原整个父窗口的 A+S+H 仍不超过900。既有 Feed650/reconciliation780/signing1050/critical1100 等 class caps 不变。账本唯一 key 为稳定 physical bank ID；binding、epoch、boot、deployment 和 IP-set digest 只是校验元数据，不能制造免费 namespace。

仅新 prepared `audit_source`/`audit_submit` 使用 V3。普通完整 A 与独立 fresh-submit 保持原 R61 v1/v2 协调/同 A 账；Core 所有 A admission 路径必须先升级为同一 V3 eligible-head 规则。G cold/429/status 不可用不能冻结纯 A。

每个 V3 episode 先取得真实严格200、零 hold parked ACK，再按 A 原有 soft cadence 和两个真实 hard gates 等待。唯一前置例外是实际 A 正在运行的纯 `READ_LOCAL_BUSY`：不读取其 dirty PG hint、不加本地 interest、不发新票；原 entry FIRST100 保留。已有或 ACK 未知的 V3 票必须同 UUID/FIRST/intent 解析并 park，不能用“尚无验证 ACK”创建新票。

Core pending 只可累积未用 S/H hold，A hold/deficit 在 S 未齐时为零。S 真齐且完整 A 可用时，一次原子 dual grant 启动唯一 active20。Node 仅在该严格 grant 之后，同步完整建立 A bundle 和独立 `SourceReservation`，两本地 book 中间没有 await。局部竞态只消耗原20秒余量；失败释放未用本地容量并精确清理原 Core 票，不分期授信或重新给20秒。

A parent 只计真实的一/两个 A child，保原 pacer/真实计费/成本学习。S/H controller 类型独立，不能伪造 A child、A cost plan 或账户完整性。`audit_submit` 的 S 也独立保留，不能借首个 A 预计退款。每个 H pool、全量计费、unknown debt、原 source cutoff/完整分页、Fixed cursor、risk/owned-exit 和未知 execution 原 ID 规则继续有效。S/H 失败不允许旧单 bank parent、换票/换 FIRST 或错 bank 重读。

账户30秒、source-at-use5秒、provider12秒、唯一 grant20秒及原 FIRST100秒都未放宽；不把不完整账户或失败的 source/history 解释成完整证据。

## 私有阶段决定输运

真实 A 仍由原 App/Core 出口直达 official。私有 S/H 阶段与 public SourceFeed 走 Core → 既有 Gateway → 固定 official host 的 IPv4 POST `/info`。A 内部即使使用 source lane 的 metadata，仍属于 A bank。缓存/flight 不跨 bank；不同完整 public-source producer 也不共享旧 boot flight，单个观察/分页固定自己的 binding。已完成 metadata 仅保原 TTL/原 evidence 时间，不刷新金融证据。

Gateway 只有窄 read-client token 与独立 forward HMAC key，无 DB、Redis、CoreServiceToken 或交易签名 key。只有固定 read schema/host/path，无任意 URL、redirect、retry、exchange。既有 `get_portfolio` 余额读取也加入同一个 G bank；只注入 Hyperliquid fetch，Bearer GraphQL/Polygon 保原 fetch，22秒总体/10秒单读信号每次独立。

forward capability 使用原 quota claim 的单用 read ID、实际 boot 和 exact request-json bytes hash。official 前必须 Core redeem CAS；Gateway 从原 remaining 扣完整 redeem RTT 和后续 elapsed，且原余额 caller 还受自己的本地10/22秒截止。所有 hop 都包含在原 provider12/父20内。evidence 使用 Core 转发前的保守时刻，不能以 Gateway 完成时间变新。

未知发送/不完整响应保留整笔原 claim 到最后可能 dispatch+60秒；已知 actual 全量结算也不提前缩掉该保守上界。Node 用预算自身 clock 的剩余 duration 保留，不能把 Date.now 绝对值塞给 performance clock。初版 V3 失败不提供零退款证明；HTTP 错误、断连或无 outbox 不证明官方未收到，更不证明金融未执行。

## 启动、重启和退役

同一原始14字段 authority 的 UTF8 SHA 是稳定 authority ID。Core 独立 pin 实际 Gateway deployment；Gateway 从实际运行环境报 service/deployment，并每次进程随机 boot。runtime binding 是稳定 authority+实际 boot 的固定 ASCII digest，仅用于新父窗口。

相同已证明 service/deployment/static mapping 内的正常重启可通过窄 authenticated status 和 Core 权威协调学习新 nonce。旧 parent/claim 不迁移、不续20/FIRST、不清 unknown/paid debt。新 deployment 不自动收养。任何 IP 变更或跨 bank 重分配，先完整 drain 两 bank 直到最后可能 dispatch+60及所有未知负债，再明确 cold；初次 G ledger 必须全900保守 cold60，nonce 重启不再 cold 或空账。回退旧 writer 之前必须 drain/fence 所有 V3。

本地 stub、单元控制和实际 Rust/Lua/Gateway 互通不等于真实 provider、物理出口、自然 A/P 联合窗口或签名成交。默认保持所有 V3/forward flags 关闭。
