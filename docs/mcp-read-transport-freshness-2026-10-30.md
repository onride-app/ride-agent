# MCP 读取限流与原始快照时间

2026-10-30。此次修复保留完整账户范围、历史分页、原 20 秒账户观察期限、12 秒 wire 期限和每进程 1000 权重/60 秒保护。不改变手动接管、签名、订单、组合配置或 App 发布流程。

## 已确认的问题

生产 `f9d277b` 的一段自然观察中，Node bridge 记录 10 次读取、76 已计权重和 7 次真实 HTTP 429；两个原组合没有生成新快照。该采样连接提前断开，不能作为完整验收，也不能据此认定某个共享出口是根因。

另一个确定的代码错误是 source 在多个 dex 读取完成后使用结束时间标记先前返回的仓位，能够把超过 5 秒的数据变成新鲜数据。`readWithEvidence` 现在保留最初 dispatch 时间，缓存命中和 single-flight 加入不改时间；完整 source 使用最早 scope 时间并在结束时检查新鲜度。

## 可选的受控读取路径

`RIDE_AGENT_INFO_READ_ROUTE` 默认 `official`。值为 `core` 时，bridge 的主网 Info 读取通过已有 S2S 凭据调用固定 `/internal/agent-core/perps_info_read`。Core 必须先部署该操作并开启独立 gate，配置与现有读取服务完全相同的 managed account scope、Redis 和供应商额度。不得创建另一份独立供应商预算或提高上限。testnet 保留原官方路径。

Core 使用已有官方优先、限流后托管备用的共享读取客户端。General + Trading 保证新上游观察，不使用展示响应缓存或历史前缀缓存。只接受白名单读取 payload，不接受 URL、header 或 exchange action。Node 原权重准入仍在 Core 调用之前执行；没有自动直连备用或额外重试。

Node 传递实际剩余 wire 的绝对截止时间，Core 限制整个协调与读取期限。Node 保留本地 dispatch 和 Core 读取起点中较早的时间，不能以 Core hop、下载或 JSON 完成时间刷新证据。

只有固定 Core 操作返回的有效 503 typed receipt 能证明 `upstream_request_sent=false`，此时原 ticket 结算为零。未知、网络中断和非契约错误保留原保守计费；真实供应商限流保持全局冷却并清理缓存。

## 诊断与验收边界

`venue_read_budget.transport` 区分 `official` 与 `core_shared_info`。`actual_fetch` 统计 Node transport dispatch；Core 模式下它包含内部 HTTP 调用，不能解释为 Hyperliquid 全部实际调用次数。`coordinated_no_upstream` 标识可信未发上游的拒绝，`charged_weight` 已扣除其退款。供应商调用、备用成功与内部准入须结合 Core 诊断核对。

429 诊断仅输出固定内容类型、server 家族、Retry-After 类型和数值计数，不输出正文、原始 header、edge ID、地址、URL 或凭据。诊断失败不能阻断冷却或缓存清理。

本地测试、打包、Git 推送、部署和真实组合连续新鲜快照分别记录。上线后需观察原组合自然快照、source 证据和至少三个完整限流窗口，保留全部失败样本。无 429 或健康检查通过不能代替快照恢复；真实跟单成交仍需独立业务证据，读取验收不授权金融操作。
