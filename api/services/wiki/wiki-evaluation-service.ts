import { eq, and, desc } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { getDb } from '../../db/index.js'
import { wikiEvaluations, wikiPlans, wikiPlanNodes } from '../../db/schema.js'

export type WikiEvaluation = {
  id: string
  projectId: string
  blockId: string
  content: string
  status: 'active' | 'planned' | 'resolved'
  planNodeId: string | null
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export type WikiPlan = {
  id: string
  projectId: string
  snapshotId: string
  evaluationIds: string[]
  status: 'draft' | 'confirmed' | 'in_progress' | 'completed'
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
  evaluationIds: string[]
  dependsOn: string[]
  expectedFiles: string[]
  status: 'pending' | 'in_progress' | 'completed' | 'incomplete'
  sortOrder: number
  reviewResult: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

const now = () => new Date().toISOString()

// ── Evaluations CRUD ────────────────────────────────────────────────────────

export async function createEvaluation(projectId: string, blockId: string, content: string): Promise<WikiEvaluation> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  await db.insert(wikiEvaluations).values({
    id, projectId, blockId, content,
    status: 'active', createdAt: ts, updatedAt: ts,
  })
  return { id, projectId, blockId, content, status: 'active', planNodeId: null, createdAt: ts, updatedAt: ts, resolvedAt: null }
}

export async function listEvaluations(projectId: string, status?: string): Promise<WikiEvaluation[]> {
  const db = getDb()
  const cond = status
    ? and(eq(wikiEvaluations.projectId, projectId), eq(wikiEvaluations.status, status))
    : eq(wikiEvaluations.projectId, projectId)
  const rows = await db.select().from(wikiEvaluations).where(cond).orderBy(desc(wikiEvaluations.createdAt))
  return rows.map(rowToEvaluation)
}

export async function listEvaluationsByBlock(blockId: string): Promise<WikiEvaluation[]> {
  const db = getDb()
  const rows = await db.select().from(wikiEvaluations)
    .where(eq(wikiEvaluations.blockId, blockId))
    .orderBy(desc(wikiEvaluations.createdAt))
  return rows.map(rowToEvaluation)
}

export async function updateEvaluationStatus(id: string, status: WikiEvaluation['status']): Promise<void> {
  const db = getDb()
  const updates: Record<string, string> = { status, updatedAt: now() }
  if (status === 'resolved') updates.resolvedAt = now()
  await db.update(wikiEvaluations).set(updates).where(eq(wikiEvaluations.id, id))
}

export async function deleteEvaluation(id: string): Promise<void> {
  const db = getDb()
  await db.delete(wikiEvaluations).where(eq(wikiEvaluations.id, id))
}

// ── Plans CRUD ──────────────────────────────────────────────────────────────

export async function createPlan(projectId: string, snapshotId: string, evaluationIds: string[]): Promise<WikiPlan> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  await db.insert(wikiPlans).values({
    id, projectId, snapshotId,
    evaluationIdsJson: JSON.stringify(evaluationIds),
    status: 'draft', createdAt: ts, updatedAt: ts,
  })
  return { id, projectId, snapshotId, evaluationIds, status: 'draft', createdAt: ts, updatedAt: ts, confirmedAt: null }
}

export async function getPlan(id: string): Promise<WikiPlan | null> {
  const db = getDb()
  const rows = await db.select().from(wikiPlans).where(eq(wikiPlans.id, id))
  return rows.length ? rowToPlan(rows[0]) : null
}

export async function getActivePlan(projectId: string): Promise<WikiPlan | null> {
  const db = getDb()
  const rows = await db.select().from(wikiPlans)
    .where(and(eq(wikiPlans.projectId, projectId), eq(wikiPlans.status, 'draft')))
    .orderBy(desc(wikiPlans.createdAt))
    .limit(1)
  return rows.length ? rowToPlan(rows[0]) : null
}

export async function confirmPlan(id: string): Promise<void> {
  const db = getDb()
  await db.update(wikiPlans).set({ status: 'confirmed', confirmedAt: now(), updatedAt: now() }).where(eq(wikiPlans.id, id))
}

// ── Plan Nodes ──────────────────────────────────────────────────────────────

export async function createPlanNode(input: {
  planId: string; projectId: string; title: string; description?: string;
  evaluationIds?: string[]; dependsOn?: string[]; expectedFiles?: string[]; sortOrder?: number;
}): Promise<WikiPlanNode> {
  const db = getDb()
  const id = nanoid()
  const ts = now()
  await db.insert(wikiPlanNodes).values({
    id, planId: input.planId, projectId: input.projectId,
    title: input.title, description: input.description ?? '',
    evaluationIdsJson: JSON.stringify(input.evaluationIds ?? []),
    dependsOnJson: JSON.stringify(input.dependsOn ?? []),
    expectedFilesJson: JSON.stringify(input.expectedFiles ?? []),
    sortOrder: input.sortOrder ?? 0,
    status: 'pending', createdAt: ts, updatedAt: ts,
  })
  return {
    id, planId: input.planId, projectId: input.projectId,
    title: input.title, description: input.description ?? '',
    evaluationIds: input.evaluationIds ?? [], dependsOn: input.dependsOn ?? [],
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
  if (status === 'completed') updates.completedAt = now()
  await db.update(wikiPlanNodes).set(updates).where(eq(wikiPlanNodes.id, id))
}

// ── Row mappers ─────────────────────────────────────────────────────────────

function rowToEvaluation(r: typeof wikiEvaluations.$inferSelect): WikiEvaluation {
  return {
    id: r.id, projectId: r.projectId, blockId: r.blockId,
    content: r.content, status: r.status as WikiEvaluation['status'],
    planNodeId: r.planNodeId ?? null,
    createdAt: r.createdAt, updatedAt: r.updatedAt, resolvedAt: r.resolvedAt ?? null,
  }
}

function rowToPlan(r: typeof wikiPlans.$inferSelect): WikiPlan {
  return {
    id: r.id, projectId: r.projectId, snapshotId: r.snapshotId,
    evaluationIds: JSON.parse(r.evaluationIdsJson),
    status: r.status as WikiPlan['status'],
    createdAt: r.createdAt, updatedAt: r.updatedAt, confirmedAt: r.confirmedAt ?? null,
  }
}

function rowToPlanNode(r: typeof wikiPlanNodes.$inferSelect): WikiPlanNode {
  return {
    id: r.id, planId: r.planId, projectId: r.projectId,
    title: r.title, description: r.description,
    evaluationIds: JSON.parse(r.evaluationIdsJson),
    dependsOn: JSON.parse(r.dependsOnJson),
    expectedFiles: JSON.parse(r.expectedFilesJson),
    status: r.status as WikiPlanNode['status'],
    sortOrder: r.sortOrder, reviewResult: r.reviewResult ?? null,
    createdAt: r.createdAt, updatedAt: r.updatedAt, completedAt: r.completedAt ?? null,
  }
}

