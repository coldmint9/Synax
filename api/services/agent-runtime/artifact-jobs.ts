import { outsideExecutionContext } from "../../lib/execution-context.js";
import { publicationPermission } from "./artifact-authorization.js";
import { agentEventService } from "./event-service.js";
import { randomUUID } from "node:crypto";
import { getRawSqlite } from "../../db/index.js";
import { agentRuntimeStore } from "./session-store.js";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import { runtimeTransaction } from "./runtime-transaction.js";
import { emitRuntimeBusEvent } from "./runtime-bus-bridge.js";
import { publishArtifact } from "./artifacts/publisher.js";
import { drainArtifactPublications } from "./artifact-integration.js";
import { requestHash } from "./artifacts/store.js";
import { validatePublish } from "./artifacts/validation.js";
import {
  ArtifactError,
  type ArtifactBuildJob,
  type ArtifactPublishInput,
  type ArtifactPublishContext,
} from "./artifacts/contracts.js";
interface JobRow {
  id: string;
  session_id: string;
  input_json: string;
  context_json: string;
  request_hash: string;
  idempotency_key: string;
  status: ArtifactBuildJob["status"];
  revision_id: string | null;
  artifact_id: string | null;
  error_code: string | null;
  diagnostics_json: string;
  created_at: string;
  updated_at: string;
  attempt: number;
  lease_until: number;
}
const active = new Map<string, AbortController>();
let draining = false;
const signal = (sessionId: string) => {
  runtimeTransaction(() => {
    const db = getRawSqlite();
    const changed = db
      .prepare(
        "SELECT * FROM artifact_jobs WHERE session_id=? AND (last_event_status IS NOT status OR last_event_attempt IS NOT attempt)",
      )
      .all(sessionId) as JobRow[];
    for (const job of changed) {
      agentEventService.append({
        sessionId,
        type: `artifact.${job.status}`,
        summary: `${JSON.parse(job.input_json).title}: ${job.status}`,
        payload: {
          jobId: job.id,
          status: job.status,
          revisionId: job.revision_id,
          attempt: job.attempt,
        },
      });
      db.prepare(
        "UPDATE artifact_jobs SET last_event_status=status,last_event_attempt=attempt WHERE id=?",
      ).run(job.id);
    }
  });
  emitRuntimeBusEvent({
    type: "session_changed",
    sessionId,
    patch: { artifactBuildChanged: true },
  });
};
function wire(row: JobRow): ArtifactBuildJob {
  return {
    jobId: row.id,
    sessionId: row.session_id,
    title: JSON.parse(row.input_json).title,
    status: row.status,
    revisionId: row.revision_id,
    artifactId: row.artifact_id,
    errorCode: row.error_code,
    diagnostics: JSON.parse(row.diagnostics_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attempt: row.attempt,
  };
}
function row(sessionId: string, id: string): JobRow {
  agentRuntimeStore.getSession(sessionId);
  const value = getRawSqlite()
    .prepare("SELECT * FROM artifact_jobs WHERE id=? AND session_id=?")
    .get(id, sessionId) as JobRow | undefined;
  if (!value)
    throw new ArtifactError(
      "ARTIFACT_NOT_FOUND",
      "Artifact build job not found",
      404,
    );
  return value;
}
export function getArtifactJob(sessionId: string, id: string) {
  return wire(row(sessionId, id));
}
export function listArtifactJobs(sessionId: string) {
  agentRuntimeStore.getSession(sessionId);
  return (
    getRawSqlite()
      .prepare(
        "SELECT * FROM artifact_jobs WHERE session_id=? ORDER BY created_at DESC LIMIT 200",
      )
      .all(sessionId) as JobRow[]
  ).map(wire);
}
export function enqueueArtifactJob(
  sessionId: string,
  input: ArtifactPublishInput,
  runId: string | null = null,
  stepId: string | null = null,
): ArtifactBuildJob {
  validatePublish(input);
  if(publicationPermission(sessionId,input).action==="deny")throw new ArtifactError("PERMISSION_DENIED","Artifact publication is denied by the current session policy",403);
  const session = agentRuntimeStore.getSession(sessionId);
  const root = resolveSessionWorkDir(sessionId, session.projectId);
  const job = runtimeTransaction(() => {
    const db = getRawSqlite();
    const old = db
      .prepare(
        "SELECT * FROM artifact_jobs WHERE session_id=? AND idempotency_key=?",
      )
      .get(sessionId, input.idempotencyKey) as JobRow | undefined;
    if (old) {
      if (old.request_hash !== requestHash(input))
        throw new ArtifactError(
          "REVISION_CONFLICT",
          "Idempotency key already used for different build",
          409,
        );
      return wire(old);
    }
    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM artifact_jobs WHERE status IN ('queued','building')",
      )
      .get() as { count: number };
    if (count.count >= 32)
      throw new ArtifactError(
        "RESOURCE_LIMIT",
        "Artifact build queue is full",
        429,
      );
    const id = randomUUID();
    const now = new Date().toISOString();
    const context: ArtifactPublishContext = {
      sessionId,
      projectId: session.projectId,
      workspaceRoot: root,
      runId,
      turnId: stepId,
      jobId: id,
    };
    db.prepare(
      "INSERT INTO artifact_jobs(id,session_id,input_json,request_hash,context_json,idempotency_key,status,artifact_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?)",
    ).run(
      id,
      sessionId,
      JSON.stringify(input),
      requestHash(input),
      JSON.stringify(context),
      input.idempotencyKey,
      input.artifactId ?? null,
      now,
      now,
    );
    agentRuntimeStore.appendMessage({
      id: "msg_artifact_job_" + id,
      sessionId,
      runId,
      stepId,
      role: "assistant",
      content: `Build interactive artifact: ${input.title}`,
      metadata: {
        source: "artifact_job",
        artifactJob: { jobId: id, title: input.title },
      },
      createdAt: now,
    });
    return getArtifactJob(sessionId, id);
  });
  signal(sessionId);
  setImmediate(() => void processArtifactJobs().catch(() => {}));
  return job;
}
function executionKey(job: JobRow) {
  return `job:${job.id}:${job.attempt}`;
}
export function cancelArtifactJob(
  sessionId: string,
  id: string,
): ArtifactBuildJob {
  const result = runtimeTransaction(() => {
    const current = row(sessionId, id);
    if (!["queued", "building"].includes(current.status)) return wire(current);
    getRawSqlite()
      .prepare(
        "UPDATE artifact_jobs SET status='cancelled',error_code='BUILD_CANCELLED',diagnostics_json='[\"Build cancelled by user\"]',updated_at=?,lease_until=0 WHERE id=? AND session_id=? AND status IN ('queued','building')",
      )
      .run(new Date().toISOString(), id, sessionId);
    getRawSqlite()
      .prepare(
        "UPDATE agent_artifact_builds SET status='failed',error_code='BUILD_CANCELLED',error_message='Build cancelled by user' WHERE session_id=? AND idempotency_key=? AND status IN ('building','failed')",
      )
      .run(sessionId, executionKey(current));
    return getArtifactJob(sessionId, id);
  });
  active.get(id)?.abort();
  signal(sessionId);
  return result;
}
export function retryArtifactJob(
  sessionId: string,
  id: string,
): ArtifactBuildJob {
  const next = runtimeTransaction(() => {
    const current = row(sessionId, id);
    if (!["failed", "cancelled"].includes(current.status))
      throw new ArtifactError(
        "REVISION_CONFLICT",
        "Only a failed or cancelled job can be retried",
        409,
      );
    const linked = getRawSqlite()
      .prepare(
        "SELECT status FROM artifact_publication_requests WHERE job_id=? AND session_id=?",
      )
      .all(id, sessionId) as Array<{ status: string }>;
    if (
      linked.some((request) => request.status === "rejected") ||
      publicationPermission(sessionId, JSON.parse(current.input_json))
        .action === "deny"
    )
      throw new ArtifactError(
        "PERMISSION_DENIED",
        "Publication has been rejected or is denied by current policy",
        403,
      );
    getRawSqlite()
      .prepare(
        "UPDATE artifact_publication_requests SET status='publishing' WHERE job_id=? AND session_id=? AND status='pending'",
      )
      .run(id, sessionId);
    getRawSqlite()
      .prepare(
        "UPDATE artifact_jobs SET status='queued',attempt=attempt+1,error_code=NULL,diagnostics_json='[]',updated_at=?,lease_until=0 WHERE id=? AND session_id=?",
      )
      .run(new Date().toISOString(), id, sessionId);
    return getArtifactJob(sessionId, id);
  });
  signal(sessionId);
  setImmediate(() => void processArtifactJobs().catch(() => {}));
  return next;
}
export async function processArtifactJobs(): Promise<void> {
  // Publishing jobs outlive the originating assistant turn. Only the API host
  // drains them; short-lived agent workers must not capture or commit a job
  // under a run lease that is about to close.
  if (
    process.env.SYNAX_AGENT_SESSION_CHILD === "1" ||
    process.env.SYNAX_WIKI_JOB_CHILD === "1"
  )
    return;
  return outsideExecutionContext(drainArtifactJobQueue);
}
async function drainArtifactJobQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const db = getRawSqlite();
    // A completed revision and its job were committed together. Lease-expired API
    // owners defer to captured-build recovery; never resnapshot live source silently.
    runtimeTransaction(() => {
      const expired = db
        .prepare(
          "SELECT * FROM artifact_jobs WHERE status='building' AND lease_until < ?",
        )
        .all(Date.now()) as JobRow[];
      for (const job of expired) {
        if (active.has(job.id)) continue;
        const build = db
          .prepare(
            "SELECT status,error_code,error_message,snapshot_json,lease_until FROM agent_artifact_builds WHERE session_id=? AND idempotency_key=?",
          )
          .get(job.session_id, executionKey(job)) as
          | {
              status: string;
              error_code: string;
              error_message: string;
              snapshot_json: string | null;
              lease_until: number;
            }
          | undefined;
        if (
          (build?.status === "building" && (build.lease_until >= Date.now() || build.snapshot_json !== null)) ||
          (build?.error_code === "BUILD_INTERRUPTED" && build.snapshot_json !== null)
        )
          continue;
        db.prepare(
          "UPDATE artifact_jobs SET status='failed',error_code=?,diagnostics_json=?,updated_at=? WHERE id=? AND status='building' AND attempt=? AND lease_until<?",
        ).run(
          build?.error_code ?? "BUILD_INTERRUPTED",
          JSON.stringify([
            build?.error_message ??
              "Build interrupted before source snapshot. Retry to publish again.",
          ]),
          new Date().toISOString(),
          job.id,
          job.attempt,
          Date.now(),
        );
        signal(job.session_id);
      }
    });
    const claimed = runtimeTransaction(() => {
      const busy = db
        .prepare(
          "SELECT COUNT(*) AS count FROM artifact_jobs WHERE status='building' AND lease_until>=?",
        )
        .get(Date.now()) as { count: number };
      const jobs = db
        .prepare(
          "SELECT * FROM artifact_jobs WHERE status='queued' ORDER BY created_at,id LIMIT ?",
        )
        .all(Math.max(0, 2 - busy.count)) as JobRow[];
      for (const job of jobs)
        db.prepare(
          "UPDATE artifact_jobs SET status='building',lease_until=?,updated_at=? WHERE id=? AND status='queued'",
        ).run(Date.now() + 30000, new Date().toISOString(), job.id);
      return jobs;
    });
    await Promise.all(
      claimed.map(async (job) => {
        const controller = new AbortController();
        active.set(job.id, controller);
        signal(job.session_id);
        try {
          if(publicationPermission(job.session_id,JSON.parse(job.input_json)).action==="deny")throw new ArtifactError("PERMISSION_DENIED","Artifact publication denied by current workflow",403);
          await publishArtifact(
            {
              ...JSON.parse(job.context_json),
              jobId: job.id,
              signal: controller.signal,
            },
            {
              ...JSON.parse(job.input_json),
              idempotencyKey: executionKey(job),
            },
          );
          drainArtifactPublications(job.session_id);
        } catch (error) {
          const safe =
            error instanceof ArtifactError
              ? error
              : new ArtifactError("INVALID_SOURCE", "Build failed");
          db.prepare(
            "UPDATE artifact_jobs SET status=?,error_code=?,diagnostics_json=?,updated_at=?,lease_until=0 WHERE id=? AND status='building' AND attempt=?",
          ).run(
            safe.code === "BUILD_BUSY" ? "queued" : "failed",
            safe.code,
            JSON.stringify([safe.message]),
            new Date().toISOString(),
            job.id,
            job.attempt,
          );
        } finally {
          active.delete(job.id);
          signal(job.session_id);
        }
      }),
    );
  } finally {
    draining = false;
  }
}
