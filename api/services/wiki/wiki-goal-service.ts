import { eq, and, desc, inArray } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/index.js'
import { wikiGoals, wikiPlans, wikiPlanNodes, wikiPlanNodeArtifacts } from '../../db/schema.js'
import type { GoalAnchor } from '../../db/schema.js'

export type { GoalAnchor }

export type WikiGoal = {
  id: string
  projectId: string
  scope: 'project' | 'document'
  documentId: string | null
  content: string
  anchorJson: GoalAnchor | null
  status: 'active' | 'planned' | 'in_progress' | 'resolved'
  planNodeId: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export type WikiPlan = {
  id: string
  projectId: string
  snapshotId: string
  goalIds: string[]
  status: 'draft' | 'confirmed' | 'executing' | 'reviewing' | 'committing' | 'completed' | 'discarded'
  createdAt: string
  updatedAt: string
  confirmedAt: string | null
}

export type WikiPlanNode = {
  id: string
  planId: string
  projectId: string
  title: string
  description: string
  goalIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
  status: 'pending' | 'executing' | 'review' | 'accepted' | 'committed'
  sortOrder: number
  reviewResult: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export type PlanNodeArtifactPatch = {
  filePath: string
  diff: string
  action: 'create' | 'modify' | 'delete'
}

export type WikiPlanNodeArtifact = {
  id: string
  nodeId: string
  planId: string
  sessionId: string | null
  patches: PlanNodeArtifactPatch[]
  executionLog: string | null
  commitMessage: string | null
  status: 'pending' | 'generated' | 'accepted' | 'committed' | 'discarded'
  redoCount: number
  redoFeedback: string | null
  createdAt: string
  updatedAt: string
}

const now = () => new Date().toISOString()

function parseGoalIds(row: { goalIdsJson?: string | null; evaluationIdsJson?: string | null }): string[] {
  const raw = row.goalIdsJson && row.goalIdsJson !== '[]' ? row.goalIdsJson : row.evaluationIdsJson
  try { return JSON.parse(raw ?? '[]') as string[] } catch { return [] }
}

export async function createGoal(input: {
  projectId: string
  content: string
  scope?: 'project' | 'document'
  documentId?: string | null
  anchorJson?: GoalAnchor | null
}): Promise<WikiGoal> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  const scope = input.scope ?? (input.documentId ? 'document' : 'project')
  const documentId = scope === 'document' ? (input.documentId ?? null) : (input.documentId ?? null)
  if (scope === 'document' && !documentId) {
    throw new Error('documentId is required for document-scoped goals')
  }
  await db.insert(wikiGoals).values({
    id,
    projectId: input.projectId,
    scope,
    documentId,
    content: input.content,
    anchorJson: input.anchorJson ? JSON.stringify(input.anchorJson) : null,
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
  })
  return rowToGoal({
    id, projectId: input.projectId, scope, documentId, content: input.content,
    anchorJson: input.anchorJson ? JSON.stringify(input.anchorJson) : null,
    status: 'active', planNodeId: null, createdAt: ts, updatedAt: ts, resolvedAt: null,
  })
}

export async function listGoals(projectId: string, status?: string): Promise<WikiGoal[]> {
  const db = getDb()
  const cond = status
    ? and(eq(wikiGoals.projectId, projectId), eq(wikiGoals.status, status))
    : eq(wikiGoals.projectId, projectId)
  const rows = await db.select().from(wikiGoals).where(cond).orderBy(desc(wikiGoals.createdAt))
  return rows.map(rowToGoal)
}

export async function listGoalsByDocument(documentId: string): Promise<WikiGoal[]> {
  const db = getDb()
  const rows = await db.select().from(wikiGoals)
    .where(eq(wikiGoals.documentId, documentId))
    .orderBy(desc(wikiGoals.createdAt))
  return rows.map(rowToGoal)
}

export async function getGoal(id: string): Promise<WikiGoal | null> {
  const db = getDb()
  const rows = await db.select().from(wikiGoals).where(eq(wikiGoals.id, id))
  return rows.length ? rowToGoal(rows[0]) : null
}

export async function updateGoalStatus(id: string, status: WikiGoal['status']): Promise<void> {
  const db = getDb()
  const updates: Record<string, string> = { status, updatedAt: now() }
  if (status === 'resolved') updates.resolvedAt = now()
  await db.update(wikiGoals).set(updates).where(eq(wikiGoals.id, id))
}

export async function updateGoalsStatus(ids: string[], status: WikiGoal['status']): Promise<void> {
  for (const id of ids) await updateGoalStatus(id, status)
}

export async function deleteGoal(id: string): Promise<void> {
  const db = getDb()
  await db.delete(wikiGoals).where(eq(wikiGoals.id, id))
}

export async function createPlan(projectId: string, snapshotId: string, goalIds: string[]): Promise<WikiPlan> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  const json = JSON.stringify(goalIds)
  await db.insert(wikiPlans).values({
    id, projectId, snapshotId,
    goalIdsJson: json,
    evaluationIdsJson: json,
    status: 'draft', createdAt: ts, updatedAt: ts,
  })
  return { id, projectId, snapshotId, goalIds, status: 'draft', createdAt: ts, updatedAt: ts, confirmedAt: null }
}

