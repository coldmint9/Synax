import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectApi,
  type ProjectWorkspace,
} from "../../adapters/transport/project";
import { openDirectoryPicker } from "../../adapters/electron/open-directory-picker";
import {
  useShellStore,
  type ProjectSummary,
} from "../../shared/state/shellStore";
import { WorkspaceManagementContent } from "./WorkspaceManagementPage";
vi.mock("../../adapters/transport/project", () => ({
  projectApi: {
    getWorkspace: vi.fn(),
    addReference: vi.fn(),
    removeReference: vi.fn(),
  },
}));
vi.mock("../../adapters/electron/open-directory-picker", () => ({
  isElectron: true,
  openDirectoryPicker: vi.fn(),
}));
vi.mock("../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
const primary = {
  id: "p",
  name: "frontend",
  path: "/repos/frontend",
  role: "primary" as const,
  status: "available" as const,
  location: { kind: "host" as const, path: "/repos/frontend" },
};
const reference = {
  id: "ref-api",
  name: "api",
  path: "/repos/api",
  role: "reference" as const,
  status: "available" as const,
};
const initial: ProjectWorkspace = { roots: [primary, reference] };
const refresh = vi.fn(async () => {});
function view(id = "p") {
  return render(
    <MemoryRouter>
      <WorkspaceManagementContent key={id} workspaceId={id} />
    </MemoryRouter>,
  );
}
async function ready() {
  await screen.findByText("/repos/frontend");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "添加项目" })).toBeEnabled(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  useShellStore.setState({
    projects: [{ id: "p", name: "产品研发" } as ProjectSummary],
    fetchProjects: refresh,
    currentProjectId: "other",
  });
  vi.mocked(projectApi.getWorkspace).mockResolvedValue(initial);
  vi.mocked(projectApi.addReference).mockResolvedValue({
    roots: [
      ...initial.roots,
      {
        id: "ref-shared",
        name: "shared",
        path: "/repos/shared",
        role: "reference",
        status: "available",
      },
    ],
  });
  vi.mocked(projectApi.removeReference).mockResolvedValue({ roots: [primary] });
  vi.mocked(openDirectoryPicker).mockResolvedValue({
    name: "shared",
    path: "/repos/shared",
  });
});
describe("workspace management", () => {
  it("binds the target workspace without changing the current workspace and protects the default", async () => {
    view();
    await ready();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "产品研发",
    );
    expect(projectApi.getWorkspace).toHaveBeenCalledWith("p");
    expect(useShellStore.getState().currentProjectId).toBe("other");
    expect(
      screen.queryByRole("button", { name: "移除: frontend" }),
    ).not.toBeInTheDocument();
  });
  it("requires an explicit add after choosing a folder, updates the count and never offers manual paths", async () => {
    const user = userEvent.setup();
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    await screen.findByText("/repos/shared");
    expect(projectApi.addReference).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "项目目录路径" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加入工作区" }));
    await screen.findByRole("status");
    expect(projectApi.addReference).toHaveBeenCalledExactlyOnceWith("p", {
      location: { kind: "host", path: "/repos/shared" },
      name: "shared",
    });
    expect(screen.getByText("3 个项目 · 本地")).toBeInTheDocument();
  });
  it("rejects duplicate selections and retains a failed add for retry", async () => {
    const user = userEvent.setup();
    vi.mocked(openDirectoryPicker).mockResolvedValueOnce({
      name: "api",
      path: "/repos/api/",
    });
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "此目录已在工作区中",
    );
    expect(screen.getByRole("button", { name: "加入工作区" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "重新选择" }));
    vi.mocked(projectApi.addReference).mockRejectedValueOnce(
      new Error("permission denied"),
    );
    await user.click(screen.getByRole("button", { name: "加入工作区" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "permission denied",
    );
    expect(screen.getByText("/repos/shared")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "加入工作区" }));
    await screen.findByRole("status");
    expect(projectApi.addReference).toHaveBeenCalledTimes(2);
  });
  it("confirms removal inline, preserves a failed confirmation and removes only after success", async () => {
    const user = userEvent.setup();
    vi.mocked(projectApi.removeReference).mockRejectedValueOnce(
      new Error("write failed"),
    );
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "移除: api" }));
    expect(projectApi.removeReference).not.toHaveBeenCalled();
    expect(screen.getByText("从工作区移除 api？")).toBeInTheDocument();
    expect(screen.getByText(/Git 数据和已有会话/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("write failed");
    expect(screen.getByText("/repos/api")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    await screen.findByRole("status");
    expect(screen.queryByText("/repos/api")).not.toBeInTheDocument();
    expect(projectApi.removeReference).toHaveBeenLastCalledWith("p", "ref-api");
    expect(screen.getByText("1 个项目 · 本地")).toBeInTheDocument();
  });
  it("ignores an old picker result after changing the management target", async () => {
    let resolve!: (v: { name: string; path: string }) => void;
    vi.mocked(openDirectoryPicker).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const old = view();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "添加项目" }));
    fireEvent.click(screen.getByRole("button", { name: "选择文件夹" }));
    old.unmount();
    view("other");
    await ready();
    await act(async () => resolve({ name: "stale", path: "/repos/stale" }));
    expect(screen.queryByText("/repos/stale")).not.toBeInTheDocument();
    expect(projectApi.addReference).not.toHaveBeenCalled();
  });
  it("locks a pending remove against repeated confirmation", async () => {
    let resolve!: (v: ProjectWorkspace) => void;
    vi.mocked(projectApi.removeReference).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    view();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "移除: api" }));
    const confirm = screen.getByRole("button", { name: "确认移除" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(projectApi.removeReference).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "返回工作区" })).toBeDisabled();
    await act(async () => resolve({ roots: [primary] }));
    expect(screen.queryByText("/repos/api")).not.toBeInTheDocument();
  });
});
