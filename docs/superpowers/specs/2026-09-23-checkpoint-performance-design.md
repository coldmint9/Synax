# Synax checkpoint / rollback：秒级响应与有界资源设计

日期：2026-09-23（本机 Asia/Shanghai）
状态：方向已批准；本文中的具体预算与验收口径待用户审阅，尚未实现。
基线：`0cc8a48d725519f205fcf47de3e2fd82b63d4fe4`（本地 main）。

## 1. 目标与范围

用户要求：按不可变版本、结构共享和切换版本根的方向优化 checkpoint / rollback，极致性能、秒级响应、不能 OOM、不能快速增长存储。

交付必须同时满足：

1. checkpoint 不复制历史；无文件 rollback 不遍历撤销历史；会话 fork 不复制历史。
2. 切换后首次读取直接访问目标版本，不全量重放，不依赖父分支链长度。
3. 正常写入、预览、恢复、迁移、GC、索引与 UI 刷新全部有资源边界。
4. 保留冲突保护、幂等、权限、执行隔离和崩溃恢复语义，不以关闭持久化换速度。
5. 保留当前会话和受保护 checkpoint；存储压力下显式背压，不静默丢弃用户内容。

不承诺任意机器、任意文件体积、无限并发下的绝对时延或绝对不 OOM。实现要通过输入限额、字节预算、并发限额、进程隔离和压力测试，保证 checkpoint 子系统的资源需求不随历史总量无界增长。超出预算必须可恢复地拒绝或暂停，而不是继续分配直到崩溃。

不在本目标中实现：通用文件系统快照、任意外部进程的瞬时撤销、Git reset、绕过外部 Agent backend 的历史限制、无限保留所有历史。

## 2. 已验证的现状

- 现场编辑操作有 67,940 条历史日志，事件占 67,318 条；主 API 子进程持续运行在 libSQL 原生执行中，健康检查超时。
- 原生采样未确定唯一最慢 SQL；这不是已证明的数据库死锁，也不能把全部耗时归因到 DELETE。
- `checkpoints/state.ts` 的 `eachUndo` 将全部记录身份 `.all()`，逐行读取并处理；`restoreHistoryBoundary` 在同步事务内完成撤销。
- `checkpoints/store.ts` 的 checkpoint payload 较小，但捕获仍遍历子会话、计算消息数量；不能仅以 payload 大小证明捕获成本不增长。
- `checkpoints/file-plan.ts` 先读取所有会话在 cursor 后的 mutation，再在 JS 内过滤 owner。
- `checkpoints/gc.ts` 全量读取 checkpoint/mutation/operation JSON，以正则收集 hash 到 Set，存在历史规模相关的峰值内存。
- `runtime-stream-writer.ts` 已有 40ms / 8192 字符的 delta 合并，不能把新增合并逻辑当成从零开始的优化；需要检查写入事件、stream records、内容快照和 undo 的重复。
- `runtime-stream-writer.ts` 还存在 runId 未确定时的待处理队列，以及中断后读取全部 delta 再 join 的路径，需要字节上限和流式恢复。
- `api/lib/execution-context.ts` 已有 host/run epoch 校验，应扩展并统一，不另建互相矛盾的授权机制。
- `checkpoints/files.ts` 已有 SHA-256 blob、流式文件读写与校验，优先复用。
- 主目录生产数据库不参与实验；基准与故障注入只在显式隔离的测试 DATA_ROOT 中进行。

## 3. 验收指标（设计目标，不是已有测量值）

### 3.1 响应时间

参考环境必须在报告中记录 CPU、内存、磁盘、Node/Electron/libSQL 版本、持久化设置、冷热缓存和并发条件。

已迁移的 v3 会话、无活动写入、无文件恢复、资源预算内：

