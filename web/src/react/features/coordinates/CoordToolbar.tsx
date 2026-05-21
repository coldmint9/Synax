import { ArrowRight, ChevronsUpDown, GripHorizontal, Send, Sparkles } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CoordNodeStatus, CoordNodeType } from '../../../lib/coordinates'
import { t } from '../../../lib/i18n'
import type { ProviderId } from '../../../lib/agents/contracts'
import { useContextStore } from '../../state/contextStore'
import { useShellStore } from '../../state/shellStore'

interface CoordToolbarProps {
  disabled?: boolean
  selectedNodeLabel: string
  selectedFeatureLabel: string
  /** v3: 丰富展开区域所需的节点上下文 */
  selectedNodeType?: CoordNodeType
  selectedNodeStatus?: CoordNodeStatus
  connectionMode?: 'dependency' | 'related'
  /** 当前项目空间名，用于展开区徽标显示（通常来自路由/shellStore） */
  projectName?: string
  onSubmit: (payload: { intent: string; providerId: ProviderId; featureLabel: string }) => void
  onToggleConnectionMode?: () => void
}

// ── 类型 → 中文标签映射 ──
const TYPE_LABEL: Record<CoordNodeType, string> = {
  project: '项目',
  feature: '特性',
  goal: '目标',
  action: '动作',
}

const STATUS_LABEL: Record<CoordNodeStatus, string> = {
  pending: '待处理',
  draft: '草稿',
  active: '进行中',
  done: '已完成',
  rejection: '已驳回',
  cancel: '已取消',
  review: '审查中',
  testing: '测试中',
}

function shouldIgnoreGlobalToolbarEnter(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return true
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'BUTTON' || tag === 'A') return true
  return false
}

// ── 根据选定节点类型生成路由预览文案 ──
function routingPreview(
  type: CoordNodeType | undefined,
  label: string,
  featureLabel: string,
): { title: string; detail: string } {
  if (!label) {
    return {
      title: '新建指令流水线',
      detail: `输入指令后将自动创建 Feature → Goal → Action 流水线，并调度 Agent 执行。`,
    }
  }
  switch (type) {
    case 'project':
      return {
        title: `为项目「${label}」创建特性`,
        detail: '将创建新的 Feature 节点作为指令入口。',
      }
    case 'feature':
      return {
        title: `为特性「${label}」创建目标`,
        detail: '将创建 Goal → Action 流水线并调度 Agent 执行。',
      }
    case 'goal':
      return {
        title: `为目标「${label}」创建动作`,
        detail: '将在此 Goal 下创建新的 Action 节点并调度 Agent 执行。',
      }
    case 'action':
      return {
        title: `为动作「${label}」追加执行`,
        detail: '将为该 Action 追加一轮新的 Agent 执行（Re-run）。',
      }
    default:
      return {
        title: `Feature: ${featureLabel}`,
        detail: '输入指令以创建新的任务节点。',
      }
  }
}

