import { getRawSqlite } from '../../infrastructure/database/index.js';
import { agentPlanSchema, type AgentPlan } from './control-contracts.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { agentRuntimeStore as sessionStore } from './session-store.js';

export const PLAN_ARTIFACT_STATUSES = ['draft', 'saved', 'approved', 'superseded'] as const;
export type PlanArtifactStatus = (typeof PLAN_ARTIFACT_STATUSES)[number];

export interface PlanArtifact extends AgentPlan {
  id: string;
  sessionId: string;
  projectId: string;
  revision: number;
  status: PlanArtifactStatus;
  executionId?: string;
  approvedRunId?: string;
  approvedStepIndex?: number;
  approvedByMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

type PlanRow = {
  id: string;
  session_id: string;
  project_id: string;
  revision: number;
  status: string;
  title: string;
  objective: string;
  steps_json: string;
  acceptance_criteria_json: string;
  human_acceptance_criteria_json: string;
  assumptions_json: string;
  risks_json: string;
  execution_id: string | null;
  approved_run_id: string | null;
  approved_step_index: number | null;
  approved_by_message_id: string | null;
  created_at: string;
  updated_at: string;
};

function json<T>(value: T): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: PlanRow): PlanArtifact | null {
  if (!PLAN_ARTIFACT_STATUSES.includes(row.status as PlanArtifactStatus)) return null;
  const plan = agentPlanSchema.safeParse({
    title: row.title,
    objective: row.objective,
    steps: parseJson(row.steps_json, []),
    acceptanceCriteria: parseJson(row.acceptance_criteria_json, []),
    humanAcceptanceCriteria: parseJson(row.human_acceptance_criteria_json, []),
    assumptions: parseJson(row.assumptions_json, []),
    risks: parseJson(row.risks_json, []),
  });
  if (!plan.success) return null;
  return {
    ...plan.data,
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    revision: row.revision,
    status: row.status as PlanArtifactStatus,
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.approved_run_id ? { approvedRunId: row.approved_run_id } : {}),
    ...(row.approved_step_index !== null ? { approvedStepIndex: row.approved_step_index } : {}),
    ...(row.approved_by_message_id ? { approvedByMessageId: row.approved_by_message_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function legacyPlanArtifact(sessionId: string): PlanArtifact | null {
  const session = sessionStore.getSession(sessionId);
  const raw = session.sessionMetadata?.plan;
  const parsed = agentPlanSchema.safeParse(raw);
  if (!parsed.success || !raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.revision !== 'number' || !Number.isInteger(record.revision) || record.revision < 1) return null;
  if (!PLAN_ARTIFACT_STATUSES.includes(String(record.status) as PlanArtifactStatus)) return null;
  return {
    ...parsed.data,
    id: `legacy-plan-${sessionId}-${record.revision}`,
    sessionId,
    projectId: session.projectId,
    revision: record.revision,
    status: record.status as PlanArtifactStatus,
    ...(typeof record.executionId === 'string' ? { executionId: record.executionId } : {}),
    ...(typeof record.approvedRunId === 'string' ? { approvedRunId: record.approvedRunId } : {}),
    ...(typeof record.approvedStepIndex === 'number' ? { approvedStepIndex: record.approvedStepIndex } : {}),
    ...(typeof record.approvedByMessageId === 'string' ? { approvedByMessageId: record.approvedByMessageId } : {}),
    createdAt: '',
    updatedAt: '',
  };
}

function nextRevision(sessionId: string): number {
  const row = getRawSqlite()
    .prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM agent_plan_artifacts WHERE session_id = ?')
    .get(sessionId) as { revision?: number } | undefined;
  const legacy = sessionStore.getSession(sessionId).sessionMetadata?.plan as { revision?: unknown } | undefined;
  const legacyRevision = typeof legacy?.revision === 'number' && Number.isInteger(legacy.revision)
    ? legacy.revision
    : 0;
  return Math.max(row?.revision ?? 0, legacyRevision) + 1;
}

export function createPlanArtifact(input: {
  sessionId: string;
  plan: AgentPlan;
  status?: PlanArtifactStatus;
}): PlanArtifact {
  const session = sessionStore.getSession(input.sessionId);
  const revision = nextRevision(input.sessionId);
  const id = makeRuntimeId('plan');
  const now = nowIso();
  const status = input.status ?? 'draft';
  getRawSqlite().prepare(`
    INSERT INTO agent_plan_artifacts (
      id, session_id, project_id, revision, status, title, objective,
      steps_json, acceptance_criteria_json, human_acceptance_criteria_json,
      assumptions_json, risks_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, input.sessionId, session.projectId, revision, status, input.plan.title,
    input.plan.objective, json(input.plan.steps), json(input.plan.acceptanceCriteria),
    json(input.plan.humanAcceptanceCriteria ?? []), json(input.plan.assumptions),
    json(input.plan.risks), now, now,
  );
  return getPlanArtifact(input.sessionId, revision)!;
}

export function getPlanArtifact(sessionId: string, revision?: number): PlanArtifact | null {
  const row = (revision === undefined
    ? getRawSqlite().prepare("SELECT * FROM agent_plan_artifacts WHERE session_id = ? AND status != 'superseded' ORDER BY revision DESC LIMIT 1").get(sessionId)
    : getRawSqlite().prepare('SELECT * FROM agent_plan_artifacts WHERE session_id = ? AND revision = ?').get(sessionId, revision)) as PlanRow | undefined;
  if (row) return mapRow(row);
  const legacy = legacyPlanArtifact(sessionId);
  return revision === undefined || legacy?.revision === revision ? legacy : null;
}

export function listPlanArtifacts(sessionId: string): PlanArtifact[] {
  const items = (getRawSqlite().prepare('SELECT * FROM agent_plan_artifacts WHERE session_id = ? ORDER BY revision DESC').all(sessionId) as PlanRow[])
    .map(mapRow).filter((item): item is PlanArtifact => item !== null);
  if (items.length) return items;
  const legacy = legacyPlanArtifact(sessionId);
  return legacy ? [legacy] : [];
}

export function updatePlanArtifact(
  sessionId: string,
  revision: number,
  patch: Partial<Pick<PlanArtifact, 'status' | 'executionId' | 'approvedRunId' | 'approvedStepIndex' | 'approvedByMessageId'>>,
): PlanArtifact {
  const current = getPlanArtifact(sessionId, revision);
  if (!current) throw new Error(`Plan revision ${revision} was not found.`);
  const next = { ...current, ...patch, updatedAt: nowIso() };
  getRawSqlite().prepare(`
    UPDATE agent_plan_artifacts SET status = ?, execution_id = ?, approved_run_id = ?,
      approved_step_index = ?, approved_by_message_id = ?, updated_at = ?
    WHERE session_id = ? AND revision = ?
  `).run(
    next.status, next.executionId ?? null, next.approvedRunId ?? null,
    next.approvedStepIndex ?? null, next.approvedByMessageId ?? null,
    next.updatedAt, sessionId, revision,
  );
  return getPlanArtifact(sessionId, revision)!;
}

/** Create a new draft revision from an older report; old revisions remain immutable. */
export function restorePlanArtifact(sessionId: string, revision: number): PlanArtifact {
  const source = getPlanArtifact(sessionId, revision);
  if (!source) throw new Error(`Plan revision ${revision} was not found.`);
  return createPlanArtifact({
    sessionId,
    plan: source,
    status: 'draft',
  });
}
