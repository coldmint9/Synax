# Native runtime 模块边界

LLM 的远端连接、供应商协议、流式解码、请求策略和重试由 Rust 统一执行。Node 不加载 AI SDK，也不创建供应商客户端；它负责业务配置选择、工具执行、资源访问与保存，以及本地 IPC 和界面事件转换。

```text
src/
  main.rs              进程装配、监听器和关闭顺序
  llm/                 唯一的供应商执行层
    contract.rs        Node/Rust 请求契约
    client.rs          Rig 客户端创建
    request.rs         请求构造、原生选项和托管工具
    messages.rs        消息、附件、工具结果和推理历史映射
    completion.rs      流式生成与完整响应
    policy.rs          思考参数、结构化输出兼容
    cache.rs           缓存键、标记预算与 TTL 顺序
    metadata.rs        明确的内容元数据透传
    retry.rs           429/5xx 指数退避与重试状态
    deadline.rs        上游流式空闲超时
    media.rs           图片、语音、转录的远端传输
    tool_names.rs      工具名称校验和映射
    errors.rs          可分类的供应商错误与工具参数修复
    tokenizer.rs       共享 token 估计
  agent/               模型/工具循环、上下文压缩和完成策略
  runtime/             会话分片、执行租约、输入队列和投影
  transport/           HTTP、WebSocket/本地套接字、线协议和流控
  storage/jsonl/       日志、事务、历史页、资源和恢复
  workspace/           工作区索引
```

`llm` 不依赖 Node 或 `agent`；`agent` 调用 `llm`，`transport` 只负责鉴权、协议边界和连接生命周期。会话新写入使用 `events-v2/` 增量日志，旧格式仍由只读兼容层解析。

## 本地接口

- `/provider/stream`：对话及辅助文本，输出统一 NDJSON 事件。
- `/provider/prepare`：只准备请求，不访问远端；供缓存诊断和契约验证使用。返回值不包含 API Key 或自定义请求头。
- `/media/stream`：统一媒体操作，返回预览或最终文件内容；文件的持久化由 Node 资源层完成。
- `/agent-loop/*`：Rust 循环的开始、恢复、上下文、工具结果、取消和事件订阅。

桥接客户端只连接本机，不根据 429/5xx 在 Node 再发起一轮请求。默认重试 10 次，等待从 2 秒翻倍，单次上限 300 秒；开始交付内容后不自动重放已交付内容。取消连接或原生循环会丢弃请求和等待。调用者显式指定的 `maxRetries` 仍由 Rust 执行。

配置和模型目录中的 `@ai-sdk/*` 字符串仅作为已保存配置的兼容标识，不能用于动态加载 Node 包。新供应商协议或媒体能力应添加在 `llm` 中；不支持的能力明确返回错误。

## 结构化运行日志

Rust 使用 `tracing` + `tracing-subscriber` JSON formatter + `tracing-appender`。
所有本项目日志均采用固定事件名和显式字段，不序列化完整请求、错误对象或响应。`stdout` 只输出 `SYNAX_RUNTIME_READY` 握手；诊断日志输出到文件和 `stderr`。

### 保存与查询

- 原生日志：`$DATA_ROOT/logs/runtime.YYYY-MM-DD.jsonl`，时间戳与轮转均使用**系统本地时区**（遵循 `TZ`），时间戳明确带偏移，例如 `2026-10-21T15:26:36.669554+08:00`。最多保留 7 个日期文件，重启不会额外删除历史。桌面默认数据目录为 `~/.synax/v2`。文件写入独立于 Node，独立启动 Rust 也可留存诊断信息。
- Node 按行解析 Rust JSON，将原级别、发生时间（保留原时区偏移和微秒精度）、事件字段和 span 关联信息接入现有 `api-YYYY-MM-DD.log` / `events-YYYY-MM-DD.jsonl`；新写入的 Node 日志也带本地时区偏移，文件按宿主本地日期归档并保留 7 天。历史 UTC 日志保持原样。
- `/api/logs` 与 `/api/logs/stats/daily` 包含 Rust 记录，`context.source` 为 `rust-runtime`。`context.sidecarPid`、`generation` 区分进程重启，`context.spans` 保留完整链路，同时将关联字段放到 context 顶层便于查询。
- 存储目录 `runtime-sidecar/jsonl` 是会话数据与恢复日志；诊断日志位于上述 `logs` 目录。

### 配置

| 环境变量 | 行为 |
| --- | --- |
| `LOG_LEVEL` | 默认 `info`，支持 `trace/debug/info/warn/error`；`fatal` 映射为 `error`，`silent/off` 禁用 Rust 日志。默认只启用本项目 target。 |
| `RUST_LOG` | 优先于 `LOG_LEVEL`，支持按模块过滤。非法配置回退到 `LOG_LEVEL` 并产生告警。Rust 已过滤的记录进入 Node 后不再受 Node 全局级别二次过滤。 |
| `SYNAX_RUNTIME_LOG_DIR` | 覆盖原生日志目录。受管进程默认由 supervisor 指定为当前数据根下的 `logs`；独立进程依次使用此变量、`DATA_ROOT/logs`、`SYNAX_RUNTIME_STORE_PATH` 的数据根下 `logs`。 |

仅调试模型与 Agent 循环，保留其余模块的正常日志：

```sh
RUST_LOG='off,synax_runtime_sidecar=info,synax_runtime_sidecar::llm=debug,synax_runtime_sidecar::agent=debug' npm run dev
```

