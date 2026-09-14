# Synax 使用与对接指南

> 状态：可用于 **Web + Runtime 单节点最小验收场景**
>
> 文档日期：2026-09-14
>
> 当前代码版本：`0.1.1` 工作区快照

这份文档回答两件事：

1. 普通使用者如何启动 Synax、导入项目、选择 Agent 后端并完成一次任务。
2. 外部 Web 客户端、CLI、自动化程序如何通过 Runtime API 对接 Synax。

当前文档以本地优先、单用户、单节点为前提。Desktop Electron 不属于本次最小验收范围；本文的 API 对接方式也不依赖 Electron。

---

## 1. Synax 是什么

Synax 由三层组成：

```text
Web 客户端 / 其他客户端
          │ HTTP + SSE
          ▼
Synax Runtime API
          │
          ├── Native Synax Agent
          ├── ACP 后端
          ├── Codex CLI 原生后端
          └── Claude Code 原生后端
```

核心对象：

- **Project**：一个本地代码库或工作目录。
- **Session**：围绕一个目标的长期会话，固定一个执行后端和工作目录。
- **Run**：Session 的一次执行回合。提交和观察是两个独立动作。
- **Step**：Run 内的执行步骤。
- **Permission**：工具执行前需要用户确认的权限请求。
- **Interaction**：Agent 向用户提出的持久化表单，例如 `AskUserQuestion`。
- **Environment**：工作目录、Git 变化、Agent 改动和输入文件的投影。

重要原则：

- Web 断开只会断开观察连接，不应自动取消已接收的 Run。
- Run 的状态、工具、审批和表单都持久化在 Runtime 数据目录中。
- Session 创建后，执行后端绑定不再根据模型字符串动态切换。
- Native Synax 的权限档位和 Codex/Claude 的原生沙箱、原生审批是两套语义，不能混用。

---

## 2. 本地启动

### 2.1 环境要求

- Node.js `>=22 <23`
- npm 10+
- Git
- tree-sitter 所需的本机构建工具
- 至少一个可用的 LLM 配置，才能使用 Native Synax 或生成 Wiki
- 如果选择 Codex，系统 PATH 中需要有 `codex`
- 如果选择 Claude Code，系统 PATH 中需要有 `claude`

### 2.2 开发模式

```bash
git clone <your-synax-repository>
cd Synax
npm install
npm run dev
```

默认地址：

- Web：`http://localhost:5173`
- Runtime API：`http://localhost:3210`

直接启动不同部分：

```bash
npm run dev:api     # API / Runtime
npm run dev:web     # Vite Web
npm run dev:all     # API + Web
```

### 2.3 编译后启动 Runtime

```bash
npm run build
npm run web:build
npm start
```

`npm start` 启动编译后的 API。生产或隔离运行时建议显式设置数据目录：

```bash
DATA_ROOT="$HOME/.synax" PORT=3210 npm start
```

### 2.4 数据目录

默认数据目录：

```text
~/.synax/
├── context.db
├── runtime-access-token
├── projects.json
├── logs/
└── ...
```

使用隔离实例时，为每个实例指定独立目录：

```bash
DATA_ROOT="$(mktemp -d /tmp/synax-data.XXXXXX)" \
PORT=3210 \
npm start
```

不要让两个不相关的 Runtime 实例共用同一个 `DATA_ROOT`。Runtime 会对数据目录和 Host 所有权进行保护。

---

## 3. Web 使用流程

### 3.1 首次使用

1. 启动 `npm run dev`。
2. 打开 `http://localhost:5173`。
3. 在 Settings 配置 LLM Provider。
4. 导入一个项目目录。
5. 进入 Wiki，按需生成项目 Wiki。
6. 进入 Work，新建 Agent Session。

### 3.2 选择执行后端

新建 Session 时可以选择：

