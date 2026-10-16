# Agent Runtime Rust Sidecar 分阶段落地计划

日期：2026-10-16

设计规格：`docs/design/2026-10-16-agent-runtime-rust-sidecar.md`

基线：`origin/main` / `22ed239a8939ae66bfd2fee650de16057521de1d`

## 2026-10-16 实现审计与继续目标

目标模式保持 active：升级 Electron，并完成整个 Rust runtime 重构；下面的基础验收不代表整个重构完成。

| 要求 | 当前证据 / 真实状态 | 剩余工作 |
| --- | --- | --- |
| Electron 原生 WebSocket | 从 39.8.10 升级并固定 44.8.0；真实 Electron `app://` + sandbox Renderer 通过 JSON/Protobuf 直连 Rust probe，主进程原生 WebSocket 可用 | authoritative 模式下业务会话页面已通过 preload/ticket 直连 Rust；默认切换仍待仓库和历史迁移 |
| 桌面打包 | Forge prePackage 自动编译 locked release Rust，并收录 server-dist/workers；Electron 44 打包和桌面 smoke 已通过 | Windows 构建/传输尚未在目标机验收 |
| Tokio + Moka | 多线程 Tokio；缓存现已改为 moka::future::Cache；写入完成/未知确认后失效 | 全局内存预算、负载下限流与压测 |
| group commit | 新增有界 WAL 提交线程，最多 64 请求/2ms 成组，flush_wal(true) 后才返回成功；阻塞刷盘、错误传播、合并测试 | 实际磁盘故障、负载 p99、停机排空验收 |
| run 生命周期 | 新增 finish_run Protobuf，原子完成 run/清除 active/推进 epoch 与 revision/写 receipt；旧 run 写入被拒绝；重试旧 receipt 不复活 run | stop/resume/recovery/lease 的完整状态机仍未完成 |
| Node 执行接入 | Unix control connection 复用、每连接/全局有界并发、关闭排空、握手与 health 校验、断线重连；append receipt 支持提交后确认丢失的幂等重试；coordinator 在执行前 await Rust admission，流写入固定 admission epoch 并按 producer 顺序排队，收尾等待写入并完成 run；受控 driver 连续两轮真实 Node→Rust smoke | submit 本身和业务 session/run 记录仍依赖 SQLite；其它 embedded/backend 路径仍需统一；不是纯 Rust admission |
| 实时数据 | 已接入 ticket/preload/原生 WS、流控/重连；Rust 物化 UI 快照与事件在同一 WriteBatch 提交，首次快照由 WS 读取；真实崩溃后 supervisor 与 UI 可恢复；session patch、permission/interaction/stop/resume control 已接入 Rust | 首次空会话元数据仍从 Node seed；完整 session/lease 恢复未完成 |
| 输入队列 | authoritative 模式已改为 Rust 队列；HTTP/自动续跑/goal continuation/force/loop 走异步边界；队列消费与 admission 原子提交 | 旧 session/run/消息行仍为 SQLite，跨 run 未确认 delivery 的恢复界面与离线迁移未完成 |
| 历史与数据迁移 | runtime-history 已有 immutable CAS/head/pin/checkpoint/fork/rollback/page/verify/GC、run/message/step/part/tool index；terminal run 完成会镜像 transcript；migration export/import/verify/rebuild-index 与 benchmark smoke 已有 | 旧 history API 全量切换、media blob 分块、旧实现删除、真实用户数据全量导入验收 |
| 旧链路移除 | 尚未执行 | 删除 runtime SQLite、storage owner/journal writer 会话路径、多模式历史和双游标 |

注意：forked worker smoke 已覆盖独立 Node child → Unix IPC → Rust append，但它仍是受控 provider stub，不是真实 LLM provider 全链路。ephemeral 暂时显式拒绝进入持久事件通道，尚未实现 live-only 通道。Windows Named Pipe 已写入 Tokio transport 路径，但尚未在 Windows 目标机执行构建/烟测。不要把已有 checkbox 推断成上述功能已完成。

