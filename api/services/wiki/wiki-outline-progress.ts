// ── Tool call → human-friendly progress messages ──────────────────────────────
// Used by wiki-loop-service.ts during Phase 1 (outline generation) to emit
// human-readable activity notifications via TaskProgress SSE events.

export type OutlineActivityPhase = 'scan' | 'explore' | 'delegate' | 'synthesize' | 'submit'

export interface OutlineActivityEvent {
  activity: string
  detail?: string
  phase: OutlineActivityPhase
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function lastSegment(path: string): string {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return segments[segments.length - 1] ?? path
}

function truncate(text: string, maxLen = 60): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '…'
}

function firstLine(text: string, maxLen = 60): string {
  const line = text.split('\n')[0] ?? text
  return truncate(line, maxLen)
}

// ── Safe arg access (args may be unknown, parsed JSON, or null) ────────────────

type LooseArgs = Record<string, unknown> | null | undefined

function str(args: LooseArgs, key: string): string | undefined {
  const v = (args as Record<string, unknown> | null)?.[key]
  return typeof v === 'string' ? v : undefined
}

// ── Mapping ────────────────────────────────────────────────────────────────────

const TOOL_MESSAGES: Record<string, (args: LooseArgs) => { activity: string; phase: OutlineActivityPhase; detailKey?: string }> = {
  // ── wiki read tools: scan phase ──
  'wiki.read_modules': () => ({
    activity: '正在分析项目模块结构…',
    phase: 'scan',
  }),

  'wiki.read_tree': (args) => {
    const path = str(args, 'path')
    return {
      activity: path ? `正在浏览 ${lastSegment(path)} 目录结构…` : '正在浏览项目目录结构…',
      phase: 'scan',
      detail: path ? lastSegment(path) : undefined,
    }
  },

  'wiki.read_code_index': (args) => {
    const kind = str(args, 'kind')
    return {
      activity: kind === 'symbols' ? '正在读取符号索引…' : '正在读取文件索引…',
      phase: 'scan',
    }
  },

  'wiki.read_graph': () => ({
    activity: '正在分析语义依赖图…',
    phase: 'scan',
  }),

  'wiki.read_call_graph': (args) => {
    const name = str(args, 'callerSymbolName') ?? str(args, 'symbolName') ?? str(args, 'symbol')
    return {
      activity: name ? `正在分析 "${truncate(name, 40)}" 的调用关系…` : '正在分析调用关系图…',
      phase: 'scan',
      detail: name ? truncate(name, 40) : undefined,
    }
  },

  'wiki.impact_analysis': (args) => {
    const target = str(args, 'target') ?? str(args, 'filePath') ?? str(args, 'symbol')
    return {
      activity: target ? `正在评估 "${truncate(target, 40)}" 的变更影响范围…` : '正在评估代码变更影响范围…',
      phase: 'scan',
      detail: target ? truncate(target, 40) : undefined,
    }
  },

  // ── file tools: explore phase ──
  'file.read': (args) => {
    const path = str(args, 'path') ?? str(args, 'filePath') ?? str(args, 'file')
    if (path) {
      const name = lastSegment(path)
      return { activity: `正在读取 ${name}…`, phase: 'explore', detail: name }
    }
    return { activity: '正在读取源文件…', phase: 'explore' }
  },

  'file.list': (args) => {
    const path = str(args, 'path') ?? str(args, 'dir')
    return {
      activity: path ? `正在浏览 ${lastSegment(path)} 文件列表…` : '正在浏览文件列表…',
      phase: 'explore',
      detail: path ? lastSegment(path) : undefined,
    }
  },

  'file.glob': (args) => {
    const pattern = str(args, 'pattern') ?? str(args, 'glob')
    return {
      activity: pattern ? `正在匹配文件: ${truncate(pattern, 40)}…` : '正在索引文件结构…',
      phase: 'explore',
    }
  },

  'grep.search': (args) => {
    const pattern = str(args, 'pattern') ?? str(args, 'query')
    if (pattern) {
      return { activity: `正在搜索 "${truncate(pattern, 40)}"…`, phase: 'explore', detail: truncate(pattern, 40) }
    }
    return { activity: '正在搜索代码模式…', phase: 'explore' }
  },

  // ── subagent: delegate phase ──
  'subagent.delegate': (args) => {
    const prompt = str(args, 'prompt')
    const detail = prompt ? firstLine(prompt, 60) : undefined
    return {
      activity: '正在委派子 Agent 深入探索子系统…',
      phase: 'delegate',
      detail,
    }
  },

  // ── wiki submit: submit phase ──
  'wiki.create_outline_draft': () => ({
    activity: '正在创建大纲草稿…',
    phase: 'submit',
  }),
  'wiki.edit_outline_draft': () => ({
    activity: '正在根据校验反馈修改大纲…',
    phase: 'submit',
  }),
  'wiki.submit_outline': () => ({
    activity: '正在提交并锁定大纲…',
    phase: 'submit',
  }),
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Map a planner agent tool call to a human-friendly activity message.
 * Returns null for tool calls that should not generate progress events
 * (e.g. internal tools that the user doesn't need to see).
 */
export function mapToolCallToActivity(
  toolId: string,
  args: unknown,
): OutlineActivityEvent | null {
  const mapper = TOOL_MESSAGES[toolId]
  if (!mapper) {
    // Fallback for unknown tools: still emit a generic explore message
    // so the user knows something is happening.
    return {
      activity: '正在分析代码库…',
      phase: 'explore',
    }
  }

  const result = mapper(args as LooseArgs)
  return {
    activity: result.activity,
    detail: result.detailKey ?? (args as LooseArgs)?.['detail'] as string | undefined,
    phase: result.phase,
  }
}

/**
 * Returns a synthesize-phase activity message for thought_delta events.
 * Throttled separately by the caller.
 */
export function synthesizeActivity(locale: 'zh' | 'en'): OutlineActivityEvent {
  return locale === 'en'
    ? { activity: 'Synthesizing and planning document structure…', phase: 'synthesize' }
    : { activity: 'AI 正在综合信息，规划文档结构…', phase: 'synthesize' }
}

/**
 * Returns a scan-complete milestone message.
 */
export function scanCompleteActivity(
  fileCount: number,
  languages: string,
  locale: 'zh' | 'en',
): OutlineActivityEvent {
  return locale === 'en'
    ? { activity: `Scan complete! Found ${fileCount} files. Primary languages: ${languages}`, phase: 'scan' }
    : { activity: `扫描完成！发现 ${fileCount} 个文件，主要语言：${languages}`, phase: 'scan' }
}

/**
 * Returns an outline-complete milestone message.
 */
export function outlineCompleteActivity(
  docCount: number,
  locale: 'zh' | 'en',
): OutlineActivityEvent {
  return locale === 'en'
    ? { activity: `Outline complete! Planned ${docCount} documents`, phase: 'submit' }
    : { activity: `大纲生成完成！规划了 ${docCount} 篇文档`, phase: 'submit' }
}
