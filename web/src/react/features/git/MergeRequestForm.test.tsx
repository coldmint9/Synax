import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../lib/api/gitMr", () => ({
  gitMrApi: { branchOptions: vi.fn() },
}));
import { gitMrApi } from "../../../lib/api/gitMr";
import { MergeRequestForm } from "./MergeRequestForm";
const workspace = {
  repositoryRoot: "/repo",
  defaultPath: "/repo",
  worktrees: [],
  branches: ["master", "feature/a", "feature/b"].map((name) => ({
    name,
    head: "oid",
    upstream: null,
    checkedOutPath: null,
  })),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitMrApi.branchOptions).mockImplementation(
    async (_project, input) => ({
      target: input.target,
      targetOid: "oid",
      comparisonBranch: input.target,
      invalidSources: [],
      branches: workspace.branches.map((branch) => ({
        name: branch.name,
        oid: branch.head,
        enabled: branch.name !== input.target,
        reason: branch.name === input.target ? "same_branch" : undefined,
        detail: branch.name === input.target ? "当前目标分支" : undefined,
        mergeBaseOids: ["base"],
        ancestor: {
          branch: "master",
          oid: "base",
          evidence: "creation_record" as const,
        },
      })),
    }),
  );
});
async function setup(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <MergeRequestForm
      projectId="project"
      roots={[]}
      rootId=""
      workspace={workspace}
      onRootChange={vi.fn()}
      onClose={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
  fireEvent.change(screen.getByLabelText("标题"), {
    target: { value: "Ordered merge" },
  });
  fireEvent.change(screen.getByLabelText("目标分支"), {
    target: { value: "master" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加源分支" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "添加 feature/a" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "添加 feature/a" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "添加 feature/b" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "添加 feature/b" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "创建并准备合并" }),
    ).toBeEnabled(),
  );
  return onSubmit;
}
describe("MR creation", () => {
  it("submits reordered sources and independently authorized preset behavior", async () => {
    const submit = await setup();
    fireEvent.click(screen.getByRole("button", { name: "上移 feature/b" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "创建并准备合并" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByLabelText("保存为一键预设"));
    fireEvent.change(screen.getByLabelText("预设名称"), {
      target: { value: "weekly" },
    });
    fireEvent.click(
      screen.getByLabelText("预设运行时，检查通过后自动更新本地目标"),
    );
    fireEvent.click(screen.getByRole("button", { name: "创建并准备合并" }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        expect.objectContaining({
          sources: ["feature/b", "feature/a"],
          target: "master",
          autoFinalize: true,
          allowCheckedOutTarget: false,
        }),
        "weekly",
      ),
    );
  });
  it("keeps invalid check arguments local and surfaces request failures", async () => {
    const submit = await setup(
      vi.fn().mockRejectedValue(new Error("Branch moved")),
    );
    fireEvent.click(screen.getByRole("button", { name: "添加检查" }));
    fireEvent.change(screen.getByLabelText("程序 1"), {
      target: { value: "npm" },
    });
    fireEvent.change(screen.getByLabelText("参数（JSON 数组）"), {
      target: { value: "test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并准备合并" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "JSON 字符串数组",
    );
    expect(submit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("参数（JSON 数组）"), {
      target: { value: '["test"]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并准备合并" }));
    expect(await screen.findByText("Branch moved")).toBeInTheDocument();
  });
});

it("shows the merge direction, disables impossible sources with ancestry and retains a visible invalid selection after target changes", async () => {
  await setup();
  expect(
    screen.getByRole("group", { name: "源分支合入目标分支" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加 master" })).toBeDisabled();
  expect(screen.getAllByText(/祖先来源：master/).length).toBeGreaterThan(0);
  vi.mocked(gitMrApi.branchOptions).mockResolvedValue({
    target: "feature/a",
    targetOid: "a",
    comparisonBranch: "feature/a",
    invalidSources: [
      { name: "feature/b", reason: "branch_policy", detail: "包含 beta 提交" },
    ],
    branches: workspace.branches.map((branch) => ({
      name: branch.name,
      oid: "oid",
      enabled: false,
      reason: "branch_policy",
      detail: "包含 beta 提交",
      mergeBaseOids: [],
      ancestor: { evidence: "unknown" },
    })),
  });
  fireEvent.change(screen.getByLabelText("目标分支"), {
    target: { value: "feature/a" },
  });
  expect(screen.getByRole("button", { name: "创建并准备合并" })).toBeDisabled();
  await screen.findByText(/有 2 个已选分支不能合入/);
  expect(screen.getByRole("button", { name: "添加 feature/b" })).toBeDisabled();
  expect(screen.getAllByText("包含 beta 提交").length).toBeGreaterThan(0);
});

it("rejects stale eligibility responses and fails closed on a query error", async () => {
  await setup();
  let complete: (value: any) => void = () => {};
  vi.mocked(gitMrApi.branchOptions).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  fireEvent.change(screen.getByLabelText("目标分支"), {
    target: { value: "feature/a" },
  });
  vi.mocked(gitMrApi.branchOptions).mockRejectedValueOnce(
    new Error("无法读取仓库"),
  );
  fireEvent.change(screen.getByLabelText("目标分支"), {
    target: { value: "feature/b" },
  });
  await screen.findAllByText("无法读取仓库");
  complete({
    target: "feature/a",
    targetOid: "old",
    comparisonBranch: "feature/a",
    invalidSources: [],
    branches: [],
  });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "创建并准备合并" }),
    ).toBeDisabled(),
  );
  expect(screen.getByLabelText("目标分支")).toHaveValue("feature/b");
});

it("reuses inspected metadata for ordinary selections but rechecks the ordered queue in fast-forward mode", async () => {
  await setup();
  expect(gitMrApi.branchOptions).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("合并策略"), {
    target: { value: "ff_only" },
  });
  await waitFor(() =>
    expect(gitMrApi.branchOptions).toHaveBeenLastCalledWith(
      "project",
      expect.objectContaining({
        strategy: "ff_only",
        sources: ["feature/a", "feature/b"],
      }),
      expect.any(AbortSignal),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "上移 feature/b" }));
  await waitFor(() =>
    expect(gitMrApi.branchOptions).toHaveBeenLastCalledWith(
      "project",
      expect.objectContaining({ sources: ["feature/b", "feature/a"] }),
      expect.any(AbortSignal),
    ),
  );
});
