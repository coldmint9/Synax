import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "../../adapters/transport/project";
import {
  useShellStore,
  type ProjectSummary,
} from "../../shared/state/shellStore";
import { WorkspaceRenameDialog } from "./WorkspaceRenameDialog";

vi.mock("../../adapters/transport/project", () => ({
  projectApi: { updateProject: vi.fn() },
}));
vi.mock("../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
const target = { id: "other", name: "产品研发" } as ProjectSummary;
beforeEach(() => {
  vi.mocked(projectApi.updateProject)
    .mockReset()
    .mockResolvedValue({ ...target, name: "新名称" });
  useShellStore.setState({
    projects: [target, { ...target, id: "active", name: "当前工作区" }],
    currentProjectId: "active",
  });
});

describe("workspace rename", () => {
  it("trims the name, updates only the target and keeps the active workspace", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<WorkspaceRenameDialog workspace={target} onClose={close} />);
    const input = screen.getByRole("textbox", { name: "工作区名称" });
    await user.clear(input);
    await user.type(input, "  新名称  ");
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(projectApi.updateProject).toHaveBeenCalledExactlyOnceWith("other", {
      name: "新名称",
    });
    expect(
      useShellStore.getState().projects.find((p) => p.id === "other")?.name,
    ).toBe("新名称");
    expect(
      useShellStore.getState().projects.find((p) => p.id === "active")?.name,
    ).toBe("当前工作区");
    expect(useShellStore.getState().currentProjectId).toBe("active");
  });

  it("rejects a blank name and allows cancelling without saving", async () => {
    const user = userEvent.setup();
    const close = vi.fn();
    render(<WorkspaceRenameDialog workspace={target} onClose={close} />);
    await user.clear(screen.getByRole("textbox", { name: "工作区名称" }));
    await user.type(screen.getByRole("textbox", { name: "工作区名称" }), "   ");
    expect(screen.getByRole("button", { name: "保存" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(close).toHaveBeenCalledOnce();
    expect(projectApi.updateProject).not.toHaveBeenCalled();
  });

  it("keeps the attempted name after failure and retries", async () => {
    vi.mocked(projectApi.updateProject).mockRejectedValueOnce(
      new Error("offline"),
    );
    const user = userEvent.setup();
    const close = vi.fn();
    render(<WorkspaceRenameDialog workspace={target} onClose={close} />);
    const input = screen.getByRole("textbox", { name: "工作区名称" });
    await user.clear(input);
    await user.type(input, "新名称");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(input).toHaveValue("新名称");
    expect(close).not.toHaveBeenCalled();
    expect(useShellStore.getState().projects[0].name).toBe(target.name);
    await user.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("blocks duplicate submissions and dismissal while saving", async () => {
    let resolve!: (value: ProjectSummary) => void;
    vi.mocked(projectApi.updateProject).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const user = userEvent.setup();
    const close = vi.fn();
    render(<WorkspaceRenameDialog workspace={target} onClose={close} />);
    await user.dblClick(screen.getByRole("button", { name: "保存" }));
    await user.keyboard("{Escape}");
    expect(close).not.toHaveBeenCalled();
    expect(projectApi.updateProject).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    await act(async () => {
      resolve(target);
    });
    expect(close).toHaveBeenCalledOnce();
  });
});
