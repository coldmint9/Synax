import { closeDb, getRawSqlite } from "../../local-node/infrastructure/database/index.js";
import { runWithExecutionContext } from "../../local-node/infrastructure/runtime/execution-context.js";
import { historyEpoch } from "../../local-node/modules/agent-runtime/checkpoints/guards.js";
import { runtimeJournal } from "../../local-node/modules/agent-runtime/runtime-journal.js";
import type { JournalWrite } from "../../local-node/modules/agent-runtime/journal-writer.js";

// The host has already initialized the schema. This child performs synchronous
// transactions serially, keeping SQLite busy waits off the HTTP event loop.
process.on("message", (request: JournalWrite) => {
  try {
    runWithExecutionContext(request.context, () => getRawSqlite().transaction(() => {
      if (historyEpoch(request.sessionId) !== request.revision)
        throw new Error("Obsolete conversation execution.");
      runtimeJournal.appendBatch(request.sessionId, request.runId, request.chunks);
    })());
    process.send?.({ id: request.id });
  } catch (error) {
    process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
process.on("disconnect", () => { closeDb(); process.exit(0); });
