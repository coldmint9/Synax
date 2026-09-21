import { processArtifactJobs } from "./artifact-jobs.js";
import { getRawSqlite } from "../../db/index.js";
import { resumeArtifactBuilds } from "./artifacts/publisher.js";
import { drainArtifactPublications } from "./artifact-integration.js";
/** Lease-based recovery must also run after startup: a recently killed job may
 * still own a non-expired lease when its replacement API starts. */
export async function recoverArtifacts(): Promise<void> {
  await resumeArtifactBuilds();
  await processArtifactJobs();
  const db = getRawSqlite();
  // Resolve approvals whose HTTP caller disappeared after the durable commit.
  db.prepare(
    `UPDATE artifact_publication_requests SET status='ready',revision_id=(SELECT b.revision_id FROM agent_artifact_builds b WHERE b.session_id=artifact_publication_requests.session_id AND b.idempotency_key=json_extract(input_json,'$.idempotencyKey') AND b.status='ready') WHERE status='publishing' AND EXISTS(SELECT 1 FROM agent_artifact_builds b WHERE b.session_id=artifact_publication_requests.session_id AND b.idempotency_key=json_extract(input_json,'$.idempotencyKey') AND b.status='ready')`,
  ).run();
  db.prepare(
    `UPDATE artifact_publication_requests SET status='pending' WHERE status='publishing' AND EXISTS(SELECT 1 FROM agent_artifact_builds b WHERE b.session_id=artifact_publication_requests.session_id AND b.idempotency_key=json_extract(input_json,'$.idempotencyKey') AND b.status='failed' AND b.error_code NOT IN ('BUILD_INTERRUPTED','BUILD_BUSY'))`,
  ).run();
  db.prepare(
    "UPDATE artifact_publication_requests SET status='ready',revision_id=(SELECT revision_id FROM artifact_jobs WHERE id=job_id) WHERE status='publishing' AND job_id IS NOT NULL AND EXISTS(SELECT 1 FROM artifact_jobs WHERE id=job_id AND status='ready')",
  ).run();
  db.prepare(
    "UPDATE artifact_publication_requests SET status='pending' WHERE status='publishing' AND job_id IS NOT NULL AND EXISTS(SELECT 1 FROM artifact_jobs WHERE id=job_id AND status IN ('failed','cancelled'))",
  ).run();
  const rows = getRawSqlite()
    .prepare(
      "SELECT DISTINCT session_id FROM agent_artifact_outbox WHERE delivered_at IS NULL",
    )
    .all() as Array<{ session_id: string }>;
  for (const row of rows) drainArtifactPublications(row.session_id);
}
export function startArtifactRecovery(
  onError: (error: unknown) => void,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await recoverArtifacts();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 5000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
