/** Client-side resume envelope. The runtime cursor inside stays opaque. */
const PREFIX = "tail-window:";
export type HistoryBoundary = {
  generation: number;
  rows: Partial<Record<"messages" | "runs" | "steps" | "toolCalls" | "events" | "permissions", string>>;
};
export function unpackHistoryCursor(cursor?: string): { cursor?: string; before?: HistoryBoundary } {
  return cursor?.startsWith(PREFIX) ? JSON.parse(cursor.slice(PREFIX.length)) : { cursor };
}
export function resumeHistoryCursor(cursor: string | undefined, before: HistoryBoundary): string {
  const previous = unpackHistoryCursor(cursor);
  return PREFIX + JSON.stringify({
    cursor: previous.cursor,
    before: { generation: before.generation, rows: { ...previous.before?.rows, ...before.rows } },
  });
}
export function historyWindowQuery(cursor?: string, since?: string, preview = false): string {
  const query = new URLSearchParams();
  if (preview) query.set("view", "timeline");
  const resume = unpackHistoryCursor(cursor);
  if (resume.cursor) query.set("cursor", resume.cursor);
  if (resume.before) query.set("before", JSON.stringify(resume.before));
  if (!cursor && since) query.set("since", since);
  return query.size ? `?${query}` : "";
}
