# Synax Runtime Protocol v1

状态：本地优先、HTTP/JSON/SSE 首版。

协议标识：`synax.runtime.v1`

## 客户端边界

```text
Web / synax CLI / TypeScript SDK / 其他客户端
                         │ HTTP JSON + SSE
                         ▼
                 Synax Runtime API
                         │
       Native / Codex / Claude Code / ACP / Pi ACP
```

客户端不得直接访问 Runtime SQLite、Session Store 或受管进程。Runtime 是 Session、Run、Step、Permission、Interaction 和事件流的唯一事实源。

## 基础对象

### BackendDescriptor

```json
{
  "id": "codex",
  "label": "Codex CLI",
  "kind": "cli",
  "capabilities": {
    "nativeControls": "unsupported",
    "resume": "supported",
    "permissions": "supported",
    "interactions": "supported",
    "pause": "supported",
    "cancel": "supported",
    "chat": "supported",
    "plan": "unsupported",
    "goal": "unsupported",
    "nativeSessionResume": "supported",
    "jsonlEvents": "supported"
  }
}
```

`supported`、`unsupported` 和 `unverified` 是能力声明，不是对后端内部实现的替代。客户端必须在执行前根据能力判断命令是否可用。

### RuntimeEvent

SSE Run 流中的每个数据帧保持 Runtime 原始事件，同时由客户端包装为：

```json
{
  "protocol": "synax.runtime.v1",
  "sequence": 42,
  "sessionId": "ars_example",
  "runId": "run_example",
  "type": "message_delta",
  "payload": {
    "type": "message_delta",
    "runId": "run_example",
    "stepId": "step_example",
    "delta": "hello"
  }
}
```

`sequence` 由 Runtime Journal 提供。断线重连时使用 `after=<sequence>`，客户端必须丢弃已经消费过的序号。

未知 `type` 必须保留整个 `payload`，不能因为客户端版本较旧而丢弃事件。

## HTTP 客户端流程

客户端可以先读取协议版本和 RPC 方法目录：

```text
GET /api/agent-runtime/protocol
```

`/backends` 响应也包含同一个 `protocol` 字段，旧客户端可以忽略新增字段。

```text
GET  /api/agent-runtime/backends
POST /api/agent-runtime/sessions
POST /api/agent-runtime/sessions/:sessionId/runs
GET  /api/agent-runtime/sessions/:sessionId/runs/:runId/stream?after=0
GET  /api/agent-runtime/sessions/:sessionId/runs/:runId
```

Run 提交必须同时携带请求体中的 `requestId` 和 `Idempotency-Key`。客户端断线后只重新观察，不重复提交 Run。

Permission 和 Interaction 是两个独立资源：

```text
GET  /api/agent-runtime/sessions/:sessionId/permissions
POST /api/agent-runtime/sessions/:sessionId/permissions/:permissionId/reply

GET  /api/agent-runtime/sessions/:sessionId/interactions
POST /api/agent-runtime/sessions/:sessionId/interactions/:interactionId/reply
```

取消、暂停和恢复使用 Session 控制接口；取消成功的判断以 Runtime 返回的 Session/Run 终态和进程停止确认作为准，不以 HTTP 请求返回或 SSE 断开作为准。

## CLI 输出

```bash
synax exec --jsonl --project <project-id> "检查项目"
synax rpc
```

`--jsonl` 的 stdout 只输出事件；诊断信息写入 stderr。`rpc` 的 stdin/stdout 都是 JSONL，每个请求包含：

```json
{"id":1,"method":"backends.list","params":{}}
```

普通响应：

```json
{"id":1,"ok":true,"result":{"items":[]}}
```

流式方法会输出多个带 `event` 的响应，最后输出持久化 Run 结果。

## 退出码

| 退出码 | 含义 |
|---:|---|
| `0` | Run completed 或命令成功 |
| `1` | Agent/Runtime Run failed |
| `2` | cancelled 或 interrupted |
| `3` | 参数、配置或认证错误 |
| `4` | waiting_permission、waiting_input 或 blocked |
| `5` | Transport failure 或 unconfirmed stop |

非交互执行遇到 Permission 或 Interaction 时必须输出结构化事件并退出 `4`，不能无限等待 stdin。

## 当前实现位置

- Runtime Protocol：`api/services/agent-runtime/runtime-protocol.ts`
- HTTP/JSON/SSE Client：`api/services/agent-runtime/runtime-client.ts`
- CLI：`cli/index.ts`
- 编译产物：`server-dist/cli.cjs`

安装包中的 `synax` 命令会从自身包目录定位 `server-dist/server.cjs`，而不是从调用者的当前目录查找 Runtime。调用者当前目录只用于创建 Session 的 `workDir` 和自动匹配本地 Project。

同进程 `InProcessTransport` 和完整 `createRuntimeKernel()` 尚未在本阶段启用；后续必须复用同一套协议和事件语义。