| 后端 ID | UI 名称 | 适用场景 | 权限来源 |
|---|---|---|---|
| `native` | Synax Native | Synax 自己的 chat / plan / goal / Wiki 能力 | Synax permission tier + 原生工具规则 |
| `codex` | Codex CLI | 使用本机 Codex 原生 Agent | Codex sandbox + Codex 原生审批 |
| `claude-code` | Claude Code CLI | 使用本机 Claude Code 原生 Agent | Claude sandbox + Claude 原生审批 |
| `opencode-acp` 等 | ACP | 使用已配置的 ACP Agent | ACP capability / permission 回调 |

后端在 Session 创建时固定。要切换后端，请新建 Session，不要修改已有 Session 的模型字符串来“切换引擎”。

### 3.3 Native Synax 模式

Native Synax 支持：

- `chat`：普通对话和工具执行。
- `plan`：先生成计划，新的计划只出现一次 `Execute / Cancel` 审批。
- `goal`：围绕目标持续推进，使用 Session/Run 的执行限制。

Codex 和 Claude 当前按各自原生 Agent 语义执行，不套用 Native 的 plan/goal 控制工具。

### 3.4 Codex / Claude 的模型与权限

选择原生 CLI 后：

- 模型从对应 CLI 的模型目录读取。
- UI 会显示已发现的模型、推理强度、CLI 版本、原生 Session ID 和工作目录。
- 默认隔离 Synax 的 MCP、插件和 Hooks 注入。
- 不应把 Native 的“只读／读写／无限制”档位当成 CLI 的真实权限控制。
- CLI 后端不接受 Native 的 `permissionTier`、`permissionOverrides`、`maxSteps`、`maxTokens`、`temperature` 覆盖。

Codex：

- 默认使用独立的 MCP/plugin/hook 配置覆盖，不修改用户全局 Codex 配置文件。
- 原生审批请求由 Codex 返回可用决策；UI 只展示后端实际支持的选项。
- 当前验证过的恢复依据是 Codex 原生 thread ID。

Claude Code：

- 使用 Agent SDK / Claude Code 原生 CLI。
- 默认不加载用户、项目和本地 settings source 中的工具配置、MCP、插件、Hooks 和 Skills。
- 只继承经过筛选的 API/网关/云认证环境和模型配置。
- 不使用 claude.ai 订阅 OAuth 登录作为第三方嵌入认证方式。
- 当前验证过的恢复依据是 Claude 原生 Session ID。

---

## 4. Runtime API 对接

### 4.1 API 基地址

假设 Runtime 地址为：

```text
http://127.0.0.1:3210
```

Agent Runtime 路由前缀为：

```text
/api/agent-runtime
```

因此，例如后端目录接口是：

```text
GET http://127.0.0.1:3210/api/agent-runtime/backends
```

项目接口前缀是：

```text
/api/projects
```

### 4.2 认证

Runtime 启动时会在 `${DATA_ROOT}/runtime-access-token` 创建一个 64 位十六进制 Token，文件权限为 `0600`。

#### 浏览器客户端

同源或受信任的本机 Web 客户端调用：

```http
POST /api/auth/session
Origin: http://localhost:5173
Content-Type: application/json

{}
```

服务端返回 HttpOnly、SameSite Cookie。浏览器客户端不需要把 Token 放在 URL 中。

#### CLI / 无界面客户端

读取 Token 文件后，在每个 API 请求中发送：

```http
Authorization: Bearer <RUNTIME_ACCESS_TOKEN>
```

示例：

```bash
TOKEN="$(cat "$DATA_ROOT/runtime-access-token")"
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:3210/api/agent-runtime/backends"
```

注意：

- 不要把 Token 放到 URL query、SSE URL 或日志中。
- 不要把 Token 提交到 Git。
- 默认只允许本机/受信任 Origin 和 Host。
- 如果从其他 Web Origin 访问，需要在 Runtime 配置受信任 Origin；不要绕过 Origin 校验。

### 4.3 健康检查

```bash
curl -fsS http://127.0.0.1:3210/api/health
```

健康检查不等于业务认证成功。真正开始对接时仍应调用一个带认证的 Runtime API，例如：

```bash
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3210/api/agent-runtime/backends
```

---

## 5. 最小 API 流程

