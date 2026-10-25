import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { agentRuntimeApi, type AgentSession } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";
import { SessionActionsDialog, type SessionAction } from "../SessionActionsDialog";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { getSessionDisplayTitle } from "../useSessionDisplayTitle";

const session = { id: "source", projectId: "p", title: "原会话", prompt: "Hello", status: "completed" } as AgentSession;
const syncSummary = vi.fn().mockResolvedValue(undefined);
const openPanel = vi.fn();
const deleted = vi.fn();
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname}{location.search}</output>; }
function start(kind: SessionAction) {
  const close = vi.fn(), complete = vi.fn();
  const view = render(<MemoryRouter initialEntries={["/projects/p/sessions?session=source"]}>
    <Location /><SessionActionsDialog request={{ kind, session }} onClose={close} onComplete={complete} />
  </MemoryRouter>);
  return { close, complete, unmount: view.unmount };
}
beforeEach(() => {
  vi.clearAllMocks();
  useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "zh" } }));
  useAgentSessionStore.setState({ projectId: "p", syncSessionSummary: syncSummary, openPanel, permanentlyDeleteSession: deleted });
});
afterEach(() => vi.restoreAllMocks());

describe("session management dialogs", () => {
  it("rejects blank names and keeps failed edits available for retry", async () => {
    const rename = vi.spyOn(agentRuntimeApi, "renameSession").mockRejectedValueOnce(new Error("保存失败"))
      .mockResolvedValue({ session: { ...session, title: "新名称" } });
    const { close } = start("rename");
    const input = screen.getByLabelText("会话名称");
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    fireEvent.change(input, { target: { value: " 新名称 " } });
    fireEvent.submit(input.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(close).not.toHaveBeenCalled();
    expect(input).toHaveValue(" 新名称 ");
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(rename).toHaveBeenLastCalledWith("source", "新名称");
    expect(syncSummary).toHaveBeenCalledWith("source");
  });

  it("reuses the fork request after a failed response and opens the returned conversation", async () => {
    const fork = vi.spyOn(agentRuntimeApi, "forkSession").mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValue({ sessionId: "fork", session: { ...session, id: "fork" } });
    start("fork");
    const submit = screen.getByRole("button", { name: "全量 Fork 新会话" });
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");
    fireEvent.click(submit);
    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("fork"));
    expect(fork.mock.calls[1]).toEqual(fork.mock.calls[0]);
    expect(fork.mock.calls[0][1]).toMatchObject({ workspaceMode: "reuse_worktree" });
    expect(screen.getByTestId("location")).toHaveTextContent("/projects/p/sessions?session=fork");
  });

  it("does not delete until confirmed and clears the selected route after success", async () => {
    deleted.mockResolvedValue(["source", "child"]);
    const { close } = start("delete");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("无法恢复");
    expect(deleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledOnce();
    expect(deleted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "永久删除会话" }));
    await waitFor(() => expect(deleted).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/projects/p/sessions"));
  });

  it("disables repeated requests while a mutation is pending", async () => {
    let finish!: (value: { sessionId: string; session: AgentSession }) => void;
    const fork = vi.spyOn(agentRuntimeApi, "forkSession").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    start("fork");
    const submit = screen.getByRole("button", { name: "全量 Fork 新会话" });
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);
    expect(fork).toHaveBeenCalledOnce();
    expect(submit).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    finish({ sessionId: "fork", session: { ...session, id: "fork" } });
    await waitFor(() => expect(openPanel).toHaveBeenCalled());
  });

  it("keeps the dialog and selection when permanent deletion fails", async () => {
    deleted.mockRejectedValueOnce(new Error("停止任务失败，请重试"));
    const { close, complete } = start("delete");
    fireEvent.click(screen.getByRole("button", { name: "永久删除会话" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("停止任务失败，请重试");
    expect(close).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByTestId("location")).toHaveTextContent("?session=source");
  });

  it("does not navigate or close a different dialog after leaving the originating workspace", async () => {
    let finish!: (value: { sessionId: string; session: AgentSession }) => void;
    vi.spyOn(agentRuntimeApi, "forkSession").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { unmount, close } = start("fork");
    fireEvent.click(screen.getByRole("button", { name: "全量 Fork 新会话" }));
    unmount();
    finish({ sessionId: "fork", session: { ...session, id: "fork" } });
    await waitFor(() => expect(syncSummary).toHaveBeenCalledWith("fork"));
    expect(openPanel).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("displays a manually chosen placeholder title literally", () => {
    expect(getSessionDisplayTitle({ ...session, title: "new session", sessionMetadata: { titleSource: "user" } }, "", "zh")).toBe("new session");
  });
});
