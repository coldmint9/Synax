import fs from 'node:fs'
import path from 'node:path'
import { logger } from '../../lib/logger.js'
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js'
import { agentRuntimeStore } from '../agent-runtime/session-store.js'
import { streamWikiAgent } from './wiki-agent-stream.js'
import { ensureLegacyGoalProfileRegistered, SYNAX_AGENT_PROFILE_ID } from '../agent-runtime/synax/index.js'
import { buildGoalSessionPrompt } from './wiki-goal-prompt.js'
import { PLAN_NODE_PERMISSION_OVERRIDES } from './wiki-goal-permissions.js'
import {
  getPlan,
  listPlanNodes,
  listGoals,
  updatePlanStatus,
  updatePlanNodeStatus,
  getNextExecutableNode,
  createArtifact,
  updateArtifact,
  getArtifact,
  updateGoalsStatus,
  updateGoalLastSessionId,
  type WikiPlanNode,
  type PlanNodeArtifactPatch,
} from './wiki-goal-service.js'
import { resolveWorkspacePath, resolveWorkspaceRoot } from '../agent-runtime/tools/workspace.js'
import { deriveNewContentsFromChunks, parseApplyPatchEnvelope } from '../agent-runtime/tools/patch-format.js'
import { wikiRefreshService } from './wiki-refresh-service.js'
import { notify } from '../notifications/notify.js'
import { TaskNotificationEventType } from '../notifications/task-notification-bus.js'

export type PlanExecuteEvent =
  | { type: 'plan_status'; status: string }
  | { type: 'node_status'; nodeId: string; status: string; title: string }
  | { type: 'node_review'; nodeId: string; artifactId: string }
  | { type: 'plan_completed'; planId: string }
  | { type: 'failed'; error: string }

type ExecutionListener = (event: PlanExecuteEvent) => void

const listeners = new Map<string, Set<ExecutionListener>>()
const runningPlans = new Set<string>()

function emit(planId: string, event: PlanExecuteEvent) {
  for (const fn of listeners.get(planId) ?? []) {
    try { fn(event) } catch { /* ignore */ }
  }
}

export function subscribePlanExecution(planId: string, listener: ExecutionListener): () => void {
  const set = listeners.get(planId) ?? new Set()
  set.add(listener)
  listeners.set(planId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(planId)
  }
}

function extractPatchesFromSession(sessionId: string): PlanNodeArtifactPatch[] {
  const calls = agentRuntimeStore.listToolCalls(sessionId)
  const patches: PlanNodeArtifactPatch[] = []
  for (const call of calls) {
    if (call.status !== 'completed') continue
    const input = call.inputRef as { path?: string; patch?: string; content?: string } | null
    if (!input?.path) continue
    if (call.toolId === 'file.write') {
      patches.push({
        filePath: input.path,
        diff: typeof input.content === 'string' ? input.content : '',
        action: 'modify',
      })
      continue
    }
    if (call.toolId === 'edit' || call.toolId === 'file.patch') {
      patches.push({
        filePath: input.path,
        diff: input.patch ?? input.content ?? '',
        action: 'modify',
      })
      continue
    }
    if (call.toolId === 'file.delete') {
      patches.push({
        filePath: input.path,
        diff: '',
        action: 'delete',
      })
    }
  }
  return patches
}

function applyPatchToFile(
  filePath: string,
  diff: string,
  action: PlanNodeArtifactPatch['action'],
  workDir: string,
): void {
  const root = resolveWorkspaceRoot(workDir)
  const abs = path.resolve(root, filePath)
  if (action === 'delete') {
    if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
    return
  }
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : ''
  let next = current
  if (diff.includes('*** Begin Patch')) {
    const hunks = parseApplyPatchEnvelope(diff)
    if (hunks.length === 1) {
      const hunk = hunks[0]
      if (hunk.type === 'add') next = hunk.contents
      else if (hunk.type === 'delete') { fs.rmSync(abs, { force: true }); return }
      else next = deriveNewContentsFromChunks(filePath, hunk.chunks, current)
    }
  } else if (diff && !diff.startsWith('---')) {
    next = diff
  } else if (diff) {
    next = diff
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, next, 'utf8')
}

