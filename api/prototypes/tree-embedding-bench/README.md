# Tree Embedding Bench — 原型使用指南

将 **Synax 全库** 经 tree-sitter 语法分析切成 **chunk**，序列化为文本后由本地 **EmbeddingGemma**（llama.cpp）向量化，支持自然语言召回代码片段。

> 语料单位 = analyzer 的 `ChunkEntry`（符号级 chunk，每文件最多 48 个；无符号时整文件一块）。  
> 向量缓存：`~/.synax/tree-embedding-cache/`。

> 本目录为开发原型，不接入生产索引链路。验证策略后再考虑迁入 `api/services/`。

---

## 前置条件

### 1. 启动 embedding 服务

使用 [embd-gema](https://github.com/) 项目在本地启动 llama.cpp embedding 服务：

```bash
cd /Users/mint/Projects/embd-gema
embd-gema serve   # 或项目内等价的启动命令
```

确认服务可用：

```bash
curl http://127.0.0.1:8080/health
# {"status":"ok"}

curl -X POST http://127.0.0.1:8080/embedding \
  -H 'Content-Type: application/json' \
  -d '{"input":"hello"}'
```

默认地址：`http://127.0.0.1:8080`  
模型：EmbeddingGemma 300M Q4（768 维）

### 2. Synax 环境

```bash
cd /Users/mint/synax
npm install
```

可选环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EMBEDDING_BASE_URL` | `http://127.0.0.1:8080` | llama.cpp embedding 服务根地址 |

---

## 目录结构

```
api/prototypes/tree-embedding-bench/
├── README.md                 # 本指南
├── contracts.ts              # 类型：策略、任务、报告
├── serializers.ts            # 4 种 AST → 文本 序列化策略
├── embedding-client.ts       # HTTP 客户端（/embedding、/health）
├── metrics.ts                # cosine、Recall@K、MRR
├── fixtures.ts               # 加载样本、构建 SymbolContext
├── corpus-loader.ts          # 全库 parseRepository + chunk 构建
├── index-cache.ts            # embedding 磁盘缓存
├── eval-set-synax.json       # Synax 全库测评集（默认）
├── eval-set.json             # fixture 小样本测评集
├── retrieval-index.ts        # chunk 向量索引 + search
├── benchmark-runner.ts         # 跑完整 benchmark
├── index.ts                  # 统一导出
└── __tests__/                # 单元测试 + live 集成测试
```

---

## 序列化策略

**Chunk 策略（默认，用于全库召回）：**

| 策略 | 说明 |
|------|------|
| `chunk-source` | path + 行号 + 符号名 + **源码切片** |
| `chunk-enriched` | chunk-source + 签名 + import/call 图上下文 |

**Symbol 策略（legacy / fixture 对比用）：**

| 策略 | 说明 |
|------|------|
| `signature` | 仅函数签名 |
| `symbol-card` | kind + path + name + signature |
| `skeleton` | AST 节点类型骨架 |
| `graph-context` | symbol-card + 调用图 |

在代码中预览某符号的序列化结果：

```typescript
import {
  loadFixtureIndex,
  serializeSymbolContext,
} from './api/prototypes/tree-embedding-bench/index.js';

const { contexts } = await loadFixtureIndex();
const text = serializeSymbolContext(contexts[0], 'symbol-card');
console.log(text);
```

---

## 快速开始

### 交互式 CLI（推荐）

默认扫描 **当前 Synax 仓库**（约 600+ 文件、5000+ chunk），首次全量 embed 较慢，之后走磁盘缓存。

```bash
npm run bench:repl

# 开发时限制 chunk 数量（加快迭代）
npm run bench:repl -- --limit 200

# 批量测评
npm run bench:eval

# 小样本 fixture 快速调试
npm run bench:repl -- --fixture
```

交互命令：

| 命令 | 说明 |
|------|------|
| `<自然语言>` | 直接输入 query 搜索 |
| `eval` | 跑完整测评集并输出 R@K |
| `eval jwt-validate` | 跑单个 case 的全部 query |
| `list` / `case <id>` | 查看测评 case |
| `strategy symbol-card` | 切换序列化策略并重建索引 |
| `topk 10` | 修改展示条数 |
| `show validateToken` | 查看符号的 embedding 文本 |
| `quit` | 退出 |

### Smoke 脚本

```bash
npx tsx api/__smoke__/tree-embedding-bench-smoke.ts
```

输出示例：

```
Strategy           R@1    R@3    R@5    MRR   posSim  negSim  latency
symbol-card        100%  100%  100%  100%  0.649  0.519  14ms
graph-context      100%  100%  100%  100%  0.649  0.525  15ms
...
Best strategy by MRR: symbol-card
```

### 单元测试

```bash
# 离线测试（不依赖 embedding 服务）
npx vitest run api/prototypes/tree-embedding-bench/__tests__/

# Live 集成测试（需 embd-gema 已启动）
EMBEDDING_BENCH_LIVE=1 npx vitest run \
  api/prototypes/tree-embedding-bench/__tests__/benchmark-runner.test.ts -t live
```

### HTTP API

先启动 Synax API：

```bash
npm run dev:api
```

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/prototypes/tree-embedding-bench/health` | 检查 embedding 服务连通性 |
| `GET` | `/api/prototypes/tree-embedding-bench/strategies` | 列出可用序列化策略 |
| `GET` | `/api/prototypes/tree-embedding-bench/fixtures` | 查看样本符号与各策略文本预览 |
| `POST` | `/api/prototypes/tree-embedding-bench/run` | 执行 benchmark |

**跑 benchmark：**

```bash
curl -X POST http://127.0.0.1:3210/api/prototypes/tree-embedding-bench/run \
  -H 'Content-Type: application/json' \
  -d '{}'
```

**指定策略子集：**

```bash
curl -X POST http://127.0.0.1:3210/api/prototypes/tree-embedding-bench/run \
  -H 'Content-Type: application/json' \
  -d '{"strategies": ["symbol-card", "graph-context"]}'
```

**指定 embedding 服务地址：**

```bash
curl -X POST http://127.0.0.1:3210/api/prototypes/tree-embedding-bench/run \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl": "http://127.0.0.1:8080"}'
```

---

## 程序化调用

```typescript
import {
  runTreeEmbeddingBenchmark,
  formatBenchmarkReport,
  loadFixtureIndex,
  defaultRetrievalTasks,
} from './api/prototypes/tree-embedding-bench/index.js';

// 查看 fixture 统计
const fixture = await loadFixtureIndex();
console.log(fixture.codeIndex.stats);

// 跑 benchmark
const report = await runTreeEmbeddingBenchmark({
  baseUrl: 'http://127.0.0.1:8080',
  strategies: ['symbol-card', 'graph-context'],
  // tasks: customTasks,  // 可选：自定义 retrieval 任务
});

console.log(formatBenchmarkReport(report));
console.log(report.strategies);  // 各策略 Recall@K / MRR
console.log(report.tasks);       // 每条 query 的 per-strategy 排名
```

### RunBenchmarkOptions

| 字段 | 类型 | 说明 |
|------|------|------|
| `baseUrl` | `string?` | embedding 服务地址，默认 `EMBEDDING_BASE_URL` |
| `strategies` | `SerializationStrategy[]?` | 要对比的策略，默认全部 4 种 |
| `tasks` | `RetrievalTask[]?` | 自定义 query → targetSymbolId，默认 8 条内置任务 |

---

## 基准设计

### 语料（fixtures/samples/）

| 文件 | 内容 |
|------|------|
| `auth.ts` | JWT 校验、密码哈希、SessionStore |
| `search.ts` | 分词、文档排序、带鉴权搜索 |
| `router.ts` | HTTP 路由注册与 JSON 工具 |

tree-sitter 解析后约 28 个 symbol，含 import / call edge。

### 语料与测评集

**语料**：`parseRepositoryFallback(repoRoot)` → tree-sitter 符号 + `chunkForSymbol` 切块 + 源码行范围切片。

**测评集**：`eval-set-synax.json`（12 case / 30+ query），目标为 Synax 真实符号，例如：

| case | 目标 |
|------|------|
| `wiki-fts-search` | `api/services/wiki/wiki-fts.ts::searchWikiDocuments` |
| `parse-one-file` | `api/services/analyzer/parse-lib.ts::parseOneFile` |
| `embedding-client` | `api/prototypes/.../embedding-client.ts::EmbeddingClient` |

召回命中判定：Top-K **chunk** 的 `symbolIds` 包含期望 symbol。

### 评测指标

| 指标 | 含义 |
|------|------|
| **R@1 / R@3 / R@5** | 正确答案出现在 Top-1/3/5 的比例 |
| **MRR** | Mean Reciprocal Rank |
| **posSim / negSim** | 正例 vs 负例的平均 cosine 相似度 |
| **latency** | 单次 query embedding 平均耗时 |

---

## 扩展指南

### 添加样本文件

1. 在 `fixtures/samples/` 下新增 `.ts` 文件
2. 在 `fixtures.ts` 的 `defaultRetrievalTasks()` 中增加对应 query / target
3. 重新跑 smoke 或 vitest 验证

### 新增序列化策略

1. 在 `contracts.ts` 的 `SerializationStrategy` 联合类型中追加
2. 在 `serializers.ts` 实现序列化逻辑
3. 更新 `listSerializationStrategies()` 与 route 的 zod enum

### 接入真实仓库

```typescript
import { parseRepository } from '../../services/analyzer/parser.js';
import { buildSymbolContexts } from './fixtures.js';

const { codeIndex } = await parseRepository('/path/to/repo');
const contexts = buildSymbolContexts(codeIndex);
// 再对 contexts 做 embed + retrieval eval
```

---

## 故障排查

| 现象 | 处理 |
|------|------|
| `Embedding 服务不可用` | 确认 embd-gema 在 8080 端口运行，`curl /health` 返回 ok |
| vitest 任务数少于 8 | 部分 class 方法需 tree-sitter；内置任务已优先选顶层 export 符号 |
| benchmark 很慢 | 每个 symbol × 每个 strategy 各调一次 embed；可先用 `strategies` 缩小范围 |
| 维度不是 768 | 确认使用的是 EmbeddingGemma 模型，而非其他 GGUF |

---

## 相关链接

- Embedding 服务项目：`/Users/mint/Projects/embd-gema`
- 语法树解析：`api/services/analyzer/parse-lib.ts`
- 符号类型定义：`api/services/contracts/forest.ts`（`SymbolEntry`）
- HTTP 路由：`api/routes/tree-embedding-bench.ts`