| 操作 | p95 | p99 | 必须同时验证的结构约束 |
| --- | ---: | ---: | --- |
| checkpoint 发布（含有界待提交数据 flush） | ≤ 1s | ≤ 2s | 不扫描消息/事件总量，不重新构造整个 session tree |
| rollback 成功提交 | ≤ 1s | ≤ 2s | 扫描/写入数不随被撤销事件数增长 |
| 会话元数据 fork（不含磁盘工作区复制） | ≤ 1s | ≤ 2s | 不复制消息、内容 blob 或状态树 |
| rollback 后首屏可用 | ≤ 1s | ≤ 2s | 限定首屏页，不读取整段 transcript |
| 请求接收/明确拒绝、健康检查 | ≤ 250ms | ≤ 1s | API 事件循环不执行历史规模相关的同步计算 |

- 基准覆盖 10k / 100k / 1M 事件，至少 1k checkpoint 和 1k 次分支切换；数据生成不计入操作时延，但生成和清理资源也要记录。
- 样本报告包含成功、拒绝、超时和失败，不能把返回 202 当作 rollback 已完成，也不能剔除慢请求粉饰分位数。
- 文件恢复：先返回可追踪的 operation，至少每秒可读取进度；参考负载 20 个文件、合计 32MiB 的完成目标为 2s。更大文件或等待外部写入停止不作固定完成时间承诺。
- 无文件快速路径仍须验证会话已静止；存在未停止写进程时，快速返回明确原因，不假称回滚完成。
- 冷缓存和受控 GC/迁移竞争单独报告；不能只测 warm-cache 空数据库。

### 3.2 内存与并发初始预算

以下是待实现的默认上限，可下调，不能在压力下自动无限上调：

| 资源 | 初始预算 / 行为 |
| --- | --- |
| 单条持久化内容 chunk | 64KiB 上限；文本按 UTF-8 边界拆分，大工具结果/附件外置 |
| 单会话待 flush 数据 | 256KiB 上限 |
| 所有会话待 flush 数据总量 | 8MiB 上限，达到后背压源端 |
| 历史操作队列 | 最多 32 个，另设 8MiB 总请求体预算；每会话最多 1 个变更操作 |
| 版本节点/内容缓存 | 全局 32MiB，按实际 bytes 淘汰，不按对象个数估算 |
| 单次 DB 查询/IPC 响应 | 最多 256 行且最多 1MiB；大字段只传引用，不能查询后才截断 |
| 单次历史操作新增 working set | ≤ 64MiB 的基准目标，包括 Node Buffer/native 分配，不仅 heapUsed |
| 版本/恢复/GC 子系统相对空载新增峰值 RSS | ≤ 256MiB 的基准目标；并发和缓存计入总量 |
| GC / 旧数据迁移 | 每类最多 1 个活动任务，共享资源预算；写入轮次错开 |

要求：

- 采集 RSS、heapUsed、external、arrayBuffers、队列 bytes、缓存 bytes 和进程树总峰值；不能只监控 V8 堆。
- 历史长度扩大 100 倍时，峰值内存不能跟随历史线性增长。
- 无界 `.all()`、全量 JSON.parse、`map().join()` 拼接、全目录 readdir 数组、全历史 Set 均不得出现在关键/维护路径。
- SQL 的排序、临时 B-tree、FTS 查询与 native 分配也计入设计，LIMIT 外层包裹不等于上游执行已被限制。
- 大输入先按 bytes 检查或流式解码；不能把整个请求传过 IPC 后才做限额检查。
- 模型源端必须支持背压；无法背压时受控终止当前执行并保留已确认数据，不能丢弃业务消息或无限排队。

### 3.3 存储增长与退化策略

必须分别计量：有效内容、历史独占内容、树节点、索引、WAL、临时文件、文件 undo blob、迁移副本；只看 context.db 主文件大小不合格。

