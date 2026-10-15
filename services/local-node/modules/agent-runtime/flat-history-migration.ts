import { getRawSqlite } from "../../infrastructure/database/index.js";
import { SIMPLE_HISTORY_STORAGE } from "../../infrastructure/runtime/env.js";
import { agentRuntimeStore, mapLegacyHistoryRow } from "./session-store.js";
import {
  versionedSession,
  versionRepository,
  boundaryOnlySession,
  appendOnlySession,
} from "./checkpoints/version-runtime/bridge.js";
import {
  diagnosticTables,
  isDiagnostic,
} from "./checkpoints/version-runtime/diagnostics.js";
import { normalizeVersionEntity } from "./checkpoints/version-runtime/entities.js";
import {
  assertHistoryIdle,
  assertHistoryUnlocked,
} from "./checkpoints/guards.js";
import {
  initializeSimpleHistory,
  simpleHistorySession,
} from "./simple-history.js";
import { transcriptRepository } from "./transcript-repository.js";
import { AgentRuntimeError } from "./runtime-errors.js";

const tables: Record<string, string> = {
  messages: "agent_runtime_messages",
  ...diagnosticTables,
};
const camel = (column: string) =>
  column
    .replace(/_json$/, "")
    .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** Only the visible branch is materialized. All work and publication occur in
 * one transaction, so interruption leaves the old backend authoritative. */
