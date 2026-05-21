// ---------------------------------------------------------------------------
// analyzer-facing HTTP / SSE client (web side)
//
// 与 api/ 层通信；Bun 侧 analyzer 已成为唯一实现。所有端点均以
// /api/coordinates 为前缀，保持与现有 dispatch 路由一致的命名空间。
// ---------------------------------------------------------------------------

import type { ForestPatch, CoordForest, SourceBinding } from '../coordinates'

export type SearchMode = 'keyword' | 'hybrid'

export interface SearchRange {
  startLine: number
  endLine: number
}

export interface SearchHit {
  id: string
  kind: 'chunk' | 'symbol' | 'file'
  score: number
  filePath: string
  range: SearchRange
  preview: string
  symbolIds: string[]
  /** 命中来源：去向量化后仅 graph / keyword / hybrid */
  provenance?: 'graph' | 'keyword' | 'hybrid'
}

export interface HybridResult {
  query: string
  mode: SearchMode
  hits: SearchHit[]
}

export interface MountHint {
  nodeId?: string
  suggestedParentId: string
  suggestedType: 'feature' | 'goal' | 'action'
  label: string
  rationale: string
  score: number
}

export interface InitializeFromRepoInput {
  projectId: string
  source: SourceBinding
  /**
   * 目标语言。由前端 shellStore.preferences.locale 决定，透传到 analyzer
   * 后在 seed_agent 的 system prompt 里锁定 feature label/summary 语种。
   */
  locale?: 'zh' | 'en'
}

/**
 * Analyzer 流事件。字段与当前 Bun analyzer 的阶段输出对齐：
 * 除 `analysis_started` / `analysis_completed` / `analysis_failed` 三种终端事件外，
 * 其余均为阶段事件，payload 统一含 { phase, progress, message? }；
 * `analysis_mapping` 和 `analysis_completed` 可携带 ForestPatch。
 */
export interface AnalysisPhasePayload {
  phase: string
  progress: number
  message?: string
}

export type AnalyzerStreamEvent =
  | { type: 'analysis_started'; payload: { runId: string; projectId?: string; startedAt?: number } }
  | { type: 'analysis_cloning'; payload: AnalysisPhasePayload }
  | { type: 'analysis_parsing'; payload: AnalysisPhasePayload }
  | { type: 'analysis_graph_build'; payload: AnalysisPhasePayload }
  | { type: 'analysis_semantic'; payload: AnalysisPhasePayload }
  | { type: 'analysis_indexing'; payload: AnalysisPhasePayload }
  | { type: 'analysis_graph_persist'; payload: AnalysisPhasePayload }
  | { type: 'analysis_neo4j_write'; payload: AnalysisPhasePayload & { ok?: boolean } }
  | { type: 'analysis_mapping'; payload: AnalysisPhasePayload & { patch?: ForestPatch } }
  | { type: 'analysis_progress'; payload: AnalysisPhasePayload }
  | {
      type: 'analysis_completed'
      payload: { runId?: string; projectId?: string; forest?: CoordForest; patch?: ForestPatch; commitSha?: string; report?: { featuresCreated?: number; linksCreated?: number; message?: string; warnings?: string[] } }
    }
  | { type: 'analysis_failed'; payload: { reason: string; runId?: string } }

const API_BASE = '/api/coordinates'

/** 低层 fetch 帮手：默认 JSON 请求，返回 parsed body。 */
async function postJson<TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`[${path}] ${resp.status}: ${text || resp.statusText}`)
  }
  return (await resp.json()) as TResponse
}

export function searchCode(
  projectId: string,
  query: string,
  mode: SearchMode = 'hybrid',
  topK = 20,
): Promise<HybridResult> {
  return postJson<{ projectId: string; query: string; mode: SearchMode; topK: number }, HybridResult>(
    '/search',
    { projectId, query, mode, topK },
  )
}

export function suggestMount(projectId: string, intent: string): Promise<MountHint[]> {
  return postJson<{ projectId: string; intent: string }, { hints: MountHint[] }>(
    '/semantic/suggest',
    { projectId, intent },
  ).then((r) => r.hints)
}

export async function fetchForestSnapshot(projectId: string): Promise<CoordForest | null> {
  const resp = await fetch(`${API_BASE}/forest/${encodeURIComponent(projectId)}`)
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`fetchForestSnapshot failed: ${resp.status}`)
  return (await resp.json()) as CoordForest
}

/**
 * 打开 SSE 连接触发 analyzer pipeline，调用方通过 onEvent 订阅事件。
 * 返回 abort 句柄，调用后中止流。
 */
export function initializeFromRepoStream(
  input: InitializeFromRepoInput,
  onEvent: (event: AnalyzerStreamEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  return openSseStream('/init/analyze', input, onEvent as (e: unknown) => void, onError)
}

/**
 * 通用的 SSE 客户端：按 SSE 规范解析帧，遇到 [DONE] 停止。
 *
 * 重点：Node 侧 SSE 仍然可能以 CRLF 作为分隔符，
 * 即帧边界是 `\r\n\r\n`。早期用 `indexOf('\n\n')` 的实现永远找不到分隔符，
 * 导致事件无法触发。这里同时容纳 `\r\n\r\n` / `\n\n` / `\r\r` 三种合规分隔符，
 * 并按 SSE 规范将同一帧内多条 `data:` 行按 `\n` 拼接。
 */
function openSseStream(
  path: string,
  input: unknown,
  onEvent: (event: unknown) => void,
  onError?: (err: unknown) => void,
): () => void {
  // 使用 new RegExp 构造，避免字面量中 CR/LF 被编辑器反序列化为真换行。
  const FRAME_SEP = new RegExp('\\r\\n\\r\\n|\\n\\n|\\r\\r')
  const LINE_SEP = new RegExp('\\r\\n|\\r|\\n')

  const controller = new AbortController()
  ;(async () => {
    try {
      const resp = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(input),
        signal: controller.signal,
      })
      if (!resp.ok || !resp.body) throw new Error(`${path} ${resp.status}`)
      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let sep: RegExpExecArray | null
        // 循环批量消费 buf 中已经完整的 SSE 帧
        while ((sep = FRAME_SEP.exec(buf))) {
          const frame = buf.slice(0, sep.index)
          buf = buf.slice(sep.index + sep[0].length)
          const dataLines = frame
            .split(LINE_SEP)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
          if (dataLines.length === 0) continue
          const payload = dataLines.join('\n').trim()
          if (payload === '[DONE]') return
          try {
            onEvent(JSON.parse(payload))
          } catch (err) {
            onError?.(err)
          }
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== 'AbortError') onError?.(err)
    }
  })()
  return () => controller.abort()
}