2026-10-16 第二轮补充实现：

- UI ticket 只经私有 Unix socket 签发，30 秒过期、单次使用，绑定 client/session；UI 只允许 health/ping/snapshot/replay/subscribe。
- WebSocket 限制 256 连接，upgrade/hello 5 秒超时、1 MiB 帧；订阅最多 64 条 / 2 MiB 在途数据，消费后按已送达 sequence 确认，重复/future ACK 不扩窗。
- 历史回放与 128 槽实时邮箱分离，backlog 最大 4 MiB；实时溢出要求 RESYNC。补充有时限的 close 握手与 close reason，避免未读 ACK 引发 TCP reset 丢掉最后错误帧。
- IPC replay 按 256 条与字节上限分页。持久路径不再在 actor 中复制整份事件历史，fanout 使用 Arc 共享 payload。
- 前后端共享 `packages/runtime-protocol/wire.ts`；新事件使用 `{schema:1, chunk, state}`，状态在提交时捕获。旧实验性 raw chunk payload 需要迁移，不能用当前 SQL 状态假造历史状态。
- Renderer 已接到业务 sessionLiveStream，初次选择明确未启用 Rust 时保持 Node；一旦选择 Rust，连接失败只重连/重建快照，不静默换数据源。媒体/手动压缩辅助事件暂由 Node 独立辅助订阅发送。
- 会话面板显示 Rust 连接恢复状态；Node HTTP 正常不会掩盖会话流断线。

证据：26 项 Rust 测试；真实 Electron adapter 回放 600 条历史 + 25 条重连期间事件无重复，验证 64 条未确认上限、伪造 ACK、慢消费者溢出重同步、跨会话/写操作拒绝、ticket 重用拒绝；打包后的真实业务页面已通过 preload → Node ticket → Rust subscription 验收。最终扩展套件包含 99 项 Node/Electron 与 55 项前端测试，均通过。真实 provider 子进程、Windows、整体吞吐/ENOSPC 验收仍缺失。


当前验收命令：

- `npm run runtime-sidecar:electron-smoke`
- `npm run runtime-sidecar:ui-smoke`（真实 Electron 原生 WS 与共享前端适配器，包含慢消费者/越权测试）
- `npm run runtime-sidecar:lifecycle-smoke`（真实 Node coordinator + Rust，受控执行器，无外部模型）
- `SYNAX_RUNTIME_BENCH_SESSIONS=100 SYNAX_RUNTIME_BENCH_BATCHES=32 npm run runtime-sidecar:benchmark`（2026-10-17 当前 macOS arm64 证据：3500 operations，p50 25.233ms，p95 42.252ms，p99 55.637ms，max 65.890ms；不是发布承诺）
- `npm run runtime-sidecar:worker-process-smoke`（真实 forked Node worker 通过 Unix IPC append Rust-authoritative stream）
- `npm run runtime:migrate:smoke`（SQLite export/verify/import/rebuild-index）
- `npm run runtime-sidecar:test`
- `npm run runtime-sidecar:smoke`、`npm run runtime-sidecar:crash-smoke`
- `npm run typecheck`、`npm run test:desktop`、`npm run build:desktop`
- `SYNAX_RUNTIME_SIDECAR_SUPERVISOR=1 SYNAX_RUNTIME_SIDECAR_ADMISSION=shadow SYNAX_RUNTIME_SIDECAR_STREAM=shadow npm run test:desktop:smoke`

2026-10-16 第三轮执行侧实现：

