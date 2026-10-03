import type { CoordNode } from '../contracts/forest.js'
import type {
  ActionReviewDecision,
  GoalReviewPackage,
  GoalReviewRequest,
  GoalReviewRun,
  ReviewAgentLogEntry,
} from '../contracts/review.js'
import { compact, hashParts, now } from './shared.js'

const REVIEW_CORRECTION_REASONS = ['arch', 'logic', 'perf', 'maintain'] as const

export function buildReviewPackage(input: GoalReviewRequest): GoalReviewPackage {
  const goal = input.forest.nodes[input.goalId]
  const childNodes = goal?.children?.map((childId) => input.forest.nodes[childId]).filter((node): node is CoordNode => Boolean(node) && node.type === 'action') ?? []
  const startedAt = now()
  const run: GoalReviewRun = {
    id: `review:${hashParts(input.projectId, input.goalId, String(startedAt))}`,
    projectId: input.projectId,
    goalId: input.goalId,
    status: 'running',
    startedAt,
    summary: '',
    overallVerdict: 'blocked',
  }
  const decisions: ActionReviewDecision[] = []
  const agentLog: ReviewAgentLogEntry[] = []
  const improvementPlan: string[] = []

  for (const [index, action] of childNodes.slice(0, 8).entries()) {
    const text = `${action.label} ${action.summary} ${(action.tags ?? []).join(' ')}`.toLowerCase()
    const done = action.status === 'done' || action.progress >= 0.8 || Boolean(action.review?.verdict === 'accepted')
    const blocked = action.status === 'rejection' || action.status === 'cancel' || /todo|fixme|pending|block/.test(text)
    const verdict: ActionReviewDecision['verdict'] = blocked ? 'blocked' : done ? 'accept' : 'reject'
    const rationale = done
      ? `${action.label} is already progressing or completed.`
      : blocked
        ? `${action.label} appears blocked or carries unresolved work.`
        : `${action.label} needs more evidence before acceptance.`
    const issues = blocked ? ['Blocker signals remain in the action summary.'] : done ? [] : ['Completion evidence is weak.']
    const suggestions = blocked
      ? ['Unblock dependencies or split the action.']
      : done
        ? ['Keep the action closed and update the goal summary.']
        : ['Add evidence, clarify scope, and mark progress once validated.']
    const correctionReasons = blocked ? ['logic'] : done ? [] : ['maintain']
    decisions.push({
      actionId: action.id,
      verdict,
      confidence: blocked ? 0.72 : done ? 0.86 : 0.64,
      rationale,
      evidenceSummary: compact(action.summary, 240),
      issues,
      suggestions,
      ...(blocked ? { correctionNote: `Resolve blockers for ${action.label}` } : {}),
      ...(correctionReasons.length ? { correctionReasons: correctionReasons as (typeof REVIEW_CORRECTION_REASONS)[number][] } : {}),
      ...(verdict === 'reject' ? { suggestedPrompt: `Refine ${action.label} with concrete evidence and a completion check.` } : {}),
    })
    agentLog.push({
      turn: index + 1,
      tool: 'evaluate_action',
      thought: `Inspect ${action.label}`,
      args: { actionId: action.id, progress: action.progress, status: action.status },
      resultSummary: `${verdict.toUpperCase()} (${Math.round((blocked ? 0.72 : done ? 0.86 : 0.64) * 100)}%)`,
    })
    if (verdict !== 'accept') improvementPlan.push(`Clarify ${action.label}: ${suggestions[0]}`)
  }

  const accepted = decisions.filter((decision) => decision.verdict === 'accept').length
  const blockedCount = decisions.filter((decision) => decision.verdict === 'blocked').length
  run.status = 'completed'
  run.completedAt = now()
  run.summary = `${accepted}/${decisions.length} actions accepted; ${blockedCount} blocked.`
  run.overallVerdict = blockedCount > 0 ? 'blocked' : accepted >= Math.ceil(decisions.length / 2) ? 'accepted' : 'rejected'

  return {
    run,
    decisions,
    improvementPlan,
    agentLog,
    warnings: childNodes.length === 0 ? ['Goal has no child actions.'] : [],
  }
}