下面是第三方客户端应实现的最小闭环：

```text
1. 获取后端目录
2. 创建 Project（如果还没有）
3. 创建 Session
4. 提交 Run，拿到 runId
5. 订阅 Run SSE
6. 如果出现 Permission，等待用户回复
7. 如果出现 Interaction，展示表单并提交答案
8. 观察到终态
9. 需要继续时，用 mode=continue 提交新的 Run
```

### 5.1 获取后端目录

```http
GET /api/agent-runtime/backends
Authorization: Bearer <token>
```

响应结构：

```json
{
  "items": [
    {
      "id": "native",
      "label": "Synax Native",
      "kind": "native",
      "capabilities": {
        "nativeControls": "supported",
        "resume": "supported",
        "permissions": "supported"
      }
    },
    {
      "id": "codex",
      "label": "Codex CLI",
      "kind": "cli",
      "experimental": true,
      "capabilities": {
        "nativeControls": "unsupported",
        "resume": "supported",
        "permissions": "supported"
      }
    }
  ]
}
```

实际返回项可能还包括 `claude-code` 和 ACP 后端。客户端应以接口返回为准，不要硬编码完整列表。

### 5.2 获取后端模型

```http
GET /api/agent-runtime/backends/codex/models
Authorization: Bearer <token>
```

```json
{
  "defaultModel": "gpt-6-astra",
  "models": [
    {
      "id": "default",
      "label": "Default",
      "efforts": ["low", "medium", "high", "xhigh"]
    }
  ]
}
```

Claude：

```http
GET /api/agent-runtime/backends/claude-code/models
Authorization: Bearer <token>
```

如果后端不可用、未安装或认证缺失，接口会返回错误；客户端应将它显示为“当前不可用”，不要把失败包装成空模型列表后静默使用错误后端。

### 5.3 创建 Project

如果项目尚未导入：

```http
POST /api/projects
Authorization: Bearer <token>
Content-Type: application/json
```

本地目录：

```json
{
  "name": "My Repository",
  "environment": "development",
  "source": {
    "kind": "localPath",
    "localPath": "/absolute/path/to/repository"
  }
}
```

Git 仓库：

```json
{
  "name": "My Repository",
  "environment": "development",
  "source": {
    "kind": "git",
    "repoUrl": "git@github.com:example/repository.git",
    "branch": "main"
  }
}
```

创建成功响应为：

```json
{
  "project": {
    "id": "proj-...",
    "name": "My Repository",
    "source": {
      "kind": "localPath",
      "localPath": "/absolute/path/to/repository"
    }
  }
}
```

### 5.4 创建 Session

#### Codex Session

```http
POST /api/agent-runtime/sessions
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "projectId": "proj-...",
  "profileId": "synax",
  "backendId": "codex",
  "model": "default",
  "workDir": "/absolute/path/to/repository",
  "prompt": "Review this repository and report the most important runtime risks.",
  "reasoningEffort": "low"
}
```

#### Claude Code Session

```json
{
  "projectId": "proj-...",
  "profileId": "synax",
  "backendId": "claude-code",
  "model": "haiku",
  "workDir": "/absolute/path/to/repository",
  "prompt": "Read the repository README and summarize the execution architecture.",
  "reasoningEffort": "low"
}
```

#### Native Synax Session

```json
{
  "projectId": "proj-...",
  "profileId": "synax",
  "backendId": "native",
  "model": "custom-api:deepseek/deepseek-chat",
  "workDir": "/absolute/path/to/repository",
  "prompt": "分析这个项目的认证流程并给出一个可执行计划。",
  "reasoningEffort": "high",
  "permissionTier": "readonly"
}
```

创建成功响应包含：

```json
{
  "session": {
    "id": "ars_...",
    "projectId": "proj-...",
    "profileId": "synax",
    "status": "running",
    "activeRunId": null,
    "sessionMetadata": {
      "backend": {
        "version": 1,
        "id": "codex",
        "model": "default",
        "workDir": "/absolute/path/to/repository"
      }
    }
  },
  "profile": {},
  "work": null,
  "context": null
}
```