- 重复创建同一状态的 checkpoint 只新增小型身份/边界记录；目标摊销物理增量 ≤ 4KiB/checkpoint（包含相关元数据索引，不含一次性页面分配噪声）。
- 100 次重复 fork 同一版本不得复制内容 blob；同一内容引用量增加不能使内容 bytes 增加。
- 首批基准采用 4KiB 以上的内容块，版本树和引用元数据摊销目标 ≤ 唯一内容 bytes 的 25%；短记录、长分支、不同数据分布另列，不用统一比例掩盖小对象开销。
- 仅 retained checkpoint、当前 head、fork、进行中操作与 reader lease 引用的对象可保留；废弃未引用对象增量清理。
- 默认可回收历史独占内容软水位 512MiB、硬水位 1GiB（节点、blob 和相关索引均计入）；不能只计一份共享 blob 或重复把共享内容算作独占。
- 软水位触发预算内 GC/合并；硬水位拒绝会增加历史占用的新写入/新分支，并告知清理或提高配额。不能删除有效 checkpoint 来偷偷达标。
- 当前会话有效内容、用户保留的 checkpoint、fork 引用和恢复操作是保护对象；它们自身超大时，必须明确显示容量占用，不承诺有限磁盘可无限保存。
- 保留既有文件 undo 24 小时闲置到期规则，不擅自缩短用户已有可恢复期限；受恢复操作引用的文件对象不可提前清除。
- 对新写入预留磁盘容量，低于 `max(1GiB, 本次有界批次估算需求 × 2)` 时不接受新增长操作；保留修复/恢复所需预留空间。估算与写入仍可能遭遇其他进程抢占空间，必须处理 ENOSPC。
- WAL 初始软/硬监控阈值 64MiB / 256MiB；长读事务拆成有 reader pin 的短页读取，后台增量推进。超过硬阈值时暂停增长型维护/写入，不能无限积压，也不能在点击回滚时同步 TRUNCATE/VACUUM。
- 异常退出遗留的临时文件按有效 lease 和操作记录回收，不能用“超过某个时间”误删活跃写入。

## 4. 架构决策

### 4.1 统一的不可变版本根

```text
SessionHead(session_id, version_id, epoch, revision, format_version)
Checkpoint(id, session_id, version_id, kind, message_id, step_id, ordinal)
SessionVersion(id, transcript_root, state_root, session_tree_root,
               file_manifest_root, aggregate_root, schema_version)
```

- `SessionVersion` 只引用不可变对象；目标 root 必须可直接读取，不能依赖递归遍历 parentBranch。
- transcript 使用分块、路径复制的序列 B+tree；entity/state 使用键排序的路径复制 B+tree。节点编码限制为 16KiB，目标填充率 50%–80%，大 value 外置。
- 节点/内容对象使用带类型和 schema_version 域隔离的内容 hash，编码必须确定性；缓存、去重和完整性校验区分 node/blob 类型。
- 每个持久化批次只复制受影响路径，同一批次重复修改相同路径合并；不为每个 token 创建版本根。
- 聚合值在写入时增量维护，不在 checkpoint 时 count 全表；子会话拓扑也随版本发布，不在回滚时全量枚举并更新子行。
- 搜索 posting 与 entity revision 绑定；候选验证必须按固定版本进行并具有可继续游标。不能先取全历史 TopK 再过滤导致缺结果，也不能为了精确 total 对所有旧分支做同步扫描。
- 权限/身份、执行 lease、外部进程状态、实际消耗审计与可回滚业务状态分离，不能恢复已撤销授权或重复激活历史运行。

### 4.2 checkpoint 发布

1. 在受控写入执行单元中建立发布 barrier，冻结本批次逻辑边界。
2. flush 有界的业务内容和树节点；内容持久化成功前不能发布引用。
3. 小事务内记录版本根、checkpoint、聚合和预留空间结算。
4. 提交成功后才返回 durable 成功并发出 UI 事件；其后的异步索引不得改变可见性正确性。

SQLite 内的版本节点/小 chunk 与 root 在同一 DB 事务提交，避免 DB-to-DB 原子性问题；大文件 blob 沿用临时写入、校验、持久化、发布和孤儿回收协议。持久化承诺须分别覆盖应用崩溃和断电，不把二者混称为“已安全保存”。

### 4.3 无文件 rollback / edit / fork

