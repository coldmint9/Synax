import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "../../adapters/transport/project";
import {
  listRemoteDirectories,
  type RemoteDirectoryListing,
} from "../../adapters/transport/fs";
import { listWslDistributions } from "../../adapters/transport/wsl";
import type { ProjectSummary } from "../../shared/state/shellStore";
import { resolveSessionsEntryPath } from "../agent-workspace/sessionLastVisit";
import { ProjectCreateDialog } from "./ProjectCreateDialog";

const { navigate, nativePicker, runtime } = vi.hoisted(() => ({
  navigate: vi.fn(),
  nativePicker: vi.fn(),
  runtime: { electron: true },
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("../../adapters/transport/project", () => ({
  projectApi: { listProjects: vi.fn(), createWorkspace: vi.fn() },
}));
vi.mock("../../adapters/transport/fs", () => ({
  listRemoteDirectories: vi.fn(),
}));
vi.mock("../../adapters/transport/wsl", () => ({
  listWslDistributions: vi.fn(),
}));
vi.mock("../../adapters/electron/open-directory-picker", () => ({
  get isElectron() {
    return runtime.electron;
  },
  openDirectoryPicker: nativePicker,
}));

function project(): ProjectSummary {
  return {
    id: "created",
    name: "Workspace",
    status: "healthy",
    environment: "development",
    healthScore: 100,
    activeAgents: 0,
    activeHumans: 1,
    openRisks: 0,
    updatedAt: "now",
    source: { kind: "localPath", localPath: "/repos/api" },
  };
}
function directoryListing(): RemoteDirectoryListing {
  return {
    path: "/repos",
    name: "repos",
    parent: "/",
    home: "/repos",
    shortcuts: [],
    truncated: false,
    entries: [
      { name: "api", path: "/repos/api", hidden: false },
      { name: "web", path: "/repos/web", hidden: false },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function addNative(name: string, path = `/repos/${name}`) {
  nativePicker.mockResolvedValueOnce({ path, name });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: /选择文件夹|添加项目/ }));
  await waitFor(() =>
    expect(screen.getByRole("list", { name: "工作区项目" })).toHaveTextContent(
      name,
    ),
  );
}
function row(name: string) {
  return screen
    .getAllByRole("listitem")
    .find((item) => within(item).queryByText(name, { exact: true }))!;
}
const desktopWindow = window as Window & { electronAPI?: { platform: string } };

beforeEach(() => {
  vi.clearAllMocks();
  runtime.electron = true;
  nativePicker.mockReset().mockResolvedValue(null);
  vi.mocked(projectApi.createWorkspace)
    .mockReset()
    .mockResolvedValue({ project: project() });
  vi.mocked(listRemoteDirectories)
    .mockReset()
    .mockResolvedValue(directoryListing());
  vi.mocked(listWslDistributions)
    .mockReset()
    .mockResolvedValue({
      available: true,
      items: [
        { name: "Ubuntu", version: 2, default: true },
        { name: "Legacy", version: 1, default: false },
      ],
    });
});
afterEach(() => {
  delete desktopWindow.electronAPI;
  vi.restoreAllMocks();
});

describe("ProjectCreateDialog", () => {
  it("shows the compact name and empty project fields together, with only directory selection", async () => {
    await act(async () => { render(<ProjectCreateDialog open onClose={vi.fn()} />); });
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toHaveValue("");
    expect(
      within(screen.getByRole("region", { name: "工作区项目" })).getByText(
        "选择现有项目目录，文件会保留在原位置。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建工作区" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /选择文件夹|添加项目/ }),
    ).toBeEnabled();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "项目目录路径" }),
    ).not.toBeInTheDocument();
    expect(projectApi.listProjects).not.toHaveBeenCalled();
  });

  it("adds native directories immediately, keeps visual order and submits the default root first", async () => {
    const onClose = vi.fn();
    render(<ProjectCreateDialog open onClose={onClose} />);
    await addNative("api");
    await addNative("web");
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toHaveValue(
      "api",
    );
    await userEvent
      .setup()
      .click(within(row("web")).getByRole("button", { name: /^设为默认:/ }));
    expect(
      screen
        .getAllByRole("listitem")
        .map((item) => item.querySelector("strong")?.textContent),
    ).toEqual(["api", "web"]);
    expect(row("web")).toHaveAttribute("data-primary", "true");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "创建工作区" }));
    await waitFor(() =>
      expect(projectApi.createWorkspace).toHaveBeenCalledWith({
        name: "api",
        roots: [
          { localPath: "/repos/web", name: "web" },
          { localPath: "/repos/api", name: "api" },
        ],
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(resolveSessionsEntryPath("created"));
  });

  it("preserves a user name, including an intentionally cleared name", async () => {
    render(<ProjectCreateDialog open onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "工作区名称" });
    fireEvent.change(input, { target: { value: "My workspace" } });
    await addNative("api");
    expect(input).toHaveValue("My workspace");
    fireEvent.change(input, { target: { value: "" } });
    await addNative("web");
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "创建工作区" })).toBeDisabled();
  });

  it("deduplicates normalized directory paths without replacing the name or default", async () => {
    render(<ProjectCreateDialog open onClose={vi.fn()} />);
    await addNative("api");
    await addNative("api", "/repos/api/");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent("此目录已在工作区中");
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toHaveValue(
      "api",
    );
    expect(row("api")).toHaveAttribute("data-primary", "true");
  });

  it("removes drafts immediately and selects the following default, wrapping at the end", async () => {
    render(<ProjectCreateDialog open onClose={vi.fn()} />);
    await addNative("api");
    await addNative("web");
    await addNative("shared");
    fireEvent.click(
      within(row("web")).getByRole("button", { name: /^设为默认:/ }),
    );
    fireEvent.click(within(row("web")).getByRole("button", { name: /^移除:/ }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(row("shared")).toHaveAttribute("data-primary", "true");
    fireEvent.click(
      within(row("shared")).getByRole("button", { name: /^移除:/ }),
    );
    expect(row("api")).toHaveAttribute("data-primary", "true");
    fireEvent.click(within(row("api")).getByRole("button", { name: /^移除:/ }));
    expect(
      within(screen.getByRole("region", { name: "工作区项目" })).getByText(
        "选择现有项目目录，文件会保留在原位置。",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建工作区" })).toBeDisabled();
  });

  it("locks submission and preserves the draft and default after failure for retry", async () => {
    const pending =
      deferred<Awaited<ReturnType<typeof projectApi.createWorkspace>>>();
    vi.mocked(projectApi.createWorkspace).mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    render(<ProjectCreateDialog open onClose={onClose} />);
    await addNative("api");
    await addNative("web");
    fireEvent.click(
      within(row("web")).getByRole("button", { name: /^设为默认:/ }),
    );
    const submit = screen.getByRole("button", { name: "创建工作区" });
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    expect(projectApi.createWorkspace).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /选择文件夹|添加项目/ }),
    ).toBeDisabled();
    await act(async () => pending.reject(new Error("Unable to create")));
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to create");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(row("web")).toHaveAttribute("data-primary", "true");
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toHaveValue(
      "api",
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建工作区" }));
    await waitFor(() =>
      expect(projectApi.createWorkspace).toHaveBeenCalledTimes(2),
    );
    expect(vi.mocked(projectApi.createWorkspace).mock.calls[1]).toEqual(
      vi.mocked(projectApi.createWorkspace).mock.calls[0],
    );
  });

  it("ignores an old native picker result after close and reopen", async () => {
    const pending = deferred<{ path: string; name: string } | null>();
    nativePicker.mockReturnValueOnce(pending.promise);
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>Reopen</button>
          <ProjectCreateDialog open={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(
      screen.getByRole("button", { name: /选择文件夹|添加项目/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await act(async () =>
      pending.resolve({ path: "/repos/stale", name: "stale" }),
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "工作区名称" })).toHaveValue("");
    await addNative("web");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("ignores a create response after the parent closes the form", async () => {
    const pending =
      deferred<Awaited<ReturnType<typeof projectApi.createWorkspace>>>();
    vi.mocked(projectApi.createWorkspace).mockReturnValueOnce(pending.promise);
    const onClose = vi.fn();
    const view = render(<ProjectCreateDialog open onClose={onClose} />);
    await addNative("api");
    fireEvent.click(screen.getByRole("button", { name: "创建工作区" }));
    view.rerender(<ProjectCreateDialog open={false} onClose={onClose} />);
    await act(async () => pending.resolve({ project: project() }));
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "adds browser multi-selection directly with WSL=%s",
    async (wsl) => {
      runtime.electron = wsl;
      if (wsl) desktopWindow.electronAPI = { platform: "win32" };
      render(<ProjectCreateDialog open onClose={vi.fn()} />);
      const user = userEvent.setup();
      if (wsl)
        await user.click(await screen.findByRole("button", { name: "WSL2" }));
      await user.click(
        screen.getByRole("button", { name: /选择文件夹|添加项目/ }),
      );
      const picker = await screen.findByRole("dialog", {
        name: "选择工作区项目",
      });
      await user.click(
        await within(picker).findByRole("checkbox", { name: "选择 api" }),
      );
      await user.click(
        within(picker).getByRole("checkbox", { name: "选择 web" }),
      );
      await user.click(
        within(picker).getByRole("button", { name: /^添加所选项目/ }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "选择工作区项目" }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getAllByRole("listitem")).toHaveLength(2);
      expect(screen.getByRole("textbox", { name: "工作区名称" })).toHaveValue(
        "api",
      );
      expect(nativePicker).not.toHaveBeenCalled();
      if (wsl) {
        expect(listRemoteDirectories).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({
            locationKind: "wsl",
            distribution: "Ubuntu",
          }),
        );
        expect(screen.getByRole("button", { name: "本地" })).toBeDisabled();
      }
      await user.click(screen.getByRole("button", { name: "创建工作区" }));
      expect(projectApi.createWorkspace).toHaveBeenCalledWith({
        name: "api",
        roots: ["api", "web"].map((name) =>
          wsl
            ? {
                location: {
                  kind: "wsl",
                  distribution: "Ubuntu",
                  path: `/repos/${name}`,
                },
                name,
              }
            : { localPath: `/repos/${name}`, name },
        ),
      });
    },
  );

  it("does not offer WSL when the Windows host has no WSL2 distributions", async () => {
    desktopWindow.electronAPI = { platform: "win32" };
    vi.mocked(listWslDistributions).mockResolvedValue({
      available: true,
      items: [{ name: "Legacy", version: 1, default: true }],
    });
    render(<ProjectCreateDialog open onClose={vi.fn()} />);
    await waitFor(() => expect(listWslDistributions).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "WSL2", exact: true }),
    ).not.toBeInTheDocument();
    await addNative("api");
    expect(screen.getByRole("listitem")).toHaveTextContent("/repos/api");
  });

  it("retains the draft when native picking is canceled or fails", async () => {
    render(<ProjectCreateDialog open onClose={vi.fn()} />);
    await addNative("api");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /选择文件夹|添加项目/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    nativePicker.mockRejectedValueOnce(new Error("Picker unavailable"));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /选择文件夹|添加项目/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Picker unavailable",
    );
    expect(row("api")).toHaveAttribute("data-primary", "true");
  });
});
