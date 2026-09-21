# Synax 对话内交互产物：完整设计

- 日期：2026-09-21
- 状态：设计评审稿；未开始产品代码实现
- 工作树：`/Users/mint/.codex/worktrees/7d60/Synax`
- 目标：让 Agent 在会话中交付可操作、可调参、可反馈、可迭代和可导出的原型、图表及交互说明，而不是仅生成文件链接。
- 范围：一次完整交付，下述实施顺序只是工程依赖顺序，不是向用户交付若干残缺版本。

## 1. 产品定义和验收用例

用户说“先做个原型给我 QA”，Agent 生成源码、发布版本，会话出现可交互的卡片。用户点击 Mini/Detail、改变宽度或状态、选中某个区域写反馈，确认后反馈成为该会话的用户消息。Agent 基于明确的版本和反馈发布下一版。旧消息保留旧版；关闭重开仍可回看。允许导出独立 HTML 或源码包。

核心验收用例使用运行摘要原型：Mini 两行摘要，Detail 原地展开，浅深色跟随主题，300–520px 宽度调节，运行/完成/等待/异常/空数据五种状态；QA 反馈必须包含版本和用户选定的参数，第二版不得覆盖第一版。

### 完整交付内容

1. HTML/CSS/JS 和受限 React/TSX 两种源码入口。
2. 不可变产物版本、资源快照、构建诊断、可取消/恢复的构建任务。
3. 对话内展示、放大预览、源码、版本切换、暂停/重载、导出。
4. 宿主 SDK：初始化、主题、尺寸、有限状态、声明式参数、反馈草稿。
5. 宿主 QA 面板：参数调整、状态场景、元素定位、反馈确认。
6. Native 与外部后端的发布接入，以及 SSE/刷新/重连一致性。
7. 沙箱、网络边界、权限、防跨会话访问、资源限额、错误恢复和自动化测试。
8. 自带示例、Agent 使用说明、开发文档、迁移和安全说明。

### 不属于完整版本的范围

这不是任意项目托管平台：不运行生成的 Node 服务、不自动 npm install、不执行用户构建脚本、不开放数据库/终端/文件系统给原型，不提供互联网公开部署，也不承诺恶意 JavaScript 在所有浏览器中具有进程级资源隔离。多人实时协作不在本次范围，数据结构保留 owner 标识。

## 2. 现状与设计选择

已核对的接入点：

- `web/src/react/features/agent-workspace/CodeViewer.tsx` 已使用 `iframe sandbox="allow-scripts"` 和 `srcDoc` 展示 HTML，但属于文件查看器。
- `SessionMarkdown.tsx` 负责 Markdown 和工作区文件链接，不应直接开启 raw HTML 执行。
- `buildInterleavedTurns.ts`、`toolCallUtils.ts`、`TurnBody.tsx` 负责内容块构建和展示，需要贯通新的 artifact block。
- `api/services/agent-runtime/tool-registry.ts` 与 `tools/` 提供 Native 工具注册。
- `runtime-stream-writer.ts`、`event-service.ts` 和 `session-store.ts` 负责持久化、事件及恢复。
- `media-assets.ts` 提供资源存储模式；`api/db/migrations/` 提供显式迁移。
- Codex/Claude 外部后端有独立工具和隔离配置，不能假设注册 Native 工具就完成外部后端支持。

三个候选方案：直接执行 Markdown 代码块最简单但缺少权限及版本边界；启动任意 Vite 项目灵活但引入后台服务、端口和依赖执行；采用受控产物快照和独立沙箱可兼顾交互、历史和安全。本方案选择第三种。

## 3. 用户体验

### 3.1 会话卡片

卡片头部展示产物标题、版本、运行状态与放大入口。操作菜单提供源码、历史、重新加载、暂停、导出。默认不露开发工具，不用装饰性大面板包裹小原型。流式生成只显示“构建中”，成功后一次性载入；不执行半截 HTML。

