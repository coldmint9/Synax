import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
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
    addReferences: vi.fn(),
    setPrimaryRoot: vi.fn(),
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
const added = {
  id: "ref-shared",
  name: "shared",
  path: "/repos/shared",
  role: "reference" as const,
  status: "available" as const,
};

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
    currentProjectId: "other",
  });
  vi.mocked(projectApi.getWorkspace).mockResolvedValue(initial);
  vi.mocked(projectApi.addReferences).mockResolvedValue({
    roots: [...initial.roots, added],
    normalizations: [],
  });
  vi.mocked(projectApi.removeReference).mockResolvedValue({ roots: [primary] });
  vi.mocked(projectApi.setPrimaryRoot).mockResolvedValue({
    roots: [
      { ...reference, id: "p", role: "primary" as const },
      { ...primary, id: "ref-frontend", role: "reference" as const },
    ],
  });
  vi.mocked(openDirectoryPicker).mockResolvedValue([
    { name: "shared", path: "/repos/shared" },
  ]);
});

describe("workspace management", () => {
  it("returns to the route supplied by the workspace switcher", async () => {
    function Location() {
      return <output data-testid="route">{useLocation().pathname}</output>;
    }
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/workspaces/p/manage",
            state: { workspaceReturnTo: "/projects/other/git" },
          },
        ]}
      >
        <Location />
        <WorkspaceManagementContent workspaceId="p" />
      </MemoryRouter>,
    );
    await ready();
    await user.click(screen.getByRole("button", { name: "返回工作区" }));
    expect(screen.getByTestId("route")).toHaveTextContent(
      "/projects/other/git",
    );
    expect(useShellStore.getState().currentProjectId).toBe("other");
  });

  it("reports a failed native picker and lets the user retry", async () => {
    const user = userEvent.setup();
    vi.mocked(openDirectoryPicker).mockRejectedValueOnce(
      new Error("picker unavailable"),
    );
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "picker unavailable",
    );
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    await waitFor(() => expect(projectApi.addReferences).toHaveBeenCalledOnce());
  });

  it("cancels project removal with Escape and restores focus", async () => {
    const user = userEvent.setup();
    view();
    await ready();
    const trigger = screen.getByRole("button", { name: "移除: api" });
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "从工作区移除 api？" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(projectApi.removeReference).not.toHaveBeenCalled();
  });

  it("binds the target workspace and protects the default project", async () => {
    view();
    await ready();
    expect(projectApi.getWorkspace).toHaveBeenCalledWith("p");
    expect(useShellStore.getState().currentProjectId).toBe("other");
    expect(
      screen.queryByRole("button", { name: "移除: frontend" }),
    ).not.toBeInTheDocument();
  });

  it("adds every folder chosen in one picker session with a single request", async () => {
    const user = userEvent.setup();
    vi.mocked(openDirectoryPicker).mockResolvedValue([
      { name: "shared", path: "/repos/shared" },
      { name: "docs", path: "/repos/docs" },
    ]);
    vi.mocked(projectApi.addReferences).mockResolvedValue({
      roots: [
        ...initial.roots,
        added,
        {
          id: "ref-docs",
          name: "docs",
          path: "/repos/docs",
          role: "reference",
          status: "available",
        },
      ],
      normalizations: [],
    });
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    expect(openDirectoryPicker).toHaveBeenCalledExactlyOnceWith({
      multiple: true,
    });
    await waitFor(() =>
      expect(projectApi.addReferences).toHaveBeenCalledExactlyOnceWith("p", [
        { location: { kind: "host", path: "/repos/shared" }, name: "shared" },
        { location: { kind: "host", path: "/repos/docs" }, name: "docs" },
      ]),
    );
    expect(await screen.findByText("已加入 2 个项目。")).toBeInTheDocument();
    expect(screen.getByText("/repos/docs")).toBeInTheDocument();
  });

  it("reports folders that are already members instead of failing the selection", async () => {
    const user = userEvent.setup();
    vi.mocked(projectApi.addReferences).mockResolvedValue({
      roots: initial.roots,
      normalizations: [
        {
          inputLocation: { kind: "host", path: "/repos/shared" },
          location: { kind: "host", path: "/repos/shared" },
          name: "shared",
          redirected: false,
          duplicate: true,
        },
      ],
    });
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    expect(
      await screen.findByText("已跳过 1 个已在工作区中的目录。"),
    ).toBeInTheDocument();
  });

  it("switches the default project from the member row", async () => {
    const user = userEvent.setup();
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "设为默认: api" }));
    expect(projectApi.setPrimaryRoot).toHaveBeenCalledExactlyOnceWith(
      "p",
      "ref-api",
    );
    expect(await screen.findByText("默认项目已切换。")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "设为默认: api" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除: frontend" })).toBeEnabled();
  });

  it("confirms removal in a dialog and preserves the project after a failed request", async () => {
    const user = userEvent.setup();
    vi.mocked(projectApi.removeReference).mockRejectedValueOnce(
      new Error("write failed"),
    );
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "移除: api" }));
    expect(screen.getByText("从工作区移除 api？")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("write failed");
    expect(screen.getByText("/repos/api")).toBeInTheDocument();
  });

  it("removes the reference after confirmation while keeping the default", async () => {
    const user = userEvent.setup();
    view();
    await ready();
    await user.click(screen.getByRole("button", { name: "移除: api" }));
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() =>
      expect(screen.queryByText("/repos/api")).not.toBeInTheDocument(),
    );
    expect(screen.getByText("/repos/frontend")).toBeInTheDocument();
  });
});