- 目标 checkpoint 直接给出目标版本。
- 小事务内校验 requestHash、requestId、revision、执行静止条件与存储可用性，CAS 切换 head、递增 epoch/revision、写入幂等结果。
- 不触碰每个历史事件，不删除旧分支，不递归回收引用，不同步更新全部 FTS 文档。
- edit 从目标版本追加新的用户输入，保留原分支对象到 GC；不能覆盖共享旧消息。
- fork 新建 session 身份及隔离执行状态，共享不可变内容；可见性、权限与子会话归属按新 session 映射，不能直接复用旧执行 ID。
- 事务提交后仅通知版本变更；缓存按 version/epoch 分区。前端清空旧请求 generation，分页读取首屏，不能等待全部历史请求重跑后才关闭对话框。
- 幂等结果重复请求返回相同结果；requestId 被不同请求体复用必须拒绝。

### 4.4 并发与 API 隔离

- 会话版本写入集中在一个明确的 writer 调度单元；不能让 worker 与 API 各自缓存可写 head 并竞争覆盖。
- API 事件循环只校验有界参数、调度和流式转发。SQL/树转换/大内容处理在可监控的独立执行单元运行。发布版本前需验证同步 libSQL 的取消/终止能力；没有可用安全中断时，超时只标记操作需查询/恢复，不在事务中途声称已撤销。
- 扩展现有 host/run execution-context 校验，把 session epoch 的提交校验放到同一写事务，覆盖模型、工具、流写入、后台任务和延迟回调。
- child session 使用 root 会话的有效执行代际，避免回滚时遍历所有 child 逐行失效。
- 内部可信 maintenance 例外必须局限于维护元数据，不允许绕过当前业务 epoch 写入。
- epoch 不能停止已经获得文件描述符的外部进程；它们仍须停止并确认，或在隔离工作区执行。无法确认时拒绝文件恢复。
- reader pin 保护版本，页间使用短 DB 事务；避免长 SQLite 读事务无限保留 WAL。
- 请求 timeout 不等于后台写入自动取消：调用方必须能查询 operation，确认提交还是恢复中；禁止已返回“取消”后在后台悄悄提交。

### 4.5 文件恢复

- 复用 `CheckpointFiles` CAS、排除目录、安全权限和完整性校验。
- 文件 manifest 保存可归属的版本、Git 边界、保留原因与完整性信息；只比较 root 差异，不遍历整个项目或所有会话 mutation。
- 同一路径多次修改合并为当前→目标的一次恢复，但不得跨越外部编辑、不确定归属或 Git 已提交的永久保留边界。
- 文件计划按 owner/root/path 的索引分页生成，持久化 plan 明细；只在内存保留当前批次。
- 预览缓存只复用可验证的 immutable 计算，执行前必须重新验证 revision、文件当前内容和写入隔离。
- 文件操作状态：prepared → applying_files → publishing → committed；失败进入 recoverable / recovery_required，细粒度步骤带 durable before/after 引用。
- 所有受影响会话/工作区的写入在操作期间被 fence；只有文件和 head 一致时才允许继续执行。
- 多文件 + DB 不是一个原子事务：崩溃后根据 durable 操作日志完成/补偿，遇到外部新编辑保留并报冲突，不覆盖。
- 工作区普通文件始终保持真实文件，不擅自改成仅 Synax 能理解的虚拟文件系统。

### 4.6 流式数据与去重

- UI 流、durable 重连流与业务版本区分职责；可重建的临时 delta 不再同时以完整文本进入多套可逆历史表。
- 初始合并 flush 仍采用 40ms 的交互粒度，但同时约束 bytes、全局缓冲和 event metadata；保留必要顺序和 checkpoint 边界，不能只拼接 delta 丢掉事件语义。
- 相同内容尽可能由最终消息、重连记录和版本树引用同一 chunk，不把不断增长的全文快照重复写入 journal。
- 中断恢复从已持久化 chunk 流式构建目标消息；不全量读取所有 records 后 join。
- 内容分块包括大 JSON 工具结果；外部 API 需要完整小字段时设大小上限，超限采用附件/引用而不是任意截断造成语义变化。
- 已确认 durable 的 chunk 不允许丢失；不持久化的 UI 缓冲在崩溃后可能丢失的范围必须在接口契约中明确。durable checkpoint 不得引用仅保留在短期重连日志中的数据；到期删除重连信息不能破坏业务版本。