- Unix control connection 改为每连接 32 个本地任务、全局 128 个执行许可和 8 MiB 响应预算；快请求不会被同连接慢请求队头阻塞，关闭前会有界排空。
- append command 增加 SHA-256 v1 内容指纹与持久化 receipt。相同 session/run/producer/sequence/epoch/durability/events 的重试返回原 receipt，不重复 fanout；内容变化返回 `REQUEST_CONFLICT`。
- 真实 RocksDB `abort_after_append` 测试覆盖“写入完成后进程 abort”；Supervisor 保持 socket/token 稳定，等待 Rust READY + health，并自动重启；Node owner 被 SIGKILL 时 Rust 子进程和 socket 清理。
- Renderer UI smoke 增加真实 Rust 进程 kill/restart 后继续消费，事件序列保持 1..650；连接凭证在重启后重新签发。

2026-10-16 第四轮：Rust 持久化 UI projection

- 新增 RocksDB `ui_projections` CF；seed 只允许创建尚无事件/执行状态的空会话，已存在 projection 永不被 seed 覆盖。
- 新增 Protobuf `seed_ui` / `ui_snapshot` / `ui_snapshot_response`。只有私有 IPC 能 seed；ticket 的只读会话授权允许读取自己的 projection，跨会话读取和 UI seed 被拒绝。
- run admission、finish、stream append 把 projection 与原有状态/receipt/events 写入同一个 WriteBatch。retry 原 receipt 不重放 reducer；确认未知时的重启/retry保持原 cursor 和文本。
- projection 保存 session 初始元数据、最新提交状态、run、当前 step 的合并 delta/tool/retry，以及 completedStepIds；不依赖 1024 条事件保留窗口重建长输出。当前限制为 768 KiB，超出会明确返回 `PROJECTION_TOO_LARGE`，整批不提交；blob 分块尚待 history/CAS 阶段，不能据此宣称支持无限长会话。
- Renderer 收到 READY 后先通过原生 WebSocket 请求持久化快照，再从该 cursor 订阅。preload/ticket HTTP 响应已删除 Node snapshot。Web 的 snapshot compatibility facade 也直接读取 Rust projection，后续快照不再拼接 SQL/session/steps/replay。
- 迁移边界：首次 missing projection 可从 Node session 元数据 seed，但已执行的 SQLite runs 或已产生 Rust stream 的旧会话必须离线迁移，不能伪造空快照。旧元数据更新与 permission/input/history 还没有全部变成 Rust command；仍不得开启全量默认切换。
- 验证：37 项 Rust 测试（1600 事件超出热保留窗后完整快照、重启、错误原子回滚、ACK unknown/幂等、大小边界等）；前端 46 项、Node/Electron 相关最终套件 92 项通过；真实 Electron WS 初始 projection + 重启续传、真实 commit 后 abort 恢复、受控 coordinator 两轮、打包业务页面 + codesign 均已验证。之后的补测以对应命令输出为准。

2026-10-16 第五轮：Rust durable run activation

- admission 后新增 `activate_run` 私有 control command。它只接受相同 session、epoch/revision 下已经 admission 的 queued run document；在 RocksDB 同一 WriteBatch 写入 `run_activated` event、run activation receipt、session cursor、UI projection 和 run document。
- 激活 receipt 使用 `(session, request_id)` 和内容指纹幂等。Node 在 provider/tool 执行前等待 activation；重复请求返回原 snapshot，不重复发布 event；不同 run document 返回 `REQUEST_CONFLICT`。
- 真实 coordinator lifecycle 已验证两轮执行：Rust admission → activation event → provider driver，结束后 replay 事件顺序、epoch/revision 和 projection 状态一致。Rust 测试扩展到 38 项。
- 仍未迁移 SQLite 的 run/session 业务行写入；SQLite 是兼容查询和 Node 执行上下文的旧权威。下一步是把 activate/finish 的 Node store 更新改为 projection/read model，并迁移 permission/input/stop/resume command。

2026-10-16 第六轮：Rust terminal run completion