客户端必须保存 `session.id`。执行后端绑定保存在 `session.sessionMetadata.backend` 中。

### 5.5 提交 Run

```http
POST /api/agent-runtime/sessions/<sessionId>/runs
Authorization: Bearer <token>
Idempotency-Key: <requestId>
Content-Type: application/json
```

请求体：

```json
{
  "requestId": "client-request-0001",
  "mode": "turn",
  "message": "Read README.md and summarize it.",
  "reasoningEffort": "low",
  "locale": "en"
}
```

`requestId` 是持久幂等键，也可以只放在 JSON body 中；当前 Web 客户端同时使用请求头和 body。建议两者使用同一个值。

响应：

```json
{
  "run": {
    "id": "run_...",
    "sessionId": "ars_...",
    "status": "queued",
    "model": "default"
  },
  "reused": false
}
```

同一个 `requestId` 和完全相同的输入重复提交，会返回原 Run；同一个 `requestId` 搭配不同输入会返回 `REQUEST_CONFLICT`。

### 5.6 观察 Run SSE

提交接口只负责接受 Run。使用以下接口观察：

```http
GET /api/agent-runtime/sessions/<sessionId>/runs/<runId>/stream?after=0
Authorization: Bearer <token>
Accept: text/event-stream
```

服务端发送的事件通常是：

```text
id: 1
data: {"type":"run_started",...}

id: 2
data: {"type":"step_started",...}

id: 3
data: {"type":"message_delta","delta":"hello",...}

id: 4
data: {"type":"tool_call",...}

id: 5
data: {"type":"permission_requested",...}

id: 6
data: {"type":"run_completed",...}

data: [DONE]

```

关键点：

- `id` 是 Runtime 持久事件序号。
- `data` 是 JSON 编码的 Runtime chunk。
- 连接断开后，保存最后一个 `id`，使用 `?after=<lastId>` 重新订阅。
- 重新订阅不会创建新 Run，也不会自动重放工具。
- `[DONE]` 只表示观察流结束；最终状态应以 Session/Run 查询为准。
- 观察连接可以断开，但不要因为观察断开就调用 cancel。

重新连接后，建议同时刷新：

```http
GET /api/agent-runtime/sessions/<sessionId>
GET /api/agent-runtime/sessions/<sessionId>/runs/<runId>
GET /api/agent-runtime/sessions/<sessionId>/interactions
GET /api/agent-runtime/sessions/<sessionId>/permissions
```

### 5.7 查询终态和详情

```http
GET /api/agent-runtime/sessions/<sessionId>/runs/<runId>
GET /api/agent-runtime/sessions/<sessionId>/runs/<runId>/steps
GET /api/agent-runtime/sessions/<sessionId>/messages
GET /api/agent-runtime/sessions/<sessionId>/tool-calls
GET /api/agent-runtime/sessions/<sessionId>/events
GET /api/agent-runtime/sessions/<sessionId>/stats
GET /api/agent-runtime/sessions/<sessionId>/environment
GET /api/agent-runtime/sessions/<sessionId>/capabilities
```

常见终态：

- `completed`：Run 正常完成。
- `interrupted`：被用户或 Runtime 中断，不代表任务全部完成。
- `cancelled`：会话或任务被取消。
- `failed`：执行失败。
- `blocked`：需要用户处理或恢复检查。

不要仅凭最后一条文本消息判断任务成功；至少同时检查 Run status、工具终态和需要的文件/环境结果。

---

## 6. 审批与持久化表单

### 6.1 Permission 审批

查询待审批项：

```http
GET /api/agent-runtime/sessions/<sessionId>/permissions
Authorization: Bearer <token>
```

典型返回：

```json
{
  "items": [
    {
      "id": "pd_...",
      "sessionId": "ars_...",
      "runId": "run_...",
      "toolCallId": "tc_...",
      "action": "ask",
      "reason": "Approve native execution?",
      "patterns": ["echo hello"],
      "userReply": null,
      "resolvedAt": null,
      "metadata": {
        "source": "codex",
        "allowedReplies": ["once", "reject"]
      }
    }
  ]
}
```