- 内联默认宽度随消息区域，初始高度 240px；内容报告后自动调整，范围 96–640px。
- 更高内容进入内部滚动或放大视图，不无限拉长会话。
- 内联和放大复用同一个运行实例/状态，不同时启动两份计时器。
- 消息写死 revisionId；“有新版”是提示和显式切换，不自动替换。
- 离开视口较远的产物暂停/卸载并保留宿主状态；自动挂载最多 2 个实例，优先当前聚焦者。
- 展示中断/删除/不支持/未授权时仍保留标题、版本和错误说明，不静默消失。

### 3.2 QA

“调整”打开宿主参数面板，参数由 SDK 声明，不允许原型注入面板 HTML。类型为 select、toggle、number/range、color、text；最多 12 项。每项必须有稳定 key、label、类型、默认值、校验范围。颜色使用明确字符串格式，文本单项最多 2KB。

“标注”进入元素选择模式：原型 SDK 协助读取被点击元素的标签、可选 `data-qa-id`、文本摘要和边界框。由宿主绘制选框和编辑反馈。元素描述属于不可信数据，不能变成执行权限。动态内容无法稳定定位时允许整卡反馈；不伪造 CSS selector 的稳定性。

“发送修改意见”首先打开宿主确认面板，展示文字、产物/版本、当前参数以及可选截图。确认后走现有用户消息/队列机制；Agent 正忙时进入原有队列，不静默打断。拒绝或关闭不发送消息。不把完整 DOM、源码、privateState 自动注入模型上下文。

截图是可选附件。Electron 在隔离预览 surface 截图；Web 仅在平台支持并获得用户授权的捕获流程中提供，不能可靠截图时明确隐藏/禁用，不用“重画 DOM”冒充准确截图。

### 3.3 状态

区分四类数据：

- artifact source：不可变版本源码和资产；
- privateState：本地交互状态，不自动给 Agent；
- modelState：原型建议分享的上下文，只有用户确认反馈时才发出；
- host UI state：版本选择、宽度、面板打开状态，由宿主管理。

状态 key 为 owner/session/artifact/revision/stateSchemaVersion。跨 revision 默认不迁移；新 revision 可声明相同 stateSchemaVersion，宿主仍要求参数 schema 兼容，允许用户选择继承。重置只影响当前版本的交互状态，不删源码。

## 4. 产物和消息协议

新建独立 contracts 模块并由 API、Web 共享校验定义，避免把可执行产物塞进面向模型 provider 的媒体输入联合类型。

```ts
type ArtifactSourceKind = 'html' | 'react';
interface ArtifactReference {
  type: 'artifact';
  artifactId: string;
  revisionId: string;
  title: string;
  presentation: 'inline' | 'wide';
}
interface PublishArtifactInput {
  sourcePath: string; // session workspace-relative; never frontend-readable absolute path
  title: string;
  sourceKind: ArtifactSourceKind;
  artifactId?: string;
  baseRevisionId?: string;
  idempotencyKey: string;
}
```

`artifact.publish` 从认证的运行上下文取得 sessionId/runId/turnId，调用者不能冒充其它会话。第一次发布创建 artifact；修改已有 artifact 必须提交 baseRevisionId。原 head 已变化时返回 `REVISION_CONFLICT`，不覆盖、不偷偷分叉。用户明确选择从历史版继续时，服务建立新分支 artifact 并记录 derivedFrom。

完成发布后，宿主插入结构化 artifact 内容块；模型获得 ID、revision、标题、摘要和 diagnostics，不获得可拿去访问其它会话的 bearer URL。一个 turn 同一 revision 仅出现一次。

兼容文字后端：支持明确的完整 `synax-artifact` fenced block，内容是 JSON manifest，不直接包含执行代码。只识别 assistant 完成消息中的顶层块；忽略引用、用户文本、工具日志和未闭合流式块。服务端再次校验工作区与发布权限，物化后持久化引用，前端不自行打开 manifest 路径。重复扫描以消息 ID、块序号、内容 hash 幂等。