- `finish_run` 接受完整 terminal run document，校验 run/session/status/completedAt/stopReason，缺失完成时间由 Rust 生成并固定在 receipt。
- finish 与 `run_finished` canonical event、最终 run document、session epoch/revision、UI projection、transition receipt 在同一 WriteBatch 提交；在线 subscriber 只收到一次结束事件。
- `executionLease.closed` 在 Rust 最终文档中落为 true；projection、stream payload、RocksDB run document 使用相同最终文档。`DURABILITY_UNKNOWN` 后重试保持同一 timestamp/cursor/event。
- 支持 `blocked` terminal run：session 展示保持现有兼容映射，run 保留 blocked status 和 blockedReason，active run 被释放。
- 真实 lifecycle、finish 后 abort/restart、Electron online completion、旧 receipt、错误回滚和 blocked terminal 测试均通过；Rust 测试扩展到 45 项。
- SQLite 仍作为 Node compatibility read model；permission/interaction/input queue/stop/resume/history 写路径还未全部迁移。

2026-10-16 第七轮：Rust input queue cutover

- `ui_projections` 保存最多 20 条 / 512 KiB 的 input queue、force marker、queue revision 和未确认 delivery。queue 更新生成 `input_queue_changed` canonical event，并与 session revision、projection、receipt 同一 WriteBatch 提交。
- 私有 IPC `queue_read`/`queue_mutation` 已接通；支持 enqueue/remove/move/force/clear_force/consume/ack_consume、幂等 request receipt 和 epoch/revision 校验。越界 reorder 沿用原有 no-op 语义，队列满/无效项不会提交。
- authoritative 模式的 HTTP、coordinator、goal continuation、loop 和 work.yield 均通过 `inputQueueRuntime` 异步接口。Rust 是队列唯一读写源；旧同步 `inputQueueService` 被显式禁止。非 cutover 模式保留旧实现，尚未全项目默认切换。
- coordinator 将选中 item 放入已接受 run 的 runtime metadata；Rust admission 校验该 item 与持久队列一致，在同一 WriteBatch 消费并保存 admission receipt。失败时队列仍保留，提交后确认丢失时 receipt 可恢复且不重复消费。
- 强制输入采用 durable delivery → 本地消息保存 → ACK，使用确定性消息 ID 防止重复插入。中断/重启后可重取未确认 delivery；若该 delivery 的 run 已经终止，当前会保留恢复阻塞，尚需接入完整跨 host/lease recovery UI。
- 前端从 Rust canonical queue event 刷新队列，即使消费发生在 admission 而不是 Node HTTP 请求中也能更新。
- 验证：51 项 Rust 测试；最终 Node/domain 套件 152 项（含 loop suite 74 项）通过；27 项前端相关测试通过。真实 queue smoke 覆盖 HTTP、排序、重启、原子 admission 消费、FIFO coordinator、forced delivery 恢复/重复 ACK，并断言 SQLite 无 inputQueue/inputForceInjectId 写入。该 smoke 使用受控执行器，没有外部模型。最终服务器注入边界补测 77 项（含 loop 74 项）通过；重建的 Electron 44 arm64 应用、业务会话 preload→Rust 快照/订阅、退出清理和 codesign 校验通过；打包复用了本机已校验的 Electron 44.8.0 缓存 zip。
- 剩余边界：run admission 的 Node 预检/业务行仍在 SQLite，媒体引用和输入消息内容也尚未迁移；旧数据 offline import、permission/interaction/stop/resume、history/CAS、Windows 和吞吐验证未完成。

后续顺序：推进 session/run/control 的异步 Rust repository，把剩余 session 元数据写入/permission/interaction/stop/resume 迁成 Rust command，完成旧数据和未确认 delivery 恢复；接入所有执行后端和故障恢复；实现 history 与迁移；删除旧实现；最后执行真实业务、故障、吞吐的全量验收。任何阶段未验收都不得标记整体完成。

## 总目标

交付一个以 Rust + Tokio + RocksDB + Moka 为核心的 agent runtime sidecar：

