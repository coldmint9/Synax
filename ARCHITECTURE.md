# Synapse — 技术架构文档

> **Synapse** (神经突触): 连接人类与 Agent 的协作突触，连接代码与项目管理的神经中枢。

## 项目命名由来

**Synapse** 取自神经科学中的"突触"——神经元之间传递信号的结构。这完美契合了本项目的三大核心概念：
1. **连接**: 连接人类与 AI Agent 两种"神经元"
2. **信号传递**: 事件驱动架构如同神经信号传导
3. **可塑性**: Human ↔ Agent 热切换如同突触可塑性

---

## 核心技术精髓提取

### 从 Claude Code (TypeScript, 163K行) 提取

| 技术点 | Claude Code 实现 | Synapse 继承 |
|--------|-----------------|-------------|
| Agent 主循环 | `QueryEngine.submitMessage()` async generator | `runAgentLoop()` async generator |
| 消息持久化 | `recordTranscript()` + fire-and-forget | 事件日志 + 审计追踪 |
| 上下文压缩 | autoCompact + CONTEXT_COLLAPSE + snipReplay | `maybeCompact()` 两层压缩 |
| 权限系统 | 三模式(default/bypass/strict) + ML推断 | 四级AgentCapabilityLevel + 三模式 |
| 记忆管理 | memdir + MEMORY.md + nested loading | file-based memory + YAML frontmatter |
| 多Agent协作 | 四层架构: 内置/Fork/Swarm/Coordinator | RoleSlot + 子Agent调度 |

### 从 clawspring (Python, ~3.4K行) 提取

| 技术点 | clawspring 实现 | Synapse 继承 |
|--------|---------------|-------------|
| 事件流 | `run()` generator yield 6种事件类型 | `runAgentLoop()` yield 6种AgentEvent |
| 工具注册 | `ToolDef` dataclass + 全局registry | `ToolDef` interface + Map registry |
| 权限检查 | `_check_permission()` + safe bash list | `shouldAutoApprove()` + minAutoLevel |
| 上下文压缩 | `maybe_compact()` + snip + compact | `maybeCompact()` + snip + compact |
| 记忆存储 | file-based .md + YAML frontmatter | file-based .md + YAML frontmatter |
| 子Agent | `AgentDefinition` + ThreadPool | `AgentUser` + RoleSlot |
| 工具输出截断 | 首半+尾1/4 中间省略 | 同样的 truncateOutput 策略 |

### 关键简化决策

1. **去掉 Bun-specific 特性**: Claude Code 深度依赖 Bun runtime，Synapse 使用标准 Node.js
2. **统一消息格式**: clawspring 的 neutral format 更简洁，Synapse 采用
3. **简化权限模型**: Claude Code 有 ML 推断权限，Synapse 用静态规则 + 角色等级
4. **合并 Agent 协作**: 四层协作简化为 RoleSlot + 事件驱动

---

## 项目结构

