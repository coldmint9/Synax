# Status 面板：上下文和平均缓存率

## 调研结论

本地 tokenizer 不能作为所有模型的精确计量：模型编码、服务商消息封装、工具定义注入和多模态输入都会影响结果。原面板仅展示 `contextComposition` 的本地估算，即使后端已经有 usage，也没有使用，且 tokenizer 一律按 GPT-4o 编码。

采用响应 usage 优先、当前请求本地估算兜底的方案。无需额外网络请求，不增加模型调用延迟，兼容已保存的历史记录。额外的服务商 token-count API 可用于发送前计量，但需要按协议适配完整请求，并不能代替实际请求返回的 usage；本次未加入该网络依赖。

依据：

- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)：完整输入为 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。不能只拿未缓存输入作为上下文，缓存写入也不是命中。
- [AI SDK generateText](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)：提供输入用量和缓存读取细分。Synax 继续使用现有归一化层，优先保留原始 usage 字段的存在性，避免把 SDK 合成的默认零当作服务商证据。

## 已实现的口径

- 原生 API 的上下文总量：最近请求的完整输入 token，包含缓存；不是会话累计输入，也不是下一轮尚未构建的请求用量。
- CLI/ACP：继续使用独立的 `contextUsage`（最近请求或窗口占用）；不把整个外部 turn 的累计 usage 当作当前上下文。
- 当前请求尚未提供 usage：采用同一请求文本、工具 schema 的本地估算。已知 OpenAI 模型按 js-tiktoken 对应编码；其他模型用 o200k 近似。非文本输入在此阶段仍有误差。
- 当前请求两者均无：保留最后有效记录，显式提示记录过期。新请求有数据后允许值下降，以反映压缩。
- 总量和分类必须来自同一条 step。服务商提供总量时，按该请求本地分类占比分配条形与分类数值，以 `≈` 标识分类估算；无分类时仅显示总量条形，不拼接历史分类。
- 未配置或未报告窗口时不显示默认窗口为已知值。

## 逐轮缓存率与平均值（2026-09-18 修订）

按用户明确指定的口径，主指标为每轮请求命中率的算术平均：

`rate_i = cacheRead_i / fullInput_i`

`average = sum(rate_i) / validRequestCount`

例如 80/100 和 0/1000 两轮，平均为 40%。原先的 80/1100 = 7.3% 是 token 加权命中率，现仅在详情中作为辅助指标。

只有输入大于零、缓存字段已知且 0 <= cacheRead <= input 的轮次计入平均。真实 0% 必须计入；未知、异常、零输入和 CLI 整回合汇总不能冒充单次请求。执行中尚无 usage 的请求单独显示等待数量。最近 10 次窗口包括缺失记录，不挑选最近十次成功命中的请求。

面板提供最近一次、最近 10 次平均和全会话逐轮平均，可展开核对原始分子/分母、字段来源、有效覆盖、模型、时间和记录 ID。子 Agent 和辅助调用不混入本会话平均。通过新增 `cache` 返回结构提供这些指标，保留旧 `usage.*.cacheReadRatio` 的加权含义以兼容其他使用者。

## 实际会话核查

对截图对应会话的前 75 条记录，只读检查原始 usage：

- 完整输入合计 4,362,282，缓存读取合计 811,648，加权值为 18.6060415%。
- 逐轮算术平均为 17.0271399%，面板新口径应显示 17.0%。
- 36 轮原始 cached_tokens 为零；第 75 轮 input_tokens=88,169，cached_tokens=0，单轮率为 0%。
- 核查时的 92 条有效记录中，原始输入和缓存字段与落库归一化数值全部一致。

链路核查：配置的 baseURL → @ai-sdk/openai Responses HTTP 响应 → SSE JSON 解析 → includeRawChunks/rawValue → applyUsageMiddleware 提取 response.usage → normalizeUsage → step metadata → cacheUsageSample 重新读取原始证据。SDK 对缺失缓存字段可能补零，但中间件保留原始字段是否存在，未报告字段保持未知。

[OpenAI 官方缓存文档](https://developers.openai.com/api/docs/guides/prompt-caching)说明缓存用量来自响应 usage；Responses 的字段是 input_tokens_details.cached_tokens，Chat Completions 对应 prompt_tokens_details.cached_tokens。无需额外请求一个“缓存率 API”。Synax 能验证与配置的服务商/网关 HTTP 返回一致，不能从网关客户端独立证明网关未改写更上游的值。

## 验证

测试包含真实 OpenAI SDK 的 HTTP SSE 解析到面板统计链路（显式零、非零、缺失），以及原始字段优先、逐轮算术平均、加权辅助值、最近窗口、覆盖率、等待请求、CLI 汇总排除和界面详情。