回复：

```http
POST /api/agent-runtime/sessions/<sessionId>/permissions/<permissionId>/reply
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "reply": "once"
}
```

可用回复：

- `once`：只允许本次。
- `always`：如果该原生后端明确支持，允许当前会话范围；必须先检查 `metadata.allowedReplies`。
- `reject`：拒绝。

对 Codex/Claude 原生后端：

- 不要默认发送 `always`。
- 如果不在 `allowedReplies` 中，服务端会拒绝该回复。
- 原生审批回复后，原生 Adapter 负责把结果返回 CLI；客户端不需要自己调用 Native resume。

对 Native Synax：

- 可以使用 `permissionTier` 和规则系统。
- `always` 会写入持久化规则，必须由用户明确操作。

### 6.2 Interaction 表单

查询表单：

```http
GET /api/agent-runtime/sessions/<sessionId>/interactions
Authorization: Bearer <token>
```

典型问题：

```json
{
  "interactions": [
    {
      "id": "hitl_...",
      "kind": "clarification",
      "revision": 1,
      "status": "pending",
      "request": {
        "title": "Agent needs your input",
        "questions": [
          {
            "id": "q0",
            "type": "single_select",
            "label": "Which file should be changed?",
            "required": true,
            "options": [
              { "value": "README.md", "label": "README.md" },
              { "value": "src/index.ts", "label": "src/index.ts" }
            ],
            "allowOther": false
          }
        ]
      }
    }
  ]
}
```

提交答案：

```http
POST /api/agent-runtime/sessions/<sessionId>/interactions/<interactionId>/reply
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "revision": 1,
  "action": "submit",
  "answers": {
    "q0": "README.md"
  }
}
```

注意：

- `revision` 必须使用服务端返回的当前 revision。
- `answers` 的 key 必须是问题的 `id`。
- 选择题只能提交允许的 value，除非 `allowOther=true`。
- 同一表单重复提交应使用同一结果或处理冲突，不要猜测默认答案。
- 用户拒绝回答使用 `action: "decline"`；取消使用 `action: "cancel"`。
- 表单是持久资源，刷新页面后重新 GET 即可恢复展示。

---

## 7. 取消、暂停与继续

### 7.1 取消当前执行

```http
POST /api/agent-runtime/sessions/<sessionId>/cancel
Authorization: Bearer <token>
Content-Type: application/json

{
  "runId": "run_..."
}
```

建议总是传入当前 `runId`，避免停止请求命中已经变化的 Run。

取消成功后，应该检查：

1. Session 状态是否为 `interrupted` 或 `cancelled`。
2. Run 是否已经终态。
3. 工具是否都不再是 `running` / `pending`。
4. 需要时检查工作目录中禁止产生的文件是否不存在。

Runtime 会等待受管进程组停止确认；如果无法确认，会进入 `runtimeControl.state = "unconfirmed"`，此时不能继续提交新 Run。Codex 还会在关闭连接前执行原生后台终端清理；这是 Runtime 内部动作，外部客户端只需要等待 cancel 接口返回并再次查询状态。

### 7.2 继续一个会话

停止、暂停或完成后继续发送新消息：

```http
POST /api/agent-runtime/sessions/<sessionId>/runs
```

```json
{
  "requestId": "client-request-0002",
  "mode": "continue",
  "message": "Continue from the current state. Do not repeat completed actions."
}
```

对 Codex/Claude：

- 如果后端支持，会使用持久化的原生 thread/session ID。
- 不要把原始 Session 的初始任务自动复制成新的工具任务。
- 新消息应明确告诉 Agent 检查已有状态，避免重放写操作。

### 7.3 未确认执行的恢复

如果 Session 显示 Runtime 需要人工确认：

```http
POST /api/agent-runtime/sessions/<sessionId>/recovery
Authorization: Bearer <token>
Content-Type: application/json

{
  "reviewedWorkspace": true,
  "confirmedNoRemainingWork": true
}
```

