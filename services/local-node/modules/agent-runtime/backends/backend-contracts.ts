import { z } from "zod/v4";
import type { AgentRunStreamChunk, StreamTurnRequest } from "../contracts.js";
import type { AgentSessionStreamMode } from "../../../infrastructure/runtime/ipc/agent-session-protocol.js";

const workspaceLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host"), path: z.string() }),
  z.object({
    kind: z.literal("wsl"),
    distribution: z.string(),
    path: z.string(),
  }),
]);
/** Active execution engines. External CLI/ACP engines are retired. */
export const backendIdSchema = z.literal("native");
export type BackendId = z.infer<typeof backendIdSchema>;
export const backendBindingSchema = z.object({
  version: z.literal(1),
  /** History can name a retired engine; execution must validate backendIdSchema. */
  id: z.string().min(1),
  model: z.string().nullable(),
  workDir: z.string().nullable(),
  workspaceLocation: workspaceLocationSchema.optional(),
  /** Explicit checkout overrides keyed by stable workspace member id. */
  rootWorktrees: z.record(z.string(), workspaceLocationSchema).optional(),
  /** User choices stay visible when the agent selects a different checkout. */
  userWorktrees: z.record(z.string(), workspaceLocationSchema).optional(),
  /** Workspace member used as the default cwd by native tools. */
  executionRootId: z.string().optional(),
  workspaceBindingRevision: z.number().int().nonnegative().optional(),
  workspaceRoots: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        path: z.string(),
        role: z.enum(["primary", "reference"]),
        status: z.enum(["available", "missing"]),
        location: workspaceLocationSchema.optional(),
      }),
    )
    .optional(),
});
export type BackendBinding = z.infer<typeof backendBindingSchema>;
export type CapabilitySupport = "supported" | "unsupported" | "unverified";
export interface BackendCapabilities {
  /** Synax-native plan/goal controls, not the backend's own prompt semantics. */
  nativeControls: CapabilitySupport;
  resume: CapabilitySupport;
  permissions: CapabilitySupport;
  interactions: CapabilitySupport;
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
  kind: "native";
  experimental?: boolean;
  capabilities: BackendCapabilities;
}
export interface BackendAdapter {
  stream(
    sessionId: string,
    mode: AgentSessionStreamMode,
    input: StreamTurnRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentRunStreamChunk>;
  interrupt(sessionId: string, reason: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
export const BACKENDS: readonly BackendDescription[] = [
  {
    id: "native",
    label: "Synax",
    kind: "native",
    capabilities: {
      nativeControls: "supported",
      resume: "supported",
      permissions: "supported",
      interactions: "supported",
      cancel: "supported",
      chat: "supported",
      plan: "supported",
      goal: "supported",
      nativeSessionResume: "supported",
      jsonlEvents: "supported",
    },
  },
];
