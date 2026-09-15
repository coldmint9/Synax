import type { RuntimeAsset, InputCapabilities, InputModality } from './content-parts.js';
import type {
  AgentRun,
  AgentRunStep,
  AgentRunStreamChunk,
  AgentSession,
  CreateSessionRequest,
  PermissionDecision,
  PermissionReply,
  StreamTurnRequest,
  AgentRuntimeMessage,
} from './contracts.js';
import type { BackendDescription } from './backends/backend-contracts.js';

/** Stable wire identifier for clients that are not coupled to Synax internals. */
export const RUNTIME_PROTOCOL_VERSION = 'synax.runtime.v1' as const;

/** Small, checked-in JSON Schema fragment for non-TypeScript clients. */
export const RUNTIME_PROTOCOL_SCHEMA = {
  $id: RUNTIME_PROTOCOL_VERSION,
  type: 'object',
  definitions: {
    contentPart: { oneOf: [{ type:'object',required:['type','text'],properties:{type:{const:'text'},text:{type:'string'}} },{type:'object',required:['type','assetId'],properties:{type:{enum:['image','audio','video','file']},assetId:{type:'string',pattern:'^asset_[a-f0-9]{32}$'}}}] },
    event: {
      type: 'object',
      required: ['protocol', 'sequence', 'sessionId', 'runId', 'type', 'payload'],
      properties: {
        protocol: { const: RUNTIME_PROTOCOL_VERSION },
        sequence: { type: 'integer', minimum: 1 },
        sessionId: { type: 'string', minLength: 1 },
        runId: { type: 'string', minLength: 1 },
        type: { type: 'string', minLength: 1 },
        payload: { type: 'object', additionalProperties: true },
      },
      additionalProperties: false,
    },
    error: {
      type: 'object',
      required: ['error'],
      properties: { error: { type: 'string' }, code: { type: 'string' }, details: {} },
      additionalProperties: true,
    },
  },
} as const;

export type RuntimeRunStatus = AgentRun['status'];
export type RuntimeSessionStatus = AgentSession['status'];

export interface RuntimeErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}

export interface RuntimeEventEnvelope<T = AgentRunStreamChunk | { type: string; [key: string]: unknown }> {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  sequence: number;
  sessionId: string;
  runId: string;
  type: string;
  payload: T;
}

export interface RuntimeTerminalResult {
  protocol: typeof RUNTIME_PROTOCOL_VERSION;
  sessionId: string;
  runId: string;
  status: RuntimeRunStatus;
  run: AgentRun;
  exitCode: 0 | 1 | 2 | 4 | 5;
  text?: string;
  permissions?: PermissionDecision[];
  interactions?: RuntimeInteraction[];
  runtimeControl?: unknown;
}

export interface RuntimeBackendDescriptor extends BackendDescription {
  models?: Array<{ id: string; label: string; efforts?: string[]; inputModalities?: InputModality[] }>;
  defaultModel?: string | null;
}

export interface RuntimeSessionPayload {
  session: AgentSession;
  profile: unknown;
  work: unknown;
  context: unknown;
}

export interface RuntimeSessionListResponse {
  items: AgentSession[];
  totalCount: number;
  countByStatus: Record<string, number>;
}

export interface RuntimeRunStepListResponse {
  items: AgentRunStep[];
}

export interface RuntimePermissionListResponse {
  items: PermissionDecision[];
}

