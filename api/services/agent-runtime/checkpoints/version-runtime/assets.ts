import { readVersionSnapshot } from "../version-store/read-snapshot.js";
import { getRawSqlite } from "../../../../db/index.js";
import { AgentRuntimeError } from "../../runtime-errors.js";
import type { RuntimeAsset, RuntimeContentPart } from "../../content-parts.js";
import { versionRepository } from "./bridge.js";
import { hashBytes } from "../version-store/hash-codec.js";
import { atomicVersionWrite } from "../version-store/transaction.js";

/** Call after media validation. Registration and root publication must commit
 * together; no checkpoint can observe a binding whose file is unprotected. */
export function bindVersionAssets(
  sessionId: string,
  assets: readonly RuntimeAsset[],
): void {
  const db = getRawSqlite(),
    repo = versionRepository();
  atomicVersionWrite(db, () => {
    const session = db
      .prepare("SELECT project_id FROM agent_runtime_sessions WHERE id=?")
      .get(sessionId) as { project_id: string } | undefined;
    if (!session)
      throw new AgentRuntimeError("Session not found.", "NOT_FOUND", 404);
    const ownership = db.prepare(
      "SELECT project_id FROM agent_runtime_assets WHERE id=?",
    );
    const pending = assets.filter((asset) => {
      if (
        asset.projectId !== session.project_id ||
        (ownership.get(asset.id) as { project_id: string } | undefined)
          ?.project_id !== session.project_id
      )
        throw new AgentRuntimeError(
          "Media belongs to another project.",
          "MEDIA_FORBIDDEN",
          403,
        );
      return !repo.recordReference(sessionId, "assets", asset.id);
    });
    if (!pending.length) return;
    const unique = [
      ...new Map(pending.map((asset) => [asset.id, asset])).values(),
    ];
    repo.putBatch(
      sessionId,
      unique.map((asset) => ({
        table: "assets",
        id: asset.id,
        fields: { assetId: asset.id, projectId: asset.projectId },
      })),
    );
    const insert = db.prepare(
      "INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)",
    );
    for (const asset of unique) {
      const ref = repo.recordReference(sessionId, "assets", asset.id);
      if (!ref)
        throw new Error("Asset publication lost its immutable binding.");
      insert.run(hashBytes(ref), asset.id);
    }
  });
}
export function versionSessionHasAsset(
  sessionId: string,
  assetId: string,
): boolean {
  const db = getRawSqlite();
  return readVersionSnapshot(
    db,
    () =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM agent_runtime_assets a JOIN agent_runtime_sessions s ON s.project_id=a.project_id WHERE a.id=? AND s.id=?",
          )
          .get(assetId, sessionId),
      ) &&
      versionRepository().recordReference(sessionId, "assets", assetId) !==
        undefined,
  );
}

/** History content pins media independently of the active tool-access binding. */
export function retainVersionRecordAssets(
  sessionId: string,
  table: string,
  id: string,
  parts: readonly RuntimeContentPart[],
  authoritySessionId = sessionId,
): void {
  const ids = [
    ...new Set(
      parts
        .filter((part) => part.type !== "text")
        .map((part) => (part as { assetId: string }).assetId),
    ),
  ];
  if (!ids.length) return;
  if (ids.length > 10)
    throw new AgentRuntimeError(
      "Media exceeds ten references per record.",
      "MEDIA_TOO_LARGE",
      413,
    );
  const db = getRawSqlite();
  atomicVersionWrite(db, () => {
    const ref = versionRepository().recordReference(sessionId, table, id);
    if (!ref) throw new Error("Media-bearing record is not published.");
    const project = db
      .prepare("SELECT project_id FROM agent_runtime_sessions WHERE id=?")
      .get(authoritySessionId) as { project_id: string } | undefined;
    if (!project)
      throw new AgentRuntimeError("Session not found.", "NOT_FOUND", 404);
    const asset = db.prepare(
        "SELECT project_id FROM agent_runtime_assets WHERE id=?",
      ),
      insert = db.prepare(
        "INSERT OR IGNORE INTO conversation_v3_asset_refs(object_hash,asset_id) VALUES(?,?)",
      );
    for (const id of ids) {
      if (
        (asset.get(id) as { project_id: string } | undefined)?.project_id !==
        project.project_id
      )
        throw new AgentRuntimeError(
          "Media is missing or belongs to another project.",
          "MEDIA_FORBIDDEN",
          403,
        );
      insert.run(hashBytes(ref), id);
    }
  });
}
