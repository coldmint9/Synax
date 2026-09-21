import {
  publicationPermission,
  requestArtifactPublication,
} from "./artifact-authorization.js";
import { ArtifactError } from "./artifacts/contracts.js";
import { createHash } from "node:crypto";
import { agentRuntimeStore as store } from "./session-store.js";
import { agentEventService } from "./event-service.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import {
  publishArtifact,
  pendingArtifactEvents,
  acknowledgeArtifactEvent,
} from "./artifacts/publisher.js";
import type {
  ArtifactPublishInput,
  ArtifactRevision,
} from "./artifacts/contracts.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { parseArtifactManifests } from "./artifact-manifest.js";

export async function publishSessionArtifact(
  sessionId: string,
  input: ArtifactPublishInput,
  runId?: string | null,
  stepId?: string | null,
  signal?: AbortSignal,
): Promise<ArtifactRevision> {
  const session = store.getSession(sessionId);
  const revision = await publishArtifact(
    {
      sessionId,
      projectId: session.projectId,
      workspaceRoot: resolveSessionWorkDir(sessionId, session.projectId),
      runId: runId ?? null,
      turnId: stepId ?? null,
      signal,
    },
    input,
  );
  if (revision.status === "ready") drainArtifactPublications(sessionId);
  return revision;
}

/** Outbox delivery and transcript insertion share a transaction. Safe after a crash/reconnect. */
export function drainArtifactPublications(sessionId: string): number {
  const pending = pendingArtifactEvents(sessionId);
  for (const event of pending) {
    const revision = event.revision;
    runtimeTransaction(() => {
      const id = `msg_artifact_${createHash("sha256")
        .update(sessionId + ":" + revision.revisionId)
        .digest("hex")
        .slice(0, 32)}`;
      if (!store.listMessages(sessionId).some((m) => m.id === id)) {
        store.appendMessage({
          id,
          sessionId,
          runId: revision.runId,
          stepId: revision.turnId,
          role: "assistant",
          content: `Interactive artifact: ${revision.title} (v${revision.revisionNumber})`,
          createdAt: revision.createdAt,
          metadata: {
            source: "artifact_publisher",
            artifacts: [
              {
                type: "artifact",
                artifactId: revision.artifactId,
                revisionId: revision.revisionId,
                title: revision.title,
                presentation: revision.presentation,
              },
            ],
          },
        });
        agentEventService.append({
          sessionId,
          type: "artifact_created",
          summary: `${revision.title} · v${revision.revisionNumber}`,
          payload: {
            kind: "interactive",
            artifactId: revision.artifactId,
            revisionId: revision.revisionId,
            status: revision.status,
          },
        });
      }
      acknowledgeArtifactEvent(sessionId, event.id);
    });
  }
  if (pending.length)
    emitRuntimeBusEvent({
      type: "session_changed",
      sessionId,
      patch: { artifactsChanged: true },
    });
  return pending.length;
}

/** Called only by a successful completed assistant turn, never while streaming. */
export async function publishCompletedManifests(
  message: AgentRuntimeMessage,
): Promise<void> {
  if (message.role !== "assistant" || message.metadata?.partial) return;
  for (const [index, input] of parseArtifactManifests(
    message.content,
  ).entries()) {
    try {
      const publication = {
        ...input,
        idempotencyKey: `message:${message.id}:${index}`,
      };
      const permission = publicationPermission(message.sessionId, publication);
      if (permission.action === "deny")
        throw new ArtifactError(
          "PERMISSION_DENIED",
          "Artifact publication is denied by this session",
          403,
        );
      if (permission.action === "ask") {
        requestArtifactPublication(
          message.sessionId,
          publication,
          message.runId,
          message.stepId,
        );
        continue;
      }
      await publishSessionArtifact(
        message.sessionId,
        { ...input, idempotencyKey: `message:${message.id}:${index}` },
        message.runId,
        message.stepId,
      );
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "BUILD_FAILED";
      const id = `msg_artifact_error_${createHash("sha256")
        .update(message.id + ":" + index)
        .digest("hex")
        .slice(0, 24)}`;
      if (!store.listMessages(message.sessionId).some((m) => m.id === id))
        store.appendMessage({
          id,
          sessionId: message.sessionId,
          runId: message.runId,
          stepId: message.stepId,
          role: "assistant",
          content: `Interactive artifact could not be published (${code}). Check the source and publish a new version.`,
          metadata: { source: "artifact_diagnostic" },
          createdAt: new Date().toISOString(),
        });
    }
  }
}