普通 HTML fence、Markdown 内任意 iframe、文件链接和模型伪造的 artifactId 均不会自动执行。

## 5. 持久化、版本和构建一致性

采用已有 SQLite 及 DATA_ROOT 存储约定：

- `runtime_artifacts`：id、projectId、sessionId、title、headRevisionId、createdAt、deletedAt、derivedFrom。
- `runtime_artifact_revisions`：id、artifactId、revisionNumber、baseRevisionId、sourceKind、manifestHash、sourceHash、bundleHash、compilerVersion、sdkVersion、policyVersion、status、diagnostics、runId、turnId、createdAt。
- `runtime_artifact_blobs`：hash、bytes、mediaType、storageKey；真实文件位于 DATA_ROOT/runtime-artifacts/blobs，客户端不接触路径。
- `runtime_artifact_files`：revisionId、normalizedRelativePath、blobHash、role。
- `runtime_artifact_states`：ownerKey、sessionId、artifactId、revisionId、schemaVersion、privateJson、modelJson、etag、updatedAt。
- `runtime_artifact_feedback`：id、revisionId、ownerKey、draft/submitted、text、parameters、elementAnchor、attachmentIds、userMessageId、idempotencyKey。
- 构建 job/outbox 表保存发布请求、状态、租约及提交事件，避免事件先到但产物尚不可读。

约束：artifact/revisionNumber 唯一；publish 幂等 key 在会话内唯一；全部资源查询通过 session ownership；状态使用 ETag 乐观并发，冲突提示重载或用户覆盖，不默默 last-write-wins。

流程：校验 → 收集并快照文件 → 在临时位置写 blob → hash 校验和原子 rename → worker 构建 → 事务登记 ready revision、CAS 更新 head、记录事件/outbox → 提交后通知 SSE。中断不会产生半个 ready 版本。构建失败版本可见诊断、不更新 head；重试创建新 attempt，已发布版本内容永不重写。

启动时回收失效构建租约；有持久化源码则恢复构建，没有则失败并要求重新发布。定期 mark-and-sweep 清理超过 24 小时且没有 DB 引用的 blob，不能依赖可能失配的 refcount 独自决定删除。历史版本不自动删除，接近配额时提示用户清理。删除会话沿现有会话生命周期清理关联记录，文件延迟 GC。

## 6. 内容采集和构建

### HTML

支持完整 HTML 文档或 fragment。用解析器重建 runtime 文档，宿主拥有 base、CSP、bootstrap 顺序；拒绝嵌套 frame/object/embed、远程脚本、meta refresh、远程 CSS/import 以及外部 base，不做正则拼接安全策略。用户脚本在 bootstrap 之后运行。

资产只从显式 manifest/解析出的相对路径收集，不递归复制整个工作区。路径 realpath 后必须属于当前 session 授权根，拒绝符号链接逃逸、设备文件、FIFO、绝对路径、目录穿越、大小写碰撞、双重编码和压缩包路径逃逸。默认拒绝 .env、密钥/凭据文件；内容授权来自发布行为而非 iframe。

文件快照采集采用打开文件后的 stat/hash 复核，变化则失败或重试，不能把混合版本发布成一致快照。预览始终使用快照，而非 live workspace 文件。

源码入口对 HTML 是单一文档，静态相对资源通过解析收集；对 React 是入口模块，依赖图通过受控解析器收集。可选 `synax-artifact.json` 只用于声明标题、入口、sourceKind、stateSchemaVersion 和静态资产，不承载任意构建命令。工具显式参数优先于 manifest。

### React/TSX

独立 worker 只做编译转换与打包，不运行项目配置或生成的代码。使用锁定版本的 esbuild 及显式解析 allowlist，支持 React、react-dom、Lucide 和受控图表包；实际依赖版本随仓库 lockfile 发布，不运行时下载 CDN。支持相对 TSX/TS/JS/CSS/JSON 和静态资源；拒绝 Node 内建、未许可 bare imports、远程 imports、任意 esbuild/Vite plugin、postinstall 和 package scripts。

