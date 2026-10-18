# Runtime 2.0 硬切换进度

用户目标：剔除旧运行时，将数据迁到 Rust runtime，跑通最小 E2E，统一版本为 2.0.0。此目标取代旧的双写/兼容方案。当前尚未完成，不应合并发布或标记 goal complete。

## 本轮实际改动

- `.env.version` 为 2.0.0；`version:sync` 同步 Node、client、lockfile、代码版本及 Rust Cargo 包版本。
- HTTP history 仅保留已有 Rust 路径；删除 flat/versioned/JSONL 动态加载与 runtime 模式选择。删除在线 history upgrade 入口和 client adapter。history recover 调用 Rust outbox reconcile。
- RuntimeFacade 移除 shadow admission/append/completion 与整库 SQL history 补写方法。部分方法仍读取中央 session-store，不能据此宣称整个依赖图已脱离 SQL。
- RuntimeStreamWriter 不再读取 SQL history epoch 或写 Node journal。它按当前流生成中断回复并等待 Rust 提交。
- RuntimeJournal 删除同步内存 append/read/snapshot 与独立 replay 数据源；保留 Rust 异步日志适配和通知等待。
- Rust history 删除全局旧索引 fallback，只从当前 head 的可达图查询实体。未发布对象不进入会话历史。
- 离线迁移从旧表解码为原生 runtime 实体，导入 permission/interaction control state，并验证实体字段；迁移 smoke 验证导入、追加新一轮、删除已迁移的 SQL 表后重启读回。

## 证据与范围

- `npm run typecheck` 通过。
- `npm run runtime-sidecar:test -- --locked`：73 项通过。
- 六个定向 Vitest 文件：26 项通过。旧 Node 内存 journal 专用测试已被 Rust adapter 测试替换；旧 SQLite checkpoint 测试中的 Node journal 断言已删除。
- `node --import tsx/esm scripts/runtime-migration-smoke.ts` 通过：测试的是隔离数据目录，不是用户实际数据迁移。
- `node --import tsx/esm scripts/runtime-v2-main-path-e2e.ts` **失败**，但前四步通过：真实 HTTP session create → submit → 独立 provider worker → Rust completion → 原生 WebSocket → host restart → HTTP history。最后 `no old runtime SQL tables` 断言失败，旧 agent_runtime/conversation/jsonl/transcript 表仍存在。
- E2E 使用确定性的本地 HTTP provider fixture；没有将其声称为外部模型验收，也没有绕过生产 create/submit 入口。
- E2E 输出：`out/runtime-v2-e2e/result.json` 和 `host.log`。失败时保留隔离 DATA_ROOT，便于定位。
- 未重新跑旧 1.x 全量测试，不沿用之前 2999 项通过作为 2.0 的验收证据。

## 下一节点（必须继续开发）

1. 用 Rust repository 替换中央 `session-store.ts` 的 SQL 实现；显式加载会话、await 提交。删除 create seed/mirror 的隐式 SQL 依赖。
2. 将 coordinator/admission/worker、work/context/plan/permission/interaction 等调用接到新仓储；删除旧 checkpoint/JSONL/flat 实现及仅验证旧后端的测试，保留原产品行为在 Rust 主路径的验收。
3. 停止在线 database migration 创建 runtime SQL 表，移除旧 bootstrap/history retention 和 runtime flags。不能仅在 E2E 结束时 DROP 表让检查变绿。
4. 完成实际数据来源摸排和迁移。目前离线导出覆盖常规 runtime SQL 行；旧 versioned/JSONL payload、附件、terminal 等数据仍须完整导入后，才能对用户数据执行最终清理。
5. 重新执行最小 E2E，要求业务步骤及“零旧 runtime SQL 表”全部通过，再做 2.0 DMG 和最终发布验收。

## 2026-10-18 第二轮：中央仓储替换与主路径闭环

已完成并验证：

