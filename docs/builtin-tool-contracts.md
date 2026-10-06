# 内建工具描述与运行时校验盘点

盘点日期：2026-10-03。共 56 个工具 ID、57 个定义（Git skill.load 覆盖版本单列）。范围以 `ToolRegistry` 的静态注册、Synax 启动追加注册和项目自带的 Git MR / Jev provider 为准。以下逐项记录当前校验、说明处理与源码依据。数值、枚举、正则等可由 JSON Schema 表达的边界继续由 schema 提供；组合约束、执行前置条件和优先级进入工具正文或字段 `describe()`。

## 共享规则与模型可见链路

- `loop-ai-tools.ts` 将 `description` 与 `progressiveDetails` 拼接；模型参数由 SDK `asSchema(...).jsonSchema` 导出。`refine`、`superRefine`、`execute` 的条件不能假定自动导出；新增测试经过这条真实链路验证。
- 普通文件、搜索、命令工具相对路径以会话工作目录为基准，绝对路径交给 sandbox 授权，外部路径可能需要批准。specialist 写入的安全相对路径限制更加严格，不能套用到普通工具。
- 已读文件变化会触发读写追踪校验。文件存在性、权限、网络、模型/provider 配置、窗口和页面状态属于动态条件；说明可以提示前置条件，但不能保证外部调用成功。
- 模式、挂载、权限、计划批准和 Work 状态由 `control-policy.ts`、`tool-mount-policy.ts`、`permission-policy.ts`、`work-runtime.ts` 和 `specialist-profile.ts` 执行。工具内部的 run/step ID 由运行时传递，不要求 agent 猜测或填写。
- 未放宽校验、权限和执行策略。除了工具说明和字段元数据，修正了 `file.read` 返回的截断提示：不再建议使用不存在的 `offset` 参数。

源码路径以下均相对于 `services/local-node/modules/agent-runtime/`，计算机工具另行标注。

## 文件、命令与搜索

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `bash` | command 长度 1–4000，拒绝 NUL；workdir 必须可解析；每个管道/链段走权限判断；有限会话限制重定向；timeout 默认 30s、1–600s，background 时忽略 | 补路径基准和 command 的 NUL 限制，保留后台/超时/权限说明 | tools/bash.ts、tools/bash-command-policy.ts、tools/workspace.ts |
| `file.read` | 普通文本文件，扩展名/内容识别二进制；maxBytes 默认和上限 64000；没有 offset 参数 | 修正可用搜索工具名、路径说明、默认上限、截断后的读取建议 | tools/file-read.ts |
| `file.write` | 非空 path、string content；完整覆盖并创建父目录；自动补读；已读文件变化可能拒绝写入 | 补路径基准、绝对路径授权与文件变化处理 | tools/file-write.ts、read-tracker.ts |
| `file.delete` | 删除单文件，不递归删除目录；路径走 sandbox | 补路径授权说明，保留明确删除请求的使用要求 | tools/file-delete.ts |
| `file.list` | 目录输入，默认当前工作目录；limit 默认 100、上限 300；仅返回当前层，过滤不可见项 | 补真实默认数量、目录和路径基准 | tools/file-list.ts、tools/workspace.ts |
| `file.patch` | 单个 Begin/End envelope；Add/Update/Delete/Move 语法；加行用 +；hunk 必须匹配；写入前进行解析、路径和读写校验 | 补具体路径语义、Move 位置、最终 End 标记和文件变化重读提示 | tools/patch.ts、tools/patch-format.ts、read-tracker.ts |
| `diff.read` | 当前会话 Git 目录内执行 git diff --stat，可选 --cached；不是完整 diff | 补 Git 目录前置条件和输出范围 | tools/diff-read.ts |
| `rg` | 默认 search 且 query 必填；files 需要 pattern 和目录；regex 默认 false；search 默认 50、截到 200，files 默认 100、上限 300；前导连字符被安全传递 | 修正默认数量和错误的前导连字符禁令；说明 files 忽略文本搜索参数和路径基准 | tools/rg.ts、tools/grep-search.ts、tools/file-glob.ts、tools/ripgrep.ts |
| `webSearch` | query/queries 恰选一；queries 为 1–5 个字符串；公共过滤条件对各查询生效；域名不含协议/路径；limit 默认 5、1–10 | 明确二选一、批量元素类型、共享过滤和每查询数量；保留外部检索/回退边界 | tools/web-search.ts |