- Rust sidecar 成为 session/run/stream/control 的权威状态机；
- Electron renderer 使用本地随机端口 WebSocket；
- Node Runtime Host 使用 Unix socket 或 Windows Named Pipe；
- Web 部署继续保持现有 HTTP/SSE 兼容；
- LLM、MCP、ACP、workspace、Git、terminal 和 browser 继续由 Node 执行；
- SQLite 只承担一次性导入源，不再作为新 runtime 的线上 fallback。

## 目标树

```text
G0 设计和基准冻结
├── G0.1 最新 HEAD 摸排完成
├── G0.2 设计规格和阶段计划入库
├── G0.3 建立性能、故障和协议验收表
└── G0.4 明确不迁移边界

G1 Rust sidecar 可启动、可发现、可健康检查
├── G1.1 Cargo package 和 binary
├── G1.2 Tokio multi-thread runtime
├── G1.3 WebSocket UI listener
├── G1.4 Unix socket / Windows transport abstraction
├── G1.5 READY/health/version handshake
└── G1.6 sidecar supervisor 和优雅退出

G2 Runtime 协议和 session actor
├── G2.1 protobuf envelope
├── G2.2 request receipt/idempotency
├── G2.3 epoch/revision fencing
├── G2.4 session shard mailbox
├── G2.5 bounded queue/backpressure
└── G2.6 snapshot/replay/subscribe

G3 runtime-hot RocksDB
├── G3.1 session/run/step schema
├── G3.2 stream batch schema
├── G3.3 interaction/permission/input queue
├── G3.4 process lease/recovery
├── G3.5 Moka cache
└── G3.6 crash/retry/compaction tests

G4 Node RuntimeFacade 和流式链路切换
├── G4.1 sidecar client
├── G4.2 run admission adapter
├── G4.3 stream writer adapter
├── G4.4 runtime journal compatibility facade
├── G4.5 Node worker direct append
└── G4.6 Web API/SSE compatibility

G5 Electron WebSocket data plane
├── G5.1 UI ticket endpoint
├── G5.2 preload connection ticket
├── G5.3 native WebSocket client
├── G5.4 credit window/backpressure
├── G5.5 reconnect/resync
└── G5.6 desktop smoke and crash recovery

G6 runtime-history RocksDB
├── G6.1 messages/parts/events/tool calls
├── G6.2 content-addressed history objects
├── G6.3 heads/pins/checkpoints
├── G6.4 fork/rollback
├── G6.5 incremental GC
└── G6.6 history UI compatibility

G7 离线导入与旧实现清理
├── G7.1 SQLite/session-log exporter
├── G7.2 sidecar importer
├── G7.3 verify/quarantine report
├── G7.4 one-shot migration smoke
├── G7.5 删除 storage owner/journal writer
└── G7.6 删除 runtime SQLite fallback
```

## 阶段 0：设计和基准冻结

状态：文档与摸排已完成；性能基线和验收设计仍未完成。IPC 拓扑图已落在 `docs/design/2026-10-16-agent-runtime-ipc-topology.md`。

本阶段交付：

- [x] 同步 `origin/main` 到 `22ed239a`；
- [x] 完成最新 HEAD runtime、Electron sidecar、前端 stream 结构摸排；
- [x] 写入 `docs/design/2026-10-16-agent-runtime-rust-sidecar.md`；
- [x] 写入协议消息清单和错误码表；
- [ ] 写入性能、故障和兼容性验收脚本设计；
- [x] 确认 sidecar binary 的桌面打包路径；
- [x] 确认第一阶段只做 runtime-hot，不迁移 history。

退出条件：

- 设计规格和阶段计划被 review；
- runtime-hot 的 command/event/schema 清单固定；
- 第一阶段不再修改现有业务行为，只新增 sidecar 基础设施。

## 阶段 1：Rust sidecar skeleton

状态：已接入 Node supervisor 与 Electron 自动打包；Windows、启动失败清理、崩溃恢复与优雅排空仍需完善。

