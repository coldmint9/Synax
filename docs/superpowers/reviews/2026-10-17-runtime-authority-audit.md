# Rust runtime 完成条件审计（2026-10-17）

总目标：完成全部 Rust + Tokio + RocksDB + Moka sidecar 重构，保留原有产品功能，SQLite runtime 仅允许离线导入。目标仍为 active。以前通过的测试不等于以下缺口已关闭。

本次在 `296fce3f` 之后重新检查源码，发现 history 基础实现存在并发覆盖、读 receipt 陈旧和同一实体返回多个历史版本的问题，先修复这些会影响后续切换的前置条件。

## 本轮完成

- `runtime-sidecar/src/history.rs`：修改操作在一个 `WriteBatch` 提交对象/索引/head 或 pin/blob/asset 与 receipt，成功返回前 WAL sync。同一会话分片锁保护检查与写入，跨会话分片可并行；32 个 blocking permit 限制存储任务；GC 独占维护锁防止与发布交错。
- 新增 `append_entities` 私有命令，一次追加最多 256 个实体，原子保留原 head、追加新版本、发布新 head 和 receipt。Node 按 768 KiB 预算分批，避免超过 1 MiB IPC 帧。过大实体明确报错，尚未自动切到 blob。
- 查询不再保存或使用持久化 receipt；同一个 query ID 在修改后读取新状态。旧版本留下的 query receipt 不再影响查询结果，但存量 receipt 清理尚未实施。
- 当前 head 的实体遍历改为优先新引用、按实体身份去重，再按消息序号、时间或 plan revision 排序。回滚后不会从全局索引拿回不可达的新版本。
- `runtime-facade.ts` 的 stream、单实体、terminal mirror 改用原子 append；移除 Node 侧多次读 head/创建 root/切 head 的竞态。history revision/request conflict 经 IPC 保留稳定错误码。
- `uiSnapshotAuthoritative()` 仅查询 Rust，不再因 missing projection 隐式读取 SQLite 和 seed。显式 `ensureUiProjection()` 仍是待删除的创建兼容边界。
- HTTP 会话 tombstone、environment 中的会话/工具/消息/附件名/子会话数据、input-source 内容、invocation usage 读取 Rust。工具名称和 workspace 解析不再重新查询 SQL 会话。
- authoritative process ownership 已开始切换：新 launcher lease 不再创建 `agent_runtime_processes` SQLite 行；lease open/close 进入 Rust control state。authoritative recovery、host shutdown 和 recovery acknowledge 从 Rust `processLeases` 枚举并停止进程；session worker、owned command/managed process、terminal PTY 在实际 start 前等待 lease 写入完成；authoritative terminal 不再更新 SQLite process row，非 authoritative fixture 仍保留 SQLite ownership。
- auxiliary usage 已增加 Rust history `runtime.aux_usage` 版本实体和 `list_aux_usage` 读路径；authoritative stats 会聚合 Rust auxiliary usage，非 authoritative 仍使用 SQLite。
- RuntimeFacade 已登记 authoritative work/context/plan/part/artifact history writes，并在 terminal finish 前 await pending writes；save 调用本身仍是同步兼容 API，未完成时会由 finish barrier 暴露错误。
- history `page` 已支持有界 JSON cursor（queue + seen），不再只返回单个 next 节点；新增 DAG 分页测试覆盖无重复、无遗漏。authoritative timeline 已开始使用该 graph cursor；HTTP history window 仍需迁移到同一路径并完成长会话压力验收。
- 新增 Rust durable history outbox：每个 durable hot append 与 stream/session/projection 同一 WriteBatch 保存 outbox event；正常 Node history append 成功后按 append receipt ack，`reconcile_stream` 也消费 outbox、成功写 history 后 ack。旧数据库无 outbox 时仍回退到 hot retention。真实 history smoke 覆盖 hot 已提交、history 缺失、reconcile 后可读；跨 sidecar 双损坏和 outbox GC 仍需继续验收。

## 不能据此标记完成的要求