读取原生日志，或筛选失败与重试：

```sh
tail -F "$HOME/.synax/v2/logs/runtime.$(date +%F).jsonl"
rg 'provider.failed|provider.retry_scheduled|agent.failed' "$HOME/.synax/v2/logs"/runtime.*.jsonl
```

### 覆盖与关联

| 路径 | 事件与字段 |
| --- | --- |
| 进程 | `runtime.starting/ready/stopping/stopped/failed/panic/service_failed/task_failed`；PID、版本、启动阶段、退出原因、监听端口。 |
| HTTP / socket | `http.received/completed/rejected/failed`、`transport.failed/auth_rejected/backpressure`、`runtime.command_completed/command_failed`；请求 ID、连接 ID、已知路由、状态码、操作名、会话 ID、耗时。正常请求细节为 debug。 |
| LLM / 媒体 | `provider.started/usage/completed/failed/cancelled`；供应商、模型、协议/操作、请求 ID、耗时、token 用量、错误类别和 HTTP 状态。 |
| 重试 | `provider.retry_scheduled/retrying/recovered/retries_exhausted/retry_skipped`；次数、预算、等待时间、是否已交付内容。 |
| Agent | `agent.started/resumed/phase/tools_waiting/tools_ready/tool_result/completed/cancel_requested/cancelled/failed/terminal_commit_failed`；loop/session/run ID、步骤、阶段、工具调用 ID、等待耗时、结果状态。 |
| 存储 | `storage.opened/session_loaded/flushed/tail_recovered/io_failed/append_failed/sync_failed/corrupt/checkpoint_failed`；耗时、恢复偏移、错误类别、OS 错误码。 |

关联 span 在只启用 warn/error 时也保留；异步任务显式继承上下文，stream 每次 poll 时进入 span，避免并发请求串线。模型流只记录边界和用量，不逐 token 写日志。提示词、思考与输出正文、工具参数/结果、API Key、请求头、URL 查询串和上游原始错误正文不会进入本项目的结构化日志。panic 只记录源码位置。显式用宽泛的 `RUST_LOG=trace` 开启第三方库日志会超出这一字段约束，排查时应使用上述模块过滤。

### 性能与故障行为

文件与 stderr 各有一个后台写线程和 8192 条容量的独立队列；Rust 调用线程负责结构化格式化，I/O 在线程外执行。队列满时丢弃诊断记录以保证 runtime 继续运行，每 30 秒及退出前上报 `logging.dropped`。写入失败计数通过 `logging.write_failed` 上报；文件初始化失败产生 `logging.file_unavailable`，stderr 仍可接入 Node。Node 接收端限制单行大小为 64 Ki 字符，超长记录产生 `logging.line_dropped`，随后恢复解析。

正常退出由 `WorkerGuard` 刷新队列，supervisor 等待 stderr 排空。强制终止、进程崩溃、磁盘故障或持续背压下仍可能丢失尾部诊断日志；它们不承担会话持久化职责。现有 Node 日志存储仍使用其同步写入路径，Rust 的独立文件队列不会等待 Node 完成落盘。

父进程先退出、关闭日志读端时，stderr 的 `BrokenPipe` / `ConnectionReset` / `NotConnected` 被识别为可选日志通道断开：只记录一次 `logging.stderr_closed`，关闭后续 stderr 写入，文件日志继续保存。其他 I/O 错误仍计数并上报 `logging.write_failed`，不会被静默忽略。

桌面端等待 API READY 的上限为 120 秒，覆盖 Rust 启动之后的存储载入和会话恢复。Node 的 `runtime.startup_phase` 记录各阶段开始、完成和耗时，便于区分启动慢与 Rust 崩溃。

## 验证

```sh
npm run runtime-sidecar:check
npm run runtime-sidecar:test
node scripts/runtime-sidecar-cargo.mjs build
SYNAX_RUNTIME_SIDECAR_BIN="$PWD/runtime-sidecar/target/debug/synax-runtime-sidecar" npm test -- services/local-node/infrastructure/llm-runtime
npm run typecheck
```

供应商集成测试使用真实 Rust 进程和本地模拟 HTTP 服务，验证实际发出的请求；重试次数和长等待用 Rust 暂停时钟测试，避免真实等待数分钟。

## 无恢复快照的会话存储

Agent Loop 的请求上下文、工具定义和执行阶段仅存在于当前进程内，不写入 `loops/*.jsonl`。同进程断线重连与权限/输入等待仍可继续；执行宿主或 Rust 进程重启后，未完成运行进入中断状态，用户继续对话会创建新运行。`loop-receipts/` 只保存请求指纹及运行标识，防止启动确认丢失导致重复执行。

会话 `events-v2/<segment>/` 保存事件、字段差量和事务提交范围。系统提示词以内容哈希引用保存一次，提交标记不含会话正文、完整状态或投影。`uiSnapshot` 是内存读取接口。会话列表索引从已提交记录重建，仅驻留内存；不再追加全局 `index/list.000000`。已提交的正文和思考在中断后仍可读取，磁盘确认前的尾部内容不作持久化保证。

旧会话文件和全局索引不迁移、不清理。旧历史只读，新正式历史追加到 `history/history-v2.000000`；读取先重放旧历史，再应用新记录。文件撤销的修改前内容和上下文压缩摘要继续保留。此次更新降低后续数据增长，不自动回收已有磁盘占用。旧客户端不支持新写入格式，升级后不能用旧版本追加这些会话。
