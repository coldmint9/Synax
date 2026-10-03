import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MergeFile } from "../../../../../services/local-node/modules/git-mr/contracts";
import { MergeFileViewer } from "./MergeFileViewer";
vi.mock("../../lib/shiki-highlighter", () => ({ highlightCode: async () => "" }));

const editorText = (element: HTMLElement) => (element as HTMLTextAreaElement).value;
function editEditor(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

const file: MergeFile = {
  id: "conflict", path: "example.ts", status: "UU", conflicted: true, kind: "text", revision: "v1",
  base: "before\nold\nafter\n", target: "before\nleft\nafter\n", source: "before\nright\nafter\n",
  result: "before\n<<<<<<< HEAD\nleft\n||||||| base\nold\n=======\nright\n>>>>>>> topic\nafter\n",
  baseExists: true, targetExists: true, sourceExists: true,
};
describe("continuous three-way merge editor", () => {
  it("keeps both complete blocks in left-then-right order", async () => {
    const user = userEvent.setup();
    const multi = { ...file, target: "before\nL1\nL2\nafter\n", source: "before\nR1\nR2\nafter\n", result: "before\n<<<<<<< HEAD\nL1\nL2\n=======\nR1\nR2\n>>>>>>> topic\nafter\n" };
    render(<MergeFileViewer file={multi} onSave={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "保留双方" }));
    expect(editorText(screen.getByRole("textbox", { name: "编辑合并结果 example.ts" }))).toBe("before\nL1\nL2\nR1\nR2\nafter\n");
  });
  it("keeps surrounding content, accepts a whole conflict, and saves the resolved result", async () => {
    const user = userEvent.setup(); const save = vi.fn(async () => {});
    render(<MergeFileViewer file={file} onSave={save} onClose={vi.fn()} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "标记文件已解决" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "采用右侧" }));
    expect(editorText(screen.getByRole("textbox", { name: "编辑合并结果 example.ts" }))).toBe("before\nright\nafter\n");
    await user.click(screen.getByRole("button", { name: "标记文件已解决" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: "v1", content: "before\nright\nafter\n", resolve: true })));
  });
  it("supports continuous editing, undo and redo without silently marking conflicts resolved", async () => {
    const user = userEvent.setup();
    render(<MergeFileViewer file={file} onSave={vi.fn()} onClose={vi.fn()} />);
    const result = screen.getByRole("textbox", { name: "编辑合并结果 example.ts" });
    editEditor(result, "before\nmanual\nafter\n");
    expect(screen.getByRole("button", { name: "标记文件已解决" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(editorText(result)).toBe("before\nleft\nafter\n");
    await user.click(screen.getByRole("button", { name: "重做" }));
    expect(editorText(result)).toBe("before\nmanual\nafter\n");
  });
});