| 要求 | 当前源码事实 | 完成所需证据 |
| --- | --- | --- |
| session/run 执行权威完全迁移 | `session-store.ts`、`run-admission.ts`、`run-coordinator.ts`、`loop-runtime.ts` 仍读写兼容 SQL；`ensureUiProjection()` 仍读取新 session 元数据 | session 创建、admission、执行、停止、恢复在不创建 runtime SQL 表时可完整运行；删除同步 repository 与隐式镜像 |
| work/context/stats 完整性 | work/context 的 Rust 镜像由兼容同步 API 触发，但 authoritative terminal finish 已等待 pending history writes；aux usage ID 现在包含 session scope，可在进程重启后恢复目标 session，但重启恢复流程和长期一致性仍需验收 | work、context、aux usage 有独立可重试 receipt、重启后可恢复的 awaited 写入与查询；统计保留父子会话、累计 usage、当前可见 context 和零步 run 语义 |
| 进程 ownership 与 recovery | 普通 command/managed process 和 terminal PTY 已等待 Rust lease；WSL runtime metadata 现在随 Rust lease 更新；authoritative terminal 活跃/关闭 metadata 已绕过 SQLite process rows，并开始写入 `runtime.terminal` history；重启后的 output transcript 和 SQL execution context guard 仍未完整迁移 | 所有 launcher 在执行前等待 Rust lease，退出/restart/reconcile 用 Rust 权威记录；移除 SQL execution lease guard |
| history 唯一写源 | authoritative finish 已不再调用 SQL 扫描补偿；`persistSessionHistory()` 仍保留给非-authoritative fixture；part/artifact/plan 的部分调用仍 fire-and-forget | authoritative 实体生命周期直接 await Rust；所有异步镜像改为可等待并在失败时阻断 finish/recovery |
| hot/history 故障一致性 | durable outbox 已与 durable hot append 同批写入，reconcile 成功后 ack；旧数据 fallback 和 outbox 长期清理/双故障验收仍未完成 | durable outbox 在两次提交之间 kill 后可修复 history，不丢 transcript；补偿游标、GC 和双故障行为有测试 |
| 大历史分页与内存预算 | Rust `page()`、authoritative timeline、history window 和 message content 已有 revision 绑定 graph cursor；详情实体和部分 history API 仍调用完整 `list_indexed()` | 全部历史 HTTP 读路径使用 revision 绑定的有界分页，长历史不超过 IPC/内存预算；无遗漏、无重复的分页验收 |
| 高吞吐长会话 | 新 append 消除了多次 IPC/head 竞态，但链式 root 仍保留旧版本，尚未验证长期增长成本 | 长会话读取、并发 append、压缩/GC 与 p99/RSS 的全链路指标，不能用 runtime-hot benchmark 代替 |
| 增量 GC | `gc()` 仍一次扫描整个对象图和索引，并占用 history 维护锁 | 有界批次、可恢复游标、live root 保护；history 维护不长时间阻塞其他会话 |
| checkpoint/fork/rollback 原功能 | Rust preview/apply 明确只处理 conversation；workspace 文件回滚尚未等价；fork 仍在 Node 复制并重映射对象 | 文件恢复、冲突保护、原子恢复流程，以及结构共享 fork 的功能与复杂度证据 |
| 旧 history 清理 | flat/versioned/JSONL/checkpoint 模块仍被线上路径导入 | 在线依赖图不含旧模式；旧实现仅供离线迁移，迁移与 purge 后完成无 SQL runtime 启动验收 |
| 真实外部 provider | 本地兼容 HTTP provider + 独立 worker 验收已通过 | 使用外部 provider 凭证的一次实际会话与工具/permission/input/recovery 验收；不能以本地 fixture 替代 |
| 最终平台与包 | workflow `39028912468` 对当前代码线 `fc643bf5` 及其父提交已成功：Windows Named Pipe/NSIS/packaged smoke、macOS arm64/x64、Linux 和 Rust release tests 均通过；当前 HEAD DMG 已重建并通过 packaged smoke | 最终实现 commit 的 Windows Named Pipe/NSIS/packaged smoke、macOS arm64/x64 和 Linux；保留外部 provider 凭证和旧 history 清理证据 |

## 验证范围

- Rust unit suite：63 项通过，其中新增并发追加/重复请求、整批拒绝无部分写入、重启 receipt、查询不落 receipt、旧 query receipt 忽略、回滚可见性。
- `runtime-sidecar-history-smoke.ts`：真实私有 IPC 32 路并发追加、同实体更新只返回最新版、重复请求、稳定 conflict code、SIGKILL 后 head/receipt/history 恢复。
- 真实 coordinator lifecycle 和本地 provider-worker smoke 通过；provider-worker 仍不等于外部凭证验收。
- focused Node/HTTP suite：56 项通过。新增 HTTP gate 禁止 session/history SQL 查询；明确允许尚未迁移的 `agent_runtime_processes` 子进程登记，不能据此声称整个 environment 路径无 SQLite。
- 全量 Vitest：370 个测试文件，2988 项通过，1 项跳过。
- process ownership/recovery focused suite：16 项通过；managed command/terminal focused suite 13 项通过；真实 recovery smoke、forked worker smoke 通过。WSL 和 terminal compatibility metadata 仍需独立验收。
- Windows protobuf smoke 的 race 修复已由 workflow `39025558762` 验证；Windows Named Pipe smoke 通过。
- 最新 workflow `39028912468` 已再次验证四平台和 Windows Named Pipe smoke；当前 HEAD DMG SHA-256 为 `f945e24dee00b07d5f4184892edc722da6bfcd5dcc6e65af281cbb4019028895`。

后续依赖顺序：先完成 session/run/work/context/ownership 的异步权威 repository 和 awaited writes，删除 terminal SQL 扫描；再完成 hot/history 恢复、分页/GC、文件 checkpoint 等价与旧模块清理；最后用无 runtime SQL 表的完整业务路径、外部 provider、长会话压测与最终平台包证明目标完成。