### 4.7 GC 与维护

- 对象引用使用结构化记录，不扫描 JSON 正则寻找 hash。
- 初始采用持久化、增量 mark/sweep：mark 队列和 epoch 保存在 DB，内存只保留有界页；遍历不驻留全体 live hash。mark 状态也计入磁盘配额，队列用去重主键且每轮完成后增量回收；不能用无限增长的 GC 元数据换内存有界。
- GC 周期固定出生水位；周期内新对象和新 pin 由写入屏障保护。发布新 root 必须防止 GC 回收它引用的旧对象；不能只按对象年龄决定删除。
- 正在恢复的 operation、fork、checkpoint、head、reader lease 与 staging writer lease 均是 root；旧 PID 不存在不足以单独证明对象可回收，要核对运行 host 身份与 durable 状态。
- 每轮最多处理 256 个对象，并设置 10ms 协作让出目标；单次慢 native SQL 仍需 worker 监控，不能把 JS 定时器当硬中断。
- mark/sweep 中途崩溃可重入，不把未完成 mark 当作可安全 sweep。
- 索引清理、旧分支回收与 WAL 维护单独计费，维护失败只影响后续容量准入，不阻塞已存在历史的只读访问。

## 5. 数据消费者迁移契约

所有会话读取必须通过版本固定的仓储接口，而不是随意按 session_id 读旧 live 表。首批审计范围：

- `session-store.ts`：消息、事件、session tree、runs、parts、tool calls、permissions、artifacts、work。
- `context-builder.ts`、`context-composition.ts`、`context-projection.ts`、compaction：LLM 上下文不能包含撤销分支。
- `session-search.ts`：搜索和 snippet 与当前版本一致，有游标和预算。
- `read-tracker.ts`：历史文件阅读资格不能跨回滚保留失效授权。
- `usage-projection.ts`、`session-invocation-usage.ts`：区分当前分支展示统计与全局真实费用审计。
- `runtime-stream-writer.ts`、`runtime-journal.ts`、runtime bus / SSE：拒绝迟到 epoch，重连按版本和序号。
- `api/routes/agent-runtime.ts`、`SessionHistoryContext.tsx` 及 session store：分页、operation 状态、资源不足、迁移状态、恢复提示。
- 所有 direct SQL 写入入口需列入审计清单，包括后台 worker、fork、导出和测试 fixture；发现遗漏时不得启用 v3。

兼容的运行控制表可以继续存在，但不得通过同步重建所有旧 live rows 来完成 root 切换。版本化业务读取与不可回滚运行控制必须显式分离，不能用视图掩盖全历史扫描。

## 6. 旧数据迁移与发布安全

1. 先建立隔离基准、统计与 v3 表，不修改生产历史格式。
2. 新建测试会话验证 v3 全链路；v2、v3 以 per-session format 标记明确分流，禁止半迁移混读。
3. 在后台按 session keyset 分批转换旧历史，以有界读取和持久化 cursor 支持崩溃继续。保留旧 checkpoint 的语义，不只迁移当前 head。
4. 已知过大的旧 JSON 用增量读取/解码或分阶段外置；不能为迁移调用一次全量 JSON.parse。若遇到无法安全转换的数据，保留原数据、标记该会话迁移失败并提供诊断，不静默丢字段。
5. 迁移会话静止且有 fence；未捕获并发写入时不得后台转换后直接交换格式标记。
6. 逐 checkpoint 对比当前消息顺序、保留状态、子会话、权限隔离和文件恢复依据，校验后原子切换格式。
7. 不在用户首次点击回滚时执行全量转换。尚未迁移时快速提示迁移状态；旧慢路径必须单独隔离、可观察，并明确不计入 v3 秒级达标。
8. 双格式重叠计入磁盘配额；按会话流式转换，空间不足暂停，禁止一次生成全数据库第二份副本。切换后旧记录分批清理；回退到旧程序不得让它修改 v3 会话，需格式兼容锁。
9. 启用前完成备份/恢复验证；开发期间不重启、替换 /Applications/Synax.app 或写用户 ~/.synax 数据库。

