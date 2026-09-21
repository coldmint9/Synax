import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { SessionGitCommitResult } from "../../../../lib/api/agentRuntime";
import { useShellStore } from "../../../state/shellStore";

const commitSessionWorkspace = vi.fn();
const streamCommitMessage = vi.fn();
vi.mock("../../settings/useConfig", () => ({
  useConfig: () => ({
    globalConfig: {
      providers: [
        {
          id: "p1",
          label: "Provider 1",
          kind: "api",
          status: "live",
          models: [{ id: "m1", label: "M1" }],
        },
      ],
      providerConnections: {
        p1: { providerId: "p1", apiKeyMasked: "te****ey" },
      },
    },
    providers: [
      {
        id: "p1",
        label: "Provider 1",
        kind: "api",
        status: "live",
        models: [{ id: "m1", label: "M1" }],
      },
    ],
  }),
}));

vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    commitSessionWorkspace: (...args: unknown[]) =>
      commitSessionWorkspace(...args),
    streamCommitMessage: (...args: unknown[]) => streamCommitMessage(...args),
  },
}));

const { SessionCommitDialog } = await import("../SessionCommitDialog");

const committed: SessionGitCommitResult = {
  commitSha: "5e5727b0abcdef0123456789",
  message: "fix: dialog layout",
  messageGenerated: false,
  pushed: true,
  branch: "feature/commit-ui",
  upstream: "origin/feature/commit-ui",
  committedFiles: 3,
};

function renderDialog(
  props: Partial<React.ComponentProps<typeof SessionCommitDialog>> = {},
) {
  const onClose = vi.fn();
  const onCommitted = vi.fn();
  render(
    <SessionCommitDialog
      isOpen
      sessionId="session-1"
      projectId="project-1"
      branch="feature/commit-ui"
      changedFiles={3}
      onClose={onClose}
      onCommitted={onCommitted}
      {...props}
    />,
  );
  return { onClose, onCommitted };
}