CSS 走宿主受控处理，不隐式加载项目 postcss/tailwind 配置。第一版完整协议支持普通 CSS；要支持 utility CSS 则由产品提供固定预编译样式集，而不是任意项目构建链。

可视化 HTML runtime 自带 SDK、Lucide 和固定版本基础样式，无需出网。React bundle 的版本/许可证清单随导出记录。编译错误返回相对文件、行列、错误类别，不能泄露本机绝对路径。

### 默认限额（服务端配置，上下限由宿主控制）

源码文本总量 2 MiB；本地资产总量 20 MiB；最多 100 文件；bundle 10 MiB；构建最长 15 秒、worker 内存上限 256 MiB（不支持强制内存上限的平台不宣称该限制有硬保证）；每会话最多 500 MiB，应用总配额默认 2 GiB；只对超额新发布拒绝，不破坏已发布版本。

## 7. 沙箱和安全模型

### 7.1 不可信边界

全部产物 HTML、JS、CSS、反馈建议、元素描述、modelState 和日志均不可信。产物不获得 Synax API token、会话 cookie、Electron preload、Node、文件系统、终端、下载和弹窗权限。不得将 iframe 内按钮点击本身当成用户授权宿主执行操作。

不能把 iframe 或 CSP 描述成对所有恶意代码的完整网络/CPU 防护：iframe 可自行导航，浏览器支持和进程调度存在限制，子页面 CSP 也不能代替应用授权。

### 7.2 Web transport

内容运行在 sandbox iframe，只有 allow-scripts，不授予 allow-same-origin、allow-popups、allow-forms、allow-downloads、allow-top-navigation。srcdoc 使用宿主构造文档，不 raw 插入业务主 DOM；referrerPolicy=no-referrer。宿主 CSP 禁止嵌套子 frame、外部脚本、连接、worker、表单及远程图片字体；本地 snapshot 资产转换为受控 inline/data/blob 资源，并受限额约束。

脚本/CSS hash 由构建过程计算；不使用 unsafe-eval。图片可允许 data/blob，SVG 图像拒绝外部引用和脚本。初版不允许网络 capability，即使原型声称需要联网。

**Web 的限制必须在 UI 和文档明确**：iframe 内代码自导航等渠道不能仅靠 CSP 被证明完全禁网。Web 默认先显示静态卡片和“运行交互内容”按钮，用户显式运行；如部署需要严格出网隔离，则运行功能要求隔离浏览器执行服务，不静默降级成“安全离线”。本文不把额外远程执行基础设施列入一次本地产品交付。不能给 Web 原型注入业务秘密或自动提供会话全文。

### 7.3 Electron transport

为严格网络和崩溃隔离使用专用 WebContentsView + 临时独立 session partition，不复用主窗口的 session/preload。sandbox=true、contextIsolation=true、nodeIntegration=false。专用最小 preload 只向 isolated world 暴露本节定义的消息通道，页面可用的仍只有 SDK；不得暴露 ipcRenderer 或主应用 preload 接口。通过私有预览协议加载当前 bundle 和 bootstrap，网络拦截只放行其静态本地资源，拒绝 HTTP/HTTPS/WS/FTP/file 和其它协议；拦截导航、window.open、下载及 permission request。

主进程校验 previewId、拥有者窗口、revision、消息格式。只有固定 bridge 消息，不提供通用 executeJavaScript 或任意 IPC 转发。每实例独立生命周期；超时/崩溃只关闭此 view。

内联定位由 renderer 发送经过约束的可见 bounds；主进程校验限制在宿主窗口内容区域。预览越出滚动 viewport 的部分裁剪。打开宿主模态框、菜单、拖拽及切换 tab 时隐藏/停用底层 view，防止原生 surface 覆盖确认按钮。放大把同一 view 移至放大容器，而非新建另一份。该 overlay/focus/缩放回归属于必须验收项目；不能直接以 shared-session iframe 替代后宣称同等级隔离。