export async function startExecution(planId: string, workDir?: string, locale: 'zh' | 'en' = 'zh'): Promise<void> {
  if (runningPlans.has(planId)) return
  runningPlans.add(planId)
  try {
    await runExecutionLoop(planId, workDir, locale)
  } finally {
    runningPlans.delete(planId)
  }
}

async function runExecutionLoop(planId: string, workDir?: string, locale: 'zh' | 'en' = 'zh'): Promise<void> {
  const plan = await getPlan(planId)
  if (!plan) throw new Error('Plan not found')

  await updatePlanStatus(planId, 'executing')
  emit(planId, { type: 'plan_status', status: 'executing' })

  while (true) {
    const node = await getNextExecutableNode(planId)
    if (!node) {
      await completePlan(planId, workDir, locale)
      return
    }

    const reviewNode = (await listPlanNodes(planId)).find(n => n.status === 'review')
    if (reviewNode) {
      await updatePlanStatus(planId, 'reviewing')
      emit(planId, { type: 'plan_status', status: 'reviewing' })
      return
    }

    try {
      await executeNode(plan, node, locale)
      const artifact = await getArtifact(node.id)
      if (artifact) {
        emit(planId, { type: 'node_review', nodeId: node.id, artifactId: artifact.id })
      }
      await updatePlanStatus(planId, 'reviewing')
      emit(planId, { type: 'plan_status', status: 'reviewing' })
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Execution failed'
      emit(planId, { type: 'failed', error: msg })
      throw err
    }
  }
}

async function executeNode(
  plan: { id: string; projectId: string },
  node: WikiPlanNode,
  locale: 'zh' | 'en',
  feedback?: string,
): Promise<void> {
  ensureLegacyGoalProfileRegistered()
  await updatePlanNodeStatus(node.id, 'executing')
  emit(plan.id, { type: 'node_status', nodeId: node.id, status: 'executing', title: node.title })

  const allGoals = await listGoals(plan.projectId)
  const linkedGoals = allGoals.filter(g => node.goalIds.includes(g.id))
  const allNodes = await listPlanNodes(plan.id)
  const committedTitles = new Set(
    allNodes
      .filter(n => n.status === 'committed' || n.status === 'accepted')
      .map(n => n.title),
  )
  const completedNodes = allNodes
    .filter(n => committedTitles.has(n.title) && n.id !== node.id)
    .map(n => ({ title: n.title }))

  const prompt = buildGoalSessionPrompt({
    mode: 'plan_node',
    content: node.description,
    node: {
      title: node.title,
      description: node.description,
      expectedFiles: node.expectedFiles,
      dependsOn: node.dependsOn,
    },
    linkedGoals,
    completedNodes,
    redoFeedback: feedback,
    locale,
  })
  const session = agentSessionRuntime.create({
    projectId: plan.projectId,
    profileId: SYNAX_AGENT_PROFILE_ID,
    prompt,
    permissionOverrides: PLAN_NODE_PERMISSION_OVERRIDES,
    sessionMetadata: {
      mode: 'plan_node',
      source: 'plan-execution',
      planId: plan.id,
      planNodeId: node.id,
      planNodeTitle: node.title,
      goalIds: node.goalIds,
    },
  })

  const artifact = await createArtifact({ nodeId: node.id, planId: plan.id, sessionId: session.id })
  const logParts: string[] = []

  const stream = streamWikiAgent(session.id, { locale })
  for await (const chunk of stream) {
    if (chunk.type === 'message_delta' && chunk.delta) logParts.push(chunk.delta)
    if (chunk.type === 'thought_delta' && chunk.delta) logParts.push(chunk.delta)
    if (chunk.type === 'run_failed') throw new Error(chunk.error ?? 'Agent run failed')
  }

  const patches = extractPatchesFromSession(session.id)
  await updateArtifact(artifact.id, {
    patches,
    executionLog: logParts.join(''),
    status: 'generated',
    sessionId: session.id,
  })
  await updatePlanNodeStatus(node.id, 'review')
  if (node.goalIds.length > 0) {
    await updateGoalsStatus(node.goalIds, 'in_progress')
    for (const goalId of node.goalIds) {
      await updateGoalLastSessionId(goalId, session.id)
    }
  }
  emit(plan.id, { type: 'node_status', nodeId: node.id, status: 'review', title: node.title })
}

