import { createHash } from "node:crypto";
import type Database from "libsql";
import { VersionObjects } from "./objects.js";
import { VersionStoreError, assertObjectId } from "./limits.js";
import { atomicVersionWrite } from "./transaction.js";
import { hashBytes } from "./hash-codec.js";
import { readVersion } from "./versions.js";

export interface HeadState {
  sessionId: string;
  versionId: string;
  revision: number;
  epoch: number;
}
export interface PublishVersion {
  sessionId: string;
  versionId: string;
  expectedRevision: number;
  expectedEpoch: number;
}
interface IdempotentRequest {
  expectedRevision: number;
  requestId: string;
  requestHash: string;
}
export interface SwitchVersion extends IdempotentRequest {
  sessionId: string;
  targetVersionId: string;
}
export interface ForkVersion extends IdempotentRequest {
  sourceSessionId: string;
  targetSessionId: string;
  versionId: string;
}

function assertIdentity(value: string): void {
  if (
    typeof value !== "string" ||
    !value.length ||
    !value.isWellFormed() ||
    value.includes("\0") ||
    Buffer.byteLength(value) > 256
  )
    throw new VersionStoreError(
      "VERSION_IDENTITY_INVALID",
      "Invalid session or request identity.",
    );
}
function assertCounter(value: number, minimum = 0): void {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value >= Number.MAX_SAFE_INTEGER
  )
    throw new VersionStoreError(
      "VERSION_REVISION_INVALID",
      "Invalid revision or epoch counter.",
    );
}
function fingerprint(
  request: IdempotentRequest,
  fields: readonly string[],
): string {
  assertIdentity(request.requestId);
  assertObjectId(request.requestHash, "request hash");
  assertCounter(request.expectedRevision);
  // Bind our actual arguments as well as the caller's hash: a dishonest/stale
  // caller cannot reuse a request id with a different target but the same hash.
  return createHash("sha256")
    .update(
      JSON.stringify([
        ...fields,
        request.expectedRevision,
        request.requestHash,
      ]),
    )
    .digest("hex");
}

/** Trusted repository boundary, not a public API. Route authorization and active
 * process/file fences must also pass before invoking history operations. */
export class VersionHeads {
  private readonly find;
  private readonly insert;
  private readonly own;
  private readonly isOwned;
  private readonly cas;
  private readonly prior;
  private readonly saveResult;

  constructor(
    private readonly db: Database.Database,
    private readonly objects: VersionObjects,
  ) {
    if (objects.db !== db)
      throw new TypeError(
        "Heads and objects require the same database connection.",
      );
    this.find = db.prepare<[string]>(
      "SELECT lower(hex(version_id)) AS version_id,revision,epoch FROM conversation_v3_heads WHERE session_id=?",
    );
    this.insert = db.prepare<[string, Uint8Array]>(
      "INSERT INTO conversation_v3_heads(session_id,version_id) VALUES(?,?)",
    );
    this.own = db.prepare<[string, Uint8Array]>(
      "INSERT OR IGNORE INTO conversation_v3_owned_versions(session_id,version_id) VALUES(?,?)",
    );
    this.isOwned = db.prepare<[string, Uint8Array]>(
      "SELECT 1 AS present FROM conversation_v3_owned_versions WHERE session_id=? AND version_id=?",
    );
    this.cas = db.prepare<[Uint8Array, number, string, number, number]>(
      "UPDATE conversation_v3_heads SET version_id=?,revision=revision+1,epoch=? WHERE session_id=? AND revision=? AND epoch=?",
    );
    this.prior = db.prepare<[string, string]>(
      "SELECT lower(hex(body_hash)) AS body_hash,result_session_id,lower(hex(result_version_id)) AS result_version_id,result_revision,result_epoch FROM conversation_v3_operations WHERE session_id=? AND request_id=?",
    );
    this.saveResult = db.prepare<
      [string, string, Uint8Array, string, Uint8Array, number, number]
    >(
      "INSERT INTO conversation_v3_operations(session_id,request_id,body_hash,result_session_id,result_version_id,result_revision,result_epoch) VALUES(?,?,?,?,?,?,?)",
    );
  }

  read(sessionId: string): HeadState {
    assertIdentity(sessionId);
    const row = this.find.get(sessionId) as
      | { version_id: string; revision: number; epoch: number }
      | undefined;
    if (!row)
      throw new VersionStoreError(
        "VERSION_SESSION_MISSING",
        "Versioned session does not exist.",
      );
    return {
      sessionId,
      versionId: row.version_id,
      revision: row.revision,
      epoch: row.epoch,
    };
  }

  create(sessionId: string, versionId: string): HeadState {
    assertIdentity(sessionId);
    return atomicVersionWrite(this.db, () => {
      readVersion(this.objects, versionId);
      if (this.find.get(sessionId))
        throw new VersionStoreError(
          "VERSION_SESSION_EXISTS",
          "Versioned session already exists.",
        );
      this.insert.run(sessionId, hashBytes(versionId));
      this.own.run(sessionId, hashBytes(versionId));
      return { sessionId, versionId, revision: 0, epoch: 1 };
    });
  }

