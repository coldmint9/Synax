import * as z from "zod/v4";
import type { RegisteredTool } from "./contracts.js";
import {
  DESIGN_STATUSES,
  readDesign,
  transitionDesign,
  writeDesign,
  type DesignStatus,
} from "./design-service.js";
import {
  assertUserInstructionTurn,
  getUserInstructionText,
} from "./plan-execution.js";
import { agentRuntimeStore as store } from "./session-store.js";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";

const status = z.enum(DESIGN_STATUSES);
const revision = z.number().int().nonnegative().optional();

function snapshotResult(snapshot: ReturnType<typeof readDesign>) {
  return {
    result: snapshot,
    displaySummary: `${snapshot.relativePath} revision ${snapshot.revision} (${snapshot.status}).`,
    artifacts: [
      {
        kind: "decision" as const,
        title: "Design draft",
        summary: `${snapshot.status} design draft revision ${snapshot.revision}.`,
        risk: "low" as const,
      },
    ],
  };
}

export const designReadTool: RegisteredTool = {
  id: "design.read",
  label: "Read design draft",
  description:
    "Read the current session design draft from the project .synax workspace. Returns an empty draft when none exists.",
  category: "read",
  internalGate: "none",
  mutability: "read",
  resumeBehavior: "auto",
  inputSchema: z.object({}).strict(),
  execute(input) {
    return snapshotResult(readDesign(input.sessionId));
  },
};

export const designPreviewTool: RegisteredTool = {
  id: "design.preview",
  label: "Preview design draft",
  description:
    "Return the current Markdown design draft and metadata for rendering in the session UI.",
  category: "read",
  internalGate: "none",
  mutability: "read",
  resumeBehavior: "auto",
  inputSchema: z.object({}).strict(),
  execute(input) {
    return snapshotResult(readDesign(input.sessionId));
  },
};

export const designWriteTool: RegisteredTool = {
  id: "design.write",
  label: "Save design draft",
  description:
    "Save the complete Markdown design draft to the current session's .synax workspace. Use expectedRevision when revising an existing draft.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: z
    .object({
      content: z.string().min(1),
      expectedRevision: revision,
      status: status.optional(),
    })
    .strict(),
  execute(input) {
    const args = input.args as {
      content: string;
      expectedRevision?: number;
      status?: DesignStatus;
    };
    return snapshotResult(
      writeDesign(input.sessionId, args.content, args.expectedRevision, args.status),
    );
  },
};

export const designTransitionTool: RegisteredTool = {
  id: "design.transition",
  label: "Update design status",
  description:
    "Update the design draft lifecycle label. Status is informational and may be skipped or moved backwards.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: z
    .object({ status, reason: z.string().trim().min(1).max(4000).optional() })
    .strict(),
  execute(input) {
    const args = input.args as { status: DesignStatus; reason?: string };
    const snapshot = transitionDesign(input.sessionId, args.status);
    return {
      ...snapshotResult(snapshot),
      result: { ...snapshot, reason: args.reason ?? null },
    };
  },
};

export const designImplementTool: RegisteredTool = {
  id: "design.implement",
  label: "Implement design draft",
  description:
    "Use the current Markdown design draft as context for ordinary workspace execution. Requires an explicit user instruction and works in Plan, Chat, or Goal mode.",
  category: "task",
  internalGate: "none",
  mutability: "task",
  resumeBehavior: "auto",
  inputSchema: z
    .object({ revision, reason: z.string().trim().min(1).max(4000).optional() })
    .strict(),
  execute(input) {
    if (!input.runId)
      throw new AgentValidationError("Design implementation requires an active run.");
    assertUserInstructionTurn({
      sessionId: input.sessionId,
      runId: input.runId,
      action: "Design implementation",
    });
    const snapshot = readDesign(input.sessionId);
    if (!snapshot.content.trim())
      throw new AgentValidationError("No saved design draft is available to implement.");
    const args = input.args as { revision?: number; reason?: string };
    if (args.revision !== undefined && args.revision !== snapshot.revision)
      throw new AgentRuntimeError(
        `The design revision changed (expected ${args.revision}, current ${snapshot.revision}).`,
        "DESIGN_REVISION_CONFLICT",
        409,
      );
    const implementing = transitionDesign(input.sessionId, "implementing");
    const session = store.getSession(input.sessionId);
    store.updateSessionMetadata(input.sessionId, { mode: "chat" });
    return {
      result: {
        ...implementing,
        implementationReason: args.reason ?? getUserInstructionText(input.sessionId, input.runId),
        instruction:
          "Continue with ordinary workspace execution. Follow the design Markdown, verify the result, and keep the user informed.",
      },
      displaySummary: `Started implementation from design revision ${implementing.revision}.`,
      artifacts: [
        {
          kind: "decision" as const,
          title: "Design implementation started",
          summary: `Switched session ${session.id} to ordinary execution using design revision ${implementing.revision}.`,
          risk: "medium" as const,
        },
      ],
    };
  },
};

export const designTools = [
  designReadTool,
  designWriteTool,
  designPreviewTool,
  designTransitionTool,
  designImplementTool,
];
