# Agent Runtime Rust Sidecar 分阶段落地计划

日期：2026-10-16

设计规格：`docs/design/2026-10-16-agent-runtime-rust-sidecar.md`

基线：`origin/main` / `22ed239a8939ae66bfd2fee650de16057521de1d`

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

状态：已完成

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

状态：已完成基础 skeleton，等待 Node/Electron supervisor 接入。

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

状态：HotStore、WriteBatch、Moka snapshot cache 和 actor 持久路径已完成基础实现；group commit、崩溃注入和 compaction 验收仍在进行。

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

状态：Node client、supervisor、shadow 验证和 authoritative stream adapter code 已完成；完整 Node runtime 验证与 admission cutover 尚未完成。

目标：Node agent loop 使用 sidecar 作为 runtime 状态源，外部 API 行为保持不变。

验收：

- [x] 新增 sidecar protobuf codec 和 Unix-socket request client；
- [x] 添加 Node client 的真实 Unix socket fake-server 回归测试；
- [x] 新增显式开关控制的 Rust sidecar supervisor 和 READY/shutdown 生命周期；
- [x] 新增 `RuntimeFacade` shadow admission 验证边界；
- [ ] authoritative `RuntimeFacade` 取代 HTTP route 的 runtime SQLite；
- `run-coordinator.ts` 使用 sidecar admission/stop/finalize；
- [x] `runtime-stream-writer.ts` 增加 shadow sidecar append 验证边界；
- [x] `runtime-stream-writer.ts` 增加可配置 authoritative append；
- [x] `runtime-journal.ts` 增加可配置 sidecar replay/snapshot projection；
- [x] 通过真实 Node↔Rust authoritative stream smoke 验证 append/replay/payload/sequence；
- [ ] 在真实 agent worker 运行中验证 authoritative stream adapter；
- Node worker 可以直接向 sidecar 写 stream batch；
- `/runs/:runId/stream` 可以从 sidecar cursor replay；
- `/sessions/:sessionId/stream` 仍然支持 SSE；
- 现有 CLI 不需要改变调用语义；
- SQLite runtime 表不再是活跃 session 的权威来源。

## 阶段 5：Electron WebSocket

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

下一步完成阶段 3 的高并发 compaction/ENOSPC 压测；同时继续把 Node shadow facade 推向 authoritative stream adapter，并验证 supervisor 下的真实 Node runtime。
