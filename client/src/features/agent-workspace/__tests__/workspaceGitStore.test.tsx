import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  agentRuntimeApi as api,
  type WorkspaceGitChanges,
  type WorkspaceRepositoryGit,
} from "../../../adapters/transport/agentRuntime";
import {
  getWorkspaceGitSnapshot,
  invalidateWorkspaceGit,
  loadWorkspaceGit,
  useWorkspaceGit,
} from "../workspaceGitStore";

const runtime = vi.hoisted(() => ({
  active: true,
  handlers: new Set<{
    events: Record<string, (event: MessageEvent) => void>;
    onConnect?: () => void;
  }>(),
}));

vi.mock("../../../app/layouts/CachedWorkbenchPage", () => ({
  useWorkbenchPageActive: () => runtime.active,
}));
vi.mock("../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: (subscription: Parameters<typeof runtime.handlers.add>[0]) => {
    runtime.handlers.add(subscription);
    return () => runtime.handlers.delete(subscription);
  },
}));

function repository(
  overrides: Partial<WorkspaceRepositoryGit> = {},
): WorkspaceRepositoryGit {
  return {
    rootId: "root",
    name: "Project",
    role: "primary",
    status: "ready",
    workspacePath: "/ws",
    branch: "main",
    headCommitSha: "abc",
    dirty: false,
    additions: 0,
    deletions: 0,
    changedFiles: [],
    revision: "rev-1",
    ...overrides,
  };
}

const changes = (
  repositories: WorkspaceRepositoryGit[],
  revision = "workspace-1",
): WorkspaceGitChanges => ({
  projectId: "project",
  revision,
  unchanged: false,
  repositories,
  refreshedAt: "now",
});

const emit = (type: string, payload: Record<string, unknown>) => {
  act(() => {
    for (const subscriber of runtime.handlers)
      subscriber.events[type]?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  });
};
const advance = async (ms = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  runtime.active = true;
  runtime.handlers.clear();
  invalidateWorkspaceGit();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("loads one workspace snapshot and reuses it for every reader", async () => {
  const getChanges = vi
    .spyOn(api, "getWorkspaceGitChanges")
    .mockResolvedValue(changes([repository()]));

  await loadWorkspaceGit("project");
  await loadWorkspaceGit("project", { maxAgeMs: 120_000 });
  expect(getChanges).toHaveBeenCalledTimes(1);
  expect(getWorkspaceGitSnapshot("project")?.revision).toBe("workspace-1");
});

it("sends the held revision and keeps object identity when the server answers unchanged", async () => {
  const getChanges = vi.spyOn(api, "getWorkspaceGitChanges");
  getChanges.mockResolvedValueOnce(changes([repository()]));
  await loadWorkspaceGit("project");
  const first = getWorkspaceGitSnapshot("project")!;

  getChanges.mockResolvedValueOnce({
    projectId: "project",
    revision: "workspace-1",
    unchanged: true,
    repositories: [],
    refreshedAt: "later",
  });
  invalidateWorkspaceGit("project");
  const next = await loadWorkspaceGit("project");

  expect(getChanges).toHaveBeenLastCalledWith("project", {
    sessionId: undefined,
    revision: "workspace-1",
  });
  expect(next).toBe(first);
  expect(next?.repositories).toBe(first.repositories);
});

it("only replaces the repositories whose revision changed", async () => {
  const getChanges = vi.spyOn(api, "getWorkspaceGitChanges");
  const primary = repository();
  const reference = repository({ rootId: "ref", name: "Docs", role: "reference", revision: "ref-1" });
  getChanges.mockResolvedValueOnce(changes([primary, reference]));
  await loadWorkspaceGit("project");
  const first = getWorkspaceGitSnapshot("project")!;

  const nextReference = { ...reference, revision: "ref-2", dirty: true, changedFiles: [{ path: "a.md", status: "modified", additions: 1, deletions: 0, staged: false, untracked: false }] };
  getChanges.mockResolvedValueOnce(changes([{ ...primary }, nextReference], "workspace-2"));
  invalidateWorkspaceGit("project");
  const next = await loadWorkspaceGit("project");

  expect(next!.repositories[0]).toBe(first.repositories[0]);
  expect(next!.repositories[1]).toBe(nextReference);
});

it("revalidates for events of its own workspace only", async () => {
  const getChanges = vi
    .spyOn(api, "getWorkspaceGitChanges")
    .mockResolvedValue(changes([repository()]));
  renderHook(() => useWorkspaceGit("project"));
  await advance();
  expect(getChanges).toHaveBeenCalledTimes(1);

  emit("session_step_completed", { sessionId: "other", projectId: "another-project" });
  await advance(1_000);
  expect(getChanges).toHaveBeenCalledTimes(1);

  emit("session_step_completed", { sessionId: "s", projectId: "project" });
  await advance(300);
  expect(getChanges).toHaveBeenCalledTimes(2);
});

it("keeps polling slowly while nothing publishes events", async () => {
  const getChanges = vi
    .spyOn(api, "getWorkspaceGitChanges")
    .mockResolvedValue(changes([repository()]));
  renderHook(() => useWorkspaceGit("project"));
  await advance();
  expect(getChanges).toHaveBeenCalledTimes(1);

  await advance(119_000);
  expect(getChanges).toHaveBeenCalledTimes(1);
  await advance(2_000);
  expect(getChanges).toHaveBeenCalledTimes(2);
});

it("does not poll while hidden or while the workbench page is inactive", async () => {
  const getChanges = vi
    .spyOn(api, "getWorkspaceGitChanges")
    .mockResolvedValue(changes([repository()]));
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const hidden = renderHook(() => useWorkspaceGit("project"));
  await advance(120_000);
  expect(getChanges).not.toHaveBeenCalled();

  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  runtime.active = false;
  hidden.rerender();
  invalidateWorkspaceGit("project");
  await advance(120_000);
  expect(getChanges).not.toHaveBeenCalled();

  runtime.active = true;
  hidden.rerender();
  await advance();
  expect(getChanges).toHaveBeenCalledTimes(1);
});