阶段 1 的 health/handshake stub 使用 JSON binary frame，目的是先冻结进程生命周期和 transport 行为；进入阶段 2 后，业务 command/event envelope 必须切换到 protobuf binary schema。

目标：sidecar 可以被 Node/Electron 启动、发现、健康检查和安全停止。

建议新增：

```text
runtime-sidecar/
  Cargo.toml
  Cargo.lock
  src/main.rs
  src/config.rs
  src/health.rs
  src/transport.rs
  src/protocol.rs
```

验收：

- Rust binary 启动耗时可测量；
- 输出 `runtime_ready`，包含 pid、port、protocol、capabilities；
- WebSocket `/runtime` 能完成 hello/auth/close；
- Unix socket 能完成 request/response；
- 未认证连接在固定时间内关闭；
- sidecar 退出不会遗留 socket；
- Node supervisor 能检测进程异常并重启；
- macOS/Linux/Windows transport 编译路径明确。

## 阶段 2：协议和 session actor

状态：已完成内存 actor、protobuf command transport 和基础 live subscription；RocksDB 持久化留在阶段 3。

目标：实现不依赖 RocksDB 的内存 session actor，先验证顺序、幂等、epoch 和背压。

验收：

- [x] 同一个 session 的 command 按 producer sequence 排序；
- [x] 不同 session 路由到独立 shard actor；
- [x] 重复 request_id 返回原 receipt；
- [x] 相同 request_id 不同 body 返回 `REQUEST_CONFLICT`；
- [x] 旧 epoch 写入返回 `STALE_EPOCH`；
- [x] revision 不匹配返回 `REVISION_CONFLICT`；
- [x] mailbox 超限返回 `BACKPRESSURE`；
- [x] subscribe 支持 snapshot_then_live 和 replay_after_cursor；
- [x] 慢客户端被丢弃或要求 resync，不阻塞其他 session。

## 阶段 3：runtime-hot RocksDB 和 Moka

状态：HotStore、WriteBatch、异步 Moka、实际 WAL group commit、Rust control state 和 runtime-history CAS 已实现；完整状态模型与压力/故障验收未完成。

目标：实现权威 session/run/stream/control 状态。

验收：

- [x] run admission 使用单个 WriteBatch；
- [x] stream batch sequence 单调递增；
- [x] canonical event 使用 sync durability；
- [x] group commit durability 字段进入 protobuf、actor、RocksDB WriteBatch，replay sequence 不重复；
- [x] sidecar 重启后可恢复 session snapshot 和 cursor；
- [x] Moka cache 命中不改变 revision/epoch 语义；
- [x] 基础 compaction 后 canonical event 可 replay；
- [x] 多线程 group-commit 写入后并行 compaction/replay 保持 cursor 和 sequence 完整；
- [x] 磁盘满/写入不可用映射为稳定 `DiskFull` 错误且不创建 receipt；
- [ ] 真实 ENOSPC 压测。
- [x] 注入提交后 ack unknown 后，receipt 查询和幂等重试结果稳定；
- [x] 真实进程在 commit 后 ack 前崩溃，重启后 request receipt/reused admission 收敛；
- [ ] ENOSPC 和高并发 compaction 压测。

## 阶段 4：Node RuntimeFacade 和 stream cutover

状态：Node client、supervisor、authoritative stream、coordinator admission/finalization、control/session patch command、history command 已接入；terminal run 完成后 Rust history 可查询 run/message/step/part/tool call；authoritative session/run/message/steps/tool route 已有 Rust 读路径，兼容 repository 仍为 SQLite，完整权威状态切换未完成。

目标：Node agent loop 使用 sidecar 作为 runtime 状态源，外部 API 行为保持不变。

验收：