export interface RuntimeInteraction {
  id: string;
  sessionId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  kind: 'clarification' | 'plan_approval';
  revision: number;
  status: 'pending' | 'answered' | 'declined' | 'cancelled';
  request: Record<string, unknown>;
  response: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RuntimeInteractionReply {
  revision: number;
  action: 'submit' | 'decline' | 'cancel' | 'save' | 'revise' | 'execute';
  answers?: Record<string, string | string[] | number | boolean>;
  message?: string;
}

export interface RuntimeClientOptions {
  baseUrl?: string;
  token?: string;
  tokenFile?: string;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  transport?: RuntimeTransport;
}

export interface RuntimeTransport {
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface SubmitRunOptions {
  requestId: string;
  mode?: 'turn' | 'continue';
}

export interface ObserveRunOptions {
  after?: number;
  signal?: AbortSignal;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
}

export interface RuntimeClient {
  uploadAsset(projectId: string, file: File, signal?: AbortSignal): Promise<{asset: RuntimeAsset}>;
  getAsset(id: string): Promise<{asset: RuntimeAsset}>;
  deleteAsset(id: string): Promise<{deleted: boolean}>;
  downloadAsset(id: string, signal?: AbortSignal): Promise<Blob>;
  getInputCapabilities(sessionId: string, model?: string): Promise<InputCapabilities>;
  getProtocol(): Promise<{ protocol: string; schema?: unknown; transports?: string[]; operations?: string[] }>;
  listBackends(): Promise<{ items: RuntimeBackendDescriptor[] }>;
  listBackendModels(id: string): Promise<{ models: Array<{ id: string; label: string; efforts?: string[]; inputModalities?: InputModality[] }>; defaultModel?: string | null }>;
  listProjects(): Promise<{ items: Array<{ id: string; name: string; source?: { localPath?: string; kind?: string } }> }>;
  createProject(body: { name: string; environment?: 'production' | 'staging' | 'development'; source: { kind: 'localPath'; localPath: string } }): Promise<{ project: { id: string; name: string; source?: { localPath?: string; kind?: string } } }>;
  listSessions(query?: Record<string, string | number | undefined>): Promise<RuntimeSessionListResponse>;
  listRuns(sessionId: string): Promise<{ items: AgentRun[] }>;
  listMessages(sessionId: string): Promise<{ items: AgentRuntimeMessage[] }>;
  getSessionCapabilities(sessionId: string): Promise<{ backend?: RuntimeBackendDescriptor }>;
  createSession(body: CreateSessionRequest): Promise<RuntimeSessionPayload>;
  getSession(sessionId: string): Promise<RuntimeSessionPayload>;
  submitRun(sessionId: string, input: StreamTurnRequest, options: SubmitRunOptions): Promise<{ run: AgentRun; reused: boolean }>;
  observeRun(sessionId: string, runId: string, options?: ObserveRunOptions): AsyncGenerator<RuntimeEventEnvelope>;
  getRun(sessionId: string, runId: string): Promise<AgentRun>;
  listRunSteps(sessionId: string, runId: string): Promise<RuntimeRunStepListResponse>;
  listPermissions(sessionId: string): Promise<RuntimePermissionListResponse>;
  replyPermission(sessionId: string, permissionId: string, reply: PermissionReply, message?: string): Promise<PermissionDecision>;
  listInteractions(sessionId: string): Promise<{ interactions: RuntimeInteraction[] }>;
  replyInteraction(sessionId: string, interactionId: string, reply: RuntimeInteractionReply): Promise<{ interaction: RuntimeInteraction }>;
  cancelSession(sessionId: string, runId?: string): Promise<AgentSession>;
  pauseSession(sessionId: string, runId?: string): Promise<AgentSession>;
  continueSession(sessionId: string, input: StreamTurnRequest, options: SubmitRunOptions): Promise<{ run: AgentRun; reused: boolean }>;
  health(): Promise<unknown>;
}

export function exitCodeForRun(status: RuntimeRunStatus, runtimeControl?: unknown): 0 | 1 | 2 | 4 | 5 {
  if (runtimeControl) return 5;
  if (status === 'completed') return 0;
  if (status === 'cancelled' || status === 'interrupted') return 2;
  if (['waiting_permission', 'waiting_input', 'blocked'].includes(status)) return 4;
  return status === 'failed' ? 1 : 5;
}

export function exitCodeForError(error: unknown): 1 | 3 | 5 {
  if (!(error instanceof Error)) return 1;
  const item = error as Error & { status?: number; code?: string };
  if (item.code === 'PROTOCOL_ERROR' || item.code === 'RECOVERY_REQUIRED' || item.code === 'STOP_UNCONFIRMED') return 5;
  if (item.status !== undefined) return item.status >= 500 ? 5 : item.status < 500 ? 3 : 1;
  return 3;
}
