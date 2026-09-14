import { ChevronRight, History, MessageCircle, Loader2 } from 'lucide-react'
import { SessionModeSummary } from './SessionWorkspace'
import './agentControls.css'
import { useEffect, useId, useRef, useState } from 'react'
import {
  type AgentInteraction,
  type AgentInteractionReply,
  type AgentPlan,
  type AgentSession,
  type HumanQuestion,
} from '../../../lib/api/agentRuntime'
import { subscribe } from '../../../lib/api/runtimeEventBus'
import { useLocale } from '../../../hooks/useLocale'
import { useAgentSessionStore } from './agentSessionStore'
import { readSessionBackendId } from './synaxSessionTypes'

const inputClass = 'agent-request-input'
const buttonClass = 'agent-request-action'
type Answers = NonNullable<AgentInteractionReply['answers']>

function PlanDetails({ plan, zh, showTitle = true }: { plan: AgentPlan; zh: boolean; showTitle?: boolean }) {
  const sections: [string, string[]][] = [
    [zh ? '验收标准' : 'Acceptance criteria', plan.acceptanceCriteria],
    [zh ? '假设' : 'Assumptions', plan.assumptions],
    [zh ? '风险' : 'Risks', plan.risks],
  ]
  return (
    <div className="agent-plan-details space-y-3">
      {showTitle && <h4 className="font-medium">{plan.title}</h4>}
      <p className="whitespace-pre-wrap">{plan.objective}</p>
      <ol className="list-decimal space-y-2 pl-5">
        {plan.steps.map(step => (
          <li key={step.id}>
            <strong>{step.title}</strong> <span className="text-muted-foreground">({step.id})</span>
            <p className="whitespace-pre-wrap">{step.description}</p>
            {step.dependsOn.length > 0 && <p>{zh ? '依赖：' : 'Depends on: '}{step.dependsOn.join(', ')}</p>}
            {step.expectedFiles.length > 0 && <ul className="font-mono text-xs">{step.expectedFiles.map(file => <li key={file}>{file}</li>)}</ul>}
          </li>
        ))}
      </ol>
      {sections.map(([title, entries]) => entries.length > 0 && (
        <div key={title}>
          <h5 className="font-medium">{title}</h5>
          <ul className="list-disc pl-5">{entries.map((item, index) => <li key={index}>{item}
            {entries === plan.acceptanceCriteria && plan.humanAcceptanceCriteria?.includes(item) && (
              <span className="ml-1 text-warning">{zh ? '（需用户确认）' : '(user confirmation)'}</span>
            )}
          </li>)}</ul>
        </div>
      ))}
    </div>
  )
}