export default function CoordToolbar(props: CoordToolbarProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [intent, setIntent] = useState('')
  const containerRef = useRef<HTMLDivElement | null>(null)
  const miniInputRef = useRef<HTMLInputElement | null>(null)
  const expandedTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const autoExpandedOnceRef = useRef(false)
  /** 折叠→展开时会卸载 mini input，避免 blur 误触发展开条被收起 */
  const skipBlurCollapseRef = useRef(false)
  const prevCollapsedRef = useRef(true)
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed

  // ── 上下文集成：submit 时写入 user entry，输入时拉建议 ──
  const appendMessage = useContextStore(s => s.appendMessage)
  const createOrResumeSession = useContextStore(s => s.createOrResumeSession)
  const suggest = useContextStore(s => s.suggest)
  const suggestions = useContextStore(s => s.suggestions)
  const currentSessionId = useContextStore(s => s.currentSessionId)
  const ctxProjectId = useContextStore(s => s.projectId)
  const locale = useShellStore(s => s.preferences.locale) ?? 'zh'
  const hasProject = Boolean(ctxProjectId)
  const [showSuggest, setShowSuggest] = useState(false)
  const canSubmit = intent.trim().length > 0 && !props.disabled && hasProject
  const selectedNodeLabel = props.selectedNodeLabel.trim()
  const hasSelectedNode = selectedNodeLabel.length > 0
  const showMiniNodeLabel = collapsed && selectedNodeLabel.length > 0

  useEffect(() => {
    if (intent.trim().length < 2) return
    const h = setTimeout(() => {
      void suggest(intent.trim())
    }, 250)
    return () => clearTimeout(h)
  }, [intent, suggest])

  const routing = routingPreview(
    props.selectedNodeType,
    selectedNodeLabel,
    props.selectedFeatureLabel,
  )

  const submitIntent = () => {
    if (!canSubmit || !ctxProjectId) return
    const trimmed = intent.trim()
    props.onSubmit({ intent: trimmed, providerId: 'opencode-acp', featureLabel: props.selectedFeatureLabel })
    // 写入当前会话；若无会话先 resume/新建
    ;(async () => {
      try {
        if (!currentSessionId) {
          await createOrResumeSession('web')
        }
        await appendMessage({
          role: 'user',
          content: trimmed,
          contentType: 'text',
          metadata: {
            providerId: 'opencode-acp',
            featureLabel: props.selectedFeatureLabel,
            selectedNodeType: props.selectedNodeType,
            selectedNodeLabel,
          },
        })
      } catch {
        /* 非阻塞路径，失败记录到 store.lastError 即可 */
      }
    })()
    setIntent('')
    setShowSuggest(false)
  }

  useEffect(() => {
    if (intent.trim().length === 0) {
      autoExpandedOnceRef.current = false
    }
  }, [intent])

  // 画布等场景下按 Enter 聚焦工具栏；焦点已在工具栏内时由下方 input/textarea 处理
  useEffect(() => {
    const onWinKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented) return
      if (props.disabled) return
      const root = containerRef.current
      if (!root) return
      const ae = document.activeElement
      if (ae && root.contains(ae)) return
      if (shouldIgnoreGlobalToolbarEnter(ae)) return
      e.preventDefault()
      skipBlurCollapseRef.current = true
      const go = () => {
        if (collapsedRef.current) {
          miniInputRef.current?.focus()
        } else {
          expandedTextareaRef.current?.focus()
        }
      }
      if (typeof queueMicrotask === 'function') queueMicrotask(go)
      else setTimeout(go, 0)
    }
    window.addEventListener('keydown', onWinKeyDown)
    return () => window.removeEventListener('keydown', onWinKeyDown)
  }, [props.disabled])

  useLayoutEffect(() => {
    if (!collapsed || autoExpandedOnceRef.current) return
    if (intent.trim().length === 0) return
    const input = miniInputRef.current
    if (!input) return
    const isOverflowing = input.scrollWidth > input.clientWidth
    if (!isOverflowing) return
    autoExpandedOnceRef.current = true
    skipBlurCollapseRef.current = true
    setCollapsed(false)
  }, [intent, collapsed, showMiniNodeLabel])

  useEffect(() => {
    if (!collapsed || autoExpandedOnceRef.current) return
    if (intent.trim().length === 0) return
    const onResize = () => {
      const input = miniInputRef.current
      if (!input) return
      if (input.scrollWidth <= input.clientWidth) return
      autoExpandedOnceRef.current = true
      skipBlurCollapseRef.current = true
      setCollapsed(false)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [collapsed, intent])

  useLayoutEffect(() => {
    const wasCollapsed = prevCollapsedRef.current
    prevCollapsedRef.current = collapsed
    if (!collapsed && wasCollapsed && expandedTextareaRef.current && !props.disabled && hasProject) {
      const ta = expandedTextareaRef.current
      ta.focus()
      const len = ta.value.length
      ta.setSelectionRange(len, len)
    }
    if (!collapsed) skipBlurCollapseRef.current = false
  }, [collapsed, props.disabled, hasProject])

  useLayoutEffect(() => {
    if (collapsed || !expandedTextareaRef.current) return
    const textarea = expandedTextareaRef.current
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
  }, [intent, collapsed])

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
      <div
        ref={containerRef}
        onBlurCapture={() => {
          if (skipBlurCollapseRef.current) return
          window.setTimeout(() => {
            if (skipBlurCollapseRef.current) return
            const root = containerRef.current
            if (!root) return
            const active = document.activeElement
            if (active && root.contains(active)) return
            setCollapsed(true)
          }, 0)
        }}
        className={`pointer-events-auto liquid-glass toolbar-shell w-full border border-white/20 shadow-lg transition-[max-width,padding,border-radius] duration-500 ease-spring ${
          collapsed
            ? `${hasSelectedNode ? 'max-w-[520px]' : 'max-w-[430px]'} rounded-2xl px-2 py-1.5 delay-150`
            : 'max-w-[920px] rounded-2xl px-2.5 py-2 delay-0'
        }`}
      >
        <div className={collapsed ? 'py-0.5' : 'py-1'}>
          {collapsed ? (
            /* ── 折叠态：mini input + send + toggle ── */
            <div className="relative">
              <input
                ref={miniInputRef}
                value={intent}
                onChange={e => {
                  setIntent(e.target.value)
                  setShowSuggest(e.target.value.trim().length >= 2)
                }}
                onFocus={() => setShowSuggest(intent.trim().length >= 2)}
                onBlur={() => setTimeout(() => setShowSuggest(false), 150)}
                className={`h-8 w-full rounded-lg border border-border/60 bg-background/70 px-2.5 text-sm outline-none ring-primary/30 transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${
                  showMiniNodeLabel ? 'pr-32' : 'pr-20'
                }`}
                placeholder={hasProject ? 'Enter 聚焦 · 输完后 Enter 发送' : t(locale, 'appProjectNotSelected')}
                disabled={props.disabled || !hasProject}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return
                  e.preventDefault()
                  if (intent.trim().length > 0) {
                    submitIntent()
                    return
                  }
                  skipBlurCollapseRef.current = true
                  setCollapsed(false)
                }}
              />
              {showSuggest && suggestions.length > 0 && (
                <ul className="absolute left-0 right-0 top-9 z-30 max-h-44 overflow-y-auto rounded-md border border-border/60 bg-card/95 shadow-lg backdrop-blur-sm">
                  {suggestions.map((s) => (
                    <li
                      key={s.refId}
                      className="cursor-pointer px-2.5 py-1.5 text-[11px] hover:bg-secondary/60"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setIntent(s.text)
                        setShowSuggest(false)
                      }}
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className={`rounded px-1 py-px font-mono text-[9px] ${
                            s.source === 'memory'
                              ? 'bg-violet-500/15 text-violet-400'
                              : 'bg-blue-500/15 text-blue-400'
                          }`}
                        >
                          {s.source}
                        </span>
                        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
                          {s.score.toFixed(2)}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-foreground/90">{s.text}</div>
                    </li>
                  ))}
                </ul>
              )}
              {showMiniNodeLabel && (
                <span className="pointer-events-none absolute right-20 top-1/2 max-w-[7rem] -translate-y-1/2 truncate text-[11px] text-muted-foreground">
                  {selectedNodeLabel}
                </span>
              )}
              <button
                type="button"
                className="absolute right-10 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
                disabled={!canSubmit}
                onClick={submitIntent}
                aria-label="Send instruction"
              >
                <Send size={12} />
              </button>
              <button
                type="button"
                className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-border/40 bg-background/50 text-xs transition hover:bg-white/20"
                onClick={() =>
                  setCollapsed((v) => {
                    if (v) skipBlurCollapseRef.current = true
                    return !v
                  })
                }
                aria-label={collapsed ? 'Expand toolbar' : 'Collapse toolbar'}
              >
                <ChevronsUpDown size={12} className={`transition-transform duration-500 ease-spring ${collapsed ? 'rotate-180' : ''}`} />
              </button>
            </div>
          ) : (
            /* ── 展开态：大 textarea + send + toggle ── */
            <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-2">
              <Sparkles size={14} className="text-primary shrink-0" />
              <div className="relative min-w-0">
                <textarea
                  ref={expandedTextareaRef}
                  value={intent}
                  onChange={e => setIntent(e.target.value)}
                  rows={1}
                  className="max-h-[220px] min-h-[56px] w-full resize-none rounded-lg border border-border/60 bg-background/70 px-2.5 py-2 text-sm outline-none ring-primary/30 transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
                  placeholder={
                    hasProject
                      ? '输入复杂指令（Enter 发送 · Shift+Enter 换行）...'
                      : t(locale, 'appProjectNotSelected')
                  }
                  disabled={props.disabled || !hasProject}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    if (e.shiftKey) return
                    if (!canSubmit) return
                    e.preventDefault()
                    submitIntent()
                  }}
                />
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-2.5 text-primary-foreground transition hover:brightness-105 disabled:opacity-50"
                disabled={!canSubmit}
                onClick={submitIntent}
                aria-label="Send instruction"
              >
                <Send size={14} />
              </button>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/40 bg-background/50 text-xs transition hover:bg-white/20"
                onClick={() =>
                  setCollapsed((v) => {
                    if (v) skipBlurCollapseRef.current = true
                    return !v
                  })
                }
                aria-label={collapsed ? 'Expand toolbar' : 'Collapse toolbar'}
              >
                <ChevronsUpDown size={14} className={`transition-transform duration-500 ease-spring ${collapsed ? 'rotate-180' : ''}`} />
              </button>
            </div>
          )}
        </div>

        {/* ═══════════════════════════════════════════════════════════
            ── 展开内容区（重构后）──
            ═══════════════════════════════════════════════════════════ */}
        <div
          className={`overflow-hidden transition-[max-height,transform,opacity] duration-500 ease-spring ${
            collapsed ? 'max-h-0 translate-y-2 opacity-0 delay-0' : 'max-h-[360px] translate-y-0 opacity-100 delay-100'
          }`}
        >
          {!collapsed && (
            <div className="mt-2 space-y-2.5 border-t border-border/30 pt-2.5">

              {/* ── 无项目空间兜底提示 ── */}
              {!hasProject && (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-400">
                  {t(locale, 'appProjectNotSelected')} — 请返回全局首页选择项目空间
                </div>
              )}

              {/* ── 路由预览卡片（仅在已绑定项目时显示） ── */}
              {hasProject && (
              <div className="rounded-lg border border-border/50 bg-background/60 px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1.5">
                  <ArrowRight size={10} />
                  指令路由预览
                </div>

                {selectedNodeLabel ? (
                  <div className="flex items-center gap-2">
                    {/* 节点信息 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        {props.selectedNodeType && (
                          <span className="shrink-0 rounded border border-border/60 px-1.5 py-px text-[9px] font-medium text-muted-foreground">
                            {TYPE_LABEL[props.selectedNodeType]}
                          </span>
                        )}
                        <span className="truncate text-xs font-semibold">{selectedNodeLabel}</span>
                        {props.selectedNodeStatus && (
                          <span className="shrink-0 rounded-full border border-border/50 px-1.5 py-px text-[9px] text-muted-foreground">
                            {STATUS_LABEL[props.selectedNodeStatus]}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground/80 leading-relaxed">
                        {routing.detail}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
                    未选定节点 — {routing.detail}
                  </p>
                )}
              </div>
              )}

              {/* ── 上下文信息行 ── */}
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                {/* 项目空间徽标 */}
                <div className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/60 px-2 py-1">
                  <span className="text-muted-foreground/60">{t(locale, 'appProjectSpace')}</span>
                  <span className="font-medium text-foreground/80">
                    {props.projectName || ctxProjectId || '—'}
                  </span>
                </div>

                {/* Feature 标签 */}
                <div className="inline-flex items-center gap-1 rounded-md border border-border/50 bg-background/60 px-2 py-1">
                  <span className="text-muted-foreground/60">Feature</span>
                  <span className="font-medium text-foreground/80">{props.selectedFeatureLabel}</span>
                </div>

                {/* 连接模式切换（如果有回调） */}
                {props.connectionMode && (
                  <button
                    type="button"
                    onClick={props.onToggleConnectionMode}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 transition hover:brightness-110 ${
                      props.connectionMode === 'dependency'
                        ? 'border-blue-500/40 bg-blue-500/10 text-blue-400'
                        : 'border-orange-500/40 bg-orange-500/10 text-orange-400'
                    }`}
                    title="点击切换连接模式"
                  >
                    <GripHorizontal size={10} />
                    {props.connectionMode === 'dependency' ? 'dep 模式' : 'rel 模式'}
                  </button>
                )}

                {/* 间距占位 */}
                <div className="flex-1" />

                {/* 键盘提示 */}
                <span className="text-[9px] text-muted-foreground/50">
                  Enter 发送 · Shift+Enter 换行 · Esc 收起
                </span>
              </div>

            </div>
          )}
        </div>
      </div>
    </div>
  )
}
