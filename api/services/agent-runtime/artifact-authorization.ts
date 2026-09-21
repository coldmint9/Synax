import { createHash } from "node:crypto";
import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore } from "./session-store.js";
import { resolvePermissionDecision } from "./permission-policy.js";
import {
  ArtifactError,
  type ArtifactPublishInput,
} from "./artifacts/contracts.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
export function publicationPermission(
  sessionId: string,
  input: ArtifactPublishInput,
) {
  const session = agentRuntimeStore.getSession(sessionId);
  return resolvePermissionDecision({
    sessionId,
    category: "write",
    internalGate: "write",
    pattern: input.sourcePath,
    rules: session.permissionRules,
    isSubSession: !!session.parentSessionId,
    metadata: { toolId: "artifact.publish", mutability: "write" },
  });
}
export function requestArtifactPublication(
  sessionId: string,
  input: ArtifactPublishInput,
  runId: string | null,
  stepId: string | null,
) {
  const id =
    "apr_" +
    createHash("sha256")
      .update(sessionId + ":" + input.idempotencyKey)
      .digest("hex")
      .slice(0, 32);
  return runtimeTransaction(() => {
    const db = getRawSqlite();
    const existing = db
      .prepare(
        "SELECT id FROM artifact_publication_requests WHERE id=? AND session_id=?",
      )
      .get(id, sessionId);
    if (existing) return id;
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO artifact_publication_requests(id,session_id,input_json,run_id,step_id,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, sessionId, JSON.stringify(input), runId, stepId, now);
    agentRuntimeStore.appendMessage({
      id: "msg_" + id,
      sessionId,
      runId,
      stepId,
      role: "assistant",
      content: `Publication requires approval: ${input.title}`,
      metadata: {
        source: "artifact_request",
        artifactRequest: {
          requestId: id,
          title: input.title,
          sourcePath: input.sourcePath,
        },
      },
      createdAt: now,
    });
    emitRuntimeBusEvent({
      type: "session_changed",
      sessionId,
      patch: { artifactRequestId: id },
    });
    return id;
  });
}
export function getPublicationRequest(sessionId: string, requestId: string) {
  agentRuntimeStore.getSession(sessionId);
  const row = getRawSqlite()
    .prepare(
      "SELECT * FROM artifact_publication_requests WHERE id=? AND session_id=?",
    )
    .get(requestId, sessionId) as
    | {
        id: string;
        input_json: string;
        run_id: string | null;
        step_id: string | null;
        status: string;
        revision_id: string | null;
      }
    | undefined;
  if (!row)
    throw new ArtifactError(
      "ARTIFACT_NOT_FOUND",
      "Publication request not found",
      404,
    );
  return {
    id: row.id,
    input: JSON.parse(row.input_json) as ArtifactPublishInput,
    runId: row.run_id,
    stepId: row.step_id,
    status: row.status,
    revisionId: row.revision_id,
  };
}
export function resolvePublicationRequest(
  sessionId: string,
  id: string,
  status: "ready" | "rejected" | "publishing" | "pending",
  revisionId: string | null = null,
) {
  getPublicationRequest(sessionId, id);
  const expected =
    status === "ready" || status === "pending" ? "publishing" : "pending";
  const result = getRawSqlite()
    .prepare(
      "UPDATE artifact_publication_requests SET status=?,revision_id=? WHERE id=? AND session_id=? AND status=?",
    )
    .run(status, revisionId, id, sessionId, expected);
  if (result.changes !== 1)
    throw new ArtifactError(
      "REVISION_CONFLICT",
      "Publication request changed; reload it before deciding",
      409,
    );
}