```
synapse/
├── package.json                    # 后端依赖
├── tsconfig.json                   # TypeScript 配置
├── README.md                       # 项目说明
├── ARCHITECTURE.md                 # 本文档
│
├── src/                            # 后端源码
│   ├── index.ts                    # 入口 & 重导出
│   ├── server.ts                   # Hono API 服务 (14个端点)
│   │
│   ├── models/
│   │   └── types.ts                # 全局类型定义 (300+行)
│   │       ├── RoleType (6种角色)
│   │       ├── AgentCapabilityLevel (4级)
│   │       ├── EventType (22种事件)
│   │       ├── TaskStatus (7种状态)
│   │       ├── AgentEvent (6种循环事件)
│   │       └── Message (3种消息类型)
│   │
│   ├── core/
│   │   ├── agent-loop.ts           # Agent 主循环引擎
│   │   │   ├── runAgentLoop()      # 核心 async generator
│   │   │   ├── buildSystemPrompt() # 角色化系统提示词
│   │   │   └── formatPermissionDesc()
│   │   │
│   │   ├── event-bus.ts            # 事件总线 + 信息中介
│   │   │   ├── SynapseEventBus     # 发布-订阅事件系统
│   │   │   └── InformationBroker   # Zero-Alignment Protocol 实现
│   │   │       ├── isRelevant()    # 角色相关性过滤
│   │   │       └── reframe()       # 事件角色化重述
│   │   │
│   │   └── code-first-state.ts     # Code-First State 引擎
│   │       └── CodeFirstStateEngine # 从Git活动推导项目状态
│   │           ├── BranchCreated → InProgress
│   │           ├── PrOpened → InReview
│   │           ├── PrMerged → Testing
│   │           └── CiFailed → RiskHigh
│   │
│   ├── roles/
│   │   └── role-slot.ts            # 角色槽位系统
│   │       ├── RoleSlotManager     # 槽位管理器
│   │       │   ├── createSlot()    # 创建角色槽位
│   │       │   ├── switchOccupant()# Human↔Agent 热切换
│   │       │   └── checkFailover() # 自动降级检测
│   │       ├── ROLE_DEFINITIONS    # 6种角色定义
│   │       └── createBuiltinAgent()# 内置Agent工厂
│   │
│   ├── tools/
│   │   ├── registry.ts             # 工具注册表
│   │   │   ├── registerTool()      # 注册工具
│   │   │   ├── executeTool()       # 执行工具 (含截断)
│   │   │   ├── shouldAutoApprove() # 权限自动审批
│   │   │   └── getToolSchemasForRole() # 角色工具过滤
│   │   │
│   │   └── builtin.ts              # 18个内置工具
│   │       ├── 文件: Read, Write, Edit, Bash, Glob, Grep
│   │       ├── 项目: TaskCreate, TaskRead, TaskUpdate
│   │       ├── 里程碑: MilestoneRead, SprintRead
│   │       ├── 知识: WikiRead, WikiUpdate
│   │       ├── 通知: Notify
│   │       ├── 记忆: MemorySave, MemorySearch
│   │       └── Git: GitStatus
│   │
│   ├── context/
│   │   └── context-manager.ts      # 上下文压缩管理
│   │       ├── estimateTokens()    # Token估算
│   │       ├── snipOldToolResults()# Layer 1: 截断旧工具结果
│   │       ├── compactMessages()   # Layer 2: LLM摘要压缩
│   │       └── maybeCompact()      # 自动触发入口
│   │
│   ├── memory/
│   │   └── memory-store.ts         # 持久化记忆系统
│   │       ├── saveMemory()        # 保存记忆 (.md + frontmatter)
│   │       ├── searchMemory()      # 关键词搜索
│   │       ├── loadIndex()         # 加载索引
│   │       ├── getMemoryContext()   # 系统提示词注入
│   │       └── checkConflict()     # 冲突检测
│   │
│   ├── integrations/               # (预留)
│   │   ├── git/                    # Git Webhook 集成
│   │   └── mcp/                    # MCP 协议支持
│   │
│   └── config/                     # (预留)
│
└── web/                            # 前端应用 (React + Vite + Tailwind)
    ├── package.json
    ├── vite.config.ts              # 开发代理到后端 :3210
    ├── tailwind.config.ts          # 自定义暗色主题
    ├── index.html
    ├── public/
    │   └── synapse-bg.png          # 生成的背景图
    └── src/
        ├── main.tsx
        ├── App.tsx                 # 侧边栏导航 + 路由
        ├── index.css               # 设计系统 tokens (14个HSL变量)
        ├── lib/utils.ts
        └── pages/
            ├── Dashboard.tsx       # 仪表盘 (4统计卡+3面板)
            ├── RolesPanel.tsx      # 角色管理 (热切换+历史)
            ├── TaskBoard.tsx       # 任务看板 (6列Kanban)
            ├── EventStream.tsx     # 事件流 (角色过滤+视角)
            └── AgentChat.tsx       # Agent对话 (3Agent+快捷提示)
```