export async function getPlan(id: string): Promise<WikiPlan | null> {
  const db = getDb()
  const rows = await db.select().from(wikiPlans).where(eq(wikiPlans.id, id))
  return rows.length ? rowToPlan(rows[0]) : null
}

export async function getActivePlan(projectId: string): Promise<WikiPlan | null> {
  const db = getDb()
  const rows = await db.select().from(wikiPlans)
    .where(eq(wikiPlans.projectId, projectId))
    .orderBy(desc(wikiPlans.createdAt))
  const active = rows.map(rowToPlan).find(p => p.status !== 'completed' && p.status !== 'discarded')
  return active ?? null
}

export async function confirmPlan(id: string): Promise<void> {
  const db = getDb()
  await db.update(wikiPlans).set({ status: 'confirmed', confirmedAt: now(), updatedAt: now() }).where(eq(wikiPlans.id, id))
}

export async function createPlanNode(input: {
  planId: string; projectId: string; title: string; description?: string;
  goalIds?: string[]; dependsOn?: string[]; expectedFiles?: string[]; sortOrder?: number;
}): Promise<WikiPlanNode> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  const goalJson = JSON.stringify(input.goalIds ?? [])
  await db.insert(wikiPlanNodes).values({
    id, planId: input.planId, projectId: input.projectId,
    title: input.title, description: input.description ?? '',
    goalIdsJson: goalJson,
    evaluationIdsJson: goalJson,
    dependsOnJson: JSON.stringify(input.dependsOn ?? []),
    expectedFilesJson: JSON.stringify(input.expectedFiles ?? []),
    sortOrder: input.sortOrder ?? 0,
    status: 'pending', createdAt: ts, updatedAt: ts,
  })
  return {
    id, planId: input.planId, projectId: input.projectId,
    title: input.title, description: input.description ?? '',
    goalIds: input.goalIds ?? [], dependsOn: input.dependsOn ?? [],
    expectedFiles: input.expectedFiles ?? [], status: 'pending',
    sortOrder: input.sortOrder ?? 0, reviewResult: null,
    createdAt: ts, updatedAt: ts, completedAt: null,
  }
}

export async function listPlanNodes(planId: string): Promise<WikiPlanNode[]> {
  const db = getDb()
  const rows = await db.select().from(wikiPlanNodes)
    .where(eq(wikiPlanNodes.planId, planId))
    .orderBy(wikiPlanNodes.sortOrder)
  return rows.map(rowToPlanNode)
}

export async function updatePlanNodeStatus(id: string, status: WikiPlanNode['status']): Promise<void> {
  const db = getDb()
  const updates: Record<string, unknown> = { status, updatedAt: now() }
  if (status === 'committed') updates.completedAt = now()
  await db.update(wikiPlanNodes).set(updates).where(eq(wikiPlanNodes.id, id))
}

export async function updatePlanStatus(id: string, status: WikiPlan['status']): Promise<void> {
  const db = getDb()
  await db.update(wikiPlans).set({ status, updatedAt: now() }).where(eq(wikiPlans.id, id))
}

export async function listPlans(projectId: string): Promise<WikiPlan[]> {
  const db = getDb()
  const rows = await db.select().from(wikiPlans)
    .where(eq(wikiPlans.projectId, projectId))
    .orderBy(desc(wikiPlans.createdAt))
  return rows.map(rowToPlan)
}

export type PlanNodeSummary = { total: number; completed: number; titles: string[] }
export type WikiPlanWithSummary = WikiPlan & { nodeSummary: PlanNodeSummary }

