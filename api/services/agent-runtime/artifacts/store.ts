import { randomUUID } from 'node:crypto';
import { getRawSqlite } from '../../../db/index.js';
import { ArtifactError, ARTIFACT_LIMITS, emptyArtifactState, type ArtifactBundle, type ArtifactFile, type ArtifactPublishContext, type ArtifactPublishInput, type ArtifactRevision, type ArtifactState } from './contracts.js';
import { COMPILER_VERSION, POLICY_VERSION, SDK_VERSION } from './policy.js';
import type { Compilation, ArtifactDependency } from './compiler.js';
import { hash, validateState } from './validation.js';

interface ArtifactRow { id: string; session_id: string; head_revision_id: string | null; deleted_at: string | null }
interface RevisionRow { id: string; revision_json: string; source_json: string; bundle_html: string; source_hash: string; bundle_hash: string; dependencies_json: string; policy_version: number; compiler_version: number; sdk_version: number }
interface BuildRow { id: string; request_hash: string; status: 'building' | 'ready' | 'failed'; revision_id: string | null; lease_until: number; error_code: string | null; error_message: string | null }
const missing = (): never => { throw new ArtifactError('ARTIFACT_NOT_FOUND', 'Artifact not found in this session.', 404); };
export function assertSession(context: ArtifactPublishContext): void {
  const session = getRawSqlite().prepare('SELECT project_id FROM agent_runtime_sessions WHERE id=?').get(context.sessionId) as { project_id: string } | undefined;
  if (!session || session.project_id !== context.projectId) missing();
}
function artifact(sessionId: string, artifactId: string): ArtifactRow {
  const row = getRawSqlite().prepare('SELECT * FROM agent_artifacts WHERE id=? AND session_id=? AND deleted_at IS NULL').get(artifactId, sessionId) as ArtifactRow | undefined;
  return row ?? missing();
}
export function revisionRow(sessionId: string, revisionId: string): RevisionRow {
  const row = getRawSqlite().prepare('SELECT r.* FROM agent_artifact_revisions r JOIN agent_artifacts a ON a.id=r.artifact_id WHERE r.id=? AND r.session_id=? AND a.session_id=? AND a.deleted_at IS NULL').get(revisionId, sessionId, sessionId) as RevisionRow | undefined;
  return row ?? missing();
}
export function getRevision(sessionId: string, revisionId: string): ArtifactRevision { return JSON.parse(revisionRow(sessionId, revisionId).revision_json); }
function checkBase(context: ArtifactPublishContext, input: ArtifactPublishInput): ArtifactRow | undefined {
  if (!input.artifactId) return;
  const current = artifact(context.sessionId, input.artifactId);
  if (current.head_revision_id !== input.baseRevisionId) throw new ArtifactError('REVISION_CONFLICT', 'Artifact revision conflict: reload the current version.', 409);
  return current;
}
export function requestHash(input: ArtifactPublishInput): string {
  return hash(JSON.stringify({ sourcePath: input.sourcePath, title: input.title, sourceKind: input.sourceKind, artifactId: input.artifactId ?? null, baseRevisionId: input.baseRevisionId ?? null }));
}
/** Expired attempts have no ready revision and may be safely retried with the same key. */
export function recoverArtifactBuilds(): number {
  getRawSqlite().prepare("UPDATE agent_artifact_builds SET snapshot_json=NULL,snapshot_hash=NULL WHERE status='failed' AND lease_until < ?").run(Date.now() - 24*60*60*1000);
  return getRawSqlite().prepare(`UPDATE agent_artifact_builds SET status='failed',error_code='BUILD_INTERRUPTED',error_message='Build interrupted; publish again.' WHERE status='building' AND lease_until < ?`).run(Date.now()).changes;
}
export function beginBuild(context: ArtifactPublishContext, input: ArtifactPublishInput): { id: string; revision?: ArtifactRevision } {
  const db = getRawSqlite();
  return db.transaction(() => {
    assertSession(context); recoverArtifactBuilds();
    const digest = requestHash(input);
    const old = db.prepare('SELECT * FROM agent_artifact_builds WHERE session_id=? AND idempotency_key=?').get(context.sessionId, input.idempotencyKey) as BuildRow | undefined;
    if (old) {
      if (old.request_hash !== digest) throw new ArtifactError('REVISION_CONFLICT', 'Idempotency key was already used for a different request.', 409);
      if (old.status === 'ready' && old.revision_id) return { id: old.id, revision: getRevision(context.sessionId, old.revision_id) };
      if (old.status === 'building') throw new ArtifactError('REVISION_CONFLICT', 'This publication is already building; retry with the same key.', 409);
    }
    checkBase(context, input);
    const usage = storageUsage(context.sessionId, old?.id);
    const requestBytes = Buffer.byteLength(JSON.stringify(input)) + 2048;
    if (usage.total + requestBytes > ARTIFACT_LIMITS.totalBytes || usage.session + requestBytes > ARTIFACT_LIMITS.sessionBytes) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact storage quota exceeded.', 413);
    const id = randomUUID();
    if (old) db.prepare('DELETE FROM agent_artifact_builds WHERE id=?').run(old.id);
    db.prepare(`INSERT INTO agent_artifact_builds(id,session_id,artifact_id,idempotency_key,request_hash,request_json,context_json,status,lease_until,created_at) VALUES(?,?,?,?,?,?,?,'building',?,?)`).run(id, context.sessionId, input.artifactId ?? null, input.idempotencyKey, digest, JSON.stringify(input), JSON.stringify({ sessionId: context.sessionId, projectId: context.projectId, runId: context.runId ?? null, turnId: context.turnId ?? null, ...(context.jobId ? { jobId: context.jobId } : {}) }), Date.now() + ARTIFACT_LIMITS.buildMs + 5000, new Date().toISOString());
    return { id };
  })();
}
export function failBuild(buildId: string, error: ArtifactError): void {
  getRawSqlite().prepare(`UPDATE agent_artifact_builds SET status='failed',error_code=?,error_message=? WHERE id=? AND status='building'`).run(error.code, error.message.slice(0, 4000), buildId);
}
export function commitBuild(context: ArtifactPublishContext, input: ArtifactPublishInput, buildId: string, compiled: Compilation): ArtifactRevision {
  const db = getRawSqlite();
  return db.transaction(() => {
    assertSession(context);
    const build = db.prepare("SELECT * FROM agent_artifact_builds WHERE id=? AND session_id=? AND status='building'").get(buildId, context.sessionId) as BuildRow | undefined;
    if (!build || build.lease_until < Date.now()) throw new ArtifactError('BUILD_TIMEOUT', 'Artifact build lease expired; publish again.', 408);
    if(context.jobId){
      const job=db.prepare("SELECT status,attempt FROM artifact_jobs WHERE id=? AND session_id=?").get(context.jobId,context.sessionId) as {status:string;attempt:number}|undefined;
      if(job?.status!=="building" || input.idempotencyKey !== `job:${context.jobId}:${job.attempt}`)throw new ArtifactError("BUILD_CANCELLED","Build was cancelled or superseded before commit",409);
    }
    const current = checkBase(context, input);
    const sourceJson = JSON.stringify(compiled.source);
    if (hash(sourceJson) !== compiled.sourceHash || hash(compiled.html) !== compiled.bundleHash) throw new ArtifactError('INVALID_SOURCE', 'Build integrity verification failed.');
    const dependenciesJson = JSON.stringify(compiled.dependencies);
    const storedBytes = Buffer.byteLength(sourceJson) + Buffer.byteLength(compiled.html) + Buffer.byteLength(dependenciesJson);
    const usage = storageUsage(context.sessionId, buildId);
    if (usage.total + storedBytes > ARTIFACT_LIMITS.totalBytes || usage.session + storedBytes > ARTIFACT_LIMITS.sessionBytes) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact storage quota exceeded; delete an artifact before publishing.', 413);
    const artifactId = current?.id ?? randomUUID();
    const createdAt = new Date().toISOString();
    const previous = current?.head_revision_id ? getRevision(context.sessionId, current.head_revision_id) : undefined;
    const revision: ArtifactRevision = { type: 'artifact', artifactId, revisionId: randomUUID(), sessionId: context.sessionId, revisionNumber: (previous?.revisionNumber ?? 0) + 1, title: input.title, presentation: 'inline', sourceKind: input.sourceKind, sourcePath: input.sourcePath, sourceHash: compiled.sourceHash, bundleHash: compiled.bundleHash, createdAt, status: 'ready', diagnostics: [], baseRevisionId: input.baseRevisionId ?? null, runId: context.runId ?? null, turnId: context.turnId ?? null };
    if (!current) db.prepare('INSERT INTO agent_artifacts(id,session_id,project_id,created_at) VALUES(?,?,?,?)').run(artifactId, context.sessionId, context.projectId, createdAt);
    db.prepare(`INSERT INTO agent_artifact_revisions(id,artifact_id,session_id,revision_number,revision_json,source_json,bundle_html,source_hash,bundle_hash,stored_bytes,compiler_version,policy_version,sdk_version,dependencies_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(revision.revisionId, artifactId, context.sessionId, revision.revisionNumber, JSON.stringify(revision), sourceJson, compiled.html, compiled.sourceHash, compiled.bundleHash, storedBytes, COMPILER_VERSION, POLICY_VERSION, SDK_VERSION, dependenciesJson, createdAt);
    const update = db.prepare('UPDATE agent_artifacts SET head_revision_id=? WHERE id=? AND session_id=? AND head_revision_id IS ? AND deleted_at IS NULL').run(revision.revisionId, artifactId, context.sessionId, input.baseRevisionId ?? null);
    if (update.changes !== 1) throw new ArtifactError('REVISION_CONFLICT', 'Artifact revision conflict.', 409);
    db.prepare("UPDATE agent_artifact_builds SET status='ready',revision_id=?,artifact_id=?,snapshot_json=NULL,snapshot_hash=NULL WHERE id=?").run(revision.revisionId, artifactId, buildId);
    db.prepare('INSERT INTO agent_artifact_outbox(id,session_id,revision_id,payload_json,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), context.sessionId, revision.revisionId, JSON.stringify(revision), createdAt);
    if(context.jobId)db.prepare("UPDATE artifact_jobs SET status='ready',revision_id=?,artifact_id=?,error_code=NULL,diagnostics_json='[]',lease_until=0,updated_at=? WHERE id=? AND session_id=? AND status='building'").run(revision.revisionId,revision.artifactId,createdAt,context.jobId,context.sessionId);
    return revision;
  })();
}
export function listArtifacts(sessionId: string): ArtifactRevision[] {
  return (getRawSqlite().prepare('SELECT r.revision_json FROM agent_artifacts a JOIN agent_artifact_revisions r ON r.id=a.head_revision_id WHERE a.session_id=? AND a.deleted_at IS NULL ORDER BY r.created_at DESC,r.id').all(sessionId) as { revision_json: string }[]).map(row => JSON.parse(row.revision_json));
}
export function listRevisions(sessionId: string, artifactId: string): ArtifactRevision[] {
  artifact(sessionId, artifactId);
  return (getRawSqlite().prepare('SELECT revision_json FROM agent_artifact_revisions WHERE session_id=? AND artifact_id=? ORDER BY revision_number DESC').all(sessionId, artifactId) as { revision_json: string }[]).map(row => JSON.parse(row.revision_json));
}
export function getArtifactBundle(sessionId: string, revisionId: string): ArtifactBundle {
  const row = revisionRow(sessionId, revisionId);
  if (row.policy_version !== POLICY_VERSION || row.compiler_version !== COMPILER_VERSION || row.sdk_version !== SDK_VERSION) throw new ArtifactError('POLICY_BLOCKED', 'This revision requires rebuilding with the current runtime policy.', 409);
  if (hash(row.bundle_html) !== row.bundle_hash) throw new ArtifactError('POLICY_BLOCKED', 'Artifact bundle integrity verification failed.', 409);
  return { revision: JSON.parse(row.revision_json), html: row.bundle_html };
}
export function getArtifactSource(sessionId: string, revisionId: string): ArtifactFile[] {
  const row = revisionRow(sessionId, revisionId);
  if (hash(row.source_json) !== row.source_hash) throw new ArtifactError('POLICY_BLOCKED', 'Artifact source integrity verification failed.', 409);
  return JSON.parse(row.source_json);
}
export function getArtifactDependencies(sessionId: string, revisionId: string): ArtifactDependency[] { return JSON.parse(revisionRow(sessionId, revisionId).dependencies_json); }
export function getArtifactState(sessionId: string, revisionId: string): ArtifactState {
  revisionRow(sessionId, revisionId);
  const row = getRawSqlite().prepare('SELECT state_json,etag FROM agent_artifact_state WHERE session_id=? AND revision_id=?').get(sessionId, revisionId) as { state_json: string; etag: number } | undefined;
  return row ? { ...JSON.parse(row.state_json), etag: row.etag } : emptyArtifactState();
}
export function saveArtifactState(sessionId: string, revisionId: string, state: Omit<ArtifactState, 'etag'>, expectedEtag: number): ArtifactState {
  const json = validateState(state, expectedEtag);
  const db = getRawSqlite();
  return db.transaction(() => {
    revisionRow(sessionId, revisionId);
    const current = getArtifactState(sessionId, revisionId);
    if (current.etag !== expectedEtag) throw new ArtifactError('STATE_CONFLICT', 'Artifact state conflict: reload the current state.', 409);
    const usage = storageUsage(sessionId);
    const old = db.prepare('SELECT state_json FROM agent_artifact_state WHERE revision_id=?').get(revisionId) as {state_json:string} | undefined;
    const growth = Buffer.byteLength(json) - (old ? Buffer.byteLength(old.state_json) : 0);
    if (growth > 0 && (usage.total + growth > ARTIFACT_LIMITS.totalBytes || usage.session + growth > ARTIFACT_LIMITS.sessionBytes)) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact storage quota exceeded.', 413);
    db.prepare('INSERT INTO agent_artifact_state(revision_id,session_id,state_json,etag) VALUES(?,?,?,?) ON CONFLICT(revision_id) DO UPDATE SET state_json=excluded.state_json,etag=excluded.etag').run(revisionId, sessionId, json, expectedEtag + 1);
    return { ...JSON.parse(json), etag: expectedEtag + 1 };
  })();
}
export function deleteArtifact(sessionId: string, artifactId: string): void {
  const db = getRawSqlite();
  db.transaction(() => {
    artifact(sessionId, artifactId);
    db.prepare('DELETE FROM agent_artifact_builds WHERE session_id=? AND artifact_id=?').run(sessionId, artifactId);
    db.prepare('DELETE FROM agent_artifacts WHERE session_id=? AND id=?').run(sessionId, artifactId);
  })();
}
/** Integration may drain after startup/reconnect; marking delivered is explicit and post-send. */
export function pendingArtifactEvents(sessionId: string): Array<{ id: string; revision: ArtifactRevision }> {
  return (getRawSqlite().prepare('SELECT id,payload_json FROM agent_artifact_outbox WHERE session_id=? AND delivered_at IS NULL ORDER BY created_at,id').all(sessionId) as { id: string; payload_json: string }[]).map(row => ({ id: row.id, revision: JSON.parse(row.payload_json) }));
}
export function acknowledgeArtifactEvent(sessionId: string, id: string): void { getRawSqlite().prepare('UPDATE agent_artifact_outbox SET delivered_at=? WHERE session_id=? AND id=? AND delivered_at IS NULL').run(new Date().toISOString(), sessionId, id); }

export function persistBuildSnapshot(buildId: string, files: ArtifactFile[]): void {
  const db = getRawSqlite();
  const json = JSON.stringify(files);
  db.transaction(() => {
    const job = db.prepare("SELECT session_id FROM agent_artifact_builds WHERE id=? AND status='building'").get(buildId) as { session_id: string } | undefined;
    if (!job) throw new ArtifactError('BUILD_CANCELLED', 'Artifact build no longer exists.', 499);
    const usage = storageUsage(job.session_id, buildId);
    if (usage.total + Buffer.byteLength(json) > ARTIFACT_LIMITS.totalBytes || usage.session + Buffer.byteLength(json) > ARTIFACT_LIMITS.sessionBytes) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact snapshot storage quota exceeded.', 413);
    db.prepare("UPDATE agent_artifact_builds SET snapshot_json=?,snapshot_hash=? WHERE id=? AND status='building'").run(json, hash(json), buildId);
  })();
}
function storageUsage(sessionId: string, excludeBuildId = ''): { total: number; session: number } {
  return getRawSqlite().prepare(`SELECT COALESCE(SUM(bytes),0) AS total,COALESCE(SUM(CASE WHEN session_id=? THEN bytes ELSE 0 END),0) AS session FROM (
    SELECT session_id, stored_bytes AS bytes FROM agent_artifact_revisions
    UNION ALL SELECT session_id,COALESCE(LENGTH(CAST(snapshot_json AS BLOB)),0)+LENGTH(CAST(request_json AS BLOB))+LENGTH(CAST(context_json AS BLOB))+COALESCE(LENGTH(CAST(error_message AS BLOB)),0) AS bytes FROM agent_artifact_builds WHERE id<>?
    UNION ALL SELECT session_id,LENGTH(CAST(state_json AS BLOB)) AS bytes FROM agent_artifact_state
  )`).get(sessionId, excludeBuildId) as { total: number; session: number };
}
export function claimRecoverableBuilds(limit = 2): Array<{ id: string; context: ArtifactPublishContext; input: ArtifactPublishInput; files: ArtifactFile[] }> {
  const db = getRawSqlite();
  return db.transaction(() => {
    recoverArtifactBuilds();
    const rows = db.prepare("SELECT * FROM agent_artifact_builds WHERE status='failed' AND error_code='BUILD_INTERRUPTED' AND snapshot_json IS NOT NULL AND lease_until <= ? ORDER BY lease_until,created_at LIMIT ?").all(Date.now(), limit) as Array<{ id: string; context_json: string; request_json: string; snapshot_json: string; snapshot_hash: string }>;
    const jobs = [];
    for (const row of rows) {
      if (hash(row.snapshot_json) !== row.snapshot_hash) { db.prepare("UPDATE agent_artifact_builds SET error_code='INVALID_SOURCE',error_message='Stored source integrity check failed.' WHERE id=?").run(row.id); continue; }
      db.prepare("UPDATE agent_artifact_builds SET status='building',lease_until=?,error_code=NULL,error_message=NULL WHERE id=?").run(Date.now() + ARTIFACT_LIMITS.buildMs + 5000, row.id);
      jobs.push({ id: row.id, context: { ...JSON.parse(row.context_json), workspaceRoot: '[durable-snapshot]' }, input: JSON.parse(row.request_json), files: JSON.parse(row.snapshot_json) });
    }
    return jobs;
  })();
}

/** Failed attempts are visible separately; failed builds never consume a ready revision number. */
export function listArtifactBuilds(sessionId: string, artifactId?: string): Array<{ buildId: string; artifactId: string | null; revisionId: string | null; status: 'building' | 'ready' | 'failed'; errorCode: string | null; diagnostics: string[]; createdAt: string }> {
  if (artifactId) artifact(sessionId, artifactId);
  const rows = getRawSqlite().prepare('SELECT id,artifact_id,revision_id,status,error_code,error_message,created_at FROM agent_artifact_builds WHERE session_id=? AND (? IS NULL OR artifact_id=?) ORDER BY created_at DESC,id DESC LIMIT 200').all(sessionId,artifactId ?? null,artifactId ?? null) as Array<{id:string;artifact_id:string|null;revision_id:string|null;status:'building'|'ready'|'failed';error_code:string|null;error_message:string|null;created_at:string}>;
  return rows.map(row => ({buildId:row.id,artifactId:row.artifact_id,revisionId:row.revision_id,status:row.status,errorCode:row.error_code,diagnostics:row.error_message ? [row.error_message] : [],createdAt:row.created_at}));
}

/** Compiler capacity is temporary, not a terminal recovery failure. */
export function deferArtifactRecovery(buildId:string):void {
 getRawSqlite().prepare("UPDATE agent_artifact_builds SET status='failed',error_code='BUILD_INTERRUPTED',error_message='Recovery waiting for compiler capacity',lease_until=? WHERE id=? AND status='building'").run(Date.now()+5000,buildId);
}
