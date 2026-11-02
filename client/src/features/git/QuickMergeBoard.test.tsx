import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../adapters/transport/quickMerge", () => ({
  quickMergeApi: {
    board: vi.fn(),
    createRule: vi.fn(),
    createGroup: vi.fn(),
    renameGroup: vi.fn(),
    deleteRule: vi.fn(),
    deleteGroup: vi.fn(),
    merge: vi.fn(),
    push: vi.fn(),
    updateRule: vi.fn(),
  },
}));
import { quickMergeApi } from "../../adapters/transport/quickMerge";
import { QuickMergeBoardView } from "./QuickMergeBoard";

function renderBoard() {
  return render(
    <QuickMergeBoardView
      projectId="p"
      rootId="root"
      branches={["main", "test"]}
      onOpenMerge={vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quickMergeApi.board).mockResolvedValue({
    groups: [
      {
        id: "g1",
        projectId: "p",
        rootId: "root",
        name: "日常发布",
        order: 0,
        createdAt: "",
      },
    ],
    rules: [],
  });
});

describe("quick merge board", () => {
  it("creates one rule when the save form is submitted twice", async () => {
    let finish!: (rule: unknown) => void;
    vi.mocked(quickMergeApi.createRule).mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve as (rule: unknown) => void;
      }) as never,
    );
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: /新增指令/ }));
    fireEvent.change(screen.getByLabelText("源分支"), {
      target: { value: "feature/a" },
    });
    fireEvent.change(screen.getByLabelText("目标分支"), {
      target: { value: "test" },
    });

    const target = screen.getByLabelText("目标分支");
    fireEvent.keyDown(target, { key: "Enter" });
    fireEvent.keyDown(target, { key: "Enter" });

    await waitFor(() => expect(quickMergeApi.createRule).toHaveBeenCalledTimes(1));
    finish({
      id: "r1",
      projectId: "p",
      rootId: "root",
      groupId: "g1",
      source: "feature/a",
      target: "test",
      order: 0,
      createdAt: "",
      status: "idle",
    });
  });

  it("creates one group when the new-group form is submitted twice", async () => {
    let finish!: (group: unknown) => void;
    vi.mocked(quickMergeApi.createGroup).mockImplementation(
      () => new Promise((resolve) => {
        finish = resolve as (group: unknown) => void;
      }) as never,
    );
    renderBoard();

    fireEvent.click(await screen.findByRole("button", { name: /新建分组/ }));
    const input = screen.getByLabelText("分组名称");
    fireEvent.change(input, { target: { value: "发布" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(quickMergeApi.createGroup).toHaveBeenCalledTimes(1));
    finish({
      id: "g2",
      projectId: "p",
      rootId: "root",
      name: "发布",
      order: 1,
      createdAt: "",
    });
  });
});
