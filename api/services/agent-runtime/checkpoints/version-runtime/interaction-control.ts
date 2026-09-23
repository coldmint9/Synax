import { getRawSqlite } from "../../../../db/index.js";
import type { AgentInteraction } from "../../control-contracts.js";
import { AgentRuntimeError } from "../../runtime-errors.js";
import { readVersionEntity, writeVersionEntity } from "./entities.js";
import { versionRepository, versionedSession } from "./bridge.js";

/** Replies are authority-bearing writes: require live epoch AND branch membership
 * before returning data to the caller that may approve a plan or resume a run. */
export function currentVersionInteraction(
  sessionId: string,
  id: string,
): AgentInteraction {
  const row = getRawSqlite()
    .prepare(
      "SELECT version_epoch FROM agent_runtime_interactions WHERE session_id=? AND id=?",
    )
    .get(sessionId, id) as { version_epoch: number | null } | undefined;
  if (!row)
    throw new AgentRuntimeError("Interaction not found.", "NOT_FOUND", 404);
  if (row.version_epoch !== versionRepository().head(sessionId).epoch)
    throw new AgentRuntimeError(
      "Interaction belongs to an obsolete history epoch.",
      "INTERACTION_CONFLICT",
      409,
    );
  return readVersionEntity<AgentInteraction>(sessionId, "interactions", id);
}

export function persistInteraction(
  value: AgentInteraction,
  write: () => void,
): void {
  if (versionedSession(value.sessionId))
    writeVersionEntity(value.sessionId, "interactions", value.id, value, () => {
      write();
      return value;
    });
  else write();
}

export function pendingVersionInteraction(
  sessionId: string,
): AgentInteraction | null {
  const row = getRawSqlite()
    .prepare(
      "SELECT id FROM agent_runtime_interactions WHERE session_id=? AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?) AND status='pending' AND consumed_at IS NULL LIMIT 1",
    )
    .get(sessionId, sessionId) as { id: string } | undefined;
  return row ? currentVersionInteraction(sessionId, row.id) : null;
}
export function readyVersionInteraction(
  sessionId: string,
  runId: string,
): AgentInteraction | null {
  const row = getRawSqlite()
    .prepare(
      "SELECT id FROM agent_runtime_interactions WHERE session_id=? AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?) AND run_id=? AND status<>'pending' AND response_json IS NOT NULL AND consumed_at IS NULL ORDER BY rowid DESC LIMIT 1",
    )
    .get(sessionId, sessionId, runId) as { id: string } | undefined;
  return row ? currentVersionInteraction(sessionId, row.id) : null;
}
export function cancelVersionInteractions(
  sessionId: string,
  now: string,
): void {
  const db = getRawSqlite();
  db.transaction(() => {
    // Materialize only bounded identities; large request bodies are read one by one.
    const rows = db
      .prepare(
        "SELECT id FROM agent_runtime_interactions WHERE session_id=? AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?) AND consumed_at IS NULL ORDER BY id LIMIT 256",
      )
      .all(sessionId, sessionId) as { id: string }[];
    if (
      rows.length === 256 &&
      db
        .prepare(
          "SELECT 1 FROM agent_runtime_interactions WHERE session_id=? AND version_epoch=(SELECT epoch FROM conversation_v3_heads WHERE session_id=?) AND consumed_at IS NULL AND id>? LIMIT 1",
        )
        .get(sessionId, sessionId, rows.at(-1)!.id)
    )
      throw new AgentRuntimeError(
        "Too many unresolved interactions; bounded recovery is required.",
        "INTERACTION_RECOVERY_REQUIRED",
        409,
      );
    for (const row of rows) {
      const value = currentVersionInteraction(sessionId, row.id);
      persistInteraction(
        { ...value, status: "cancelled", resolvedAt: now },
        () => {
          db.prepare(
            "UPDATE agent_runtime_interactions SET status='cancelled',resolved_at=?,consumed_at=? WHERE id=? AND session_id=?",
          ).run(now, now, row.id, sessionId);
        },
      );
    }
  })();
}