---

## 数据流架构

```
用户输入 ──→ runAgentLoop()
               │
               ├── maybeCompact()        ← 上下文压缩
               │     ├── snipOldToolResults()
               │     └── compactMessages()
               │
               ├── streamLlm()           ← LLM 流式响应
               │     └── yield TextChunk / ThinkingChunk
               │
               ├── shouldAutoApprove()   ← 权限检查
               │     └── yield PermissionRequest
               │
               └── executeTool()         ← 工具执行
                     │
                     ├── SynapseEventBus.emit()  ← 事件发射
                     │     │
                     │     ├── InformationBroker  ← Zero-Alignment
                     │     │     └── reframe() per role
                     │     │
                     │     └── CodeFirstStateEngine ← 状态推导
                     │           └── derive StateChange[]
                     │
                     └── return ToolResult
```

---

## API 端点清单

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/health` | 健康检查 |
| GET | `/api/projects/:id/roles` | 获取项目角色列表 |
| POST | `/api/projects/:id/roles/:slotId/switch` | Human↔Agent 切换 |
| GET | `/api/roles/definitions` | 角色定义列表 |
| GET | `/api/tools` | 工具列表 |
| GET | `/api/tools/schemas` | 工具 JSON Schema |
| GET | `/api/projects/:id/events` | 项目事件流 |
| GET | `/api/events/types` | 事件类型列表 |
| GET | `/api/projects/:id/state-changes` | Code-First 状态变更 |
| GET | `/api/memory` | 记忆索引 |
| GET | `/api/memory/search` | 记忆搜索 |
| POST | `/api/chat` | Agent 对话 |
| GET | `/api/projects/:id/stats` | 项目统计 |
| GET | `/api/roles/switch-log` | 切换历史 |

---

## 关键设计决策记录

### ADR-001: 异步生成器作为 Agent 循环核心
**决定**: 使用 `AsyncGenerator<AgentEvent>` 作为 agent 主循环的返回类型  
**来源**: Claude Code 的 `QueryEngine.submitMessage()` 和 clawspring 的 `run()` generator  
**原因**: 生成器天然支持流式响应、取消、背压控制  
**代价**: 调试略复杂，但比回调/Promise链清晰

### ADR-002: 两层上下文压缩
**决定**: 先 snip(截断旧工具结果)，再 compact(LLM摘要)  
**来源**: clawspring 的 `maybe_compact()` + Claude Code 的 autoCompact  
**原因**: snip 代价极低，可快速回收大量 token；compact 代价高但效果好

### ADR-003: 文件系统记忆 + YAML Frontmatter
**决定**: 记忆以 .md 文件存储，元数据用 YAML frontmatter  
**来源**: clawspring 的 memory/store.py  
**原因**: 人类可读、Git 友好、零依赖、自然支持版本控制

### ADR-004: 角色能力等级而非固定权限
**决定**: AgentCapabilityLevel (1-4) + 工具 minAutoLevel  
**来源**: 结合 Claude Code 三模式权限和 clawspring 的 safe bash list  
**原因**: 比固定权限更灵活，支持渐进式授权，比ML推断更可解释

### ADR-005: 事件驱动 + 角色化信息投递
**决定**: 所有系统行为通过 EventBus 发布，InformationBroker 按角色重述  
**原创**: 这是 AgentForge 产品设计中的 Zero-Alignment Protocol  
**原因**: 从根本上消除角色间对齐成本

---

## 启动方式

```bash
# 后端 (需要 Bun 或 Node.js + tsx)
cd synapse
npm install
npx tsx src/server.ts

# 前端
cd synapse/web
npm install
npm run dev

# 访问
# 前端: http://localhost:5173
# API:  http://localhost:3210/api/health
```

---

*文档版本: v1.0 | 生成日期: 2026-04-19*
