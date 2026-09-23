import { getRawSqlite } from "../../../db/index.js";
import { historyError } from "./guards.js";
import { assertBatchInput } from "./version-runtime/batch-input.js";
import type { HistoryRequest } from "./operations.js";
import type { FileChange } from "./files.js";

export interface JournalPayload {
  changes: FileChange[];
  ownerPid: number;
  applied: number;
  request: HistoryRequest;
}
export const FILE_JOURNAL_BYTES = 1024 * 1024;
export function writeFileJournal(
  id: string,
  state: string,
  payload: JournalPayload,
): void {
  try {
    assertBatchInput(payload, FILE_JOURNAL_BYTES);
  } catch {
    throw historyError(
      "Recovery journal exceeds its resource budget; no further file writes were accepted.",
      "HISTORY_PLAN_LIMIT",
    );
  }
  getRawSqlite()
    .prepare(
      "UPDATE conversation_history_operations SET state=?,payload_json=? WHERE id=?",
    )
    .run(state, JSON.stringify(payload), id);
}
