import { diagnosticPage, isDiagnostic, readDiagnostic } from "./diagnostics.js";
import { getRawSqlite } from "../../../../db/index.js";
import { readVersionSnapshot } from "../version-store/read-snapshot.js";
import { boundaryOnlySession, versionRepository } from "./bridge.js";
import { normalizeVersionEntity } from "./entities.js";

/** A coherent, replaceable transcript window, NOT independently paged slices.
 * At most 24 messages, 48 steps, 96 tools, 48 runs and 32 events/permissions.
 * All projections and related reads observe the same short SQLite snapshot. */
export function readHistoryWindow(sessionId: string, cursor?: string) {
  return readVersionSnapshot(getRawSqlite(), () => {
    const repo = versionRepository(),
      head = repo.head(sessionId);
    const page = repo.page(sessionId, "messages", {
      limit: 24,
      maxBytes: 768 * 1024,
      reverse: true,
      preview: true,
      cursor,
    });
    const messages = page.items.reverse();
    const boundary = boundaryOnlySession(sessionId);
    const detailPage = (
      kind: string,
      options: Parameters<typeof repo.page>[2],
    ) =>
      boundary && isDiagnostic(kind)
        ? (() => {
            const result = diagnosticPage(sessionId, kind, {
              limit: options?.limit,
              scope: options?.scope,
              preview: true,
            });
            return {
              items: result.items.reverse(),
              next: result.truncated ? "more" : undefined,
            };
          })()
        : repo.page(sessionId, kind, options);
    const steps = new Map<string, Record<string, unknown>>();
    const runs = new Map<string, Record<string, unknown>>();
    const tools: Record<string, unknown>[] = [];
    let detailsTruncated = false;
    let remainingBytes =
      2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(messages)) - 4096;
    const retain = (row: Record<string, unknown>) => {
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (bytes > remainingBytes) {
        detailsTruncated = true;
        return false;
      }
      remainingBytes -= bytes;
      return true;
    };
    const add = (
      kind: string,
      id: unknown,
      target: Map<string, Record<string, unknown>>,
    ) => {
      if (typeof id !== "string" || target.has(id)) return;
      const row =
        boundary && isDiagnostic(kind)
          ? readDiagnostic(sessionId, kind, id, true)
          : repo.previewRecord(sessionId, kind, id);
      if (row && retain(row))
        target.set(id, normalizeVersionEntity(kind, row, head.epoch));
    };
    for (const message of messages) {
      add("steps", message.stepId, steps);
      add("runs", message.runId, runs);
    }
    // A currently executing step might not yet have an assistant message.
    // Never mix today's executing steps into a historical page.
    if (!cursor) {
      const tail = detailPage("steps", {
        reverse: true,
        preview: true,
        limit: 24,
      });
      const earliest = String(messages[0]?.createdAt ?? "");
      for (const row of tail.items) {
        if (
          String(row.startedAt ?? "") >= earliest &&
          !steps.has(String(row.id)) &&
          retain(row)
        )
          steps.set(
            String(row.id),
            normalizeVersionEntity("steps", row, head.epoch),
          );
      }
      detailsTruncated ||= Boolean(tail.next);
    }
    for (const step of steps.values()) {
      add("runs", step.runId, runs);
      if (tools.length >= 96) {
        detailsTruncated = true;
        break;
      }
      const related = detailPage("tools", {
        scope: { field: "stepId", value: String(step.id) },
        reverse: true,
        preview: true,
        limit: Math.min(16, 96 - tools.length),
      });
      tools.push(
        ...related.items
          .reverse()
          .filter(retain)
          .map((row) => normalizeVersionEntity("tools", row, head.epoch)),
      );
      detailsTruncated ||= Boolean(related.next);
    }
    const recent = (kind: string) =>
      detailPage(kind, {
        reverse: true,
        preview: true,
        limit: 32,
        maxBytes: 512 * 1024,
      })
        .items.reverse()
        .filter(retain)
        .map((row) => normalizeVersionEntity(kind, row, head.epoch));
    return {
      messages,
      steps: [...steps.values()],
      runs: [...runs.values()],
      toolCalls: tools,
      events: cursor ? [] : recent("events"),
      permissions: cursor ? [] : recent("permissions"),
      historyWindow: {
        revision: head.revision,
        epoch: head.epoch,
        cursor,
        olderCursor: page.next,
        hasEarlier: Boolean(page.next),
        latest: !cursor,
        detailsTruncated,
      },
    };
  });
}
