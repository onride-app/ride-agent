# 数据库 ClientWrite 断联回收

2026-10-31，本地防复发候选，基于 `7db4c37`，尚未推送或部署。原账户的一条用户状态读取在本轮部署退出界点前启动，其后仍以 PostgreSQL `active / ClientWrite` 持有行锁约 461 秒，阻塞该用户后续状态更新；另一用户继续推进。该读取所属源码与实例尚未独立证明。原独立 99 点窗口的失败保持失败，精准清理及其后运营恢复观察分别记录，不能替代新的完整自然验收。这次不发布 App 或 npm 包。

原 `statement_timeout=20s`、driver `query_timeout=25s` 和关闭 reading socket 的代码仍保留。SQL cancel 或客户端超时并不保证服务端正在向停止接收的连接发送大结果时立即退出；本地真实 Linux PostgreSQL 17.11 对照也显示，300ms statement timeout 和 1s transaction timeout 在超过 1.8 秒后仍可能停在 ClientWrite 并持锁。该结果与 PostgreSQL 的 [ClientWrite 中断路径](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/tcop/postgres.c) 一致，不将 transaction timeout 当作本故障的已验证修复。

候选只在 `PgRepository` 的新连接初始化阶段增加一次配置，使用安装的 `pg 8.23.1` / pg-pool 会等待完成的 `onConnect` hook。在连接 checkout、用户事务和业务 callback 之前，从 `pg_catalog.pg_settings` 读取 `tcp_user_timeout` 的 canonical 整数值和 `ms` 单位：

- 已有 1–20000ms 的更严格值原样保留，不执行新 SET。
- disabled0 或大于 20000ms 时，通过 `pg_catalog.set_config` 将该连接上限设为 20000ms。
- 参数缺失、单位不符、设置失败或返回值不合法均使初始化失败，该连接不能进入业务 callback。
- 原连接 URL 不重写。URL options、PGOPTIONS 的原优先级及 search_path、application_name、转义空格等设置保留。只在 pg 完成原配置解析之后处理 TCP 上限，避免 URL options 静默覆盖单独的 Pool config.options。

这是**连接初始化的 TCP 发送未确认界限**，不是围绕金融 callback 或整个事务的新 wall-time timer。稳定复用连接没有新增 SQL 往返。`migrate/read/transact/users/close` 方法及 MemoryRepository 与 `7db4c37` 字节相同；原行锁、20/25 秒 SQL/driver 边界、5 秒 lock timeout、90 秒 idle transaction 边界、业务顺序和关闭 drain 均未改动。未知提交仍保留原 ID 和原对账路径，不新增自动重放。

尚未被 checkout 持有的初始化连接或空闲连接断线时，pg-pool 已移除故障连接，但仍会向 Pool 发出 `error` 事件。候选增加一个只输出固定文字、且诊断本身不可抛错的监听，避免未监听事件退出进程。初始化 checkout 仍按原错误拒绝，不能进入业务 callback；后续请求重新建立并初始化连接。不会打印驱动错误对象、stack、SQL 或连接信息，也不吞掉已经 checkout 的业务异常。

支持范围依赖服务端 TCP 内核与连接类型。[PostgreSQL TCP 文档](https://www.postgresql.org/docs/17/runtime-config-connection.html#GUC-TCP-USER-TIMEOUT) 说明，此参数只作用于尚未确认的发送数据；不支持的内核或 Unix socket 可报告 effective0。本机 Darwin PostgreSQL 18 实测 SET 成功但 effective 仍为0，因此这些连接明确为 unsupported，不能宣称已经获得服务端保护。测试不会因 Linux effective0 而跳过失败；Darwin 专用回归会明确 skip 两项服务端保证测试。

该上限不等于从查询开始精确计时二十秒；正常持续接收的客户端可以继续传输。若中间代理已经确认上游数据但阻塞了更下游，TCP 上限也不是所有网络故障的通用事务期限，因此原 driver/SQL/关闭保护仍需保留。已经存在的旧孤儿连接不会因新连接初始化自动获得此配置，精准处置旧 reader 是独立操作，不新增全局清理器或自动 terminate。

最终冻结源码已在独占官方 PostgreSQL 17 Linux 容器、独立数据库运行完整套件：**1165/1165 PASS，0 skip，0 fail**；另一个隔离数据库 functional 为 **53/53 PASS**。功能验证使用真实本地 MCP/backend/OAuth/CLI/PG，但 Core 身份和交易所响应仍为 fixture，不能当作原账户成交或自然跟单证明。

新增十一项回归在原精确 `7db4c37` 上保留九项 RED、两项语义控制 PASS。候选覆盖 URL/PGOPTIONS 的0、过大和更严格值、空闲连接复用与新连接、初始化失败不 checkout、关闭与初始化竞态，以及真实提交后注入丢失 COMMIT ACK 时不伪造回滚、不重跑 callback、保持原事件 ID 和完整已提交状态。真实 socket 初始化断线回归在隔离子进程证明旧24行候选会因未监听 Pool error 退出；最终候选保留错误身份、业务 callback 零次、故障连接清空，并能重新建立受保护连接。空闲连接断线且诊断输出主动抛错时也能恢复。旧候选的1164项通过记录与新增回归 RED 分开保留，不覆盖旧证据。

真实 24MiB `SELECT state ... FOR UPDATE` 暂停 socket 读取后，默认 **20000ms** TCP 上限在最终完整套件约 **20.7 秒**由服务端独立终止连接并释放行锁。证明发生前客户端仍 paused，未 resume/destroy/terminate，driver60s未触发，业务 callback 未进入。该测试没有为通过而缩短候选的 TCP 上限。另一个健康连接的已进入 callback 等待约 **21 秒**后仍只提交一次，证明此设置没有变成业务 callback 总时长限制。真实 COMMIT ACK 丢失回归是在数据库完成实际 COMMIT 后注入 transport error，不冒充所有代理故障的网络仿真。

check、build、package、diff-check 均通过。package 只在本地和临时安装目录验证；此防复发候选仍需要独立源码交付、部署身份和完整原账户自然窗口。快照时间戳、完整金融 scope、费用、配额、风险和既有失败样本均未调整。