主进程 watchdog 使用实例心跳、无响应事件和用户停止操作关闭失控 renderer；不依赖被阻塞的生成脚本自报健康。Web watchdog 仅为错误恢复辅助，不能保证恶意死循环不影响同 renderer。

### 7.4 SDK 通信

每次挂载生成 instanceId 和随机 nonce；握手绑定 iframe contentWindow/专用 transport 和 revision，建立 MessageChannel。opaque origin 为 null，不能只检验 event.origin；必须校验 window source、一次性 nonce、协议版本和消息 schema。重新加载撤销旧 port/nonce，所有异步响应带 requestId，超时 5 秒。

最大单消息 32 KiB；每实例 20 msg/s、短时 burst 40；日志环形缓冲 100 条且单条 2 KiB；resize 每帧合并并限频，状态写入 500ms debounce。超过配额拒绝/暂停，不把巨大数组继续送入 React 状态树。

## 8. SDK v1

```ts
interface SynaxWidget {
  ready(): Promise<{theme: 'light'|'dark'; locale: string; state: WidgetState}>;
  getState(): WidgetState;
  setState(next: {privateState?: Json; modelState?: Json}): Promise<void>;
  onThemeChange(listener: (theme: string) => void): () => void;
  onStateChange(listener: (state: WidgetState) => void): () => void;
  reportHeight(height: number): void;
  registerControls(schema: ControlSchema[]): Promise<void>;
  onControlsChange(listener: (values: JsonObject) => void): () => void;
  requestFeedbackDraft(input: {text?: string; modelState?: Json}): Promise<void>;
}
```

无 callTool/executeShell/openFile/fetchProxy 等越权接口。发出 feedbackDraft 只会形成宿主待审草稿或低优先级提示，不自动弹窗、不自动提交、不写入用户队列。宿主独立确认才有副作用。

主题变量由 SDK 注入受控产品 tokens，不给原型访问主页面 DOM；容器 ResizeObserver 自动报告高度，并允许 reportHeight 请求，宿主最终裁决尺寸。state 保存 private+model 合计最多 16 KiB；拒绝循环引用、原型污染 key 和非 JSON 值。

## 9. API 与运行时集成

拟议 session-scoped 路由：

- POST `/api/agent-runtime/sessions/:sessionId/artifacts`：发布任务，返回 202 + jobId。
- GET `.../artifacts`：分页列表。
- GET `.../artifacts/:artifactId/revisions`：版本列表。
- GET `.../artifacts/:artifactId/revisions/:revisionId`：manifest、状态与诊断。
- GET `.../revisions/:revisionId/source`、`.../bundle`：宿主读取；不直接在 app origin 作为可导航 HTML 执行，使用 application/json/attachment + nosniff。
- GET/PUT `.../revisions/:revisionId/state`：状态与 ETag。
- POST `.../revisions/:revisionId/feedback`：确认后的幂等反馈提交。
- GET `.../revisions/:revisionId/export?format=html|source`：attachment。
- DELETE `.../artifacts/:artifactId`：显式用户删除/墓碑。

沿用现有身份与 session/project 权限校验；不能仅凭猜不出的 ID 放行。访问不属于当前授权范围的资源返回统一 not-found，不泄露是否存在。跨域修改校验 Origin/CSRF，不将 wildcard CORS 和 cookie 凭据组合。

事件增加 `artifact.building`、`artifact.ready`、`artifact.failed`、`artifact.feedback_submitted`，遵循已有 sequence/cursor 回放。事件携带摘要与引用，不携带完整代码/privateState。runtime content projection 将引用转成专门 artifact block；所有 turn 合并、tool grouping、静态/流式 transcript、持久化恢复都保留这个块。

### Agent 接入

Native 注册 publish/read/list 工具，其中 publish 是有副作用的工作区派生操作，遵守已有工具权限和只读模式。read 返回 manifest/diagnostics/source 明确分项；不能跨项目读 blob。