只有在人工检查工作目录和进程状态后才可以调用。该接口不会自动重试不确定的写操作。

---

## 8. 其他有用接口

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/agent-runtime/sessions` | 列出 Session |
| `GET` | `/api/agent-runtime/sessions/:id` | Session 投影 |
| `GET` | `/api/agent-runtime/sessions/:id/messages` | 消息历史 |
| `GET` | `/api/agent-runtime/sessions/:id/runs` | Run 历史 |
| `GET` | `/api/agent-runtime/sessions/:id/steps` | Step 历史 |
| `GET` | `/api/agent-runtime/sessions/:id/tool-calls` | 工具调用和结果 |
| `GET` | `/api/agent-runtime/sessions/:id/permissions` | 审批列表 |
| `GET` | `/api/agent-runtime/sessions/:id/interactions` | 表单列表 |
| `GET` | `/api/agent-runtime/sessions/:id/stats` | Token、上下文和耗时 |
| `GET` | `/api/agent-runtime/sessions/:id/capabilities` | 能力目录 |
| `GET` | `/api/agent-runtime/sessions/:id/environment` | 工作区环境投影 |
| `GET` | `/api/agent-runtime/sessions/:id/environment/file?path=...&kind=diff` | 读取 diff 或输入文件 |
| `GET` | `/api/agent-runtime/events/stream` | 全局 Session 事件 SSE |
| `GET` | `/api/agent-runtime/sessions/:id/live` | Session 级实时事件 SSE |

实时事件流用于更新 UI，不取代持久化查询。重连后应重新 GET Session、Run、Interaction 和 Permission。

---

## 9. Node.js 最小客户端示例

下面示例只依赖 Node.js 22 原生 `fetch`，演示 Codex 后端的“创建会话 → 提交 → 观察”流程。审批和表单需要在真实客户端中增加用户交互。

```js
import { randomUUID } from 'node:crypto'

const API = process.env.SYNAX_API ?? 'http://127.0.0.1:3210'
const TOKEN = process.env.SYNAX_RUNTIME_TOKEN
const PROJECT_ID = process.env.SYNAX_PROJECT_ID
const WORK_DIR = process.env.SYNAX_WORK_DIR

if (!TOKEN || !PROJECT_ID || !WORK_DIR) {
  throw new Error('Set SYNAX_RUNTIME_TOKEN, SYNAX_PROJECT_ID and SYNAX_WORK_DIR')
}

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  const body = text ? JSON.parse(text) : null
  if (!response.ok) {
    const error = new Error(body?.error ?? `HTTP ${response.status}`)
    error.code = body?.code
    throw error
  }
  return body
}

const sessionPayload = await api('/api/agent-runtime/sessions', {
  method: 'POST',
  body: JSON.stringify({
    projectId: PROJECT_ID,
    profileId: 'synax',
    backendId: 'codex',
    model: 'default',
    workDir: WORK_DIR,
    prompt: 'Inspect the repository and summarize the README.',
    reasoningEffort: 'low',
  }),
})

const sessionId = sessionPayload.session.id
const requestId = `node-client-${randomUUID()}`
const accepted = await api(`/api/agent-runtime/sessions/${sessionId}/runs`, {
  method: 'POST',
  headers: { 'Idempotency-Key': requestId },
  body: JSON.stringify({
    requestId,
    mode: 'turn',
    message: 'Read README.md and summarize it. Do not modify files.',
    reasoningEffort: 'low',
  }),
})

const runId = accepted.run.id
const stream = await fetch(
  `${API}/api/agent-runtime/sessions/${sessionId}/runs/${runId}/stream?after=0`,
  { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' } },
)
if (!stream.ok || !stream.body) throw new Error(`SSE failed: ${stream.status}`)

const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader()
let buffer = ''
let lastSequence = 0
for (;;) {
  const { value, done } = await reader.read()
  if (done) break
  buffer += value
  const frames = buffer.split(/\r?\n\r?\n/)
  buffer = frames.pop() ?? ''
  for (const frame of frames) {
    let data = ''
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('id:')) lastSequence = Number(line.slice(3).trim())
      if (line.startsWith('data:')) data += line.slice(5).trimStart()
    }
    if (!data || data === '[DONE]') continue
    const chunk = JSON.parse(data)
    console.log({ sequence: lastSequence, type: chunk.type, chunk })
  }
}

