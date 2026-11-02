import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeApi as api,
  type WorkspaceGitChanges,
  type WorkspaceRepositoryGit,
} from "../../../../adapters/transport/agentRuntime";
import { invalidateWorkspaceGit } from "../../../../features/agent-workspace/workspaceGitStore";
import { useGitUnpushed } from "../useGitUnpushed";

vi.mock("../../../../adapters/transport/runtimeEventBus", () => ({
  subscribe: () => () => {},
}));

function repository(overrides: Partial<WorkspaceRepositoryGit> = {}): WorkspaceRepositoryGit {
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

function changes(
  repositories: WorkspaceRepositoryGit[],
  revision = "workspace-1",
): WorkspaceGitChanges {
  return {
    projectId: "project",
    revision,
    unchanged: false,
    repositories,
    refreshedAt: new Date(0).toISOString(),
  };
}

function Probe({ projectId, sessionId }: { projectId: string | null; sessionId?: string | null }) {
  const unpushed = useGitUnpushed(projectId, sessionId);
  return <output data-testid="unpushed">{`${unpushed.count}|${unpushed.since ?? "-"}`}</output>;
}

beforeEach(() => {
  invalidateWorkspaceGit();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGitUnpushed", () => {
  it("reads the selected session checkout instead of the default branch", async () => {
    const getChanges = vi
      .spyOn(api, "getWorkspaceGitChanges")
      .mockImplementation(async (_projectId, options) =>
        changes(
          [
            repository({
              workspacePath: options?.sessionId ? "/isolated" : "/ws",
              unpushedCommitCount: options?.sessionId ? 3 : 0,
              unpushedSince: options?.sessionId ? "2026-10-31T14:32:00+08:00" : null,
            }),
          ],
          options?.sessionId ?? "default",
        ),
      );

    const view = render(<Probe projectId="project-session" sessionId="session-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("unpushed")).toHaveTextContent(
        "3|2026-10-31T14:32:00+08:00",
      ),
    );
    expect(getChanges).toHaveBeenCalledWith("project-session", {
      sessionId: "session-1",
      revision: undefined,
    });

    view.rerender(<Probe projectId="project-session" sessionId={null} />);
    await waitFor(() => expect(screen.getByTestId("unpushed")).toHaveTextContent("0|-"));
  });

  it("stays idle without a project", async () => {
    const getChanges = vi.spyOn(api, "getWorkspaceGitChanges");
    render(<Probe projectId={null} sessionId="session-1" />);
    expect(screen.getByTestId("unpushed")).toHaveTextContent("0|-");
    expect(getChanges).not.toHaveBeenCalled();
  });

  it("reads the primary checkout and ignores reference repositories", async () => {
    vi.spyOn(api, "getWorkspaceGitChanges").mockImplementation(async () =>
      changes([
        repository({
          rootId: "primary",
          unpushedCommitCount: 1,
          unpushedSince: "2026-11-01T14:51:59+08:00",
        }),
        repository({
          rootId: "reference",
          role: "reference",
          unpushedCommitCount: 44,
          unpushedSince: "2026-10-20T09:00:00+08:00",
        }),
      ]),
    );

    render(<Probe projectId="project-roots" />);
    await waitFor(() =>
      expect(screen.getByTestId("unpushed")).toHaveTextContent(
        "1|2026-11-01T14:51:59+08:00",
      ),
    );
  });
});
