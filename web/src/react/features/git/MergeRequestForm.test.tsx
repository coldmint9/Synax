import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
function setup(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <MergeRequestForm
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
  fireEvent.change(screen.getByLabelText("添加源分支"), {
    target: { value: "feature/a" },
  });
  fireEvent.change(screen.getByLabelText("添加源分支"), {
    target: { value: "feature/b" },
  });
  return onSubmit;
}
describe("MR creation", () => {
  it("submits reordered sources and independently authorized preset behavior", async () => {
    const submit = setup();
    fireEvent.click(screen.getByRole("button", { name: "上移 feature/b" }));
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
    const submit = setup(vi.fn().mockRejectedValue(new Error("Branch moved")));
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
