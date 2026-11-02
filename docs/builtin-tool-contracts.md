# 内建工具描述与运行时校验盘点

盘点更新：2026-10-29。范围以 `ToolRegistry` 的静态注册、Synax 启动追加注册和项目自带的 Git MR / Jev provider 为准，Git skill.load 覆盖版本单列。以下逐项记录当前校验、说明处理与源码依据。数值、枚举、正则等可由 JSON Schema 表达的边界继续由 schema 提供；组合约束、执行前置条件和优先级进入工具正文或字段 `describe()`。

## 共享规则与模型可见链路

- `loop-ai-tools.ts` 将 `description` 与 `progressiveDetails` 拼接；模型参数由 SDK `asSchema(...).jsonSchema` 导出。`refine`、`superRefine`、`execute` 的条件不能假定自动导出；新增测试经过这条真实链路验证。
- 模型可见的工具参数根 schema 必须是 `type: "object"`：`z.discriminatedUnion` 只能序列化成根 `oneOf`（没有 `type`），OpenAI 兼容 provider（如 DeepSeek）会以 `Invalid schema for function '...': schema must be a JSON Schema of 'type: "object"', got 'type: null'` 拒绝整次请求。因此按动作区分的必填/禁用组合用扁平对象加 `superRefine` 表达，动作适用性写进字段 `describe()`。
- 普通文件、搜索、命令工具相对路径以会话工作目录为基准，绝对路径交给 sandbox 授权，外部路径可能需要批准。specialist 写入的安全相对路径限制更加严格，不能套用到普通工具。
- 已读文件变化会触发读写追踪校验。文件存在性、权限、网络、模型/provider 配置、窗口和页面状态属于动态条件；说明可以提示前置条件，但不能保证外部调用成功。
- 模式、挂载、权限、计划批准和 Work 状态由 `control-policy.ts`、`tool-mount-policy.ts`、`permission-policy.ts`、`work-runtime.ts` 和 `specialist-profile.ts` 执行。工具内部的 run/step ID 由运行时传递，不要求 agent 猜测或填写。
- 权限、写入参数和执行策略保持严格。读取预算（`file.read.maxBytes`、`file.list.limit`、`rg.limit/contextLines`）接受超出有效预算的安全整数，由执行层收敛并披露实际预算，不再将普通预算超额当成参数失败；类型、正负号和安全整数边界仍校验。
- `ToolRegistry` 仅对输入解析阶段的 Zod 错误生成有界诊断（工具、字段、错误码、数值边界、恢复建议），不回显输入字符串正文，不改写或自动重放失败操作。执行失败与结果分页仍是不同情况。

源码路径以下均相对于 `services/local-node/modules/agent-runtime/`，计算机工具另行标注。