Codex/Claude 外部后端默认采用上述完成消息 manifest 兼容通道；不为了接入本功能打开全局 MCP、改变外部后端既有安全校验或注入全权限本地凭据。adapter 给出可用能力标识与发布格式说明，宿主在外部 assistant turn 完成时校验并执行发布。Native 和外部入口最终调用同一 publisher。外部 manifest 被拒绝时给出可读诊断，并在用户继续请求时进入模型上下文，不伪造隐藏用户消息。

ACP 后端同样通过完成消息 manifest 入口接入，不假设供应商支持自定义 Native 工具。工作区来源按现有 workspaceLocation 区分 host/WSL：host 使用本机授权目录，WSL 通过受控 workspace 文件读取适配器完成 snapshot，禁止把 Linux 路径直接交给宿主 fs 或拼接 shell 命令。无法安全读取的远程工作区明确返回 UNSUPPORTED_WORKSPACE_LOCATION，不能静默读取宿主同名路径。端到端矩阵必须包含已支持的 WSL 工作区；无法验证的 ACP 供应商在能力列表标为 unverified，不宣称全供应商验证完成。

instructions 引导 Agent 在“原型/demo/可视化/交互说明”时使用产物；一般表格用 Markdown，静态关系图可沿用现有方案。禁止默认把用户文件/凭据植入原型。必须声明 demo 数据与真实数据的区别，成功发布前不声称可运行。

## 10. 反馈和版本循环

1. 用户操作的状态停留在 SDK + host state，不调用模型。
2. 宿主创建 feedback draft，包括 artifactId/revisionId/hash、选中区域、用户文字、用户允许共享的参数。
3. 确认面板显示全部将发送的数据；privateState 不自动列入。截图显式勾选。
4. 事务记录 submitted feedback 和待入队用户消息，按 idempotencyKey 防双击/重连重复。
5. 通过现有发送/队列逻辑进入 Agent；原型建议文字标为“来自不可信原型的建议”，用户文字单独保存。
6. Agent 读固定 source revision 并修改工作区副本，publish(baseRevisionId) 产生下一版。
7. UI 告知新版；用户可比较源码 diff、选择预览、返回历史。模型上下文保留短引用和用户意见，避免每轮重新塞整份源码。

## 11. 导出和兼容性

- 单 HTML 导出：将允许的资源及 runtime fallback 打包为可离线运行文件；保留本地 mini/detail 和参数交互；状态回落到该文件自己的存储或内存。不能把 Synax token、sessionId、绝对路径和 privateState 直接导出。
- 需要宿主反馈的功能在导出后显示“仅在 Synax 内可用”，不能伪装已经发送。
- 源码包：包含 manifest、原始源码、受控本地资产、依赖/许可证说明；不包含任何运行 shell script。React 的独立预览 HTML 含预编译 bundle，无需 npm install。
- SDK、构建器、policy 都有版本。旧 revision 通过兼容 runner 加载；不兼容或安全策略撤销时阻止执行、允许看源码和重新构建成新 revision，不偷偷改历史 hash。
- 现有 CodeViewer 不在本改动中一并重写权限语义；新运行容器抽成模块，后续若统一预览必须单独验证行为，不扩散到普通文件链接。

## 12. 故障与可观察性

稳定错误码：INVALID_SOURCE、PATH_OUTSIDE_WORKSPACE、RESOURCE_LIMIT、UNSUPPORTED_IMPORT、BUILD_TIMEOUT、REVISION_CONFLICT、STATE_CONFLICT、POLICY_BLOCKED、RUNTIME_UNRESPONSIVE、ARTIFACT_NOT_FOUND。

每个失败面板区分“构建失败/执行异常/权限阻止”，提供看源码、看诊断、重新发布/重新运行的合理入口；重试执行不会创建新版本，重试构建不会覆盖已发布版本。AbortSignal 贯穿采集与构建；未 commit 前取消不推送 ready。

仅记录 artifactId、revision、buildDuration、size、错误码、transport、SDK 版本。默认不记录源码、用户状态、用户反馈全文或令牌；诊断路径脱敏。日志通过现有 logger 接入。

