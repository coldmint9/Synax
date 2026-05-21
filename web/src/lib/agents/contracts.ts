import type { PmVerdict } from '../pm-taxonomy'

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

export type AgentProviderStatus = 'live' | 'experimental'

export interface AgentProvider {
  id: ProviderId
  label: string
  status: AgentProviderStatus
  caps: { canFollowUp: boolean; canCancel: boolean }
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

export interface DispatchIntentResult {
  runId: string
  provider: string
  events: AsyncIterable<CoordinatesRunEvent>
}

export interface CursorAgentAdapter {
  providerId: ProviderId
  dispatchIntent(input: DispatchIntentInput): Promise<DispatchIntentResult>
}

export function resolveProviderId(raw?: string | null, explicit?: ProviderId): ProviderId {
  if (explicit) return explicit
  if (raw === 'cursor-acp' || raw === 'opencode-acp') return raw
  return 'opencode-acp'
}