## 文件、命令与搜索

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `bash` | command 长度 1–4000，拒绝 NUL；workdir 必须可解析；每个管道/链段走权限判断；有限会话限制重定向；timeout 默认 600s、1–600s，120s 未返回时触发依赖评估；显式短超时优先；async=true 在资源排队和进程启动前返回 commandTaskId，共用完成队列；async=false 正常等待；async 与 background=true / shell & 互斥；background 常驻服务忽略超时；测试/构建进入 CPU 资源池，检查命令进入 search 资源池 | 补路径基准和 command 的 NUL 限制，说明异步排队、资源隔离和启动计时 | tools/bash.ts、tools/bash-command-policy.ts、tools/workspace.ts、resource-admission.ts |
| `run` | 单次调用二选一：`argv` 为不经过 shell 的可执行文件和字面参数，或 `language/source` 为 sh、Python、Node 的内存源码；source 可为逐行数组；`scriptId` 仅复用当前会话的有界内存源码缓存；stdin 与源码独立；sh 全文预检，Python 使用既有 guard，Node 使用 ESM；源码不写入工作区或临时源文件，超出平台参数上限直接失败；默认 shell gate ask；支持 async 后由 command.manage 管理 | argv 按原始 token 授权和执行，脚本及缓存复用每次重新检查权限；workdir/argv 路径走 sandbox，run 作为可能写入的 opaque command 标脏工作区并进入 mutation lease；Windows sh、cmd/bat 和 WSL 明确拒绝，不静默回退到 shell 或临时文件 | tools/run.ts、script-execution/、permission-policy.ts、tool-registry.ts |
| `command.manage` | 当前 run 内的 commandTaskId；action=status/wait/background/cancel；reason 必填；background 要求独立 nextStep；单独调用 | 支持 bash async=true 与 120s 监测产生的任务；status 非阻塞返回排队/执行状态，wait 阻塞到完成，cancel 取消，background 解除等待；后台命令保留资源和取消所有权；完成结果在下一 step 自动注入并持久化，汇总前不允许结束 | command-tasks.ts、tool-registry.ts、native-step-context.ts |
| `file.read` | UTF-8 文本，扩展名/内容识别二进制；maxBytes 默认 64000、有效范围 4–64000，合法超额请求收敛；byteOffset 默认 0，非零必须携带 expectedRevision；另支持 startLine + lineCount（不能与 byteOffset 混用） | content 只含原文；返回 bytesRead、effectiveMaxBytes、revision、nextByteOffset、eof/truncated；UTF-8 边界分页；单描述符有界读取与读取前后版本校验；完整读才缓存全文快照，部分页只记录元数据 | tools/file-read.ts、tools/file-read-page.ts、read-tracker.ts |
| `file.write` | 非空 path、string content；完整覆盖并创建父目录；自动补读；已读文件变化可能拒绝写入 | 补路径基准、绝对路径授权与文件变化处理 | tools/file-write.ts、read-tracker.ts |
| `file.generate` | Python 3 script 1–65,536 字符；timeoutMs 默认 30s、钳制 1–120s；synax.write/delete/move 暂存后统一校验和提交；120 文件、64 MiB、单文件 8 MiB、诊断各 8 KiB；仅无 NUL 的 UTF-8 | write 审批；删除/移动要求 file.delete；提交前检查 sandbox、writeScope、文件新鲜度，持有写锁并在失败时回滚；完整恢复才返回 rolledBack，否则报告 residualPaths；缺 Python 不注册；不进入 code mode 允许列表 | tools/file-generate.ts、file-generation/、infrastructure/runtime/python-runtime.ts |
| `python.run` | Python 3 code 1–100,000 字符且非空白；workdir 相对工作区、必须存在且是目录（WSL 工作区明确拒绝），默认工作区根也是进程 cwd；stdin ≤1 MB；timeoutMs 默认 120s、钳制 1–600s；stdout/stderr 各按字节截到 64,000 并带截断提示；源码通过私有内存 envelope 交给固定 guard，源码不写入 `main.py`；`-I -B -X utf8` 隔离执行，HOME/TMPDIR/SYNAX_SANDBOX 指向持久沙盒，不继承宿主环境；guard.py 把读写限制在工作区与沙盒（带 writeScope 的委派会话只放宽到该范围写入），阻止网络、子进程、ctypes、硬/软链接和非法 fd，unrestricted 会话不设限；被拦截的操作写成 sticky `denied`，即使脚本捕获异常也返回失败；每次调用仅保留 violation 临时目录并清理 | shell 审批（默认 ask，pattern 为 python.run）；超时保留部分输出；退出码非 0 只作为结果证据，沙盒越界单独判失败；写操作标脏工作区并进入 checkpoint；缺 Python 不注册；不进入 code mode 允许列表 | tools/python-run.ts、python-execution/、resource-admission.ts、tool-registry.ts |
| `file.delete` | 删除单文件，不递归删除目录；路径走 sandbox | 补路径授权说明，保留明确删除请求的使用要求 | tools/file-delete.ts |
| `file.list` | 目录输入，默认当前工作目录；limit 默认 100、有效上限 300，合法超额请求收敛；仅返回当前层，过滤不可见项 | 返回 effectiveLimit、truncated/hasMore；不将截断结果当成完整列表 | tools/file-list.ts、tools/workspace.ts |
| `file.patch` | 单个 Begin/End envelope；每路径一个操作；所有 hunk 基于调用前原文，按原文顺序且上下文不重叠；匹配歧义拒绝；EOF 标记严格定位尾部 | 首次失败返回 `PATCH_*` 分类、hunk/搜索位置、有界原文预览和重读建议；匹配/格式失败前不写入，不自动重试或覆盖全文 | tools/patch.ts、tools/patch-format.ts、tools/patch-diagnostics.ts |
| `diff.read` | 当前会话 Git 目录内执行 git diff --stat，可选 --cached；不是完整 diff | 补 Git 目录前置条件和输出范围 | tools/diff-read.ts |
| `rg` | 默认 search 且 query 必填；files 需要 pattern 和目录；regex 默认 false；search 默认 50、截到 200，files 默认 100、截到 300；contextLines 默认 0、截到 5；合法超额预算收敛，前导连字符被安全传递 | 返回 effectiveLimit/effectiveContextLines；命中与上下文逐行 metadata 标明 truncated/originalLength，预览上限 240 字符不能当作完整原文；files 模式忽略搜索上下文并报告 0；timeout 等非预算参数仍严格校验 | tools/rg.ts、tools/grep-search.ts、tools/file-glob.ts、tools/ripgrep.ts |
| `webSearch` | query/queries 恰选一；queries 为 1–5 个字符串；公共过滤条件对各查询生效；域名不含协议/路径；limit 默认 5、1–10 | 明确二选一、批量元素类型、共享过滤和每查询数量；保留外部检索/回退边界 | tools/web-search.ts |

### 文件分页读取

首次调用可以省略预算：`file.read({path:"src/large.ts"})`。当 `nextByteOffset` 非 null 时，下一页使用相同 path、`byteOffset=nextByteOffset`、`expectedRevision=revision`。`content` 可以直接拼接，不包含提示文字；`bytesRead` 是实际返回原文的 UTF-8 字节数，可能因字符边界小于有效预算。请求预算 1–3 时按 4 字节执行，保证四字节字符也能前进。

版本标识基于设备、inode、大小、mtime 和 ctime；文件变化或路径替换时拒绝旧版本，必须从 0 重新读取。页首不允许位于 UTF-8 字符内部；无效 UTF-8 拒绝而不是静默替换。EOF 返回空内容与 null 游标；越过 EOF 的偏移拒绝。单页最多读取 64001 字节（含边界探测），续页另有最多 8192 字节头部二进制探测，不为读写追踪额外读取大文件全文。完整小文件读保留完整快照；部分页只保留元数据，元数据变化后须重新读取，不能据此判定全文相同。

