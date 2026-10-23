/** Browser-safe wire contract. Keep persistence and runtime imports out of this module. */
export interface ContextCompactionState {
  id: string;
  runId?: string;
  stepId?: string;
  checkpointId?: string;
  throughStepId?: string;
  throughRevision?: number;
  boundaryAt?: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  requestId: string | null;
  originalTokens?: number;
  compressedTokens?: number;
  messageCount?: number;
  compacted?: boolean;
  error?: string;
}
