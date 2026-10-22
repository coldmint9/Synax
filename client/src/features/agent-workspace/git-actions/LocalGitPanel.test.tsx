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
import LocalGitPanel from "./LocalGitPanel";
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