- 删除中央 session-store 的 SQL repository 实现，改为 Rust-backed execution working set。session/run/message/step/part/tool/context/thinking/compaction 等记录通过 Rust IPC 写入；HTTP/worker/执行收尾有显式 hydrate/flush 边界。
- work、plan、usage 读取和持久化接入同一仓储，取消旧 SQL 与 history mirror。Node worker 在发送 chunk/done 前提交持久化，父进程完成一轮前重新 hydrate。
- 新 session 不再加载或初始化 flat/JSONL/versioned history；Native loop 的 checkpoint 捕获使用 Rust pins，执行 fence 使用 Rust。
- 删除 48 个旧 runtime/conversation/JSONL SQL 迁移文件及 schema repair/trigger bootstrap。应用其他领域的 SQLite 数据库保留；不再创建 runtime 表。
- 新增 Rust `asset_page`，将启动附件清理迁出 SQL。worker 存活判断从 Rust process leases 读取，不再捕获 SQL 错误后默认回答。
- `runtime:repository-smoke`：无 context.db 的目录创建 session、run、message、context、thinking、compaction、work、plan，sidecar 重启后全部读回；取消的本地 mutation 不发布。
- 最小主路径 E2E 通过：HTTP create → HTTP submit → forked provider worker → 真实 file.read → provider 读取工具结果 → Rust 完成 → 原生 WS 增量 → host restart → HTTP 读回 → 第二轮完成。
- E2E 不仅检查不存在旧 runtime 表，还用进程预加载探针记录所有旧表 SQL 调用（包括被 catch 掩盖的查询）；本轮结果两项均为零。
- 当前 typecheck 通过；Rust tests 74 项通过；中央仓储/stream/facade 的定向 Vitest 19 项通过；离线原生迁移 smoke 通过。

范围限制和下一步：

- 上面的 working set 仍需要在更多后台命令/子代理/表单/文件写入入口接完整加载与提交边界。此次 E2E 证明聊天 + 文件读取，不证明这些未覆盖的流程。
- 在线已不创建旧 runtime 表，但仓库里仍有旧 checkpoint/flat/transcript、同步 admission、interaction mutation、media/terminal/process 兼容分支；必须继续移除或改为 Rust 实现。旧 1.x 全量测试不再是完成标准；不能为保留它们恢复 SQL 后端。
- 只读检查实际目录 `/Users/mint/.synax`：context.db 约 1.53 GB，299 个 session；228 个 versioned head、71 个 flat head、56,926 条 JSONL payload 索引、147 个资产。源数据未迁移/清理。下一步是完整的离线 versioned/JSONL/附件提取与有界原生导入，随后逐会话核对。
- 不得将当前最小 E2E 的绿色结果当作“旧实现已全部删除/用户数据已完成迁移”。目标保持 active。2.0.0 DMG 尚未重新构建。

## 2026-10-18 第三轮：真实数据只读提取与流式归档

已新增独立离线读取器 `scripts/runtime-migration/v1-reader.ts`，只依赖文件读取、libsql 和离线字段 decoder，不导入旧在线 runtime。它支持：

- flat SQL、早期 transcript JSONL、v3 不可变对象树（原始/紧凑节点）、外置 JSONL/二进制 payload、分块 text/JSON 字段。
- 对象内容哈希、JSONL envelope/payload 哈希、committed offset、树/文本计数验证；原始内容不截断。
- 根据旧程序的实际可见性选择数据源：消息读不可变树；boundary-only 的执行证据读 SQL locator + 当前/祖先 epoch 上界。`full_history=1` **不会**覆盖此规则。append-only 的 work/context 等也遵循旧 diagnostic 规则。
- 当前 SQL live metadata 和 immutable session 内容合并；同 epoch 的控制字段覆盖；祖先分支的执行/权限状态按旧语义归一化。JSONL 迁移时临时 scope 的 header id 不覆盖真实 session id。
- 保留检查点元数据及整个可达不可变对象图，并读取资产文件及绑定。全部能力留在离线脚本中，不增加在线 fallback。

新增 CLI：

```sh
node --import tsx/esm scripts/synax-runtime-migrate.ts audit-v1 --data-root /Users/mint/.synax --output out/runtime-v2-migration/v1-audit.json
node --import tsx/esm scripts/synax-runtime-migrate.ts export-v1 --data-root /Users/mint/.synax --output out/runtime-v2-migration/v1-source.ndjson
node --import tsx/esm scripts/synax-runtime-migrate.ts verify-v1-export --input out/runtime-v2-migration/v1-source.ndjson
```