### 按行读取目标区域

补丁诊断中的 `suggestedRead` 可直接传给 `file.read`，例如 `file.read({path:"src/large.ts",startLine:120,lineCount:20})`。`startLine` 从 1 开始；`lineCount` 默认 40、有效上限 1000，返回 `effectiveLineCount`。与显式 `byteOffset` 互斥，单独提供 `lineCount` 会拒绝。`maxBytes` 继续约束原文页大小。

行模式返回原文 `content` 及实际 `startLine/endLine/lineCount/lineComplete`；空结果的 `lineCount=0`、`endLine=startLine-1`。`lineComplete=false` 表示末行被字节预算截断，不能直接拿去构造补丁；用 `nextByteOffset` 和 `revision` 续读，不混用行参数。行数已满足不表示文件 EOF，`eof` 和 `nextByteOffset` 仍反映文件剩余内容。扫描定位使用固定小块，前缀扫描最多 16 MiB，超出明确要求改用字节分页，不为行定位缓存整文件。沿用同一描述符、UTF-8 解码、二进制检查及读取前后版本校验。

### 补丁协议与冲突恢复

`file.patch` 的 `@@` 不是标准 unified diff 行号头。裸 `@@` 开始一个片段；`@@ 精确原文行` 指定锚点，从锚点的**下一行**搜索，不能在片段中再次包含锚点本身；锚点行在文件中重复时由片段正文定位——正文紧随其中一个锚点则取该处，正文只在某一处唯一则按该处应用，正文同时匹配多处仍报 `PATCH_AMBIGUOUS_MATCH`，不带正文的纯插入仍需要唯一锚点。上下文、删除、新增行分别以空格、`-`、`+` 开头，空白上下文行也需要空格前缀。`*** Move to:` 紧跟 `*** Update File:`。非法前缀、空 hunk、错误位置的 Move/EOF 等不再静默跳过。带空格前缀的 `*** End Patch` 是正文上下文，不会提前终止 envelope。删除或上下文中的空行必须存在，不再通过丢掉末尾空行约束强行匹配；输出保留实际尾部空行。相对/绝对路径别名以 sandbox 解析后的路径统一检查重复操作。

同一文件所有片段都使用调用前原文，而非前一片段的修改结果。片段须按原文位置排序，上下文不得重叠；相邻修改合并成一个片段。例如原文件为 `first = 1;`、`middle`、`last = 1;` 三行，可使用：

```diff
*** Begin Patch
*** Update File: src/example.ts
@@
-first = 1;
+first = 2;
@@
-last = 1;
+last = 2;
*** End Patch
```

无旧文本且无锚点的片段追加到 EOF；有锚点的纯新增片段插入锚点之后。`*** End of File` 必须紧跟片段内容且要求片段匹配到原文件尾部，不能退回到文件中间。保留精确匹配、行尾空白、首尾空白、有限 Unicode 标点归一化的优先级；在命中的匹配级别内出现多处候选就拒绝，不静默选择第一处，不做语义模糊自动替换。

失败返回 `applied:false` 与以下分类：`PATCH_INVALID_FORMAT`、`PATCH_CONTEXT_MISMATCH`、`PATCH_ANCHOR_NOT_FOUND`、`PATCH_HUNK_ORDER_CONFLICT`、`PATCH_AMBIGUOUS_MATCH`。匹配诊断包含 1-based 的 `hunkIndex`、`patchLine`、`searchStartLine`，有限 `expectedExcerpt/actualExcerpt`、候选行和 `suggestedRead`。预览长行/行数被截断时有明确标记，不能当作完整补丁原文。`readBaseline` 只比较已有完整内容缓存，返回 changed/unchanged/unknown；没有全文快照、仅部分页或快照淘汰时为 unknown，不额外读取文件、不推进基线、不作为局部 patch 的拒绝门禁。首次失败即按建议读取当前目标区域、合并或重建片段；不要原样重放，不要转为整文件覆盖绕过冲突。

结构化失败保存在工具记录并完整投影给模型，不被普通输出摘要或旧 receipt 吞掉恢复信息。`tool_result` 分类事件只记录 code、序号、状态与调用关联，不复制源码片段。可通过既有调用记录关联“失败→读取→修正”尝试，不能由此断言线上失败率已下降。保护范围是**格式/匹配预检失败前不触盘**，不是对所有磁盘 I/O 异常提供跨文件事务回滚。

## Code Mode（1.7.0）

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `code.tools` | 项目默认关闭；query/offset 分页短目录，toolId 返回单工具 schema；仅已挂载、profile 允许的内置读取工具或逐项信任的只读 MCP | 保留普通工具；无需一次注入全部 Schema | code-mode/tools.ts、code-mode/policy.ts |
| `code.run` | JavaScript async 函数体，await tools.call(id,args)，return 小 JSON；32KB 代码/参数、32 次调用、4 并发、15s、32MiB guest heap；无 Node、直接 FS/网络、模块加载器；不自动重试/重放 | 每次内调经过 Registry，ask 转 denied，结构化失败记录，父子审计，历史只投影外层结果 | code-mode/、tool-registry.ts、loop-model-messages.ts |
| `code.result` | 读取当前 code mode 执行的结构化结果；只接受当前会话与当前 run 的结果引用 | 记录结果消费边界，避免把 code mode 内部调用重新暴露为顶层工具 | code-mode/results.ts、tool-registry.ts |
| `presentation.select` | 选择当前会话可展示的结果形态；输入必须来自运行时已登记的 presentation 选项 | 保留运行时选项校验与会话边界，避免模型自行构造未登记的展示类型 | presentation-runtime.ts、tool-registry.ts |

