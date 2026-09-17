# Work 页面会话体验与性能优化设计

- 日期：2026-09-17
- 范围：`web/src/react/pages/SessionsPage.tsx` 及 `web/src/react/features/sessions/`
- 目标：让会话切换、工作区切换、加载状态和大量会话/长对话渲染稳定、顺滑、可恢复。
- 非目标：不修改后端 API 协议，不引入新的虚拟列表依赖，不重做现有视觉风格。

## 1. 现状与问题

当前页面由 URL、`useSessionRouteSync`、Zustand `agentSessionStore` 和多个页面组件共同驱动。切换会话时，store 会替换详情数据，页面再根据 `selectedSessionId` 条件渲染 transcript、workspace 或空态。虽然已有详情缓存和 `TimelineLazyEntry`，但还存在几个直接影响体验的点：

1. 页面层存在重复的 `useSessionDetailPolling` 挂载点，轮询职责不唯一，后续维护容易造成重复调度。
2. 详情切换的状态是“清空旧内容 → 请求 → 渲染新内容”或一次性替换大块数据，容易产生白屏、骨架屏跳动和旧请求覆盖新会话的问题。
3. 列表刷新固定请求最多 200 条，而列表 hook 又维护自己的分页请求；批量会话时会产生重复数据、重复树构建和多次 React 更新。
4. 会话树每次 sessions 变化都递归排序/展开，所有可见行一起参与渲染；长列表中选择一个会话也会放大更新范围。
5. 长 transcript 已有可视区懒挂载，但占位高度和切换边界还不够稳定，切换会话或数据增量到达时容易出现滚动位置跳动。
6. workspace tab、dashboard、transcript 之间通过条件分支直接互斥挂载，切换时会丢失局部渲染上下文并触发布局重算。
7. 面板 resize 和页面 inset 使用布局属性高频更新，拖动或切换时可能和内容渲染竞争主线程。

## 2. 设计原则

- **先稳定，再刷新**：缓存或旧内容先保持布局，后台更新不阻塞首帧。
- **单一调度入口**：每类刷新只有一个调度器；重复请求合并，过期结果丢弃。
- **增量提交**：轻量数据先显示，transcript 和 workspace 数据分批进入 store。
- **稳定身份与高度**：组件 key、容器尺寸、列表节点顺序和滚动锚点尽量稳定。
- **只优化真实热路径**：优先使用现有 Zustand、IntersectionObserver、CSS containment 和浏览器调度 API；不新增状态管理或虚拟化框架。
- **无障碍与降级不牺牲**：保留键盘操作、语义结构和 `prefers-reduced-motion` 支持；API 失败时保留最后可用内容。

## 3. 总体架构

### 3.1 页面层：持久容器 + 内容层

`SessionsPage` 保持左右面板、主内容容器和 command rail 的 DOM 身份稳定。会话内容切换不再依赖 `key={agentSessionId}` 强制重挂载；由一个持久的 `SessionContentStage` 承载以下三种状态：

- `empty`：没有选中会话；
- `draft`：新会话编辑器；
- `session`：transcript 或 workspace 内容。

`SessionContentStage` 接收当前会话 id、是否正在切换、是否有缓存内容和 presentation 状态。切换时优先显示目标会话缓存；没有缓存时显示固定尺寸的骨架，而不是先拆除主内容容器。过渡只使用 `opacity` 和 `transform`，容器尺寸由现有 flex/grid 结构和固定骨架行保证。

旧会话不再作为第二棵完整 transcript 树长期并存；当目标没有可用缓存时，保留旧内容到目标首个轻量 payload 到达，最多跨一个动画周期，随后交给目标骨架。这避免大数据切换时同时维护两份长列表。

### 3.2 Store 层：SWR 详情缓存与版本门禁

沿用 `agentSessionStore` 的 `sessionDetailCache`，不新增缓存类。调整为：

- `openPanel` 只负责同步选择状态、读取缓存、启动实时订阅和触发一次 refresh；
- 缓存命中立即提交到当前详情状态；缓存过期采用 stale-while-revalidate，旧内容保持可见；
- 每次详情 refresh 生成 session/version token，所有响应提交前必须验证 token、当前会话 id 和项目 id；
- profile 数据（steps、stats、todos、capabilities）和 transcript 数据分开提交；transcript 请求不会阻塞 profile 首帧；
- 完成/失败/删除等终态只清理对应会话的流式状态，不清空其他已缓存详情；
- detail cache 继续受数量上限和 TTL 限制，更新时采用已有的 LRU-like `cachedAt` 淘汰。

