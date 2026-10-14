import { closeDb, getRawSqlite } from "../../local-node/infrastructure/database/index.js";
import {
  journalWriteLockPolicy,
  retryWriteLockAcquisition,
} from "../../local-node/infrastructure/database/write-contention.js";
import { runWithExecutionContext } from "../../local-node/infrastructure/runtime/execution-context.js";
import { historyEpoch } from "../../local-node/modules/agent-runtime/checkpoints/guards.js";
import { runtimeJournal } from "../../local-node/modules/agent-runtime/runtime-journal.js";
import type { JournalWrite } from "../../local-node/modules/agent-runtime/journal-writer.js";

// The host has already initialized the schema. This child performs synchronous
// transactions serially, keeping SQLite busy waits off the HTTP event loop.
// Because no event loop is served here, a contended write lock is waited out
// instead of reported: failing it would quarantine the whole Run.
const lockPolicy = journalWriteLockPolicy();
let lockWaitApplied = false;

/** The shared connection budget is tuned for the host's event loop, so this
 * process sets its own once the schema is open. */
function openDatabase() {
  const db = getRawSqlite();
  if (!lockWaitApplied) {
    lockWaitApplied = true;
    db.exec(`PRAGMA busy_timeout = ${lockPolicy.waitMs}`);
  }
  return db;
}

process.on("message", (request: JournalWrite) => {
  // Set before the first statement of an attempt, so a lock failure that happens
  // after writing is never replayed: it may already be durable.
  let wrote = false;
  try {
    runWithExecutionContext(request.context, () =>
      retryWriteLockAcquisition(
        lockPolicy,
        () =>
          openDatabase().transaction(() => {
            if (historyEpoch(request.sessionId) !== request.revision)
              throw new Error("Obsolete conversation execution.");
            wrote = true;
            runtimeJournal.appendBatch(
              request.sessionId,
              request.runId,
              request.chunks,
            );
          })(),
        () => wrote,
      ),
    );
    process.send?.({ id: request.id });
  } catch (error) {
    process.send?.({
      id: request.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

process.on("disconnect", () => {
  closeDb();
  process.exit(0);
});