export async function listPlansWithSummary(projectId: string): Promise<WikiPlanWithSummary[]> {
  const plans = await listPlans(projectId)
  if (plans.length === 0) return []

  const db = getDb()
  const planIds = plans.map(p => p.id)
  const allNodes = await db.select({
    planId: wikiPlanNodes.planId,
    title: wikiPlanNodes.title,
    status: wikiPlanNodes.status,
    sortOrder: wikiPlanNodes.sortOrder,
  }).from(wikiPlanNodes)
    .where(inArray(wikiPlanNodes.planId, planIds))
    .orderBy(wikiPlanNodes.sortOrder)

  const nodesByPlan = new Map<string, typeof allNodes>()
  for (const n of allNodes) {
    const arr = nodesByPlan.get(n.planId) ?? []
    arr.push(n)
    nodesByPlan.set(n.planId, arr)
  }

  return plans.map(plan => {
    const nodes = nodesByPlan.get(plan.id) ?? []
    const completed = nodes.filter(n => n.status === 'accepted' || n.status === 'committed').length
    const titles = nodes.slice(0, 3).map(n => n.title)
    return { ...plan, nodeSummary: { total: nodes.length, completed, titles } }
  })
}

export async function getNextExecutableNode(planId: string): Promise<WikiPlanNode | null> {
  const nodes = await listPlanNodes(planId)
  const committedTitles = new Set(nodes.filter(n => n.status === 'committed' || n.status === 'accepted').map(n => n.title))
  for (const node of nodes) {
    if (node.status !== 'pending') continue
    const depsOk = node.dependsOn.every(dep => committedTitles.has(dep))
    if (depsOk) return node
  }
  return null
}

export async function updatePlanNode(id: string, updates: {
  title?: string; description?: string; goalIds?: string[];
  dependsOn?: string[]; expectedFiles?: string[];
}): Promise<void> {
  const db = getDb()
  const set: Record<string, unknown> = { updatedAt: now() }
  if (updates.title !== undefined) set.title = updates.title
  if (updates.description !== undefined) set.description = updates.description
  if (updates.goalIds !== undefined) {
    const json = JSON.stringify(updates.goalIds)
    set.goalIdsJson = json
    set.evaluationIdsJson = json
  }
  if (updates.dependsOn !== undefined) set.dependsOnJson = JSON.stringify(updates.dependsOn)
  if (updates.expectedFiles !== undefined) set.expectedFilesJson = JSON.stringify(updates.expectedFiles)
  await db.update(wikiPlanNodes).set(set).where(eq(wikiPlanNodes.id, id))
}

export async function deletePlan(id: string): Promise<void> {
  const db = getDb()
  await db.delete(wikiPlanNodeArtifacts).where(eq(wikiPlanNodeArtifacts.planId, id))
  await db.delete(wikiPlanNodes).where(eq(wikiPlanNodes.planId, id))
  await db.delete(wikiPlans).where(eq(wikiPlans.id, id))
}

export async function deletePlanNode(id: string): Promise<void> {
  const db = getDb()
  await db.delete(wikiPlanNodes).where(eq(wikiPlanNodes.id, id))
}

export async function reorderPlanNodes(planId: string, nodeIds: string[]): Promise<void> {
  const db = getDb()
  for (let i = 0; i < nodeIds.length; i++) {
    await db.update(wikiPlanNodes)
      .set({ sortOrder: i, updatedAt: now() })
      .where(and(eq(wikiPlanNodes.id, nodeIds[i]), eq(wikiPlanNodes.planId, planId)))
  }
}

export async function createArtifact(input: {
  nodeId: string; planId: string; sessionId?: string;
}): Promise<WikiPlanNodeArtifact> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  await db.insert(wikiPlanNodeArtifacts).values({
    id, nodeId: input.nodeId, planId: input.planId,
    sessionId: input.sessionId ?? null,
    status: 'pending', createdAt: ts, updatedAt: ts,
  })
  return {
    id, nodeId: input.nodeId, planId: input.planId,
    sessionId: input.sessionId ?? null, patches: [],
    executionLog: null, commitMessage: null,
    status: 'pending', redoCount: 0, redoFeedback: null,
    createdAt: ts, updatedAt: ts,
  }
}