`export-v1` 每次只解码单条实体，缓存受限，写缓冲为 1 MiB；附件分块为 256 KiB。输出文件使用 0600 权限，完成后原子改名。验证器不依赖源数据库，验证 archive footer、对象哈希、附件块顺序/大小/哈希和 session 归属，拒绝截断或被修改的归档。

真实目录最终核对结果（首轮误把 full_history 当作执行证据来源的计数已经作废）：

| 项目 | 数量 |
| --- | ---: |
| 会话 | 299 |
| 当前可见记录总数 | 403,344 |
| 消息 | 7,833 |
| run / step / part | 698 / 17,049 / 52,384 |
| tool / event | 22,881 / 258,790 |
| permission / interaction | 23,095 / 117 |
| artifact / context / work | 19,477 / 291 / 520 |
| plan / aux usage | 78 / 131 |
| 检查点 | 2,787 |
| 保留的不可变历史对象 | 74,835 |
| 附件 / 绑定 | 147 / 105 |
| 附件总字节数 | 38,441,890 |

流式归档为 1,141,038,604 bytes，已通过独立校验。证据保存在被 Git 忽略的 `out/runtime-v2-migration/`；归档含真实用户内容，不提交 Git。源 `context.db` 仍为 1,526,464,512 bytes，修改时间仍是 2026-10-18 12:21:37；没有执行实际导入、删除旧表或清理源文件。

验证：新增 7 个离线读取/归档测试通过（包含两种树格式、两种外置 payload、epoch 分支、append-only、live control、JSONL 截断/篡改和附件）；独立 scripts TypeScript 检查、项目 typecheck、原来的普通 SQL fixture → Rust 原生迁移 smoke 通过。

仍需完成，不能据此宣称迁移成功：

1. **真实数据暴露了整表 IPC 的硬问题**：一个会话的 step 正文合计 73,380,134 bytes；`history.rs::list_indexed` 仍遍历整个 head 图并一次性返回，Node working set 又依次全量加载多个集合。必须改为按字节分页/按需加载，才能用实际会话验收。
2. 单实体最大 375,144 bytes，当前没有超过 900 KiB 的实体；单会话 permission 历史 1,013,860 bytes。用现有 `nativeProjection` 对全部导出会话实际序列化后，最大导入体为 **1,056,826 bytes**，已有 1 个会话超过 1 MiB 控制帧限制；证据为 `out/runtime-v2-migration/transport-audit.json`。历史权限和待处理权限的职责必须分开，不能持续向 control 数组堆积历史。
3. 本次 archive 包含当前可见实体、保留 immutable graph 和附件；旧 process/terminal、SQL mutation/undo 及 boundary-only 检查点的完整原生转换仍需完成。原 SQL-only `export/import/verify-runtime` 仍只用于其现有 fixture，不能拿它清理真实目录。
4. 下一步将上述 archive/reader 接入原生 Rust 导入，恢复 checkpoint/pin 和附件绑定，逐会话读回核对；再删除全部在线旧模块、扩展写文件/交互 E2E，最后构建 2.0.0 DMG。当前目标继续 active。

## 2026-10-18 第四轮：原生分页、交互切换、真实数据暂存与逐字段验证

### 在线代码变更

- Rust 增加 `visible_entities` 索引：实体身份和有序查询键只随当前 head 原子提交，未发布对象不会进入列表。追加增量更新索引；head switch、fork 和显式 rebuild 根据可达历史重建。移除 `put_object` 对旧全局实体索引的写入，列表不再逐次扫描整个历史 DAG。
- 所有 `list_*` 实体查询返回有字节上限的分页，游标绑定 session、kind、direction、head revision。更新同一实体会删除旧排序键；同一批次中最后一次更新获胜。Node 仓储、facade、迁移校验和 benchmark 接入分页；UI 历史页不再按对象图扫描后丢弃多余消息。
- `session_list` 增加 after 游标，每页最多 64 条且正文预算 900 KiB。仓储启动加载和 facade 列表都迭代分页，解决真实会话元数据总计 5,944,798 bytes 超出控制帧的问题。
- 历史对象 Moka 缓存改用字节权重，容量 64 MiB。控制状态 `read` 不再生成持久化 receipt 或触发 WAL 写入。
- 热控制状态只保留未解决的 permission 和未消费的 interaction。完成记录随控制事件写入 durable outbox，再进入 `runtime.permission` / `runtime.interaction` 历史。命令回执返回本次变更实体，HTTP 与工作集从历史读取完整记录。
- outbox reconcile receipt 按事件序列范围生成，避免同一个调用方 request id 处理后续新事件时发生冲突。
- `interaction-service.ts` 删除全部 SQL/version/checkpoint 引用和兼容回退，统一使用工作集事务、排队控制命令及显式 flush。保留答案校验、skip 语义、计划批准和任务创建、consume 后的 tool_result、取消与重启恢复。权限不再 fire-and-forget shadow 写入，随工作集 flush 提交。