缓存不做持久化到 localStorage：transcript 数据体积大且可能过期，内存缓存已经覆盖页面内快速切换场景。

### 3.3 刷新层：唯一 polling owner

`useSessionDetailPolling` 只在 `SessionsPage` 挂载一次。`AgentSessionList`、`SessionQuickToolbar` 等子组件移除重复挂载；它们仍通过 store 读取数据。

polling 调度规则：

- 当前没有打开会话、页面隐藏、API 不可达或会话非 active 时不轮询；
- refresh 请求在 store 内合并，已有请求期间只设置 `again`，不启动并发请求；
- 页面从隐藏恢复只触发一次 refresh；
- 实时流可更新运行状态，但不额外触发整组详情请求，只有明确需要的事件触发增量 refresh；
- 列表刷新与详情刷新并行，但互不重复拥有同一职责。

### 3.4 列表层：分页数据单源 + 增量树计算

列表以 `useSessionList` 的分页结果为唯一 UI 数据源。首次加载使用现有 `PAGE_SIZE`，向下滚动再加载下一页；列表刷新只更新第一页并保留旧列表直到新页成功返回，避免刷新时闪烁。

store 的全量刷新仍可服务实时状态同步，但不再用一次最多 200 条的响应覆盖列表分页结构。列表 hook 根据 session id 合并分页数据，保持已加载页顺序，删除和状态 patch 通过 store 直接反映。树计算只在会话集合、搜索词或展开状态实际变化时进行；子节点排序使用已有时间字段，避免在 render 中重复创建 `Date` 对象。

不引入虚拟列表库。首版用分页、稳定 memo、CSS `content-visibility: auto`/`contain-intrinsic-size` 限制超长列表的布局成本；只有在真实数据超过当前分页上限并经 profiling 证明仍卡顿时，才考虑窗口化。

### 3.5 Transcript 层：稳定占位与分段渲染

沿用 `SessionStaticTimeline` 和 `TimelineLazyEntry`，做最小改造：

- 每个 entry 使用稳定的 `cacheKey` 和基于类型/内容的高度估算；
- 未进入视口的 entry 保留 `contain-intrinsic-size` 和最小占位高度，避免 IntersectionObserver 触发后整体上移；
- 可见区域之外的 entry 使用 `content-visibility: auto`，已加载内容不因 store 的流式更新而重复挂载；
- timeline 输入先由 `useMemo` 生成，流式内容只更新 live turn，不重建历史 entry；
- 切换会话时在 `useLayoutEffect`/首帧阶段只恢复目标会话自己的滚动锚点；没有锚点则置顶，不能沿用上一会话的 scrollTop。

不把整个 transcript 持久化为多个并行会话组件，避免会话切换时内存和事件订阅线性增长。

### 3.6 Workspace 层：保留 tab 状态，局部切换

`sessionWorkspaceStore` 继续按 session 保存 tab 和 presentation。`SessionWorkspacePanel` 对 dashboard、active tab 和 viewer shell 保持稳定外壳，只切换内部内容；切换 tab 时不重新请求环境数据，环境请求按 session 去重并在已有结果上更新。

文件、diff、subagent 视图保留现有组件和懒加载方式。tab 切换动画使用 opacity/translate，读取中的内容显示固定尺寸 skeleton；加载失败显示局部错误，不让整个 Work 页面回退到空态。

### 3.7 动画与布局

仅为 Work 页面新增/整理局部 CSS：

- 会话内容切换：`opacity` + `translateY(4px)`，短时长；
- skeleton 与真实内容：同一容器、同一 padding、相近行高；
- 面板显隐优先用 `transform`/`opacity`，宽度只在 resize 时更新；
- resize 过程中给根容器添加拖拽态，关闭不必要的阴影/blur 和过渡；
- 增加 `@media (prefers-reduced-motion: reduce)`，禁用非必要过渡；
- 仅对列表和 transcript 热区域使用 `contain`、`content-visibility`，不影响需要浮层定位的父容器。

## 4. 组件与数据流

### 会话选择

1. 列表点击或 URL 变化调用 `openPanel(sessionId)`。
2. store 立即写入 `selectedSessionId`、`panelOpen`，从 cache 恢复目标详情（若存在）。
3. page 内容 stage 保持 DOM 外壳；根据 `detailReady` 显示缓存内容、旧内容短暂过渡或 skeleton。
4. store 建立目标 session 的 live subscription，并启动去重后的 `refreshDetail`。
5. profile payload 到达后先更新轻量侧栏和骨架状态；transcript payload 到达后更新历史 timeline。
6. 过期响应因 token/session 校验被丢弃，不允许回写当前会话。