// SSE 结束后，以持久化 Run 状态作为最终判断。
const finalRun = await api(`/api/agent-runtime/sessions/${sessionId}/runs/${runId}`)
console.log('final status:', finalRun.status)
```

生产客户端还应该：

- 为每个提交生成稳定的 `requestId`。
- 持久化最后 SSE sequence，并在 `?after=` 处重连。
- 独立处理 `waiting_permission` 和 `waiting_input`。
- 对 `409` 做状态刷新，不要盲目重试写操作。
- 在 UI 中区分“请求等待”和真实 reasoning 内容。
- Run 终态后再读取 environment/diff，确认实际副作用。

---

## 10. 浏览器客户端对接建议

不建议直接使用原生 `EventSource`，因为它不能安全地自定义 Bearer Header。可以采用 Fetch + ReadableStream，或者复用项目已有的认证 SSE 客户端模式：

```text
apiFetch()
  ├── 自动完成 /api/auth/session 浏览器认证
  ├── 不把 Token 放到 URL
  └── 对 SSE 使用 Fetch Header + Last-Event-ID
```

建议前端状态机：

```text
idle
  └─ submit → queued
queued/running
  ├─ permission_requested → waiting_permission
  ├─ interaction_requested → waiting_input
  ├─ SSE 断开 → reconnecting（不取消 Run）
  ├─ cancel → stopping
  └─ terminal chunk + GET Run → completed / failed / interrupted / blocked