- [x] 新增 sidecar protobuf codec 和 Unix-socket request client；
- [x] 添加 Node client 的真实 Unix socket fake-server 回归测试；
- [x] 新增显式开关控制的 Rust sidecar supervisor 和 READY/shutdown 生命周期；
- [x] 真实 Node `http-server` supervisor smoke 验证 sidecar startup、HTTP health 和 shutdown；
- [x] 新增 `RuntimeFacade` shadow admission 验证边界；
- [ ] authoritative `RuntimeFacade` 取代全部 HTTP route 的 runtime SQLite；当前 session snapshot、runs、messages、permissions/interactions 已有 Rust 路径，列表/step/part/history 仍在迁移；
- `run-coordinator.ts` 使用 sidecar admission/stop/finalize；
- [x] `runtime-stream-writer.ts` 增加 shadow sidecar append 验证边界；
- [x] `runtime-stream-writer.ts` 增加可配置 authoritative append；
- [x] `runtime-journal.ts` 增加可配置 sidecar replay/snapshot projection；
- [x] 通过真实 Node↔Rust authoritative stream smoke 验证 append/replay/payload/sequence；
- [x] 通过同进程 `recordRuntimeStream`/`RuntimeStreamWriter` 受控生成器 smoke 验证 authoritative append/replay；
- [x] 通过真实 forked Node worker smoke 验证 child process → Unix IPC → Rust append/replay；真实 LLM provider 全链路仍待验收；
- Node worker 可以直接向 sidecar 写 stream batch；
- `/runs/:runId/stream` 可以从 sidecar cursor replay；
- `/sessions/:sessionId/stream` 仍然支持 SSE；
- 现有 CLI 不需要改变调用语义；
- SQLite runtime 表不再是活跃 session 的权威来源。

## 阶段 5：Electron WebSocket

状态：ticket、preload、业务页面原生 WS、窗口/重连/重同步已落地并完成真实 Electron 验收；Unix control 与 Windows Named Pipe transport 代码已接入。初始 UI 快照已由 Rust 物化并通过 WebSocket 读取，真实进程重启恢复已验收；Windows 目标机 smoke、session 元数据 seed 清理和默认切换未完成。

目标：桌面端实时会话切换到 Rust sidecar WebSocket。

验收：

- Electron 主进程拿到 sidecar port 和短期 ticket；
- renderer 能完成 auth 和 session subscribe；
- credit window 生效；
- 页面切换和重连从 cursor 继续；
- `RESYNC_REQUIRED` 能触发 snapshot 重建；
- sidecar 崩溃时前端显示连接恢复状态；
- Web 部署仍走 HTTP/SSE fallback；
- 不把长期 token 放到 URL query。

## 阶段 6：runtime-history RocksDB

当前进度：已完成 immutable object CAS、head/pin/checkpoint、fork/rollback、page、verify、GC、`rebuild_index`、run/message/tool index、terminal mirror 和离线迁移 CLI 的最小可运行闭环；尚未替换全部旧 history API。

目标：统一旧 flat/versioned/JSONL history 为新的 immutable history store。

验收：

- messages/parts/tool calls/events 可以分页读取；
- history head 切换不复制整段历史；
- checkpoint/fork/rollback 通过 head 和 pin 工作；
- 大消息和媒体使用 chunk/blob 引用；
- GC 增量执行，不阻塞 runtime-hot；
- 现有 history API 和 UI 行为保持一致；
- 旧 runtime history 可以离线导入。

## 阶段 7：旧实现删除

目标：删除线上 SQLite runtime 和重复进程链路。

删除候选：

- `agent_runtime_stream_records` 线上读写；
- `SessionLog` runtime replay；
- journal writer child；
- storage owner runtime path；
- `FILE_REPLAY_BASE` 双游标；
- runtime 直接 SQLite repository；
- flat/versioned/JSONL 多模式开关；
- runtime read service 中对旧 runtime 表的只读 fallback。

保留：

- SQLite 离线导入工具；
- history verify 工具；
- Node provider/tool/process 能力；
- HTTP/SSE Web 兼容层。

## 当前下一步

以本文顶部的实现审计和后续顺序为准；完整目标保持 active。