## 13. 模块划分

新增而非扩大现有巨型文件：

- `api/services/agent-runtime/artifacts/`：contracts、store、publisher、snapshot、build-worker、policy、export、feedback。
- `api/services/agent-runtime/tools/artifact-*.ts`：Native 工具薄封装。
- `api/routes/agent-artifacts.ts`：路由薄封装，主 runtime router 挂载。
- `web/src/react/features/artifacts/`：ArtifactCard、ArtifactPreview、ArtifactInspector、ArtifactSource、ArtifactVersions、ArtifactFeedbackDialog、runtimeBridge、artifactStore。
- `web/src/lib/api/artifacts.ts`：typed API client。
- `electron/lib/artifact-preview/`：隔离 session、view manager、协议资源、IPC schema、权限和导航策略。
- `api/db/migrations/`：前向迁移与索引。
- Agent instructions、stream/event unions、turn projection、runtime protocol 只增加明确接入点；不把可执行 HTML 混入供应商请求。

契约层保持环境无关，不依赖 React、Node fs 或 Electron。构建和存储留在 API worker；Electron 不另建一份 DB，也不重复实现 publisher。

## 14. 验收矩阵

### 自动化

- 合法 HTML/TSX 发布；缺文件、绝对路径、symlink、编码路径逃逸、远程依赖、危险 MIME 拒绝。
- 两个并行更新仅一个 CAS 成功；重试同 key 不重复版本/消息；构建中崩溃和事务回滚恢复。
- 刷新、SSE 重连、取消、外部后端完成消息扫描不重复卡片。
- Markdown/code/用户引用中的假 manifest 不执行；Native 和两种外部后端完整发布闭环。
- iframe/window 来源伪造、旧 instance、跨版本、跨会话请求、洪泛、超大状态和 prototype pollution 拒绝。
- 外链、下载、嵌套 frame、网络请求和导航行为按各平台安全等级验证，Web 无法提供的硬保证明确测试为限制。
- Electron overlay、滚动裁剪、缩放、焦点、菜单、窗口 resize、后台 tab、preview crash 和停止能力。
- 主题、300/380/520px、Mini/Detail、pending/error/empty、键盘操作、屏幕阅读器、reduced-motion。
- 状态恢复/重置/冲突、反馈预审、拒绝无副作用、忙时排队、导出后离线可用。

### 人工 QA（不能由 build success 替代）

在真实会话生成运行摘要原型 → 原地展开 → 调参 → 元素标注 → 确认发送意见 → Agent 发布 v2 → 查看 v1/v2 → 重启恢复 → HTML 导出离线打开。分别验证 Electron 和 Web；截图记录实际产物，不用单独手写页面代替真实消息管线。

产品验收门槛：上述闭环通过；权限负向测试通过；相关测试、类型检查和构建通过；没有未标明的 dummy action，没有“发布成功但无法回看”的路径。未通过的能力在交付报告列明，不能标作全部完成。

## 15. 落地顺序和评审门

1. 确认本文范围和 Web/Electron 安全等级差异。
2. 编写精确实施计划：逐项文件、失败用例、实现及测试命令。
3. 契约/迁移/存储/快照/构建，随后发布 API 和事件恢复。
4. Native 工具与外部 manifest adapter，验证不改变现有后端隔离约束。
5. Web 沙箱、SDK 和 Electron 独立 transport。
6. 会话卡片、详情、调参、标注、反馈闭环、版本/导出。
7. 负向安全测试、真实会话 E2E、UI QA、性能和回归。
8. 一次交付：功能代码、迁移、测试、使用说明、已知限制和验证证据。

实现前需要用户对完整设计确认。当前文档不意味着代码已实现、浏览器安全实验已通过或平台能力已证明；相关库和 Electron API 的官方资料、打包可行性及跨平台原生 surface 验证在实施计划的首个技术检查中完成。若隔离 transport 验证不通过，不得以弱安全替代品静默完成。