```

当页面刷新时：

1. 先 GET Session。
2. 再 GET Run、Interaction、Permission。
3. 如果 Session 仍有 activeRunId，按该 Run 的最新 sequence 订阅。
4. 如果有 pending Interaction/Permission，优先恢复用户操作面板。
5. 不因为前端没有收到完整 `[DONE]` 就把 Run 标成失败。

---

## 11. 错误处理

常见错误码：

| code | 含义 | 客户端处理 |
|---|---|---|
| `AUTH_REQUIRED` | 未认证 | 获取 Runtime Token 或重新执行浏览器认证 |
| `HOST_DENIED` | Host 不受信任 | 使用本机/受信任 Host，不绕过校验 |
| `ORIGIN_DENIED` | Origin 不受信任 | 配置受信任 Origin |
| `LLM_PROVIDER_NOT_CONFIGURED` | Native LLM 未配置 | 进入 Settings 配置 Provider |
| `REQUEST_CONFLICT` | 幂等键对应了不同输入 | 生成新的 requestId，保留旧 Run |
| `SESSION_BUSY` | Session 有活动 Run | 查询当前 Run，不重复提交 |
| `INTERACTION_PENDING` | 有未处理的交互 | GET interactions 并提交/拒绝 |
| `PERMISSION_EXPIRED` | 审批已失效 | 刷新 Session/Permission，不重放旧审批 |
| `RECOVERY_REQUIRED` | 需要恢复检查 | 检查工作区和进程后调用 recovery |
| `PROCESS_UNCONFIRMED` | 进程停止未确认 | 不继续提交，先处理进程状态 |
| `EMBEDDED_HOST_REQUIRED` | Wiki embedded host 专属执行 | 使用 Wiki 作业控制，不直接启动普通 Run |
| `PARENT_CONTROL_REQUIRED` | 子 Session 由父 Session 控制 | 停止或恢复父 Session |

HTTP 状态大致含义：

- `201`：资源创建成功。
- `202`：Run 已接受，尚未代表完成。
- `400`：请求格式或参数错误。
- `401/403`：认证、Host 或 Origin 问题。
- `404`：资源不存在。
- `409`：状态冲突、审批失效、需要恢复或 Session 忙。
- `422`：Provider 或执行前提未满足。
- `500`：Runtime 或后端异常；先查询持久化状态，再决定是否重试。

---

## 12. 当前对接边界

当前可以依赖的能力：

- 本地单节点 Runtime。
- Web + HTTP/SSE 对接。
- Native Synax、ACP、Codex、Claude Code 后端选择。
- 显式 Session backend binding。
- 持久化 Run、Step、消息、工具、权限和表单。
- 提交与观察分离。
- 断开重连后按 sequence 恢复观察。
- Codex/Claude 原生 Session ID 恢复。
- 原生审批和 Native 持久化表单。
- 受管进程组取消与停止确认。

当前不要假设：

- 不要假设已经支持云端多租户、集群调度、远程 Worker 或计费。
- 不要假设不同后端之间可以无损切换上下文。
- 不要假设 Claude 可以使用第三方产品自己的 claude.ai 订阅 OAuth 登录。
- 不要假设所有 CLI/TUI 功能都已经映射为 Synax UI 能力。
- 不要把 Electron Desktop 的生命周期结论从本文 Web + Runtime 验收中推导出来。
- 不要把 `completed` 理解成文件已经提交到 Git；Synax 默认只记录工作区变更，不自动替你提交业务代码。
- 不要在收到观察流断开时自动 cancel。
- 不要在 `unconfirmed` 状态下自动重试可能产生副作用的写操作。

---

## 13. 如果要接入新的 CLI Agent

当前推荐的内部扩展方式是实现一个 Backend Adapter，而不是在前端加一组 CLI 特判：

1. 定义稳定的 `BackendId` 和 capability description。
2. 实现 `stream / interrupt / close`。
3. 将原生输出映射到公共 Run/Step/message/tool/permission/interaction 契约。
4. 使用 Runtime 的受管进程所有权，不直接裸 spawn 后自行管理 PID。
5. 将原生 Session ID、版本、模型、工作目录和有效配置摘要写入 Session metadata。
6. 原生权限请求必须回到持久 Permission，再由用户回复；不能默认放行。
7. 原生用户问题必须映射到持久 Interaction；不能只存在内存回调里。
8. 原生取消必须等待真实进程或原生终端清理确认。
9. 给 Adapter 增加 fixture 单测、隔离 CLI 真实任务和停止/恢复测试。
10. 最后再把后端目录和模型目录暴露给 Web，不要让 UI 猜测后端能力。

当前项目中的主要实现入口：

```text
api/services/agent-runtime/backends/backend-contracts.ts
api/services/agent-runtime/backends/backend-registry.ts
api/services/agent-runtime/backends/external-turn.ts
api/services/agent-runtime/backends/codex-backend.ts
api/services/agent-runtime/backends/claude-backend.ts
api/services/agent-runtime/run-coordinator.ts
api/routes/agent-runtime.ts
```

这些是当前实现入口，不等于外部插件 API；如果要把 Adapter 做成第三方插件，还需要额外定义版本化插件契约和安全加载边界。

---

## 14. 最小验收状态

截至 2026-09-14，Web + Runtime 最小验收已经完成：

- Codex：Web 提交、审批、刷新观察、续聊、延迟停止和停止后不重放写操作。
- Claude Code：Web 提问表单、刷新恢复、单次写入审批、延迟停止、停止后续聊。
- 编译 Runtime：独立 cwd / 独立 DATA_ROOT 启动、后端模型发现、编译 Native Worker 实际工具回合。
- API 和 Web 类型检查通过。
- Web、Runtime、ACP/Wiki 相关最小回归通过。

详细证据记录：

- `tmp/runtime-evolution/minimal-acceptance-receipt.json`
- `tmp/runtime-evolution/minimal-claude-web-receipt.json`
- `tmp/runtime-evolution/minimal-claude-web-stop-receipt.json`
- `docs/superpowers/plans/2026-09-13-synax-runtime-execution.md`

这些证据支持“Web + Runtime 最小可用闭环”，不替代 Desktop、完整 P5、高负载性能和多租户验收。