describe("SessionCommitDialog", () => {
  beforeEach(() => {
    cleanup();
    commitSessionWorkspace.mockReset();
    streamCommitMessage.mockReset();
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
  });

  it("shows the branch, model and explicit generation control", () => {
    renderDialog();

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("feature/commit-ui")).toBeTruthy();
    expect(screen.getByText("3 个文件已变更")).toBeTruthy();
    expect(screen.getByRole("button", { name: "生成提交信息" })).toBeTruthy();
    expect(screen.getByLabelText("生成模型")).toBeTruthy();
    expect(screen.getByLabelText("提交信息")).toBeTruthy();
    expect(screen.getByRole("button", { name: "仅提交" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "提交并推送" })).toBeTruthy();
  });

  it("falls back to the empty-state copy and disables commit when nothing changed", () => {
    renderDialog({ changedFiles: 0 });

    expect(screen.getByText("没有可提交的变更")).toBeTruthy();
    expect(screen.getByRole("button", { name: "仅提交" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交并推送" })).toBeDisabled();
  });

  it("rejects an empty submit without calling the model or committing", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "请先填写或生成",
    );
    expect(streamCommitMessage).not.toHaveBeenCalled();
    expect(commitSessionWorkspace).not.toHaveBeenCalled();
  });

  it("streams into the editor, then commits the reviewed final message", async () => {
    streamCommitMessage.mockImplementation(async (_id, _body, onEvent) => {
      onEvent({ type: "delta", text: "fix:" });
      await Promise.resolve();
      onEvent({ type: "delta", text: " new message" });
      onEvent({ type: "final", message: "fix: new message" });
    });
    commitSessionWorkspace.mockResolvedValue(committed);
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "生成提交信息" }));
    await waitFor(() =>
      expect(screen.getByLabelText("提交信息")).toHaveValue("fix: new message"),
    );
    expect(streamCommitMessage.mock.calls[0][1]).toMatchObject({
      model: "p1/m1",
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));
    await waitFor(() =>
      expect(commitSessionWorkspace).toHaveBeenCalledWith("session-1", {
        message: "fix: new message",
      }),
    );
  });

  it("restores the original content when generation fails", async () => {
    streamCommitMessage.mockImplementation(async (_id, _body, onEvent) => {
      onEvent({ type: "delta", text: "partial" });
      throw new Error("model failed");
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText("提交信息"), {
      target: { value: "keep me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成提交信息" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "model failed",
    );
    expect(screen.getByLabelText("提交信息")).toHaveValue("keep me");
  });

  it("cancels generation and restores the prior message", async () => {
    let deliver!: (event: { type: "delta"; text: string }) => void;
    let pendingSignal!: AbortSignal;
    streamCommitMessage.mockImplementation((_id, _body, callback, signal) => {
      deliver = callback;
      pendingSignal = signal;
      return new Promise<void>(() => {});
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText("提交信息"), {
      target: { value: "original" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成提交信息" }));
    act(() => deliver({ type: "delta", text: "partial" }));
    fireEvent.click(screen.getByRole("button", { name: "停止生成" }));
    expect(pendingSignal.aborted).toBe(true);
    expect(screen.getByLabelText("提交信息")).toHaveValue("original");
    act(() => deliver({ type: "delta", text: "late" }));
    expect(screen.getByLabelText("提交信息")).toHaveValue("original");
  });

  it("discards stale stream events after changing repositories", async () => {
    let deliver!: (event: { type: "final"; message: string }) => void;
    let pendingSignal!: AbortSignal;
    streamCommitMessage.mockImplementation((_id, _body, callback, signal) => {
      deliver = callback;
      pendingSignal = signal;
      return new Promise<void>(() => {});
    });
    const props = {
      isOpen: true,
      sessionId: "session-1",
      projectId: "project-1",
      branch: "main",
      changedFiles: 3,
      onClose: vi.fn(),
      onCommitted: vi.fn(),
    };
    const { rerender } = render(
      <SessionCommitDialog {...props} rootId="primary" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "生成提交信息" }));
    rerender(<SessionCommitDialog {...props} rootId="secondary" />);
    expect(pendingSignal.aborted).toBe(true);
    act(() => deliver({ type: "final", message: "stale" }));
    expect(screen.getByLabelText("提交信息")).toHaveValue("");
  });

  it("sends a trimmed message and reports the pushed commit", async () => {
    commitSessionWorkspace.mockResolvedValue(committed);
    const { onCommitted } = renderDialog();

    fireEvent.change(screen.getByLabelText("提交信息"), {
      target: { value: "  fix: dialog layout  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));

    await waitFor(() =>
      expect(commitSessionWorkspace).toHaveBeenCalledWith("session-1", {
        message: "fix: dialog layout",
      }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("5e5727b0");
    expect(status.textContent).toContain("origin/feature/commit-ui");
    expect(onCommitted).toHaveBeenCalledWith(committed);
  });

  it("commits without pushing when only-commit is chosen", async () => {
    commitSessionWorkspace.mockResolvedValue({
      ...committed,
      pushed: null,
      upstream: null,
    } satisfies SessionGitCommitResult);
    renderDialog();

    fireEvent.change(screen.getByLabelText("提交信息"), {
      target: { value: "fix: local" },
    });
    fireEvent.click(screen.getByRole("button", { name: "仅提交" }));

    await waitFor(() =>
      expect(commitSessionWorkspace).toHaveBeenCalledWith("session-1", {
        message: "fix: local",
        push: false,
      }),
    );
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("已在本地提交");
    expect(status.textContent).toContain("尚未推送到远端");
  });

  it("surfaces a failed commit as an alert and keeps the form usable", async () => {
    commitSessionWorkspace.mockRejectedValue(
      new Error("remote rejected the push"),
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText("提交信息"), {
      target: { value: "fix: retry" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交并推送" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("remote rejected the push");
    expect(screen.getByLabelText("提交信息")).toBeTruthy();
  });

  it.each(["success", "failure"])(
    "ignores a stale %s after switching repositories and only submits once",
    async (outcome) => {
      let finish!: (value: SessionGitCommitResult) => void;
      let fail!: (error: Error) => void;
      commitSessionWorkspace.mockReturnValueOnce(
        new Promise<SessionGitCommitResult>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
      );
      const props = {
        isOpen: true,
        sessionId: "session-1",
        projectId: "project-1",
        branch: "main",
        changedFiles: 3,
        onClose: vi.fn(),
        onCommitted: vi.fn(),
      };
      const { rerender } = render(
        <SessionCommitDialog {...props} rootId="primary" rootName="API" />,
      );
      fireEvent.change(screen.getByLabelText("提交信息"), {
        target: { value: "fix: first" },
      });
      const submit = screen.getByRole("button", { name: "仅提交" });
      act(() => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      expect(commitSessionWorkspace).toHaveBeenCalledTimes(1);
      expect(commitSessionWorkspace).toHaveBeenCalledWith("session-1", {
        rootId: "primary",
        message: "fix: first",
        push: false,
      });

      rerender(
        <SessionCommitDialog {...props} rootId="secondary" rootName="Web" />,
      );
      expect(screen.getByText("Web")).toBeInTheDocument();
      await act(async () => {
        if (outcome === "success") finish(committed);
        else fail(new Error("old repository failure"));
      });
      expect(props.onCommitted).not.toHaveBeenCalled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      commitSessionWorkspace.mockResolvedValueOnce({
        ...committed,
        rootId: "secondary",
      });
      fireEvent.change(screen.getByLabelText("提交信息"), {
        target: { value: "fix: second" },
      });
      fireEvent.click(screen.getByRole("button", { name: "仅提交" }));
      await waitFor(() =>
        expect(props.onCommitted).toHaveBeenCalledWith({
          ...committed,
          rootId: "secondary",
        }),
      );
      expect(commitSessionWorkspace).toHaveBeenLastCalledWith("session-1", {
        rootId: "secondary",
        message: "fix: second",
        push: false,
      });
    },
  );
});
