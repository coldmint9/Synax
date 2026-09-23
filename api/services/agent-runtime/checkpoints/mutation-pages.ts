import { setImmediate as yieldNow } from "node:timers/promises";
import { getRawSqlite } from "../../../db/index.js";
import { historyError } from "./guards.js";

export const FILE_PLAN_BYTES = 1024 * 1024;
export interface HistoryMutation {
  id: string;
  sequence: number;
  owner_session_id: string;
  paths_json: string;
  changes_json: string;
  state: string;
  uncertain: number;
  format_version: number;
  warning: string | null;
}
export function mutationHighWater(): number {
  return (
    getRawSqlite()
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS cursor FROM conversation_mutations",
      )
      .get() as { cursor: number }
  ).cursor;
}
/** Snapshot a finite sequence range. Do not retain historical payloads between
 * rows; only a bounded identity page and one guarded JSON record are resident. */
export async function* mutationPages(
  owner: string,
  after: number,
  through: number,
  foreign = false,
): AsyncGenerator<HistoryMutation> {
  const db = getRawSqlite(),
    ids = db.prepare(
      `SELECT sequence FROM conversation_mutations WHERE owner_session_id${foreign ? "<>" : "="}? AND sequence>? AND sequence<=? AND state<>'reverted' ORDER BY sequence LIMIT ?`,
    );
  const changes = foreign
    ? `CASE WHEN length(CAST(paths_json AS BLOB))<=${FILE_PLAN_BYTES} THEN CASE WHEN json_valid(paths_json) AND json_array_length(paths_json)>0 THEN '[]' ELSE changes_json END ELSE '[]' END`
    : "changes_json";
  const warning = foreign ? "NULL" : "warning";
  const bytes = `length(CAST(id AS BLOB))+length(CAST(owner_session_id AS BLOB))+length(CAST(paths_json AS BLOB))+length(CAST((${changes}) AS BLOB))+COALESCE(length(CAST((${warning}) AS BLOB)),0)+length(CAST(state AS BLOB))`;
  const read = db.prepare(
    `SELECT sequence,uncertain,format_version,CASE WHEN ${bytes}<=${FILE_PLAN_BYTES} THEN id END AS id,CASE WHEN ${bytes}<=${FILE_PLAN_BYTES} THEN owner_session_id END AS owner_session_id,CASE WHEN ${bytes}<=${FILE_PLAN_BYTES} THEN paths_json END AS paths_json,CASE WHEN ${bytes}<=${FILE_PLAN_BYTES} THEN (${changes}) END AS changes_json,CASE WHEN ${bytes}<=${FILE_PLAN_BYTES} THEN (${warning}) END AS warning,CASE WHEN ${bytes}<=${FILE_PLAN_BYTES} THEN state END AS state FROM conversation_mutations WHERE sequence=? AND state<>'reverted'`,
  );
  let cursor = after;
  for (;;) {
    const page = ids.all(owner, cursor, through, 64) as { sequence: number }[];
    if (!page.length) return;
    for (const row of page) {
      cursor = row.sequence;
      const value = read.get(cursor) as HistoryMutation | undefined;
      if (!value) continue;
      if (
        value.id === null ||
        value.changes_json === null ||
        value.paths_json === null
      )
        throw historyError(
          "A mutation record exceeds the bounded file-plan budget. Use recovery/migration tooling before restoring files.",
          "HISTORY_PLAN_LIMIT",
        );
      yield value;
    }
    await yieldNow();
  }
}
export class FilePlanBudget {
  private bytes = 0;
  replace(previous: unknown, next: unknown): void {
    const size = (value: unknown) =>
      value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)) + 64;
    const total = this.bytes - size(previous) + size(next);
    if (total > FILE_PLAN_BYTES)
      throw historyError(
        "File plan exceeds its in-memory response budget; a paged restore plan is required.",
        "HISTORY_PLAN_LIMIT",
      );
    this.bytes = total;
  }
}