## Code Mode（1.7.0）

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `code.tools` | 项目默认关闭；query/offset 分页短目录，toolId 返回单工具 schema；仅已挂载、profile 允许的内置读取工具或逐项信任的只读 MCP | 保留普通工具；无需一次注入全部 Schema | code-mode/tools.ts、code-mode/policy.ts |
| `code.run` | JavaScript async 函数体，await tools.call(id,args)，return 小 JSON；32KB 代码/参数、32 次调用、4 并发、15s、32MiB guest heap；无 Node、直接 FS/网络、模块加载器；不自动重试/重放 | 每次内调经过 Registry，ask 转 denied，结构化失败记录，父子审计，历史只投影外层结果 | code-mode/、tool-registry.ts、loop-model-messages.ts |

MCP readOnlyHint 不是安全保证；管理员须逐项验证服务器行为。允许的 MCP 请求仍可能发送代码组装的参数到外部服务器。全局运维关闭：SYNAX_CODE_MODE=0。

### 原生能力路径（分阶段启用）

设置 `SYNAX_NATIVE_CAPABILITIES=1` 后，原生会话使用固定的 `agent.discover` / `agent.execute` 入口。模型首轮仅接收常用读取与必要控制工具，其他 schema 按需披露；旧 `code.tools` / `code.run` 保留兼容但不同时展示。关闭该发布开关可恢复旧工具面。

| 入口 | 实际约束/行为 | 依据 |
| --- | --- | --- |
| `agent.discover` | 支持 query/group、最多 4 个精确 ids、cursor 分页；每页最多 4 个契约，动态工作集最多 12 个、估算 8,000 tokens；下一模型步骤生效；披露不授予权限 | native-capabilities/service.ts、disclosure.ts |
| `agent.execute` | 复用隔离编排服务；内部调用必须使用本轮已披露且版本有效的契约，并重新校验原有权限；限制和禁止自动重放行为沿用 Code Mode | code-mode/composition-service.ts、native-capabilities/service.ts |

编排权限关闭时仍可发现与直接调用获准工具。旧项目策略保持不变；发布开关开启后新创建项目默认允许内置只读编排，MCP 精确允许列表仍为空。完整架构和发布验收见 `docs/design/2026-10-06-native-agent-capabilities.md`。

## 媒体

媒体引用须属于当前会话；图像和视频请求的引用总预算由 `media-context.ts` 限制为 100 MiB。模型和可选生成能力依赖实际 provider，不将某个 provider 的规则错误地声明为通用 schema 限制。

| 工具 | 实际约束/行为 | 处理 | 依据 |
| --- | --- | --- | --- |
| `media.read` | assetId/path 恰选一个非空值；assetId 必须已附加当前会话；文件为普通文件且最多 50 MiB；path 走 sandbox | 正文和字段明确二选一、归属、文件大小及路径授权 | tools/media-read.ts、content-parts.ts |
| `media.generate` | 配置 provider；非 OpenAI 适配器须显式 model；images/mask 加载会话资产；预算 100 MiB；Images/Responses 对格式/尺寸/组合执行额外限制，SDK 有不同规则 | 补资产预算、参考图 <50 MB、Responses n=1、SDK 流式限制、Images/Responses 的 size/aspectRatio/seed/压缩/透明组合条件，字段说明注明 GPT Image 2 尺寸规则 | tools/media-generate.ts、tools/media-context.ts、infrastructure/llm-runtime/image-generation.ts、infrastructure/llm-runtime/media-generation.ts |
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
| `subagent.delegate` | builtin profile 限 explorer/reviewer；specialist 优先；prompt 非空；specialist prompt 最多 20000；一层、最多 3 活跃 children；同时最多一个 specialist writer；Plan specialist 不写；权限继承 | 列出 profile、优先级、写入范围和串行 writer 要求；capabilities/writeScope 字段带完整约束及合法例子 | tool-registry.ts、specialist-profile.ts |
| `skill.load` | skillId 在目录中且当前 profile/权限/会话可用；specialist 受 skillIds 授权列表限制 | 补从可用目录取得精确 ID，检查成功结果后再采用内容 | tool-registry.ts、modules/skills/agent-bridge.ts、specialist-profile.ts |
| `agent.adapt` | 仅 Synax 会话；variantId 为 planner/explorer/reviewer；reason trim 后非空 | 补非空白 reason 说明，保留持续工作使用要求 | synax/synax-adapt-tool.ts |
| `human.ask` | 1–5 问且 ID 唯一；select 必须有唯一 options；recommended 只用于 select 且来自 options，single_select 最多一个；min≤max；主控会话/单工具步骤 | 在正文和字段补无法由普通 JSON Schema 表达的规则 | control-tools.ts、control-contracts.ts、control-policy.ts |
| `plan.propose` | 1–40 步，ID 唯一且只依赖之前的步骤；humanAcceptanceCriteria 为 acceptanceCriteria 的子集；主控会话/单工具步骤；通常审批暂停，unrestricted goal 直接保存执行 | 补依赖顺序、人工验收子集、审批/自动执行区别 | control-tools.ts、control-contracts.ts |
| `plan.execute` | 当前用户明确指令；存在可执行保存计划；可选 revision 必须匹配；主控会话/单工具步骤 | 补先取得保存计划与 revision，过期时重新读取 | control-tools.ts、plan-execution.ts |
| `mode.switch` | chat/goal 枚举；当前用户明确要求；主控会话/单工具步骤；不因此批准保存计划 | 补作用于主控会话与未完成工作限制提示，保留授权要求 | control-tools.ts、control-policy.ts、work-runtime.ts |
| `goal.finish` | goal 工作流；完成需实际 criterion evidence，toolCallIds/artifactIds 属于当前 Work/children 且成功；验证须当前版本；blocked 为具体阻塞 | 补证据 ID 来源、验收原文和验证要求 | control-tools.ts、work-runtime.ts、work-evidence.ts |
| `tools.invalid` | SDK 的未知工具名恢复入口；普通 agent 不应主动调用 | 保留，说明已明确使用当前可用工具名 | tool-invalid.ts、loop-ai-tools.ts |

