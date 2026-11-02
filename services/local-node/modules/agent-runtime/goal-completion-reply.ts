import { agentRuntimeStore as store } from "./session-store.js";
import { getGoalState } from "./goal-control.js";
import { buildGoalCompletionReport } from "./goal-completion-report.js";
import {
  persistedVisualizationAppendix,
  withoutVisualizationDeclarations,
  type InlineVisualizationMetadata,
} from "./visualization-integration.js";
import { usesGoalWorkflow } from "./workflow-mode.js";
import { workStore, type WorkEvidence } from "./work-store.js";

/** The reply a user reads once the runtime accepts a root goal. */
export interface AcceptedGoalReply {
  content: string;
  /** The accepted conclusion alone, for session previews and notifications. */
  conclusion: string;
  /** Identity of the accepted Work checkpoint the report was projected from. */
  workId: string | null;
  evidence: WorkEvidence[];
  visualizations: InlineVisualizationMetadata[];
}

/** What the native loop publishes once the run settles. */
export interface FinishedRunReply {
  content: string;
  /** The session preview. A report is too long to be one. */
  resultSummary: string;
  metadata: Record<string, unknown>;
}

export interface FinishedRunInput {
  sessionId: string;
  /** Terminal status the loop decided, not the model's claim. */
  status: string;
  /** The loop's own disposition summary. */
  summary?: string | null;
  /** The final text the model produced in this turn. */
  text: string;
}

/**
 * The reply a finished run publishes.
 *
 * An accepted goal answers with its acceptance report; every other outcome
 * keeps the loop's disposition, which is the only fact it owns.
 */
export function finishedRunReply(input: FinishedRunInput): FinishedRunReply {
  const accepted = input.status === "completed" ? acceptedGoalReply(input.sessionId) : null;
  const content = accepted?.content ?? (input.summary || input.text);
  if (!accepted) return { content, resultSummary: content, metadata: {} };
  return {
    content,
    resultSummary: accepted.conclusion || content,
    metadata: {
      purpose: "work_result",
      goalStatus: "completed",
      acceptanceEvidence: accepted.evidence,
      ...(accepted.workId ? { goalFinalWorkId: accepted.workId } : {}),
      ...(accepted.visualizations.length ? { visualizations: accepted.visualizations } : {}),
    },
  };
}

/**
 * Project an accepted goal into its final reply.
 *
 * The native loop only knows the goal's stop state, so ending the run there
 * would leave the user with a one-line disposition instead of the acceptance
 * report. Everything the report asserts is already persisted — the goal's
 * acceptance evidence plus the Work checkpoint's objective, changed paths and
 * verification receipts — so the reply is projected from those facts, never
 * from model text that was not accepted.
 */
export function acceptedGoalReply(sessionId: string): AcceptedGoalReply | null {
  const session = store.getSession(sessionId);
  const goal = getGoalState(session.sessionMetadata);
  if (!goal || goal.status !== "completed" || !usesGoalWorkflow(session)) return null;
  const work = workStore.current(sessionId);
  const plan = session.sessionMetadata?.plan as { acceptanceCriteria?: string[] } | undefined;
  const evidence = goal.acceptanceEvidence ?? work?.evidence ?? [];
  const accepted = work?.result ?? goal.reason ?? "";
  const runIds = new Set(
    store
      .listRuns(sessionId)
      .filter(run => (work ? run.metadata.workId === work.id : run.id === session.activeRunId))
      .map(run => run.id),
  );
  // An accepted preview rides after the report; its declaration text would
  // otherwise interrupt the human-facing acceptance facts.
  const appendix = persistedVisualizationAppendix(store.listMessages(sessionId), runIds, {
    sessionId,
    content: accepted,
    id: `goal-source:${work?.id ?? sessionId}`,
  });
  const conclusion = withoutVisualizationDeclarations(accepted);
  const report = buildGoalCompletionReport({
    conclusion,
    objective: work?.objective ?? goal.objective,
    criteria: work?.acceptanceCriteria?.length ? work.acceptanceCriteria : plan?.acceptanceCriteria,
    evidence,
    changedPaths: work?.changedPaths,
    verifications: work?.verifications,
    remaining: work?.remaining,
  });
  return {
    content: `${report}${appendix.content}`,
    conclusion: conclusion || goal.reason || "",
    workId: work?.id ?? null,
    evidence,
    visualizations: appendix.visualizations.map(item => ({
      ...item,
      start: item.start + report.length,
      end: item.end + report.length,
    })),
  };
}
