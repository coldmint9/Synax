import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { RepositoryBranchPicker } from "../RepositoryBranchPicker";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    listSessionBranches: vi.fn(),
    switchSessionBranch: vi.fn(),
    createSessionBranch: vi.fn(),
  },
}));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en" }),
}));
const branches = {
  rootId: "r",
  current: "main",
  branches: [
    { name: "main", current: true, occupied: false },
    { name: "feature", current: false, occupied: false },
    { name: "occupied", current: false, occupied: true },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(agentRuntimeApi.listSessionBranches).mockResolvedValue(branches);
});
it.each(["main", "codex/streaming-commit-message"])(
  "keeps the Git icon outside the truncated label for %s",
  (branch) => {
    render(
      <RepositoryBranchPicker
        sessionId="s"
        branch={branch}
        onSwitched={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Switch Git branch/ });
    const icon = trigger.querySelector(".ws-branch-icon");
    const label = trigger.querySelector(".ws-branch-label");
    expect(icon?.querySelector("svg.lucide-git-branch")).not.toBeNull();
    expect(label).toHaveTextContent(branch);
    expect(label?.querySelector("svg")).toBeNull();
    expect(trigger.querySelector(".lucide-chevron-down")).toBeNull();
    expect(trigger).toHaveAttribute("title", branch);
  },
);

it("lists local branches and prevents choosing a branch used by another worktree", async () => {
  const changed = vi.fn();
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockResolvedValue({
    ...branches,
    current: "feature",
  });
  render(
    <RepositoryBranchPicker
      sessionId="s"
      rootId="r"
      branch="main"
      onSwitched={changed}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Switch Git branch/ }),
  );
  expect(
    await screen.findByRole("option", { name: /occupied/ }),
  ).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(screen.getByRole("option", { name: "feature" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(agentRuntimeApi.switchSessionBranch).toHaveBeenCalledWith(
    "s",
    "feature",
    "r",
  );
});
it("keeps a failed switch visible without duplicating its alert in a closing menu", async () => {
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockRejectedValue(
    new Error("uncommitted changes"),
  );
  render(
    <RepositoryBranchPicker
      sessionId="s"
      rootId="r"
      branch="main"
      onSwitched={vi.fn()}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Switch Git branch/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "feature" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "uncommitted changes",
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
});
it("ignores a switch response after the repository component unmounts", async () => {
  let finish!: (value: typeof branches) => void;
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const changed = vi.fn();
  const view = render(
    <RepositoryBranchPicker
      sessionId="s"
      rootId="r"
      branch="main"
      onSwitched={changed}
    />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Switch Git branch/ }),
  );
  await userEvent.click(await screen.findByRole("option", { name: "feature" }));
  view.unmount();
  await act(async () => finish(branches));
  expect(changed).not.toHaveBeenCalled();
});

it("shows full branch names in a flat list and switches with the full name", async () => {
  const flat = {
    ...branches,
    branches: [
      branches.branches[0],
      { name: "feature/ui/header", current: false, occupied: false },
      { name: "feature/api/header", current: false, occupied: false },
      { name: "fix/header", current: false, occupied: false },
    ],
  };
  vi.mocked(agentRuntimeApi.listSessionBranches).mockResolvedValue(flat);
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockResolvedValue(flat);
  const changed = vi.fn();
  render(
    <RepositoryBranchPicker
      sessionId="s"
      rootId="r"
      branch="main"
      onSwitched={changed}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Switch Git branch/ }));
  const leaf = await screen.findByRole("option", { name: "feature/ui/header" });
  expect(screen.getAllByRole("option")).toHaveLength(4);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByTitle("feature/ui/header")).toHaveTextContent(
    "feature/ui/header",
  );
  expect(leaf.querySelector(".lucide-git-branch")).not.toBeNull();
  await user.click(leaf);
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(agentRuntimeApi.switchSessionBranch).toHaveBeenCalledExactlyOnceWith(
    "s",
    "feature/ui/header",
    "r",
  );
});

it("searches full names case-insensitively, shows an empty result and resets on reopen", async () => {
  render(
    <RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} />,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: /Switch Git branch/ });
  await user.click(trigger);
  await screen.findByRole("option", { name: "feature" });
  const search = screen.getByRole("combobox", { name: "Search branches" });
  await waitFor(() => expect(search).toHaveFocus());
  await user.type(search, "FEATURE");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: "feature" })).toBeInTheDocument();
  await user.type(search, "missing");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("No matching branches");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(search).not.toBeInTheDocument());
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  expect(await screen.findAllByRole("option")).toHaveLength(3);
  expect(screen.getByRole("combobox")).toHaveValue("");
});

