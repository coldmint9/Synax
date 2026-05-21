import type { CoordForest, CorrectionReason } from './forest.js';
import type { CoordinatesContextIndex } from './context.js';

export type ReviewRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'discarded' | 'applied';
export type ReviewOverallVerdict = 'accepted' | 'rejected' | 'blocked';
export type ActionReviewVerdict = 'accept' | 'reject' | 'blocked';

export interface ReviewAgentLogEntry {
  turn: number;
  tool: string;
  thought?: string;
  args?: Record<string, unknown>;
  resultSummary?: string;
}

export interface GoalReviewRun {
  id: string;
  projectId: string;
  goalId: string;
  status: ReviewRunStatus;
  startedAt: number;
  completedAt?: number;
  summary: string;
  overallVerdict: ReviewOverallVerdict;
}

export interface ActionReviewDecision {
  actionId: string;
  verdict: ActionReviewVerdict;
  confidence: number;
  rationale: string;
  evidenceSummary: string;
  issues: string[];
  suggestions: string[];
  correctionNote?: string;
  correctionReasons?: CorrectionReason[];
  suggestedPrompt?: string;
}

export interface GoalReviewPackage {
  run: GoalReviewRun;
  decisions: ActionReviewDecision[];
  improvementPlan: string[];
  agentLog: ReviewAgentLogEntry[];
  warnings: string[];
}

export interface NodeReviewState {
  latestRunId: string;
  status: ReviewRunStatus;
  verdict?: ReviewOverallVerdict | ActionReviewVerdict;
  confidence?: number;
  summary?: string;
  updatedAt: number;
}

export interface GoalReviewRequest {
  projectId: string;
  goalId: string;
  forest: CoordForest;
  contextIndex?: CoordinatesContextIndex;
  workDir?: string | null;
  locale?: 'zh' | 'en';
}

export type GoalReviewStreamEvent =
  | { type: 'review_started'; payload: { run: GoalReviewRun } }
  | { type: 'review_turn'; payload: ReviewAgentLogEntry }
  | { type: 'review_tool_result'; payload: { turn: number; tool: string; resultSummary: string } }
  | { type: 'review_action_decision'; payload: ActionReviewDecision }
  | { type: 'review_completed'; payload: { package: GoalReviewPackage } }
  | { type: 'review_failed'; payload: { runId?: string; reason: string } };
