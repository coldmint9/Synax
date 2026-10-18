import { agentPlanSchema, type AgentPlan } from "./control-contracts.js";
import { makeRuntimeId, nowIso } from "./runtime-ids.js";
import { agentRuntimeStore } from "./session-store.js";

export const PLAN_ARTIFACT_STATUSES = [
  "draft",
  "saved",
  "approved",
  "superseded",
] as const;
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

export function listPlanArtifacts(sessionId: string): PlanArtifact[] {
  return agentRuntimeStore
    .listRecords<PlanArtifact>("plan", sessionId)
    .sort((a, b) => b.revision - a.revision);
}
export function getPlanArtifact(
  sessionId: string,
  revision?: number,
): PlanArtifact | null {
  return (
    listPlanArtifacts(sessionId).find((plan) =>
      revision === undefined
        ? plan.status !== "superseded"
        : plan.revision === revision,
    ) ?? null
  );
}
export function createPlanArtifact(input: {
  sessionId: string;
  plan: AgentPlan;
  status?: PlanArtifactStatus;
}): PlanArtifact {
  const session = agentRuntimeStore.getSession(input.sessionId),
    now = nowIso();
  const plan: PlanArtifact = {
    ...agentPlanSchema.parse(input.plan),
    id: makeRuntimeId("plan"),
    sessionId: input.sessionId,
    projectId: session.projectId,
    revision: (listPlanArtifacts(input.sessionId)[0]?.revision ?? 0) + 1,
    status: input.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  };
  return agentRuntimeStore.saveRecord("plan", plan);
}
export function updatePlanArtifact(
  sessionId: string,
  revision: number,
  patch: Partial<
    Pick<
      PlanArtifact,
      | "status"
      | "executionId"
      | "approvedRunId"
      | "approvedStepIndex"
      | "approvedByMessageId"
    >
  >,
): PlanArtifact {
  const current = getPlanArtifact(sessionId, revision);
  if (!current) throw new Error(`Plan revision ${revision} was not found.`);
  return agentRuntimeStore.saveRecord("plan", {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}
export function restorePlanArtifact(
  sessionId: string,
  revision: number,
): PlanArtifact {
  const plan = getPlanArtifact(sessionId, revision);
  if (!plan) throw new Error(`Plan revision ${revision} was not found.`);
  return createPlanArtifact({ sessionId, plan, status: "draft" });
}