export async function acceptPlanNode(planId: string, nodeId: string, workDir: string): Promise<void> {
  const artifact = await getArtifact(nodeId)
  if (!artifact || artifact.status !== 'generated') throw new Error('No generated artifact to accept')

  for (const patch of artifact.patches) {
    applyPatchToFile(patch.filePath, patch.diff, patch.action, workDir)
  }
  await updateArtifact(artifact.id, { status: 'accepted' })
  await updatePlanNodeStatus(nodeId, 'committed')
  emit(planId, { type: 'node_status', nodeId, status: 'committed', title: '' })

  const pending = await getNextExecutableNode(planId)
  if (pending) {
    void startExecution(planId, workDir)
  } else {
    const nodes = await listPlanNodes(planId)
    const allReviewed = nodes.every(n => n.status === 'committed' || n.status === 'accepted')
    if (allReviewed) await completePlan(planId, workDir)
  }
}

export async function redoPlanNode(
  planId: string,
  nodeId: string,
  feedback: string,
  locale: 'zh' | 'en' = 'zh',
): Promise<void> {
  const plan = await getPlan(planId)
  if (!plan) throw new Error('Plan not found')
  const nodes = await listPlanNodes(planId)
  const node = nodes.find(n => n.id === nodeId)
  if (!node) throw new Error('Node not found')

  const prev = await getArtifact(nodeId)
  if (prev) await updateArtifact(prev.id, { status: 'discarded', redoFeedback: feedback, redoCount: (prev.redoCount ?? 0) + 1 })

  await updatePlanNodeStatus(nodeId, 'pending')
  await executeNode(plan, { ...node, status: 'pending' }, locale, feedback)
  const artifact = await getArtifact(nodeId)
  if (artifact) {
    emit(planId, { type: 'node_review', nodeId, artifactId: artifact.id })
  }
  await updatePlanStatus(planId, 'reviewing')
  emit(planId, { type: 'plan_status', status: 'reviewing' })
}

async function completePlan(planId: string, workDir?: string, locale: 'zh' | 'en' = 'zh'): Promise<void> {
  const plan = await getPlan(planId)
  if (!plan) return

  await updatePlanStatus(planId, 'completed')
  emit(planId, { type: 'plan_status', status: 'completed' })

  const nodes = await listPlanNodes(planId)
  const goalIds = [...new Set(nodes.flatMap(n => n.goalIds))]
  if (goalIds.length > 0) await updateGoalsStatus(goalIds, 'resolved')

  emit(planId, { type: 'plan_completed', planId })

  if (workDir) {
    try {
      const task = await wikiRefreshService.triggerRefresh(plan.projectId, plan.snapshotId, workDir, locale)
      notify({
        type: TaskNotificationEventType.TaskCompleted,
        taskKind: 'wiki_refresh',
        projectId: plan.projectId,
        taskId: task.id,
        title: locale === 'en' ? 'Wiki drafts ready' : 'Wiki 草稿已就绪',
        message: locale === 'en'
          ? 'Plan completed. Review wiki refresh drafts.'
          : '规划执行完成，请审阅 Wiki 刷新草稿。',
        severity: 'success',
        meta: { taskId: task.id, planId },
      })
    } catch (err) {
      logger.warn({ err, planId }, 'wiki sync after plan failed')
    }
  }
}
