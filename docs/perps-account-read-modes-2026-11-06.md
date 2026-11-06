# Perps 只读余额模式与安全诊断

未知但非空的 `accountAbstraction` 曾按独立 Perps/Spot 账户核算，可能重复加入 Spot USDC。账户读取现在只接受明确的 Standard、Dex abstraction、Unified、Portfolio Margin 模式及已有兼容别名。缺失、未知、未来枚举和含糊的 UI 标签均保持不可用；确认两代钱包均 `NOT_CREATED` 的零余额路径保留。

这是读取核算规则，与执行支持分别校验。未改执行模式、账户归属、资金预检、限流、策略或 feature flags。合法的只读 Portfolio Margin / Dex abstraction 不会因执行不支持而被一概拒绝。

## 核算依据

- Standard / Dex abstraction 保留独立 Perps 账户值，再加可完整估值的 Spot 资产；Spot USDC 扣除其 hold 后计入可用金额。
- 当前 Core `hyperliquidAccountState` 的 Unified / Portfolio Margin 分支将 Spot **USDC** 的 total / available 分别映射到 `accountValue` / `withdrawable`，并附带 `spotClearinghouseState`。因此 USDC 不再加入一次，其他正余额 Spot 资产仍须独立定价；缺价或缺证据保持不可用，不新增现金回退规则。
- 同一物理钱包只计一次，但每个 selector 都须先通过模式验证。首个 selector 读取失败后，完整的同模式 alias 仍可提供已核实小计；完整总额仍未知。明确的重复钱包模式矛盾会剔除该钱包此前的小计，不影响其他独立钱包。
- 部分钱包失败时，原有已核实小计仍可保留；完整总额、完整可用金额和跟单额度不因此变成已知。借贷或其他无法用现有核算规则证明的金额不会补零。

[Hyperliquid 官方模式文档](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes) 说明独立余额与统一余额的区别，并规定 Unified / Portfolio Margin 的余额和 holds 位于 Spot clearinghouse。Core 的 USDC 映射另以 `predictly_server` 的 `crates/api/src/schema/query.rs` 中 `hyperliquid_abstraction_uses_unified_balance` 分支核对；若 Core 改为全资产总额，必须同步更改此读端与契约测试。

## 安全诊断

Perps 失败响应新增 `diagnostic_request_id`、`read_diagnostics`；相同诊断以固定事件 `account_balance_read_failure` 写日志。仅包含随机 request ID、固定 selector / stage / reason code，以及存在时的 HTTP 状态。不会输出用户、钱包、token、URL、GraphQL 或上游原文。

分类区分 Core HTTP / GraphQL / 限流 / 超时、账户归属与陈旧快照、模式、Spot 读取、定价和金额校验。Core `HYPERLIQUID_RATE_LIMITED` 与本地 VenueReads `VENUE_RATE_LIMITED` 分别分类；HTTP 503 不因 body 里的限流或认证字样被重分类。已有明确认证错误继续传播 `AUTH_REQUIRED`，不会伪装成余额读取失败。

这些分类用于定位失败阶段，不能单凭同期另一个路由的 503 / 429 判定同一请求或用户的根因。部署成功、匿名契约测试通过和真实账户恢复须分别记录。

## 验证

`src/account_balances.test.ts` 覆盖未知/缺失/未来模式、四种读模式、USDC 去重与其他 Spot 估值、重复钱包及冲突、确认零余额、partial availability、安全故障分类、认证传播及诊断 sink 失败。执行保护另由现有 `perps_account`、Unified 与账户读取回归确认。所有测试仅使用匿名假响应；不扫描、创建任务或触发金融操作。