MCP readOnlyHint 不是安全保证；管理员须逐项验证服务器行为。允许的 MCP 请求仍可能发送代码组装的参数到外部服务器。全局运维关闭：SYNAX_CODE_MODE=0。

### 原生能力路径（分阶段启用）

原生会话直接使用固定的 `agent.discover` 入口和执行循环内的自动编排。模型首轮仅接收常用读取与必要控制工具，其他 schema 按需披露；`agent.execute`、`code.tools` 和 `code.run` 不作为模型入口展示。执行循环会自动安排读取、写入和补丁，写操作遵循原有权限与审批。

| 入口 | 实际约束/行为 | 依据 |
| --- | --- | --- |
| `agent.discover` | 支持 query/group、最多 4 个精确 ids、cursor 分页；每页最多 4 个契约，动态工作集最多 12 个、估算 8,000 tokens；下一模型步骤生效；披露不授予权限 | native-capabilities/service.ts、disclosure.ts |
| 执行循环自动编排 | 普通工具调用进入持久化编排队列；只读调用可限并发，写入/补丁按顺序形成屏障；审批暂停后只继续未完成操作；内部调用重新校验契约和权限 | native-capabilities/loop-composition.ts、loop-runtime.ts |

编排权限关闭时仍可发现与直接调用获准工具。旧项目迁移只保留 MCP 精确允许列表；新项目默认启用原生编排，MCP 列表仍为空。完整架构和发布验收见 `docs/design/2026-10-06-native-agent-capabilities.md`。

## 媒体

