import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectApi, type ProjectWorkspace } from "../../adapters/transport/project";
import { openDirectoryPicker } from "../../adapters/electron/open-directory-picker";
import { useShellStore, type ProjectSummary } from "../../shared/state/shellStore";
import { WorkspaceManagementContent } from "./WorkspaceManagementPage";

vi.mock("../../adapters/transport/project", () => ({
  projectApi: { getWorkspace: vi.fn(), addReference: vi.fn(), removeReference: vi.fn() },
}));
vi.mock("../../adapters/electron/open-directory-picker", () => ({ isElectron: true, openDirectoryPicker: vi.fn() }));
vi.mock("../../shared/hooks/useLocale", () => ({ useLocale: () => ({ locale: "zh" }) }));

const primary = { id: "p", name: "frontend", path: "/repos/frontend", role: "primary" as const, status: "available" as const, location: { kind: "host" as const, path: "/repos/frontend" } };
const reference = { id: "ref-api", name: "api", path: "/repos/api", role: "reference" as const, status: "available" as const };
const initial: ProjectWorkspace = { roots: [primary, reference] };
const added = { id: "ref-shared", name: "shared", path: "/repos/shared", role: "reference" as const, status: "available" as const };

function view(id = "p") {
  return render(<MemoryRouter><WorkspaceManagementContent key={id} workspaceId={id} /></MemoryRouter>);
}
async function ready() {
  await screen.findByText("/repos/frontend");
  await waitFor(() => expect(screen.getByRole("button", { name: "添加项目" })).toBeEnabled());
}

beforeEach(() => {
  vi.clearAllMocks();
  useShellStore.setState({ projects: [{ id: "p", name: "产品研发" } as ProjectSummary], currentProjectId: "other" });
  vi.mocked(projectApi.getWorkspace).mockResolvedValue(initial);
  vi.mocked(projectApi.addReference).mockResolvedValue({ roots: [...initial.roots, added] });
  vi.mocked(projectApi.removeReference).mockResolvedValue({ roots: [primary] });
  vi.mocked(openDirectoryPicker).mockResolvedValue({ name: "shared", path: "/repos/shared" });
});

describe("workspace management", () => {
  it("binds the target workspace and protects the default project", async () => {
    view(); await ready();
    expect(projectApi.getWorkspace).toHaveBeenCalledWith("p");
    expect(useShellStore.getState().currentProjectId).toBe("other");
    expect(screen.queryByRole("button", { name: "移除: frontend" })).not.toBeInTheDocument();
  });

  it("opens the folder picker directly and adds the selected folder immediately", async () => {
    const user = userEvent.setup(); view(); await ready();
    await user.click(screen.getByRole("button", { name: "添加项目" }));
    expect(openDirectoryPicker).toHaveBeenCalledOnce();
    await waitFor(() => expect(projectApi.addReference).toHaveBeenCalledExactlyOnceWith("p", { location: { kind: "host", path: "/repos/shared" }, name: "shared" }));
  });

  it("confirms removal inline and preserves the project after a failed request", async () => {
    const user = userEvent.setup();
    vi.mocked(projectApi.removeReference).mockRejectedValueOnce(new Error("write failed"));
    view(); await ready();
    await user.click(screen.getByRole("button", { name: "移除: api" }));
    expect(screen.getByText("从工作区移除 api？")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("write failed");
    expect(screen.getByText("/repos/api")).toBeInTheDocument();
  });

  it("removes the reference after confirmation while keeping the default", async () => {
    const user = userEvent.setup(); view(); await ready();
    await user.click(screen.getByRole("button", { name: "移除: api" }));
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(screen.queryByText("/repos/api")).not.toBeInTheDocument());
    expect(screen.getByText("/repos/frontend")).toBeInTheDocument();
  });
});
