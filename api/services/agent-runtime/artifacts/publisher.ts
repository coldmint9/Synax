import { publicationPermission } from "../artifact-authorization.js";
import {
  ArtifactError,
  type ArtifactPublishContext,
  type ArtifactPublishInput,
  type ArtifactRevision,
} from "./contracts.js";
import { readSnapshot, StoredSnapshot } from "./snapshot.js";
import { compileArtifact } from "./compiler.js";
import {
  beginBuild,
  commitBuild,
  failBuild,
  persistBuildSnapshot,
  claimRecoverableBuilds,
  deferArtifactRecovery,
} from "./store.js";
import { requestHash } from "./store.js";
import { validatePublish } from "./validation.js";

export {
  listArtifacts,
  listRevisions,
  getArtifactBundle,
  getArtifactSource,
  getArtifactState,
  saveArtifactState,
  deleteArtifact,
  pendingArtifactEvents,
  acknowledgeArtifactEvent,
  recoverArtifactBuilds,
  listArtifactBuilds,
} from "./store.js";
const inFlight = new Map<
  string,
  { hash: string; promise: Promise<ArtifactRevision> }
>();
export function publishArtifact(
  context: ArtifactPublishContext,
  input: ArtifactPublishInput,
): Promise<ArtifactRevision> {
  try {
    validatePublish(input);
  } catch (error) {
    return Promise.reject(error);
  }
  const signal = context.signal;
  const checkCancelled = () => {
    if (signal?.aborted)
      throw new ArtifactError(
        "BUILD_CANCELLED",
        "Artifact publication was cancelled.",
        499,
      );
  };
  try {
    checkCancelled();
  } catch (error) {
    return Promise.reject(error);
  }
  context = { ...context };
  input = { ...input };
  const key = JSON.stringify([
    context.projectId,
    context.sessionId,
    input.idempotencyKey,
  ]);
  const digest = requestHash(input);
  const existing = inFlight.get(key);
  if (existing)
    return existing.hash === digest
      ? existing.promise
      : Promise.reject(
          new ArtifactError(
            "REVISION_CONFLICT",
            "Idempotency key was already used for a different request.",
            409,
          ),
        );
  const promise = (async () => {
    const attempt = beginBuild(context, input);
    if (attempt.revision) return attempt.revision;
    try {
      const snapshot = readSnapshot(context.workspaceRoot, input.sourcePath);
      persistBuildSnapshot(attempt.id, snapshot.files());
      snapshot.onCapture = (files) => {
        checkCancelled();
        persistBuildSnapshot(attempt.id, files);
      };
      const compiled = await compileArtifact(snapshot, input.sourceKind, {
        signal,
      });
      checkCancelled();
      return commitBuild(context, input, attempt.id, compiled);
    } catch (error) {
      const safe =
        error instanceof ArtifactError
          ? error
          : new ArtifactError("INVALID_SOURCE", "Artifact publication failed.");
      failBuild(attempt.id, safe);
      throw safe;
    }
  })();
  inFlight.set(key, { hash: digest, promise });
  void promise.finally(() => inFlight.delete(key)).catch(() => {});
  return promise;
}

/** Call on startup to rebuild expired jobs from durable captured bytes, never live workspace. */
export async function resumeArtifactBuilds(): Promise<number> {
  const jobs = claimRecoverableBuilds();
  let recovered = 0;
  await Promise.all(
    jobs.map(async (job) => {
      try {
        if (
          publicationPermission(job.context.sessionId, job.input).action ===
          "deny"
        )
          throw new ArtifactError(
            "PERMISSION_DENIED",
            "Current workflow denies recovered artifact publication",
            403,
          );
        const snapshot = new StoredSnapshot(job.input.sourcePath, job.files);
        const compiled = await compileArtifact(snapshot, job.input.sourceKind);
        commitBuild(job.context, job.input, job.id, compiled);
        recovered++;
      } catch (error) {
        if (error instanceof ArtifactError && error.code === "BUILD_BUSY") {
          deferArtifactRecovery(job.id);
          return;
        }
        failBuild(
          job.id,
          error instanceof ArtifactError
            ? error
            : new ArtifactError(
                "INVALID_SOURCE",
                "Interrupted artifact build could not be recovered; publish again.",
              ),
        );
      }
    }),
  );
  return recovered;
}