`writeScope` 及 specialist 的写路径要求：具体相对文件/目录，目录自动包含后代，无需 /**；拒绝绝对路径、根路径（含 .）、.. 路径段、* / ?、反斜杠、冒号、百分号、控制字符、~ 开头、首尾空白及 symlink 路径组件。数组 1–32 项，单路径最多 1024 字符。普通文件工具不使用这套严格路径 schema。

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
| `verification.run` | goal、active Work；criterion 多个时复制一个，无验收项时显式提供；purpose/scope；宽泛套件需 broader=true 和具体 unresolved risk；禁止 stash/reset/restore/checkout/clean/后台脱离；默认120s、最大600s | 补未批准 criterion、宽泛 suite 与路径范围前置条件，保留已有超时/版本收据语义 | tools/verification.ts、work-runtime.ts |
| `context.read` | kind 为 step/message/checkpoint；精确 ID 属当前会话或 children；message 只 user，step 取历史文本，checkpoint 取索引；offset 默认0、limit 默认6000 最大12000；不返回 tool results | 补各 ID/kind 与字符分页说明 | context-projection.ts |

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

## 注册范围的排除项

- `file.glob`、`grep.search` 是 rg 使用的内部后端，不是当前全局注册的可调用工具；保留后端实现，不将其重复算作内建入口。
- 当前工作区已移除 Wiki specialist 能力和 Wiki 委派 profile；静态注册和自带 provider 中没有 Wiki 原生工具。本次描述以当前 explorer/reviewer 和实际 SAFE_CAPABILITIES 常量为准；外部 Wiki/MCP 工具由各自 server 提供描述。
- MCP server 工具（包括 Direct Cua）、用户自定义工具走动态 provider，按服务端 schema/description 转发，本次不替服务端重写其契约。
- `goal.finish`、`work.checkpoint`、`verification.run` 和部分控制工具受会话模式及状态挂载，清单包括它们并不表示任意会话均可调用。

## 回归验证

新增 `__tests__/builtin-tool-contracts.test.ts` 验证全局注册覆盖、最终模型定义导出、writeScope 有效/无效例子、媒体/browser 组合、human/plan refine 规则及 rg 默认数量/前导连字符。修正旧 tool-registry 测试仍引用已撤下 edit 的断言，改为当前 file.patch。新增图像适配器与 webSearch 批量参数形状检查。

实际验证记录：

- 当前工作区运行 17 个相关 Vitest 文件，共 176 项：初次 175 通过，1 项 Jev mock 因继承 production 环境而进入真实凭据校验失败。
- 显式 `NODE_ENV=test` 重跑 `services/local-node/modules/computer-use/jev-tool-provider.test.ts`，2 项全部通过。因此全部 176 项均取得通过记录；不改变生产环境的真实凭据要求。
- 当前工作区 `npm run typecheck` 通过。
- 本次涉及文件的 `git diff --check` 通过；未重排其他工作区改动。
- 最终模型工具定义验证经过 `buildLoopToolSet` 与 SDK `asSchema`，包括全部静态注册工具覆盖和重点参数规则。
- 未执行真实付费媒体生成、外部浏览器/桌面操作或所有项目测试。MCP/自定义工具的服务端说明不在本次修改范围。

验证日志保存在本地 `.tmp/tool-contract-final-tests.log` 与 `.tmp/tool-contract-jev-test.log`。隔离工作区曾缺少未纳入 checkout 的 Git 技能资源，导致其额外 Git 检查失败；最终当前工作区的全部 11 项 Git 工具检查通过。
