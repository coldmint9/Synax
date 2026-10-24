/** Browser-safe wire contract. The usage field is type-only and serialized as
 * part of the completion event for the composer ring. */
export interface CompactionContextUsageSnapshot {
  version: 1;
  stepId: string;
  total: number;
  limit: number | null;
  composition: {
    version?: 2;
    tools: number;
    mcp: number;
    skills: number;
    messages: number;
    system?: number;
    total: number;
    measuredAt: string;
  };
  measuredAt: string;
}

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
  /** The post-compaction request-context snapshot for the composer ring. */
  contextUsage?: CompactionContextUsageSnapshot;
}
