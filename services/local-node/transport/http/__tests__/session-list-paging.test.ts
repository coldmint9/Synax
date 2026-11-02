import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { runtimeFacade } from "../../../modules/agent-runtime/sidecar/runtime-facade.js";

/** Minimal session row as the runtime projection serves it. */
const row = (id: string, updatedAt: string, pinned = false) => ({
  id,
  projectId: "p1",
  parentSessionId: null,
  childSessionIds: [],
  nodeId: null,
  profileId: "planner",
  status: "completed",
  title: id,
  prompt: id,
  contextSnapshotId: null,
  thinkingMode: "standard",
  permissionRules: [],
  skillIds: [],
  mcpServerIds: [],
  createdAt: updatedAt,
  updatedAt,
  completedAt: null,
  resultSummary: null,
  blockedReason: null,
  activeRunId: null,
  pendingResumeToken: null,
  sessionMetadata: pinned ? { pinned: true } : {},
});

const listSessions = async (query: string) =>
  (await agentRuntimeRoutes.request(`http://localhost/sessions?${query}`)).json();

afterEach(() => vi.restoreAllMocks());

describe("session list paging order", () => {
  it("serves pinned rows on the first page even when they are the oldest", async () => {
    vi.spyOn(runtimeFacade, "listSessionProjection").mockResolvedValue([
      row("newest", "2026-10-30T10:00:00.000Z"),
      row("second", "2026-10-30T09:00:00.000Z"),
      row("third", "2026-10-30T08:00:00.000Z"),
      // Pinning preserves `updatedAt`, so this row would sit on a later page.
      row("old-pinned", "2026-01-01T00:00:00.000Z", true),
    ] as never);

    const first = await listSessions("projectId=p1&limit=2&offset=0");
    expect(first.items.map((item: { id: string }) => item.id)).toEqual([
      "old-pinned",
      "newest",
    ]);
    expect(first.items[0].sessionMetadata.pinned).toBe(true);
    expect(first.totalCount).toBe(4);

    const second = await listSessions("projectId=p1&limit=2&offset=2");
    expect(second.items.map((item: { id: string }) => item.id)).toEqual([
      "second",
      "third",
    ]);
  });
});