### 真实数据证据

新增 `stage-v1` / `verify-v1-stage`，逐条读取上一轮归档、按 750 KiB/256 条批量提交原生实体，附件以 256 KiB 块写入 Rust blob 并核验 manifest。验证时只保留每条记录的字段哈希，通过原生分页逐条比较，核对完整 session、待处理 controls、附件字节和绑定。

首次验证发现实际浮点精度损失：metadata 中 `1792047838.6933553` 被读成 `1792047838.693355`。已启用 serde_json `float_roundtrip` 并增加持久化重启回归测试；重新创建暂存目录后全量校验通过。旧 `native-staging` 保留为失败样本，不可用于切换；仅下述 `native-staging-precise` 通过字段级验收。

```sh
node --import tsx/esm scripts/synax-runtime-migrate.ts stage-v1 --input out/runtime-v2-migration/v1-source.ndjson --data-root out/runtime-v2-migration/native-staging-precise
node --import tsx/esm scripts/synax-runtime-migrate.ts verify-v1-stage --input out/runtime-v2-migration/v1-source.ndjson --data-root out/runtime-v2-migration/native-staging-precise
```

结果：

- 299 个会话、403,344 条当前可见实体全部完成原生导入，并在 sidecar 重启后逐字段哈希一致。
- 147 个附件、38,441,890 bytes、105 个绑定原生读回一致。
- 最大单页实体正文 520,158 bytes；最大会话列表页正文 913,775 bytes，均经真实 IPC 返回。
- 最大 projection 导入体从 1,056,826 bytes 降至 88,516 bytes。
- 最后一次完整核对耗时 37,383 ms，包含原始归档校验、哈希计算、IPC 读回及附件验证；不是纯存储吞吐或端到端性能基准。
- 证据：`out/runtime-v2-migration/native-staging-precise/stage-v1-result.json`、`verify-v1-stage-result.json`。源用户目录未切换，归档与暂存库均不纳入 Git。

### 验收与剩余范围

- Rust tests **79/79**；6 个定向 Vitest 文件 **31 项**；服务端、客户端和新增迁移脚本 typecheck 通过。
- `runtime-v2-main-path-e2e.ts` 再次通过真实 HTTP → 独立 worker → provider fixture → file.read → WS → 重启 → 第二轮，并保持零旧 runtime SQL 表、零旧表读写尝试。
- 新增 `runtime-v2-interaction-smoke.ts`：真实 Rust 持久化下校验非法答案、回复、重启后消费一次、tool_result、计划执行、skip 重试、取消、历史权限；全过程不创建 context.db。
- 原生仓储、SQL fixture 迁移、控制状态重启、outbox 维护/重复 reconcile/unknown ack 的 smoke 均通过。

**目标仍未完成。** 暂存结果明确 `cutoverComplete: false`：2,787 个检查点及文件恢复语义尚未完成原生转换；旧 file/checkpoint/flat/transcript、同步 admission、media/process 等在线依赖仍待剔除。Node 工作集仍可能加载整个会话（现在分 IPC 页加载），HTTP 某些列表仍会收集全量实体，不能宣称长会话按需加载或极限吞吐已经完成。下一阶段继续转换保留历史和文件状态、拆掉剩余旧依赖、验证文件写入和回滚，最后才切用户目录、清理旧数据并构建 2.0.0 DMG。
