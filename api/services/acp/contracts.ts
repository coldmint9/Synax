// ---------------------------------------------------------------------------
// ACP Service Layer — Backend-side type definitions
// Aligned with web/src/lib/agents/contracts.ts
// ---------------------------------------------------------------------------

export type PmVerdict =
  | 'incremental_adjust'
  | 'new_requirement'
  | 'risk_escalation'
  | 'scope_change'
  | 'tech_debt'
  | 'bug_fix'
  | 'knowledge_update'
  | 'team_orchestration'
  | 'forecast_query'
  | 'decision_request'

export type ProviderId = 'opencode-acp' | 'cursor-acp'

export type AgentRunFileChangeType = 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown'
export type AgentRunFileChangeSource = 'git' | 'acp_hint'

export interface AgentRunFileChange {
  path: string
  changeType: AgentRunFileChangeType
  additions?: number
  deletions?: number
  startLine?: number
  endLine?: number
  source: AgentRunFileChangeSource
}

export interface AgentRunChangeSummary {
  added: number
  modified: number
  deleted: number
  files: number
  insertions: number
  deletions: number
}

export type CoordinatesRunEventType =
  | 'run_started'
  | 'intent_interpreted'
  | 'cluster_status'
  | 'node_created'
  | 'node_updated'
  | 'edge_created'
  | 'agent_message'
  | 'artifact_proposed'
  | 'artifact_applied'
  | 'run_blocked'
  | 'run_completed'
  | 'run_failed'

export interface CoordinatesRunEvent {
  type: CoordinatesRunEventType
  ts: number
  runId: string
  clusterId: string
  intent: string
  payload?: {
    provider?: string
    providerId?: ProviderId
    message?: string
    reason?: string
    classification?: {
      verdicts: PmVerdict[]
      primaryVerdict: PmVerdict
      confidence?: number
      rationale?: string
    }
    clusterStatus?: 'decomposing' | 'classifying' | 'planning' | 'executing' | 'completed' | 'failed'
    node?: {
      id: string
      title: string
      layer: 'origin' | 'verdict' | 'artifact_op' | 'execution'
      status?: 'pending' | 'running' | 'done' | 'failed'
      summary?: string
    }
    edge?: {
      id: string
      sourceNodeId: string
      targetNodeId: string
      edgeType?: string
      status?: string
      strength?: number
    }
    layer?: 'origin' | 'verdict' | 'artifact_op' | 'execution'
    fileChanges?: AgentRunFileChange[]
    changeSummary?: AgentRunChangeSummary
    contextSnapshotId?: string
    contextBlockIds?: string[]
    /** v3: 从 agent 工具调用里提取的文件/符号引用，供 forest.links upsert。 */
    sourceLinkHints?: Array<{
      nodeId?: string
      path?: string
      startLine?: number
      endLine?: number
      symbol?: string
      confidence?: number
      createdBy?: 'agent' | 'analyzer' | 'human'
    }>
  }
}

export interface DispatchIntentInput {
  projectId: string
  sessionId?: string | null
  userId: string
  userName: string
  intent: string
  providerId: ProviderId
  context?: {
    selectedNodeId?: string | null
    selectedClusterId?: string | null
    workDir?: string | null
    contextSnapshotId?: string | null
    contextPrompt?: string | null
  }
}

/** Backend version — events is a plain array (not AsyncIterable) */
export interface DispatchIntentResult {
  runId: string
  provider: string
  events: CoordinatesRunEvent[]
}

export interface AcpClient {
  dispatch(input: DispatchIntentInput): Promise<DispatchIntentResult>
  dispatchStream(input: DispatchIntentInput): AsyncGenerator<CoordinatesRunEvent>
}
