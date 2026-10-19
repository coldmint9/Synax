export type AgentRunFileChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
export type AgentRunFileChangeSource = 'git' | 'runtime_hint';
export interface AgentRunFileChange {
  path: string;
  changeType: AgentRunFileChangeType;
  additions?: number;
  deletions?: number;
  startLine?: number;
  endLine?: number;
  source: AgentRunFileChangeSource;
}
export interface AgentRunChangeSummary {
  added: number;
  modified: number;
  deleted: number;
  files: number;
  insertions: number;
  deletions: number;
}
export type CoordinatesRunEventType = 'run_started' | 'intent_interpreted' | 'cluster_status' | 'node_created' | 'node_updated' | 'edge_created' | 'agent_message' | 'artifact_proposed' | 'artifact_applied' | 'run_blocked' | 'run_completed' | 'run_failed';
export interface CoordinatesRunEvent {
  type: CoordinatesRunEventType;
  ts: number;
  runId: string;
  clusterId: string;
  intent: string;
  payload?: Record<string, unknown> & { fileChanges?: AgentRunFileChange[]; changeSummary?: AgentRunChangeSummary };
}