export function migrateFlatHistory(sessionId: string): {
  migrated: boolean;
  backend: string;
} {
  if (simpleHistorySession(sessionId))
    return { migrated: false, backend: "sqlite-flat" };
  const db = getRawSqlite();
  return db.transaction(() => {
    const session = agentRuntimeStore.getSession(sessionId);
    assertHistoryUnlocked(sessionId, []);
    const versioned = versionedSession(sessionId);
    const transcript = Boolean(
      db
        .prepare("SELECT 1 FROM transcript_heads WHERE session_id=?")
        .get(sessionId),
    );
    if (versioned || transcript) assertHistoryIdle(sessionId);
    const historical = versioned
      ? versionRepository().readSession(sessionId)
      : undefined;
    const metadata = {
      ...session.sessionMetadata,
      ...((historical?.sessionMetadata as Record<string, unknown>) ?? {}),
    };
    // Authorization, workspace and live-control fields always come from current state.
    for (const name of [
      "backend",
      "permissionTier",
      "permissionOverrides",
      "runtimeControl",
    ]) {
      if (session.sessionMetadata && name in session.sessionMetadata)
        metadata[name] = session.sessionMetadata[name];
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM conversation_history_operations WHERE session_id=? AND state NOT IN ('committed','aborted')",
        )
        .get(sessionId)
    )
      throw new AgentRuntimeError(
        "Finish history recovery before converting storage.",
        "HISTORY_RECOVERY_REQUIRED",
        409,
      );
    db.exec(
      "CREATE TEMP TABLE IF NOT EXISTS flat_conversion_rows(kind TEXT,id TEXT,payload TEXT,PRIMARY KEY(kind,id)); DELETE FROM flat_conversion_rows;",
    );
    const stage = db.prepare(
      "INSERT INTO flat_conversion_rows(kind,id,payload) VALUES(?,?,?)",
    );
    if (versioned) {
      const repo = versionRepository(),
        head = repo.head(sessionId);
      const light = boundaryOnlySession(sessionId),
        appendOnly = appendOnlySession(sessionId);
      for (const [kind, table] of Object.entries(tables)) {
        if (
          kind !== "messages" &&
          light &&
          (isDiagnostic(kind) || appendOnly)
        ) {
          // Read bounded raw pages and retain only locators visible at this head.
          const epochs = repo.runtimeEpochs(sessionId);
          const legacy = (
            db
              .prepare(
                "SELECT legacy_runtime FROM conversation_v3_heads WHERE session_id=?",
              )
              .get(sessionId) as { legacy_runtime: number }
          ).legacy_runtime;
          let after = 0;
          for (;;) {
            const rows = db
              .prepare(
                `SELECT t.rowid AS _rowid,t.*,r.epoch AS _epoch,r.sequence AS _sequence FROM ${table} t
              LEFT JOIN conversation_v3_runtime_records r ON r.session_id=t.session_id AND r.kind=? AND r.record_id=t.id
              WHERE t.session_id=? AND t.rowid>? ORDER BY t.rowid LIMIT 64`,
              )
              .all(kind, sessionId, after) as Record<string, unknown>[];
            if (!rows.length) break;
            for (const row of rows) {
              after = Number(row._rowid);
              if (
                row._epoch == null
                  ? !legacy
                  : !epochs.some(
                      (range) =>
                        range.epoch === row._epoch &&
                        Number(row._sequence) <= range.through,
                    )
              )
                continue;
              const value = normalizeVersionEntity(
                kind,
                {
                  ...mapLegacyHistoryRow(table, row),
                  __synaxExecutionEpoch: row._epoch ?? 0,
                },
                head.epoch,
              );
              stage.run(kind, String(value.id), JSON.stringify(value));
            }
          }
        } else {
          let cursor: string | undefined,
            sequence = 0;
          do {
            const page = repo.page(sessionId, kind, {
              cursor,
              limit: 64,
              fields: ["id"],
            });
            for (const identity of page.items) {
              const value = repo.get(
                sessionId,
                kind,
                String(identity.id),
                32 * 1024 * 1024,
              )!;
              if (kind === "messages") value.sequence = ++sequence;
              stage.run(
                kind,
                String(value.id),
                JSON.stringify(normalizeVersionEntity(kind, value, head.epoch)),
              );
            }
            cursor = page.next;
          } while (cursor);
        }
      }
      let assetCursor: string | undefined;
      do {
        const page = repo.page(sessionId, "assets", {
          cursor: assetCursor,
          limit: 64,
        });
        for (const asset of page.items) {
          if (typeof asset.assetId === "string")
            stage.run("assets", asset.assetId, "{}");
        }
        assetCursor = page.next;
      } while (assetCursor);
      for (const table of [
        "conversation_v3_history_requests",
        "conversation_v3_operations",
        "conversation_v3_owned_versions",
      ])
        db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
      db.prepare(
        "DELETE FROM conversation_v3_pins WHERE owner=? AND kind='checkpoint'",
      ).run(sessionId);
      db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(
        sessionId,
      );
      db.prepare(
        "DELETE FROM conversation_v3_runtime_records WHERE session_id=?",
      ).run(sessionId);
    } else if (transcript) {
      // This older format is bounded to 64 KiB records; read one at a time.
      let after = 0,
        sequence = 0;
      for (;;) {
        const ids = db
          .prepare(
            "SELECT message_id,sequence FROM transcript_records WHERE session_id=? AND visible=1 AND sequence>? ORDER BY sequence LIMIT 64",
          )
          .all(sessionId, after) as { message_id: string; sequence: number }[];
        if (!ids.length) break;
        for (const row of ids) {
          const value = transcriptRepository.jsonlMessage(
            sessionId,
            row.message_id,
          );
          if (!value) throw new Error("Missing committed transcript record");
          stage.run(
            "messages",
            value.id,
            JSON.stringify({ ...value, sequence: ++sequence }),
          );
          after = row.sequence;
        }
      }
    }
    for (const row of db
      .prepare("SELECT id FROM flat_conversion_rows WHERE kind='assets'")
      .all() as { id: string }[])
      db.prepare(
        "INSERT OR IGNORE INTO agent_runtime_asset_sessions(asset_id,session_id) VALUES(?,?)",
      ).run(row.id, sessionId);
    // Disable undo capture before replacing current rows; never retain a deleted suffix.
    db.prepare(
      "DELETE FROM conversation_history_tracking WHERE session_id=?",
    ).run(sessionId);
    for (const [kind, table] of Object.entries(tables)) {
      if (!versioned && !(transcript && kind === "messages")) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
      let after = "";
      for (;;) {
        const rows = db
          .prepare(
            "SELECT id,payload FROM flat_conversion_rows WHERE kind=? AND id>? ORDER BY id LIMIT 64",
          )
          .all(kind, after) as { id: string; payload: string }[];
        if (!rows.length) break;
        for (const row of rows) {
          const value = JSON.parse(row.payload);
          const fields: Record<string, unknown> = {};
          for (const column of columns) {
            const name = column.name;
            if (name === "version_epoch") {
              fields[name] = null;
              continue;
            }
            const property = name === "step_index" ? "index" : camel(name);
            let input = value[property];
            if (name === "project_id") input ??= session.projectId;
            if (name === "session_id") input = sessionId;
            if (name === "payload_json" && kind === "work") input = value;
            if (input === undefined) {
              if (column.dflt_value !== null) continue;
              if (column.notnull)
                throw new Error(
                  `Missing ${kind}.${property} during history conversion`,
                );
              input = null;
            }
            fields[name] =
              name.endsWith("_json") && input !== null
                ? JSON.stringify(input)
                : input;
          }
          const keys = Object.keys(fields);
          db.prepare(
            `INSERT INTO ${table} (${keys.map((key) => `"${key}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
          ).run(...Object.values(fields));
          after = row.id;
        }
      }
    }
    for (const table of [
      "conversation_history_journal",
      "conversation_checkpoints",
      "conversation_history_operations",
      "conversation_mutations",
      "conversation_history_access",
    ])
      db.prepare(
        `DELETE FROM ${table} WHERE ${table === "conversation_mutations" ? "owner_session_id" : "session_id"}=?`,
      ).run(sessionId);
    db.prepare("DELETE FROM transcript_records WHERE session_id=?").run(
      sessionId,
    );
    db.prepare("DELETE FROM transcript_heads WHERE session_id=?").run(
      sessionId,
    );
    db.prepare("DELETE FROM session_history_storage WHERE session_id=?").run(
      sessionId,
    );
    const oldMigration = db
      .prepare(
        "SELECT staging_id FROM conversation_v3_migrations WHERE session_id=? AND state<>'copying'",
      )
      .get(sessionId) as { staging_id: string } | undefined;
    if (oldMigration && oldMigration.staging_id !== sessionId) {
      db.prepare(
        "DELETE FROM conversation_v3_owned_versions WHERE session_id=?",
      ).run(oldMigration.staging_id);
      db.prepare("DELETE FROM conversation_v3_heads WHERE session_id=?").run(
        oldMigration.staging_id,
      );
    }
    db.prepare("DELETE FROM conversation_v3_migrations WHERE session_id=?").run(
      sessionId,
    );
    db.prepare("DELETE FROM jsonl_history_migrations WHERE session_id=?").run(
      sessionId,
    );
    db.prepare("DELETE FROM jsonl_checkpoint_aliases WHERE session_id=?").run(
      sessionId,
    );
    db.prepare("UPDATE jsonl_payload_segments SET sealed=1 WHERE owner=?").run(
      sessionId,
    );
    db.prepare("DELETE FROM jsonl_payload_heads WHERE owner=?").run(sessionId);
    if (versioned)
      metadata.historyRollbackEnabled =
        session.sessionMetadata?.historyRollbackEnabled !== false &&
        !session.sessionMetadata?.fork;
    if (!versioned && !transcript) {
      db.prepare(
        `WITH ordered AS MATERIALIZED (SELECT id,row_number() OVER(ORDER BY sequence,created_at,rowid) AS n FROM agent_runtime_messages WHERE session_id=?)
        UPDATE agent_runtime_messages SET sequence=(SELECT n FROM ordered WHERE ordered.id=agent_runtime_messages.id) WHERE session_id=?`,
      ).run(sessionId, sessionId);
    }
    metadata.historyStorage = "sqlite-flat";
    metadata.historyPayloadStorage = "sqlite";
    if (historical) {
      session.prompt = String(historical.prompt ?? session.prompt);
      session.resultSummary = historical.resultSummary as string | null;
      session.contextSnapshotId = historical.contextSnapshotId as string | null;
    }
    db.prepare(
      "UPDATE agent_runtime_sessions SET prompt=?,result_summary=?,context_snapshot_id=?,session_metadata_json=? WHERE id=?",
    ).run(
      session.prompt,
      session.resultSummary,
      session.contextSnapshotId,
      JSON.stringify(metadata),
      sessionId,
    );
    initializeSimpleHistory(sessionId);
    db.exec("DELETE FROM flat_conversion_rows");
    return { migrated: true, backend: "sqlite-flat" };
  })();
}
/** Ordinary active legacy/versioned sessions keep their original reader until idle. */
export function prepareFlatHistory(sessionId: string): void {
  if (!SIMPLE_HISTORY_STORAGE || simpleHistorySession(sessionId)) return;
  const session = agentRuntimeStore.getSession(sessionId);
  if (
    [
      "running",
      "queued",
      "waiting_permission",
      "waiting_input",
      "stopping",
    ].includes(session.status) ||
    session.sessionMetadata?.runtimeControl
  )
    return;
  try {
    migrateFlatHistory(sessionId);
  } catch (error) {
    if (
      ["HISTORY_SESSION_BUSY", "HISTORY_PROCESS_ACTIVE"].includes(
        (error as { code?: string }).code ?? "",
      )
    )
      return;
    throw error;
  }
}