媒体引用须属于当前会话；图像和视频请求的引用总预算由 `media-context.ts` 限制为 100 MiB。模型和可选生成能力依赖实际 provider，不将某个 provider 的规则错误地声明为通用 schema 限制。

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `media.read` | assetId/path 恰选一个非空值；assetId 必须已附加当前会话；文件为普通文件且最多 50 MiB；path 走 sandbox | 正文和字段明确二选一、归属、文件大小及路径授权 | tools/media-read.ts、content-parts.ts |
| `media.generate` | 配置 provider；非 OpenAI 适配器须显式 model；images/mask 加载会话资产；预算 100 MiB；Images/Responses 对格式/尺寸/组合执行额外限制，native 有不同规则（sdk 为旧别名） | 参考图 <50 MB、Responses n=1；native 拒绝 stream=true 和 partialImages，Images/Responses 的 partialImages 需要流式；size/aspectRatio/seed/压缩/透明组合条件由字段说明和运行时校验 | tools/media-generate.ts、tools/media-context.ts、infrastructure/llm-runtime/image-generation.ts、infrastructure/llm-runtime/media-generation.ts |
| `media.speak` | 必填精确 model ID；provider 必须有 speechModel；speed 正数；providerOptions 为 provider 命名空间到参数对象的映射 | 补 provider 选择和命名空间对象形状，不添加不存在的 speed 上限 | tools/media-audio-video.ts |
| `media.transcribe` | 必填 model/audio；audio 是当前会话的 audio/* 资产；provider 有 transcriptionModel | 明确音频类型、归属和 provider 能力 | tools/media-audio-video.ts、tools/media-context.ts |
| `media.video` | 必填 model/prompt；image/frameImages 为图片；references 为图片或视频；最多 2 frameImages、16 references；引用预算 100 MiB；provider 有 videoModel | 补资产类型、归属、预算与具体模型能力限制；不虚构输入互斥规则 | tools/media-audio-video.ts |
| `media.models` | 返回配置的图像/视频模型和显式能力；不是所有语音/转写模型的目录 | 保留目录范围，说明用于生成模型/能力发现 | tools/media-jobs.ts、modules/media/catalog.ts |
| `media.status` | jobId 必须存在且属于当前会话 | 补会话归属和从返回结果/list 取得 ID | tools/media-jobs.ts |
| `media.cancel` | 同上；取消已有 job，不创建新 job；终态行为由 jobs 模块决定 | 补 job 来源/归属，保留不重提交说明 | tools/media-jobs.ts、modules/media/jobs.ts |
| `media.list` | 仅当前会话；limit 1–100，实际默认由 listMediaJobs 提供 | 保留会话范围，提示返回 jobId 可用于查询/取消 | tools/media-jobs.ts、modules/media/jobs.ts |

## 浏览器

以下工具均为严格参数对象，只接受列出的字段。ref 必须使用最近快照中的 eN/fNeN；页面变化后重新获取。可见会话、标签页与捕获缓冲都属于本次浏览器会话。

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `browser.navigate` | url 为 http(s)；url/pageSeq 至少一个；url 分支优先且忽略 pageSeq；newTab 只作用于 URL 导航；headless 只首次启动生效 | 明确条件必填与优先级，不错误描述为 schema 二选一拒绝 | tools/browser/browser-tools.ts、browser-session.ts |
| `browser.snapshot` | 可选已有 pageSeq；depth 1–30；返回当前页面快照 | 保留，字段说明与实际选择行为一致 | tools/browser/browser-tools.ts |
| `browser.click` | 合法且当前仍可定位的 ref；left/right、doubleClick；snapshot 默认 true | 保留已有新鲜引用和导航后重取快照说明 | tools/browser/browser-tools.ts |
| `browser.type` | 合法 ref，text 最多 10000；填入替换原内容，可 submit；snapshot 默认 true | 保留，已有字段说明覆盖替换/提交行为 | tools/browser/browser-tools.ts |
| `browser.screenshot` | ref 可选；fullPage 默认 false；filename 为资产名提示而非文件写路径 | 保留，参数与资产返回行为一致 | tools/browser/browser-tools.ts |
| `browser.console` | kind 枚举；sinceSeq 正整数；limit 1–200 默认 50；最近 600 条捕获 | 保留，已有说明覆盖缓冲、异常与增量 cursor | tools/browser/browser-tools.ts |
| `browser.network` | seq 分支优先于 filter/sinceSeq/limit；seq 必须在当前捕获缓冲，最近 400 条；响应文本最多 50000 字符 | 补优先级、ID 来源与旧 ID 失效提示 | tools/browser/browser-tools.ts |
| `browser.evaluate` | expression 1–20000；有 ref 时 expression 为作用于元素的函数；输出须可序列化 | 保留已有窗口/元素两种表达式示例和 origin/cookies 限制 | tools/browser/browser-tools.ts |
| `browser.wait` | text/selector/timeMs 恰选一；timeout 1–30s 默认 10s；固定 delay 时不用 timeout | 保留已有 exactly-one 说明；契约测试验证非法组合仍拒绝 | tools/browser/browser-tools.ts |
| `browser.close` | scope 默认 browser；pageSeq 仅 scope=tab 时使用，默认当前页 | 保留，字段已说明作用域 | tools/browser/browser-tools.ts |

## 委派、技能与会话控制

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `subagent.delegate` | 通用 subagent；主代理按任务配置 profile 或选择 templateId；未提供的配置继承主代理；最多 5 个活跃 children；子代理不可再次委派；工具等待子任务结束后返回结果 | profile 包含角色、指令、工具、只读限制、写入范围和模型；自动继承当前授权；自定义配置限制不可放宽；旧角色仅用于历史会话恢复 | subagent-config.ts、subagent-delegation.ts、subagent-profile.ts |
| `subagent.lifecycle` | start 与 delegate 使用同一通用 profile/templateId 配置；start 需 prompt；除 start/list 外必须带 childSessionId；message 需 message；timeoutMs 0–30000；只控制自己的直接子会话 | start 异步启动；其余生命周期控制不改变已保存的角色和授权；参数保持根 object schema | subagent-tools.ts、subagent-delegation.ts、subagent-orchestrator.ts |
| `skill.load` | skillId 在目录中且当前 profile/权限/会话可用；specialist 受 skillIds 授权列表限制 | 补从可用目录取得精确 ID，检查成功结果后再采用内容 | tool-registry.ts、modules/skills/agent-bridge.ts、specialist-profile.ts |
| `agent.adapt` | 仅 Synax 会话；variantId 为 planner/explorer/reviewer；reason trim 后非空 | 补非空白 reason 说明，保留持续工作使用要求 | synax/synax-adapt-tool.ts |
| `human.ask` | 1–5 问且 ID 唯一；select 必须有唯一 options；recommended 只用于 select 且来自 options，single_select 最多一个；min≤max；主控会话/单工具步骤 | 在正文和字段补无法由普通 JSON Schema 表达的规则 | control-tools.ts、control-contracts.ts、control-policy.ts |
| `plan.propose` | 1–40 步，ID 唯一且只依赖之前的步骤；humanAcceptanceCriteria 为 acceptanceCriteria 的子集；主控会话/单工具步骤；通常审批暂停，unrestricted goal 直接保存执行 | 补依赖顺序、人工验收子集、审批/自动执行区别 | control-tools.ts、control-contracts.ts |
| `plan.execute` | 当前用户明确指令；存在可执行保存计划；可选 revision 必须匹配；主控会话/单工具步骤 | 补先取得保存计划与 revision，过期时重新读取 | control-tools.ts、plan-execution.ts |
| `mode.switch` | chat/goal 枚举；当前用户明确要求；主控会话/单工具步骤；不因此批准保存计划 | 补作用于主控会话与未完成工作限制提示，保留授权要求 | control-tools.ts、control-policy.ts、work-runtime.ts |
| `goal.finish` | goal 工作流；完成需实际 criterion evidence，toolCallIds/artifactIds 属于当前 Work/children 且成功；验证须当前版本；blocked 为具体阻塞 | 补证据 ID 来源、验收原文和验证要求 | control-tools.ts、work-runtime.ts、work-evidence.ts |
| `tools.invalid` | SDK 的未知工具名恢复入口；普通 agent 不应主动调用 | 保留，说明已明确使用当前可用工具名 | tool-invalid.ts、loop-ai-tools.ts |

通用 subagent 的 `writeScope` 可选；省略时继承工作区。提供时为具体相对文件/目录，目录包含后代；拒绝根路径、绝对路径、遍历和通配符。运行时校验实际目标路径（含 patch 移动目标），限制工具集为可约束写入范围的原生文件工具。`access: read-only` 会进一步限制继承权限。旧 specialist 快照仍按原有规则恢复。

## 设计、任务、Work 与历史

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `design.read` | 无参数严格对象；未保存返回空草案 | 保留，已有说明完整 | design-tools.ts、design-service.ts |
| `design.preview` | 无参数严格对象；返回草案与渲染元数据 | 保留，已有说明完整 | design-tools.ts |
| `design.write` | 非空白 Markdown；可选 expectedRevision 乐观并发校验；status 枚举 | 补空白内容/版本不匹配处理 | design-tools.ts、design-service.ts |
| `design.transition` | status 枚举；非强制顺序、可回退；只更新标签 | 保留，不虚构必须先 approved 的限制 | design-tools.ts、design-service.ts |
| `design.implement` | 当前用户明确指令；存在非空草案；可选 revision 与当前版本一致；转入普通 chat 执行 | 补草案存在与版本校验，说明执行模式 | design-tools.ts、plan-execution.ts |
| `task.create` | subject 非空；创建本会话 TODO；goal 已批准计划时结构锁定 | 补计划任务结构锁定提示，不误称验收证据 | tools/task-tools.ts、control-policy.ts |
| `task.update` | taskId 已存在；in_progress 时存在的 blockers 应 completed/deleted；依赖 ID 不做存在性校验，应从本会话 TODO 取得 | 补 blocker 前置条件、ID 来源 | tools/task-tools.ts |
| `task.get` | 当前会话存在的 taskId | 补 ID 来源，保留返回完整详情说明 | tools/task-tools.ts |
| `task.list` | 列本会话非 deleted 项；无参数 | 保留，符合实现 | tools/task-tools.ts |
| `work.checkpoint` | goal 挂载；start 需新用户目标、objective 且没有活跃 children；continue 需 unmetRequirement/nextAction/expectedEvidence 且与计划验收匹配；complete/yield/blocked 条件不同 | 补各 action 条件和 evidence 来源，区分完成与让出回合 | tools/work-tools.ts、work-runtime.ts |
| `verification.run` | goal、active Work；criterion 多个时复制一个，无验收项时显式提供；purpose/scope；宽泛套件需 broader=true 和具体 unresolved risk；禁止 stash/reset/restore/checkout/clean/后台脱离；默认600s、最大600s；120s 未返回时由 command.manage 评估依赖 | 补未批准 criterion、宽泛 suite 与路径范围前置条件，保留已有超时/版本收据语义 | tools/verification.ts、work-runtime.ts |
| `context.read` | kind 为 step/message/checkpoint；精确 ID 属当前会话或 children；message 只 user，step 取历史文本，checkpoint 取索引；offset 默认0、limit 默认6000 最大12000；不返回 tool results | 补各 ID/kind 与字符分页说明 | context-projection.ts |

## 会话检索

三个工具共用权威运行时读取：会话列表来自 sidecar 会话索引，单会话状态来自 authority summary，transcript 只在 `session.search` 显式读取。工作进程内的 store 只镜像执行工作集，因此跨会话读取不走 `agentRuntimeStore.listSessions`。默认作用域是当前会话所属工作区，跨工作区必须显式 `scope:"all"`；已删除（`deletedAt`）和 fork 准备中的会话始终不可见。

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `session.list` | scope 默认 project，projectId 仅 project 可用；status 枚举 1–10；默认只列根会话，子会话需 includeChildren；归档需 includeArchived；limit 默认20、最大100；置顶优先，其余按 updatedAt 倒序；countByStatus 统计整个过滤集而不是当前页 | 新建只读工具；不读 transcript，分页继续用 offset，单会话状态和文本检索分别交给 status/search | session-query/service.ts、tools/session.ts |
| `session.status` | sessionIds 1–20，省略为当前会话，重复 ID 折叠；逐个读取 authority summary；未知 ID 进 missing，全部未知返回 SESSION_NOT_FOUND；includeChildren 额外读取会话索引并附最多20个直接子会话；analytics 来自持久化 runtimeAnalytics 投影 | 补缺省会话、missing 语义与投影来源；不声明读取 run/tool-call 明细 | session-query/query.ts、session-query/service.ts |
| `session.search` | query 为 2–200 字面量子串，大小写不敏感；sessionIds 覆盖 scope，且不能与 projectId 或 scope all 同用；roles 默认 user/assistant；先匹配标题/first prompt，再按 updatedAt 倒序读取最多 maxSessions（默认20）份 transcript，每会话最多3条消息命中；整体命中上限为 max(limit×3, 30)；truncated 表示旧会话或额外命中未返回；missing 只针对显式 sessionIds | 新建只读工具；明确 transcript 读取成本、扫描边界和截断含义 | session-query/service.ts、tools/session.ts |

## 项目自带会话 provider

Git 工具仅在持久化 MR 绑定有效的 Git manager 会话挂载；禁止自行传 root/project/MR/path。参数对象 strict。与普通工具同名的 Git `skill.load` 覆盖普通版本，因此单独记录。

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `git.mr.inspect` | 无参数；读取绑定 MR 状态与版本；绑定改变须重新打开会话 | 补共享绑定边界 | git/provider.ts、git/binding.ts |
| `git.history.compare` | 无参数；只读冻结 target/source 序列及 integration 结果，不是完整 log | 补共享绑定边界，保留历史范围 | git/provider.ts |
| `git.conflicts.list` | 无参数；返回绑定 MR 的 file IDs | 补共享绑定边界 | git/provider.ts |
| `git.diff.read` | fileId 来自绑定 MR；各侧最多48000字符；不是 filesystem path | 补 fileId 来源和绑定范围，保留大内容改用 blob.read | git/provider.ts |
| `git.blob.read` | fileId/side；offset 默认0，limit 默认24000最大48000字符；绑定 MR 的有界侧内容 | 补共享绑定边界，保留字符范围/side schema | git/provider.ts |
| `git.resolution.propose` | MR 为 conflicted、文件 kind=text、revision 当前；content≤2Mi字符；只是保存 proposal | 补状态、类型、revision 来源与过期重读 | git/provider.ts、modules/git-mr/service.ts |
| `skill.load`（Git override） | 只接受6个锁定版本 bundled Git skills；不加载 project/local skills | 补共享绑定边界，保留专用技能约束 | git/provider.ts、git/skills.ts |
| `computer.use` | Jev/Cua 配置可用；goal 非空、pid/windowId 正整数、text≤1000；用具体窗口观察选择最多一个动作；可能 abstain 或切 Direct Cua fallback | 补新鲜窗口 ID、配置前置条件、fallback 后使用下一步挂载工具 | ../computer-use/jev-tool-provider.ts |

## 会话合并、远程 PR 与工作树

| 工具 | 实际约束/行为 | 依据 |
| --- | --- | --- |
| `git.merge.create` | 在当前会话创建持久合并任务；源/目标为注册根中的本地分支；委派隔离子任务并等待终态摘要或显式异步移交，不推送远程、不删除源分支 | conversation-git/tools.ts、schemas.ts |
| `git.merge.analyze` | 已有 objectId；加入活跃 worker 或恢复失败执行，复用同一任务及隔离候选；暂停任务通过 resume 继续 | conversation-git/tools.ts、worker.ts |
| `git.merge.resume` | 复用任务、子代理与候选；instructions 传递用户决定；尊重显式暂停，完成/取消任务保持原状态 | conversation-git/tools.ts、worker.ts |
| `git.merge.cancel` | 停止 worker、阻断晚到写入并清理隔离候选；幂等；不撤销已完成合并、不删除源分支或用户工作目录 | conversation-git/tools.ts、worker.ts |
| `git.merge.configure` | 为停止或等待中的任务设置有依据的验证命令，然后可通过 resume 继续 | conversation-git/tools.ts、schemas.ts |
| `git.merge.read` | 省略 objectId 列当前会话任务；提供 objectId/fileId 读取状态和文件；部分内容按 side/byteOffset/expectedRevision 分页，预览不能视为全文 | conversation-git/tools.ts、schemas.ts |
| `git.merge.propose` | 先读取精确文件和 revision，再保存文字解决建议；不应用文件、不执行检查、不合并，由用户决定是否应用 | conversation-git/tools.ts、schemas.ts |
| `git.pr.read` | objectId 必须为当前会话已附加的 GitHub PR/GitLab MR；返回实时状态及关联本地冲突任务；不推送、不创建或合并远程请求 | modules/remote-pr/tools.ts |
| `worktree.list` | 读取项目、分支、工作树和当前选择；省略 rootId 列全部项目；不扫描工作区改动 | tools/worktree.ts、session-worktrees.ts |
| `worktree.select` | path 来自 list；多项目修改需 rootId；先结束子代理和后台命令；单独调用，切换后相对文件及命令使用新目录 | tools/worktree.ts、session-worktrees.ts |
| `worktree.create` | 使用已有分支，或 createBranch=true 加新分支及可选 startPoint；创建后不自动选择 | tools/worktree.ts、session-worktrees.ts |
| `worktree.remove` | 保留分支和提交；拒绝主目录、锁定、脏或占用中的工作树；missingOnly=true 仅清理已不存在目录的登记 | tools/worktree.ts、session-worktrees.ts |

## 注册范围的排除项

- `file.glob`、`grep.search` 是 rg 使用的内部后端，不是当前全局注册的可调用工具；保留后端实现，不将其重复算作内建入口。
- 新委派统一使用通用 subagent profile。explorer/reviewer/specialist 只兼容旧会话，不再作为新委派的公开配置。自定义子代理在全局设置保存，通过输入框选择或 /subagent 引用，以快照随当前消息、排队输入传递。
- MCP server 工具（包括 Direct Cua）、用户自定义工具走动态 provider，按服务端 schema/description 转发，本次不替服务端重写其契约。
- `goal.finish`、`work.checkpoint`、`verification.run` 和部分控制工具受会话模式及状态挂载，清单包括它们并不表示任意会话均可调用。

## 回归验证

新增 `__tests__/builtin-tool-contracts.test.ts` 验证全局注册覆盖、最终模型定义导出、writeScope 有效/无效例子、媒体/browser 组合、human/plan refine 规则及 rg 默认数量/前导连字符。修正旧 tool-registry 测试仍引用已撤下 edit 的断言，改为当前 file.patch。新增图像适配器与 webSearch 批量参数形状检查。

后续修正：`subagent.lifecycle` 原用 `z.discriminatedUnion`，导出的根 schema 为 `oneOf`，DeepSeek 等 OpenAI 兼容 provider 直接拒绝该工具定义。改为扁平严格对象加 `superRefine`（保留 start 需要 prompt、start/list 不接受 childSessionId、其余动作需要 childSessionId、message 需要 message 等原有约束），并在 `builtin-tool-contracts.test.ts` 增加根 `type: "object"` 与逐动作参数形状断言。

实际验证记录：

- 当前工作区运行 17 个相关 Vitest 文件，共 176 项：初次 175 通过，1 项 Jev mock 因继承 production 环境而进入真实凭据校验失败。
- 显式 `NODE_ENV=test` 重跑 `services/local-node/modules/computer-use/jev-tool-provider.test.ts`，2 项全部通过。因此全部 176 项均取得通过记录；不改变生产环境的真实凭据要求。
- 当前工作区 `npm run typecheck` 通过。
- 本次涉及文件的 `git diff --check` 通过；未重排其他工作区改动。
- 最终模型工具定义验证经过 `buildLoopToolSet` 与 SDK `asSchema`，包括全部静态注册工具覆盖和重点参数规则。
- 未执行真实付费媒体生成、外部浏览器/桌面操作或所有项目测试。MCP/自定义工具的服务端说明不在本次修改范围。

验证日志保存在本地 `.tmp/tool-contract-final-tests.log` 与 `.tmp/tool-contract-jev-test.log`。隔离工作区曾缺少未纳入 checkout 的 Git 技能资源，导致其额外 Git 检查失败；最终当前工作区的全部 11 项 Git 工具检查通过。

### 命令异步执行

有限任务可在调用时选择是否等待：

```json
{"command":"npm run build","async":true,"timeoutMs":600000}
```

权限校验完成后，异步调用会在资源排队和进程启动前返回 `commandTaskId`，主会话可以继续独立工作。命令执行仍由受管进程异步完成；进程结束后，stdout、stderr、退出码与失败信息通过同一完成队列注入下一 step，并保留持久化结果。依赖该结果时调用 `command.manage`：

```json
{"commandTaskId":"<返回的 ID>","action":"wait","reason":"下一步依赖构建结果"}
```

不等待命令时可查询状态：

```json
{"commandTaskId":"<返回的 ID>","action":"status","reason":"查看是否已获得资源"}
```

`cancel` 会停止该任务；省略 `async` 或设置 `async:false` 则正常等待，120 秒后沿用依赖评估机制。异步任务仍遵守 `timeoutMs` 和会话取消，最终汇总前必须处理其结果。`background:true` 继续用于常驻服务，不能与 `async:true` 同时传入。

### 命令并发与计时（0.8.0）

根会话与子会话可使用资源池中的空闲名额，不再固定共享一个名额。出现竞争时，下一空闲名额优先分给活跃任务最少的根会话，同等负载轮转分配；已运行任务不被抢占。没有新增工作区全局串行锁。

| 资源池 | 默认并发 | 适用操作 |
| --- | --- | --- |
| command | CPU 可用核数，最小 8、最大 32 | 普通命令及未识别的 shell 程序 |
| cpu | CPU 可用核数的一半，最小 2、最大 8 | 已识别的 Vitest、tsc、构建/测试脚本和 verification.run |
| search | 8 | 搜索、常见 Git 检查、sed 纯打印行范围 |
| external | 16 | MCP 与外部执行 |
| io | 16 | 文件等 I/O 操作 |

各池可用 `SYNAX_RESOURCE_<大写池名>_LIMIT` 显式覆盖，范围 1–128；启动时生效。命令识别只用于调度，不替代权限检查，也不保证识别动态脚本内部启动的构建。普通调用最多排队 60 秒；显式 async 调用可排队 300 秒，等待期间可查询、取消，且不会占用执行名额。

macOS/Linux 前台命令将语法检查放入同一个受管进程组，检查成功才 exec 实际 Bash，省去第二次租约和 guardian 注册。Windows、WSL 和常驻服务保留原有启动路径。guardian 在 25ms 窗口内合并退出确认扫描，停止信号仍立即发出。

`command.completed` 按 toolCallId 记录 gateMs、syntaxMs、processMs、cleanupMs、totalMs；`tool.execution.timing` 记录工具前后指纹、资源等待和整体耗时。数值是所在进程的观测时间，processMs 包括子进程启动及 stdio 关闭，不等于纯 CPU 时间。日志不包含命令正文或环境凭据。前后工作区指纹仍保留，用于变化追踪与验证收据。

启动对照基准：`node --import tsx/esm scripts/command-execution-benchmark.ts .tmp/command-execution-benchmark.json`。它比较单/双受管登记和 8 个并发命令，不包含生产资源准入、持久化租约或工具注册层。上线须同步构建 Node 服务与 Rust sidecar；仅重启旧的已安装应用不会载入源码变更。