## 7. 模块边界与实施顺序

这是一个统一 checkpoint 子系统改造，按依赖分阶段验收，不同时改无关产品功能：

1. **基准与资源治理**：真实 fixture、阶段计时、峰值内存/空间计量，修复 owner 过滤和无界维护路径；这一步只能称止血，不能称 O(1) 回滚。
2. **版本存储核心**：新建 `checkpoints/version-store/` 内的 codecs、immutable objects、bounded tree、heads、pins、budgets 和 gc 模块，各自有独立测试。SQL migration 使用下一可用序号，执行时检查并发新增迁移。
3. **写入与读取适配**：集成 runtime journal、execution context、session store、context/search/UI 数据消费者；缺少消费者迁移不得启用。
4. **checkpoint / rollback / fork**：切换 root 和 epoch、小事务幂等、首屏分页。
5. **文件恢复与受控维护**：复用 CAS，实现版本差异计划、恢复日志、增量 GC。
6. **旧数据迁移与压力验收**：per-session 转换、故障注入、存储长期稳态报告。

设计审阅通过后再为这些阶段拆解 TDD 实施任务；不在尚未验证接口前写一个无法执行的巨型重构计划。

## 8. 验证与失败准则

### 正确性

- 连续回滚、回滚后编辑、分支再分支、重复 requestId、stale revision、checkpoint 已过期。
- 保留记录被 update/delete/INSERT OR REPLACE 后的历史值正确。
- 迟到 delta、后台写入、子会话写入在旧 epoch 下拒绝；不可激活历史权限/运行 lease。
- 文件外部修改、Git commit、符号链接、并发写入、未归属变更、权限/路径变化保持现有保护。
- 查询、搜索、LLM context、导出、统计、UI 首屏不出现废弃分支内容。
- 在每个持久化边界注入进程退出、磁盘写失败、ENOSPC；恢复幂等且不覆盖外部新编辑。
- GC 与 reader/writer/fork/recovery 同时运行不误删引用。

### 性能与资源

- 测试 10k/100k/1M 事件、1k 分支、1k checkpoint、超大单条工具结果、20 个文件合计 32MiB 的时延样本，以及 20×32MiB 文件的非固定时延压力样本，记录 raw 样本。
- 对关键路径计数 SQL、读取行数、写入行数、读取/写入 bytes、flush bytes 和 event-loop delay。
- 在低堆配置和受限总内存测试环境执行，监测 native RSS；不能把 `--max-old-space-size` 等同于整个进程限额。
- 至少 10k 次创建/编辑/回滚/GC 混合操作的 soak，验证队列、缓存、临时文件、孤儿对象、WAL 不持续单调增长。
- 对重复相同内容与不可压缩全新内容分别测试，禁止只靠高压缩率样本宣称磁盘有界。
- 基准中主动制造低磁盘、超额 queue、GC 跟不上等压力，验证明确背压、读可用和恢复可继续。

### 禁止作为成功的替代品

- 只把阻塞 SQL 移到 worker，却没有降低 rollback 的历史相关成本。
- 返回 operationId 后就把请求视为已经完成。
- 改成根指针但首次读全量重放，或 FTS 重建阻塞首屏。
- 默认丢弃用户历史、减弱 fsync、绕过文件冲突校验、清空真实数据库。
- 只报告测试通过，不给基准规模、内存峰值、WAL/临时文件和长期空间数据。

## 9. 完成定义

上述正确性、延迟、内存与存储四类门槛都通过，且旧数据具备可验证的迁移/恢复路径，才可以把总体目标标为完成。只交付设计、worker 隔离或批量 DELETE 不能算完成。

## 10. Git 与工作区约束

- 从本地 main `0cc8a48` 创建 `codex/checkpoint-performance`，不从 test/beta 引入代码。
- `.DS_Store` 永不加入 Git；仅显式暂存本任务文件。
- 本文沿用仓库已有被跟踪的 `docs/superpowers/specs/` 文档目录；不改全局 ignore 规则。
- 不修改安装中的 Synax 或真实数据库；需要发布/恢复实际应用时另行明确操作边界。