export async function getArtifact(nodeId: string): Promise<WikiPlanNodeArtifact | null> {
  const db = getDb()
  const rows = await db.select().from(wikiPlanNodeArtifacts)
    .where(eq(wikiPlanNodeArtifacts.nodeId, nodeId))
    .orderBy(desc(wikiPlanNodeArtifacts.createdAt))
    .limit(1)
  return rows.length ? rowToArtifact(rows[0]) : null
}

export async function listArtifacts(planId: string): Promise<WikiPlanNodeArtifact[]> {
  const db = getDb()
  const rows = await db.select().from(wikiPlanNodeArtifacts)
    .where(eq(wikiPlanNodeArtifacts.planId, planId))
  return rows.map(rowToArtifact)
}

export async function updateArtifact(id: string, updates: {
  patches?: PlanNodeArtifactPatch[]; executionLog?: string;
  commitMessage?: string; status?: WikiPlanNodeArtifact['status'];
  sessionId?: string; redoFeedback?: string; redoCount?: number;
}): Promise<void> {
  const db = getDb()
  const set: Record<string, unknown> = { updatedAt: now() }
  if (updates.patches !== undefined) set.patchesJson = JSON.stringify(updates.patches)
  if (updates.executionLog !== undefined) set.executionLog = updates.executionLog
  if (updates.commitMessage !== undefined) set.commitMessage = updates.commitMessage
  if (updates.status !== undefined) set.status = updates.status
  if (updates.sessionId !== undefined) set.sessionId = updates.sessionId
  if (updates.redoFeedback !== undefined) set.redoFeedback = updates.redoFeedback
  if (updates.redoCount !== undefined) set.redoCount = updates.redoCount
  await db.update(wikiPlanNodeArtifacts).set(set).where(eq(wikiPlanNodeArtifacts.id, id))
}

export async function discardArtifact(id: string): Promise<void> {
  const db = getDb()
  await db.update(wikiPlanNodeArtifacts)
    .set({ status: 'discarded', updatedAt: now() })
    .where(eq(wikiPlanNodeArtifacts.id, id))
}

function rowToGoal(r: typeof wikiGoals.$inferSelect): WikiGoal {
  let anchorJson: GoalAnchor | null = null
  if (r.anchorJson) {
    try { anchorJson = JSON.parse(r.anchorJson) as GoalAnchor } catch { anchorJson = null }
  }
  return {
    id: r.id, projectId: r.projectId,
    scope: (r.scope as WikiGoal['scope']) ?? 'document',
    documentId: r.documentId ?? null,
    content: r.content, anchorJson,
    status: r.status as WikiGoal['status'],
    planNodeId: r.planNodeId ?? null,
    createdAt: r.createdAt, updatedAt: r.updatedAt, resolvedAt: r.resolvedAt ?? null,
  }
}

function rowToPlan(r: typeof wikiPlans.$inferSelect): WikiPlan {
  return {
    id: r.id, projectId: r.projectId, snapshotId: r.snapshotId,
    goalIds: parseGoalIds(r),
    status: r.status as WikiPlan['status'],
    createdAt: r.createdAt, updatedAt: r.updatedAt, confirmedAt: r.confirmedAt ?? null,
  }
}

function rowToPlanNode(r: typeof wikiPlanNodes.$inferSelect): WikiPlanNode {
  return {
    id: r.id, planId: r.planId, projectId: r.projectId,
    title: r.title, description: r.description,
    goalIds: parseGoalIds(r),
    dependsOn: JSON.parse(r.dependsOnJson),
    expectedFiles: JSON.parse(r.expectedFilesJson),
    status: r.status as WikiPlanNode['status'],
    sortOrder: r.sortOrder, reviewResult: r.reviewResult ?? null,
    createdAt: r.createdAt, updatedAt: r.updatedAt, completedAt: r.completedAt ?? null,
  }
}

function rowToArtifact(r: typeof wikiPlanNodeArtifacts.$inferSelect): WikiPlanNodeArtifact {
  return {
    id: r.id, nodeId: r.nodeId, planId: r.planId,
    sessionId: r.sessionId ?? null,
    patches: JSON.parse(r.patchesJson),
    executionLog: r.executionLog ?? null,
    commitMessage: r.commitMessage ?? null,
    status: r.status as WikiPlanNodeArtifact['status'],
    redoCount: r.redoCount, redoFeedback: r.redoFeedback ?? null,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  }
}