  /** Only the fenced runtime writer may adopt a newly constructed state. */
  publish(request: PublishVersion): HeadState {
    assertCounter(request.expectedRevision);
    assertCounter(request.expectedEpoch, 1);
    return atomicVersionWrite(this.db, () => {
      const current = this.read(request.sessionId);
      this.checkRevision(current, request.expectedRevision);
      if (current.epoch !== request.expectedEpoch)
        throw new VersionStoreError(
          "VERSION_EPOCH_STALE",
          "Writer epoch has been superseded.",
        );
      readVersion(this.objects, request.versionId);
      this.own.run(request.sessionId, hashBytes(request.versionId));
      return this.advance(current, request.versionId, current.epoch);
    });
  }

  /** Retry lookup before resolving a possibly collected checkpoint. The caller's
   * hash must bind its full checkpoint request, not only the destination version. */
  retrySwitch(
    request: IdempotentRequest & { sessionId: string },
  ): HeadState | undefined {
    assertIdentity(request.sessionId);
    const row = this.prior.get(request.sessionId, request.requestId) as
      | { result_version_id: string }
      | undefined;
    if (!row) return undefined;
    const bodyHash = fingerprint(request, [
      "switch",
      request.sessionId,
      row.result_version_id,
    ]);
    return this.result(request.sessionId, request.requestId, bodyHash);
  }

  switch(request: SwitchVersion): HeadState {
    assertIdentity(request.sessionId);
    assertObjectId(request.targetVersionId);
    const bodyHash = fingerprint(request, [
      "switch",
      request.sessionId,
      request.targetVersionId,
    ]);
    return atomicVersionWrite(this.db, () => {
      const previous = this.result(
        request.sessionId,
        request.requestId,
        bodyHash,
      );
      if (previous) return previous;
      const current = this.read(request.sessionId);
      this.checkRevision(current, request.expectedRevision);
      this.checkOwned(request.sessionId, request.targetVersionId);
      const result = this.advance(
        current,
        request.targetVersionId,
        current.epoch + 1,
      );
      this.record(request.sessionId, request.requestId, bodyHash, result);
      return result;
    });
  }

  fork(request: ForkVersion): HeadState {
    assertIdentity(request.sourceSessionId);
    assertIdentity(request.targetSessionId);
    assertObjectId(request.versionId);
    const bodyHash = fingerprint(request, [
      "fork",
      request.sourceSessionId,
      request.targetSessionId,
      request.versionId,
    ]);
    return atomicVersionWrite(this.db, () => {
      const previous = this.result(
        request.sourceSessionId,
        request.requestId,
        bodyHash,
      );
      if (previous) return previous;
      this.checkRevision(
        this.read(request.sourceSessionId),
        request.expectedRevision,
      );
      this.checkOwned(request.sourceSessionId, request.versionId);
      const result = this.create(request.targetSessionId, request.versionId);
      this.record(request.sourceSessionId, request.requestId, bodyHash, result);
      return result;
    });
  }

  private checkRevision(current: HeadState, expected: number): void {
    if (current.revision !== expected)
      throw new VersionStoreError(
        "VERSION_REVISION_STALE",
        "Session revision changed; refresh the checkpoint preview.",
      );
  }

  private checkOwned(sessionId: string, versionId: string): void {
    if (!this.isOwned.get(sessionId, hashBytes(versionId)))
      throw new VersionStoreError(
        "VERSION_ROOT_NOT_OWNED",
        "Target version is not owned by this session.",
      );
    readVersion(this.objects, versionId);
  }

  private advance(
    current: HeadState,
    versionId: string,
    epoch: number,
  ): HeadState {
    assertCounter(current.revision);
    assertCounter(epoch, 1);
    if (
      !this.cas.run(
        hashBytes(versionId),
        epoch,
        current.sessionId,
        current.revision,
        current.epoch,
      ).changes
    )
      throw new VersionStoreError(
        "VERSION_REVISION_STALE",
        "Session revision changed before root publication.",
      );
    return {
      sessionId: current.sessionId,
      versionId,
      revision: current.revision + 1,
      epoch,
    };
  }

  private result(
    sessionId: string,
    requestId: string,
    bodyHash: string,
  ): HeadState | undefined {
    const row = this.prior.get(sessionId, requestId) as
      | {
          body_hash: string;
          result_session_id: string;
          result_version_id: string;
          result_revision: number;
          result_epoch: number;
        }
      | undefined;
    if (!row) return undefined;
    if (row.body_hash !== bodyHash)
      throw new VersionStoreError(
        "VERSION_REQUEST_CONFLICT",
        "Request identity was already used for a different operation.",
      );
    return {
      sessionId: row.result_session_id,
      versionId: row.result_version_id,
      revision: row.result_revision,
      epoch: row.result_epoch,
    };
  }

  private record(
    sessionId: string,
    requestId: string,
    bodyHash: string,
    result: HeadState,
  ): void {
    this.saveResult.run(
      sessionId,
      requestId,
      hashBytes(bodyHash),
      result.sessionId,
      hashBytes(result.versionId),
      result.revision,
      result.epoch,
    );
  }
}
