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
export interface BackendDescription {
  id: BackendId;
  label: string;
  kind: 'native' | 'acp' | 'cli';
  experimental?: boolean;
  capabilities: {
    nativeControls: CapabilitySupport;
    resume: CapabilitySupport;
    permissions: CapabilitySupport;
  };
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
    nativeControls: 'supported', resume: 'supported', permissions: 'supported',
  } },
  { id: 'codex', label: 'Codex CLI', kind: 'cli', experimental: true, capabilities: { nativeControls: 'unsupported', resume: 'supported', permissions: 'supported' } },
  { id: 'claude-code', label: 'Claude Code CLI', kind: 'cli', experimental: true, capabilities: { nativeControls: 'unsupported', resume: 'supported', permissions: 'supported' } },
  ...ACP_PROVIDER_IDS.map((id): BackendDescription => ({
    id, label: id, kind: 'acp', capabilities: {
      nativeControls: 'unsupported', resume: 'unverified', permissions: 'supported',
    },
  })),
];
