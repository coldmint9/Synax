import { z } from 'zod/v4';
import { ACP_PROVIDER_IDS } from '../../../lib/config/acp-provider-ids.js';
import type { AgentRunStreamChunk, StreamTurnRequest } from '../contracts.js';
import type { AgentSessionStreamMode } from '../../../lib/ipc/agent-session-protocol.js';

export const backendIdSchema = z.enum(['native', 'codex', 'claude-code', ...ACP_PROVIDER_IDS]);
export type BackendId = z.infer<typeof backendIdSchema>;
export const backendBindingSchema = z.object({
  version: z.literal(1),
  id: backendIdSchema,
  model: z.string().nullable(),
  workDir: z.string().nullable(),
});
export type BackendBinding = z.infer<typeof backendBindingSchema>;
export type CapabilitySupport = 'supported' | 'unsupported' | 'unverified';
export interface BackendCapabilities {
  /** Synax-native plan/goal controls, not the backend's own prompt semantics. */
  nativeControls: CapabilitySupport;
  resume: CapabilitySupport;
  permissions: CapabilitySupport;
  interactions: CapabilitySupport;
  pause: CapabilitySupport;
  cancel: CapabilitySupport;
  chat: CapabilitySupport;
  plan: CapabilitySupport;
  goal: CapabilitySupport;
  nativeSessionResume: CapabilitySupport;
  jsonlEvents: CapabilitySupport;
}
export interface BackendDescription {
  id: BackendId;
  label: string;
  kind: 'native' | 'acp' | 'cli';
  experimental?: boolean;
  capabilities: BackendCapabilities;
}
export interface BackendAdapter {
  stream(sessionId: string, mode: AgentSessionStreamMode, input: StreamTurnRequest, signal?: AbortSignal): AsyncGenerator<AgentRunStreamChunk>;
  interrupt(sessionId: string, reason: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  hasPendingPermission?(sessionId: string, permissionId: string): boolean;
  replyPermission?(sessionId: string, permissionId: string, reply: import('../contracts.js').PermissionReply): boolean;
  hasPendingInteraction?(sessionId: string, interactionId: string): boolean;
  replyInteraction?(sessionId: string, interactionId: string): boolean;
  models?(): Promise<{ models: Array<{ id: string; label: string; efforts?: string[] }>; defaultModel?: string | null }>;

}
export const BACKENDS: readonly BackendDescription[] = [
  { id: 'native', label: 'Synax Native', kind: 'native', capabilities: {
    nativeControls: 'supported', resume: 'supported', permissions: 'supported', interactions: 'supported',
    pause: 'supported', cancel: 'supported', chat: 'supported', plan: 'supported', goal: 'supported',
    nativeSessionResume: 'supported', jsonlEvents: 'supported',
  } },
  { id: 'codex', label: 'Codex CLI', kind: 'cli', experimental: true, capabilities: {
    nativeControls: 'unsupported', resume: 'supported', permissions: 'supported', interactions: 'supported',
    pause: 'supported', cancel: 'supported', chat: 'supported', plan: 'unsupported', goal: 'unsupported',
    nativeSessionResume: 'supported', jsonlEvents: 'supported',
  } },
  { id: 'claude-code', label: 'Claude Code CLI', kind: 'cli', experimental: true, capabilities: {
    nativeControls: 'unsupported', resume: 'supported', permissions: 'supported', interactions: 'supported',
    pause: 'supported', cancel: 'supported', chat: 'supported', plan: 'unsupported', goal: 'unsupported',
    nativeSessionResume: 'supported', jsonlEvents: 'supported',
  } },
  ...ACP_PROVIDER_IDS.map((id): BackendDescription => ({
    id, label: id, kind: 'acp', capabilities: {
      nativeControls: 'unsupported', resume: 'unverified', permissions: 'supported', interactions: 'unverified',
      pause: 'unverified', cancel: 'supported', chat: 'supported', plan: 'unsupported', goal: 'unsupported',
      nativeSessionResume: 'unverified', jsonlEvents: 'supported',
    },
  })),
];