function InteractionForm({ interaction, disabled }: {
  interaction: AgentInteraction
  disabled: boolean
}) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const formId = useId()
  const [values, setValues] = useState<Answers>({})
  const [otherEnabled, setOtherEnabled] = useState<Record<string, boolean>>({})
  const [otherValues, setOtherValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const replyInteraction = useAgentSessionStore(s => s.replyInteraction)
  const refreshInteractions = useAgentSessionStore(s => s.refreshInteractions)
  const isPlan = interaction.kind === 'plan_approval'
  const update = (id: string, value: Answers[string]) => setValues(current => ({ ...current, [id]: value }))

  function collectAnswers(): Answers | null {
    const answers: Answers = {}
    const invalid: Record<string, string> = {}
    for (const question of interaction.request.questions ?? []) {
      let value = values[question.id]
      if (typeof value === 'string') value = value.trim()
      if (question.allowOther && otherEnabled[question.id]) {
        const other = otherValues[question.id]?.trim()
        if (!other) {
          invalid[question.id] = zh ? '请填写其他选项' : 'Enter an other option'
          continue
        }
        value = question.type === 'multi_select'
          ? [...new Set([...(Array.isArray(value) ? value : []), other])]
          : other
      }
      const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
      if (empty) {
        if (question.required) invalid[question.id] = zh ? '必填' : 'Required'
        continue
      }
      if (question.type === 'number') {
        value = Number(value)
        if (!Number.isFinite(value)) {
          invalid[question.id] = zh ? '请输入有效数字' : 'Enter a finite number'
          continue
        }
      }
      const size = typeof value === 'number' ? value
        : typeof value === 'string' || Array.isArray(value) ? value.length : undefined
      if (size !== undefined && ((question.min !== undefined && size < question.min) || (question.max !== undefined && size > question.max))) {
        invalid[question.id] = zh
          ? `超出范围（最小 ${question.min ?? '—'}，最大 ${question.max ?? '—'}）`
          : `Out of bounds (min ${question.min ?? '—'}, max ${question.max ?? '—'})`
      } else {
        answers[question.id] = value
      }
    }
    setErrors(invalid)
    return Object.keys(invalid).length ? null : answers
  }

  async function reply(action: AgentInteractionReply['action']) {
    if (disabled || submittingRef.current) return
    const answers = action === 'submit' ? collectAnswers() : undefined
    if (answers === null) return
    submittingRef.current = true
    setSubmitting(true)
    setServerError(null)
    try {
      await replyInteraction(interaction.sessionId, interaction.id, {
        revision: interaction.revision,
        action,
        ...(answers ? { answers } : {}),
      })
    } catch (error) {
      setServerError(error instanceof Error ? error.message : String(error))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  function questionInput(question: HumanQuestion) {
    const value = values[question.id]
    const id = `${formId}-${question.id}`
    const common = {
      id,
      'aria-label': question.label,
      'aria-required': Boolean(question.required),
      'aria-invalid': Boolean(errors[question.id]),
      'aria-describedby': errors[question.id] ? `${id}-error` : undefined,
      className: inputClass,
    }
    if (question.type === 'single_select' || question.type === 'multi_select') {
      const multiple = question.type === 'multi_select'
      const selected = Array.isArray(value) ? value : []
      return (
        <div className="space-y-1">
          {(question.options ?? []).map(option => (
            <label key={option.value} className="agent-request-choice">
              <input
                type={multiple ? 'checkbox' : 'radio'}
                name={id}
                checked={multiple ? selected.includes(option.value) : !otherEnabled[question.id] && value === option.value}
                aria-describedby={common['aria-describedby']}
                onChange={event => {
                  if (multiple) update(question.id, event.target.checked ? [...selected, option.value] : selected.filter(item => item !== option.value))
                  else {
                    update(question.id, option.value)
                    setOtherEnabled(current => ({ ...current, [question.id]: false }))
                  }
                }}
              />
              {option.label}
            </label>
          ))}
          {question.allowOther && (
            <>
              <label className="agent-request-choice">
                <input type={multiple ? 'checkbox' : 'radio'} name={id} checked={Boolean(otherEnabled[question.id])}
                  onChange={event => setOtherEnabled(current => ({ ...current, [question.id]: event.target.checked }))} />
                {zh ? '其他' : 'Other'}
              </label>
              {otherEnabled[question.id] && (
                <input {...common} aria-label={`${question.label} — ${zh ? '其他' : 'Other'}`}
                  value={otherValues[question.id] ?? ''}
                  onChange={event => setOtherValues(current => ({ ...current, [question.id]: event.target.value }))} />
              )}
            </>
          )}
        </div>
      )
    }
    if (question.type === 'boolean') {
      return <select {...common} value={typeof value === 'boolean' ? String(value) : ''} onChange={event => update(question.id, event.target.value === '' ? '' : event.target.value === 'true')}>
        <option value="">{zh ? '请选择' : 'Choose…'}</option>
        <option value="true">{zh ? '是' : 'Yes'}</option>
        <option value="false">{zh ? '否' : 'No'}</option>
      </select>
    }
    if (question.type === 'textarea') {
      return <textarea {...common} rows={3} minLength={question.min} maxLength={question.max} value={typeof value === 'string' ? value : ''} onChange={event => update(question.id, event.target.value)} />
    }
    return <input {...common} type={question.type} step={question.type === 'number' ? 'any' : undefined}
      min={question.type === 'number' ? question.min : undefined} max={question.type === 'number' ? question.max : undefined}
      minLength={question.type === 'text' ? question.min : undefined} maxLength={question.type === 'text' ? question.max : undefined}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''} onChange={event => update(question.id, event.target.value)} />
  }

  return (
    <form noValidate aria-labelledby={`${formId}-title`} aria-busy={submitting}
      onSubmit={event => { event.preventDefault(); if (!isPlan) void reply('submit') }}
      className="agent-request-surface">
      <header className="agent-request-header">
        {submitting ? <Loader2 size={13} className="shrink-0 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden /> : <MessageCircle size={13} className="shrink-0 text-muted-foreground" aria-hidden />}
        <h3 id={`${formId}-title`} className="min-w-0 flex-1 text-[12px] font-medium">{interaction.request.title}</h3>
        <span className="shrink-0 text-[10px] text-muted-foreground">v{interaction.revision}</span>
        <span role="status" className="shrink-0 text-[10px] text-muted-foreground">{submitting ? (zh ? '正在提交' : 'Submitting…') : (zh ? '等待确认' : 'Needs your input')}</span>
      </header>
      <fieldset disabled={disabled || submitting} className="agent-request-fields">
        <div className="agent-request-body space-y-3">
          {isPlan && interaction.request.plan && <PlanDetails plan={interaction.request.plan} zh={zh} showTitle={interaction.request.plan.title !== interaction.request.title} />}
          {(interaction.request.questions ?? []).map(question => (
            <fieldset key={question.id} aria-describedby={errors[question.id] ? `${formId}-${question.id}-error` : undefined}>
              <legend className="agent-request-label">{question.label}{question.required ? <span className="ml-1 text-muted-foreground">*</span> : null}</legend>
              {questionInput(question)}
              {errors[question.id] && <p id={`${formId}-${question.id}-error`} className="mt-1 text-xs text-danger">{errors[question.id]}</p>}
            </fieldset>
          ))}
        </div>
        <footer className="agent-request-footer">
          {isPlan && <p className="text-[11px] leading-relaxed text-muted-foreground">{zh ? '执行当前计划，或取消这次快捷确认。取消不会删除计划。' : 'Execute this plan now, or cancel this shortcut. Cancelling keeps the plan.'}</p>}
          <div className="flex flex-wrap items-center gap-1">
            {!isPlan && <button type="button" className={buttonClass} onClick={() => void reply('decline')}>{zh ? '拒绝回答' : 'Decline'}</button>}
            <button type="button" className={buttonClass} onClick={() => void reply('cancel')}>{isPlan ? (zh ? '取消' : 'Cancel') : (zh ? '取消请求' : 'Cancel request')}</button>
            <button type={isPlan ? 'button' : 'submit'} className={`${buttonClass} agent-request-primary ml-auto`}
              onClick={isPlan ? () => void reply('execute') : undefined}>
              {isPlan ? (zh ? '执行' : 'Execute') : (zh ? '提交回答' : 'Submit answers')}
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-muted-foreground">{isPlan ? (zh ? '也可以忽略此确认，直接在输入框中发送后续执行指令。' : 'You may ignore this confirmation and send a later execution instruction instead.') : (zh ? '拒绝或取消将停止本轮执行，不会使用默认答案。' : 'Declining or cancelling stops this round; no default answers are assumed.')}</p>
          {Object.keys(errors).length > 0 && <p role="alert" className="text-xs text-danger">{zh ? '请检查上方标记的字段。' : 'Check the highlighted fields above.'}</p>}
          {serverError && <div role="alert" className="space-y-1 text-xs text-danger">
            <p className="break-words">{serverError}</p>
            <button type="button" className={buttonClass} onClick={() => void refreshInteractions(interaction.sessionId)}>{zh ? '重新加载请求' : 'Reload requests'}</button>
          </div>}
        </footer>
      </fieldset>
    </form>
  )
}

function InteractionHistory({ interaction, zh }: { interaction: AgentInteraction; zh: boolean }) {
  const reply = interaction.response
  const action = reply?.action
  const status = action === 'save' ? (zh ? '已保存，可稍后执行' : 'Saved for later execution')
    : action === 'revise' ? (zh ? '已请求修改' : 'Revision requested')
      : action === 'execute' ? (zh ? '已开始执行' : 'Execution started')
        : interaction.status === 'declined' ? (zh ? '已拒绝' : 'Declined')
          : interaction.status === 'cancelled' ? (interaction.request.plan ? (zh ? '已取消快捷执行' : 'Shortcut execution cancelled') : (zh ? '已取消' : 'Cancelled')) : (zh ? '已回答' : 'Answered')
  return <details className="agent-history-item">
    <summary className="cursor-pointer">{interaction.request.title} v{interaction.revision} — {status}</summary>
    <div className="mt-2 space-y-2">
      {interaction.request.plan && <PlanDetails plan={interaction.request.plan} zh={zh} />}
      <dl className="space-y-1">
        {interaction.request.questions?.map(question => {
          const value = reply?.answers?.[question.id]
          return <div key={question.id}>
            <dt className="font-medium">{question.label}</dt>
            <dd className="whitespace-pre-wrap">{value === undefined ? '—' : Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? (zh ? '是' : 'Yes') : (zh ? '否' : 'No')) : String(value)}</dd>
          </div>
        })}
      </dl>
      {reply?.message && <p className="whitespace-pre-wrap">{reply.message}</p>}
    </div>
  </details>
}

export function AgentInteractionPanel({ session }: { session: AgentSession }) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const state = useAgentSessionStore(s => s.interactionState)
  const selectedSessionId = useAgentSessionStore(s => s.selectedSessionId)
  const refreshInteractions = useAgentSessionStore(s => s.refreshInteractions)
  const refreshSessions = useAgentSessionStore(s => s.refreshSessions)
  const acp = readSessionBackendId(session).endsWith('-acp')

  useEffect(() => {
    if (!acp && selectedSessionId === session.id) void refreshInteractions(session.id)
  }, [acp, selectedSessionId, session.id, session.status, session.updatedAt, refreshInteractions])

  useEffect(() => {
    if (acp) return
    const refresh = () => {
      void refreshInteractions(session.id)
      void refreshSessions()
    }
    const onEvent = (event: MessageEvent) => {
      try {
        if ((JSON.parse(event.data) as { sessionId?: string }).sessionId === session.id) refresh()
      } catch { /* Ignore malformed notifications; durable HTTP state is authoritative. */ }
    }
    return subscribe({ onConnect: refresh, events: { session_changed: onEvent, session_step_completed: onEvent } })
  }, [acp, session.id, refreshInteractions, refreshSessions])

  if (acp) return null
  const current = state?.sessionId === session.id ? state : null
  const pending = current?.items.filter(item => item.status === 'pending') ?? []
  const waiting = session.status === 'waiting_input' || pending.length > 0
  const history = current?.items.filter(item => item.status !== 'pending') ?? []
  const metadata = session.sessionMetadata
  const hasSummary = Boolean(metadata?.goal || metadata?.plan || metadata?.specialist)
  if (!waiting && !history.length && !hasSummary && !current?.error) return null

  return (
    <section aria-label={zh ? '待处理请求' : 'Agent requests'} className="agent-controls-stack">
      {(hasSummary || history.length > 0) && <div className="agent-context-row">
        {hasSummary && <SessionModeSummary session={session} />}
        {history.length > 0 && <details key={session.id} className="agent-history">
          <summary><ChevronRight size={11} aria-hidden className="agent-disclosure-arrow" /><History size={11} aria-hidden />
            <span>{zh ? '交互记录' : 'Interaction history'}</span><span className="agent-history-count">{history.length}</span>
          </summary>
          <div className="agent-context-body agent-history-body">
            {history.map(interaction => <InteractionHistory key={`${interaction.id}:${interaction.revision}`} interaction={interaction} zh={zh} />)}
          </div>
        </details>}
      </div>}
      {waiting && pending.length === 0 && <p role="status" className="px-2 text-xs text-muted-foreground">{zh ? '等待你的输入，正在加载请求…' : 'Waiting for your input. Loading requests…'}</p>}
      {current?.error && <div role="alert" className="px-2 text-xs text-danger">
        <p className="break-words">{current.error}</p>
        <button type="button" className={buttonClass} onClick={() => void refreshInteractions(session.id)}>{zh ? '重新加载' : 'Retry loading'}</button>
      </div>}
      {pending.map(interaction => <InteractionForm key={`${session.id}:${interaction.id}:${interaction.revision}`} interaction={interaction}
        disabled={session.status === 'cancelled'} />)}
    </section>
  )
}
