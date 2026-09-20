import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  SessionEnvironment,
  SessionEnvironmentFile,
} from "../../../../lib/api/agentRuntime";

const getSessionEnvironment = vi.fn();
const openWorkspaceDiff = vi.fn();

vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    getSessionEnvironment: (...args: unknown[]) =>
      getSessionEnvironment(...args),
  },
}));

vi.mock("../state/sessionWorkspaceStore", () => ({
  openWorkspaceDiff: (...args: unknown[]) => openWorkspaceDiff(...args),
}));

const { SessionFileChangeIsland } = await import("../SessionFileChangeIsland");

function file(
  overrides: Partial<SessionEnvironmentFile> = {},
): SessionEnvironmentFile {
  return {
    path: "src/app.ts",
    status: "modified",
    additions: 6,
    deletions: 1,
    staged: false,
    untracked: false,
    ...overrides,
  };
}

function environment(
  agentChangedFiles: SessionEnvironmentFile[],
): SessionEnvironment {
  return {
    sessionId: "sess-1",
    projectId: "p1",
    workspacePath: "/tmp/ws",
    branch: "main",
    headCommitSha: "abc",
    dirty: agentChangedFiles.length > 0,
    additions: agentChangedFiles.reduce((sum, f) => sum + f.additions, 0),
    deletions: agentChangedFiles.reduce((sum, f) => sum + f.deletions, 0),
    changedFiles: agentChangedFiles,
    agentChangedFiles,
    inputFiles: [],
    subagents: [],
    refreshedAt: "2026-01-01T00:00:00Z",
  };
}

async function renderIsland() {
  const utils = render(
    <SessionFileChangeIsland sessionId="sess-1" isRunning={false} />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe("SessionFileChangeIsland", () => {
  beforeEach(() => {
    getSessionEnvironment.mockReset();
    openWorkspaceDiff.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing while the agent has not written anything", async () => {
    getSessionEnvironment.mockResolvedValue(environment([]));
    await renderIsland();

    expect(document.querySelector(".session-file-island-pill")).toBeNull();
  });

  it("summarises the session files with added and removed line counts", async () => {
    getSessionEnvironment.mockResolvedValue(
      environment([
        file({ path: "src/app.ts", additions: 6, deletions: 1 }),
        file({
          path: "src/new.ts",
          status: "added",
          additions: 12,
          deletions: 0,
        }),
      ]),
    );
    await renderIsland();

    const pill = document.querySelector(".session-file-island-pill");
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain("2 个文件已更改");
    expect(pill?.textContent).toContain("+18");
    expect(pill?.textContent).toContain("-1");
  });

  it("lists the changed files and opens a diff tab when one is picked", async () => {
    getSessionEnvironment.mockResolvedValue(
      environment([file({ path: "src/app.ts" })]),
    );
    await renderIsland();

    fireEvent.click(screen.getByRole("button", { name: "1 个文件已更改" }));

    const row = screen.getByRole("menuitem");
    expect(screen.getByRole("menu").parentElement).toBe(document.body);
    expect(row.querySelector('[data-file-type-icon="app.ts"]')).not.toBeNull();
    expect(row.textContent).toContain("src/app.ts");
    expect(row.textContent).toContain("+6");

    fireEvent.click(row);
    expect(openWorkspaceDiff).toHaveBeenCalledWith("sess-1", "src/app.ts");
  });
});