### 实时流

实时事件只更新当前 session 的运行状态、live blocks 和必要的局部缓存。文本 delta 继续按帧合并；当缓冲超过阈值时按现有 backpressure 策略批量 drain，避免每个字符触发 React 更新。终态事件触发一次列表状态 patch，必要时由 polling owner 安排详情刷新。

### 列表加载

1. `useSessionList.refresh` 请求第一页；成功后合并到分页集合，失败保留旧集合。
2. 接近底部时只请求下一页；同一页请求在 flight 中合并。
3. session patch 按 id 替换单行数据；不重置 page、expanded 或 scroll position。
4. 搜索或 view 切换清理分页结果，但保留固定的 loading shell 和 selected id。

## 5. 加载、错误与边界处理

- 首次加载：显示固定行高的列表 skeleton、详情 profile skeleton 和 transcript skeleton；不显示会改变高度的 spinner-only 空块。
- 缓存命中：立即显示缓存，并在标题/顶部用轻量 updating 状态提示；刷新失败不覆盖缓存。
- 空数据：只在确认请求成功且结果为空时显示空态；请求中不误显示空态。
- 网络失败：列表和详情各自保留最后可用内容；错误只在对应区域显示可重试入口。
- 快速连续切换：只允许最后选择的 session 更新当前详情；旧 session 的 live subscription 及时释放。
- 删除当前会话：先标记资源移除，再关闭当前 panel；任何迟到响应都被 registry/token 双重拦截。
- 页面隐藏：停止轮询与非必要动画；恢复时刷新一次，避免积累请求。
- 小屏：保留现有折叠行为，不在窄屏同时挂载 desktop 右侧 workspace。
- Reduced motion：不执行位移动画，保持 opacity/即时切换和稳定布局。

## 6. 实施文件边界

优先修改以下已有文件，避免扩散：

- `web/src/react/pages/SessionsPage.tsx`
- `web/src/react/features/sessions/agentSessionStore.ts`
- `web/src/react/features/sessions/useSessionDetailPolling.ts`
- `web/src/react/features/sessions/useSessionList.ts`
- `web/src/react/features/sessions/SessionListPanel.tsx`
- `web/src/react/features/sessions/SessionTimeGroups.tsx`
- `web/src/react/features/sessions/SessionTranscript.tsx`
- `web/src/react/features/sessions/SessionStaticTimeline.tsx`
- `web/src/react/features/sessions/TimelineLazyEntry.tsx`
- `web/src/react/features/sessions/SessionWorkspacePanel.tsx`
- Work 页面现有 CSS 文件中对应的局部规则

只在现有组件无法表达“持久内容外壳”时新增一个小组件文件；不新增通用缓存、通用动画或通用虚拟列表抽象。

## 7. 验证策略

先跑与本次修改直接相关的现有测试：

- `agentSessionStore.test.ts`
- `useSessionDetailPolling.test.tsx`
- `useSessionList.test.tsx`
- `TimelineLazyEntry.test.tsx`
- `SessionTreeItem.test.tsx`
- `WorkspaceDashboard.test.tsx`
- `sessionWorkspaceStore.test.ts`

新增最小行为测试：

1. 缓存命中切换时先保留详情数据，后台刷新结果不会被旧请求覆盖。
2. 多个组件同时触发 polling 时只有一组 refresh 请求。
3. 列表加载下一页不重置当前选择、展开状态和已加载行。
4. timeline 懒加载占位高度在 entry 进入视口后不导致容器整体跳动。
5. reduced-motion 下不会应用位移动画类。

最后执行 `npm run --prefix web build`，确认 TypeScript、Vite 构建和 CSS 均通过。性能验收以浏览器 Performance 面板手动检查三种场景为准：快速切换 10 个已有缓存会话、首次打开长 transcript、加载 100+ 会话并连续滚动。验收关注主线程长任务、布局抖动、滚动位置和网络请求数量，而不是只看单次 render 时间。

## 8. 取舍与后续门槛

本设计刻意不引入虚拟列表和持久化 transcript 缓存：现有分页、懒挂载、CSS containment 和内存 SWR 缓存是更小的改动，覆盖当前已知热路径。若生产数据证明单页仍需要渲染数百个可见列表节点，或 timeline 的历史条目超过浏览器可接受的布局预算，再引入窗口化，并以 profiling 数据决定具体库和边界。
