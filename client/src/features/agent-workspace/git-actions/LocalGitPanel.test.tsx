import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, it, expect, vi } from "vitest";
vi.mock("../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessionBranches: vi.fn(),
    commitSessionWorkspace: vi.fn(),
    switchSessionBranch: vi.fn(),
    createSessionBranch: vi.fn(),
  },
}));
vi.mock("../workspaceRefresh", () => ({ refreshWorkspace: vi.fn() }));
vi.mock("../state/agentSessionStore", () => ({
  useAgentSessionStore: {
    getState: () => ({ ingestConversationMessages: vi.fn() }),
  },
}));
import {
  agentRuntimeApi,
  type AgentSession,
} from "../../../adapters/transport/agentRuntime";
import LocalGitPanel, { keepBranchSelection } from "./LocalGitPanel";
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentRuntimeApi.listSessionBranches).mockResolvedValue({
    rootId: "root",
    current: "feature/a",
    dirtyFileCount: 1,
    branches: [
      { name: "feature/a", current: true, occupied: false },
      { name: "main", current: false, occupied: false },
    ],
  });
});
it("Commit explicitly writes locally without pushing", async () => {
  vi.mocked(agentRuntimeApi.commitSessionWorkspace).mockResolvedValue({
    rootId: "root",
    branch: "feature/a",
    commitSha: "a".repeat(40),
    message: "Fix",
    messageGenerated: false,
    pushed: null,
    upstream: null,
    committedFiles: 1,
  });
  render(
    <LocalGitPanel
      session={{ id: "s", status: "completed" } as AgentSession}
      rootId="root"
      onBusy={vi.fn()}
      onTaskReady={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByLabelText("提交说明"), {
    target: { value: "Fix" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Commit 到本地" }));
  await waitFor(() =>
    expect(agentRuntimeApi.commitSessionWorkspace).toHaveBeenCalledWith("s", {
      rootId: "root",
      message: "Fix",
      includeUntracked: true,
      push: false,
    }),
  );
  expect(await screen.findByRole("status")).toHaveTextContent("尚未推送");
});
it("does not mutate an active agent workspace", async () => {
  render(
    <LocalGitPanel
      session={
        { id: "s", activeRunId: "run", status: "running" } as AgentSession
      }
      rootId="root"
      onBusy={vi.fn()}
      onTaskReady={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("button", { name: "Commit 到本地" }),
  ).toBeDisabled();
  expect(agentRuntimeApi.commitSessionWorkspace).not.toHaveBeenCalled();
});
it("creates and checks out a branch while the agent owns the workspace", async () => {
  vi.mocked(agentRuntimeApi.createSessionBranch).mockResolvedValue({
    rootId: "root",
    current: "feature/run",
    dirtyFileCount: 1,
    branches: [
      { name: "feature/run", current: true, occupied: false },
      { name: "feature/a", current: false, occupied: false },
    ],
  });
  render(
    <LocalGitPanel
      session={
        { id: "s", activeRunId: "run", status: "running" } as AgentSession
      }
      rootId="root"
      onBusy={vi.fn()}
      onTaskReady={vi.fn()}
    />,
  );
  const name = await screen.findByLabelText("新建分支（feature 从生产基线创建）");
  expect(name).toBeEnabled();
  fireEvent.change(name, { target: { value: "feature/run" } });
  fireEvent.click(screen.getByRole("button", { name: "创建并切换" }));
  await waitFor(() =>
    expect(agentRuntimeApi.createSessionBranch).toHaveBeenCalledWith(
      "s",
      "feature/run",
      "root",
    ),
  );
});

it("keeps a picked branch when the branch list reloads", () => {
  const current = "feature/a";
  expect(
    keepBranchSelection("main", {
      rootId: "root",
      current,
      dirtyFileCount: 0,
      branches: [
        { name: current, current: true, occupied: false },
        { name: "main", current: false, occupied: false },
      ],
    }),
  ).toBe("main");
  // A branch that no longer exists falls back to the checked-out one.
  expect(
    keepBranchSelection("gone", {
      rootId: "root",
      current,
      dirtyFileCount: 0,
      branches: [{ name: current, current: true, occupied: false }],
    }),
  ).toBe(current);
});