it("supports keyboard selection and preserves current and occupied branch indicators", async () => {
  vi.mocked(agentRuntimeApi.switchSessionBranch).mockResolvedValue(branches);
  const changed = vi.fn();
  render(
    <RepositoryBranchPicker
      sessionId="s"
      rootId="r"
      branch="main"
      onSwitched={changed}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Switch Git branch/ }));
  const occupied = await screen.findByRole("option", { name: /occupied/ });
  expect(occupied).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("option", { name: "main" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(screen.getByLabelText("Current branch")).toBeInTheDocument();
  await user.click(occupied);
  expect(agentRuntimeApi.switchSessionBranch).not.toHaveBeenCalled();
  await user.click(screen.getByRole("combobox"));
  const search = screen.getByRole("combobox", { name: "Search branches" });
  await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "main" }).id));
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { name: "feature" }).id));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(agentRuntimeApi.switchSessionBranch).toHaveBeenCalledExactlyOnceWith(
    "s",
    "feature",
    "r",
  );
});

it("does not switch when the current branch is chosen", async () => {
  render(
    <RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Switch Git branch/ }));
  await user.click(await screen.findByRole("option", { name: "main" }));
  expect(agentRuntimeApi.switchSessionBranch).not.toHaveBeenCalled();
});

it("shows a loading failure without an empty list message", async () => {
  vi.mocked(agentRuntimeApi.listSessionBranches).mockRejectedValue(
    new Error("Cannot read branches"),
  );
  render(
    <RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} />,
  );
  await userEvent.click(
    screen.getByRole("button", { name: /Switch Git branch/ }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Cannot read branches",
  );
  expect(screen.queryByText("No local branches")).not.toBeInTheDocument();
});

it("honors external open requests through the actual trigger and dismisses with Escape or outside click", async () => {
  const user = userEvent.setup();
  const view = render(<RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} />);
  view.rerender(<RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} openRequest={1} />);
  const search = await screen.findByRole("combobox", { name: "Search branches" });
  expect(search).toHaveFocus();
  await screen.findByRole("option", { name: "feature" });
  expect(agentRuntimeApi.listSessionBranches).toHaveBeenCalledTimes(1);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
  view.rerender(<RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} openRequest={2} />);
  await screen.findByRole("option", { name: "feature" });
  expect(agentRuntimeApi.listSessionBranches).toHaveBeenCalledTimes(2);
  await user.click(document.body);
  await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
  expect(agentRuntimeApi.switchSessionBranch).not.toHaveBeenCalled();
});

it("shows the current checkout's true dirty count and prioritizes main", async () => {
  vi.mocked(agentRuntimeApi.listSessionBranches).mockResolvedValue({
    ...branches,
    current: "feature",
    dirtyFileCount: 214,
    branches: [
      { name: "feature", current: true, occupied: false },
      { name: "main", current: false, occupied: false },
    ],
  });
  render(<RepositoryBranchPicker sessionId="s" branch="feature" onSwitched={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: /Switch Git branch/ }));
  expect((await screen.findAllByRole("option")).map((option) => option.getAttribute("aria-label"))).toEqual(["main", "feature"]);
  expect(screen.getByText("Uncommitted: 214 files")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create and check out new branch…" })).toBeEnabled();
});

it("creates a branch through the checkout API and reports its production base", async () => {
  const changed = vi.fn();
  vi.mocked(agentRuntimeApi.createSessionBranch).mockResolvedValue({
    ...branches,
    current: "feature/new-ui",
    dirtyFileCount: 0,
  });
  render(<RepositoryBranchPicker sessionId="s" rootId="r" branch="main" onSwitched={changed} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Switch Git branch/ }));
  await screen.findByRole("option", { name: "main" });
  await user.click(screen.getByRole("button", { name: "Create and check out new branch…" }));
  expect(screen.getByText("Create from main")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox", { name: "New branch name" }), "feature/new-ui");
  await user.click(screen.getByRole("button", { name: "Create and check out" }));
  await waitFor(() => expect(agentRuntimeApi.createSessionBranch).toHaveBeenCalledExactlyOnceWith("s", "feature/new-ui", "r"));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.queryByRole("textbox", { name: "New branch name" })).not.toBeInTheDocument();
});

it("keeps a failed creation editable and does not submit an existing branch", async () => {
  vi.mocked(agentRuntimeApi.createSessionBranch).mockRejectedValue(new Error("Please commit first"));
  render(<RepositoryBranchPicker sessionId="s" branch="main" onSwitched={vi.fn()} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Switch Git branch/ }));
  await screen.findByRole("option", { name: "main" });
  await user.click(screen.getByRole("button", { name: "Create and check out new branch…" }));
  const input = screen.getByRole("textbox", { name: "New branch name" });
  await user.type(input, "feature");
  await user.click(screen.getByRole("button", { name: "Create and check out" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Branch already exists");
  expect(agentRuntimeApi.createSessionBranch).not.toHaveBeenCalled();
  await user.clear(input);
  await user.type(input, "feature/new-ui");
  await user.click(screen.getByRole("button", { name: "Create and check out" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Please commit first");
  expect(input).toHaveValue("feature/new-ui");
});
