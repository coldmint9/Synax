import { EditorView } from "@codemirror/view";
import { act } from "@testing-library/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileViewerDialog } from "./FileViewerDialog";
import { createMergeModel, decideRows, serializeMergeResolutionState } from "./mergeModel";
import type { MergeFile } from "../../../../../api/services/git-mr/contracts";
vi.mock("../../../lib/shiki-highlighter", () => ({ highlightWikiCode: async () => "" }));

function editorText(element: HTMLElement) { return EditorView.findFromDOM(element)!.state.doc.toString(); }
function editEditor(element: HTMLElement, value: string) {
  const view = EditorView.findFromDOM(element)!;
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } }));
}

const file: MergeFile = {
  id: "f", path: "file.ts", status: "UU", conflicted: true, kind: "text",
  base: "old\nold2\n", target: "A\nB\n", source: "a\nb\n",
  result: "<<<<<<< HEAD\nA\nB\n||||||| base\nold\nold2\n=======\na\nb\n>>>>>>> source\n",
  revision: "rev1", baseExists: true, targetExists: true, sourceExists: true,
};
const editor = () => screen.getByRole("textbox", { name: "编辑合并结果 file.ts" });
const resolve = () => screen.getByRole("button", { name: "标记文件已解决" });
afterEach(cleanup);
describe("shared FileViewerDialog", () => {
  it("gates unresolved blocks, supports manual mixed results, undo/redo and expected revision", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined), onClose = vi.fn();
    render(<FileViewerDialog file={file} onSave={onSave} onClose={onClose} />);
    expect(resolve()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "采用右侧" }));
    expect(editorText(editor())).toBe("a\nb\n");
    editEditor(editor(), "a\nB\n");
    expect(resolve()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认当前结果" }));
    expect(resolve()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "撤销" })); expect(resolve()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重做" })); fireEvent.click(resolve());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ expectedRevision: "rev1", content: "a\nB\n", resolutionState: expect.objectContaining({ schemaVersion: 1 }), resolve: true }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it("keeps a failed draft save and its edited buffer", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("409 文件版本已过期"));
    render(<FileViewerDialog file={file} onSave={onSave} onClose={vi.fn()} />);
    editEditor(editor(), "manual\nB\n");
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("409"));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: "rev1", content: "manual\nB\n", resolve: false }));
    expect(editorText(editor())).toBe("manual\nB\n"); expect(resolve()).toBeDisabled();
  });
  it("requires explicit confirmation after keeping both complete blocks", () => {
    render(<FileViewerDialog file={file} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "保留双方" }));
    expect(editorText(editor())).toBe("A\nB\na\nb\n"); expect(resolve()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认当前结果" })); expect(resolve()).toBeEnabled();
  });
  it("does not close dirty buffers with Escape and restores trigger focus", async () => {
    const user = userEvent.setup(); const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    const onClose = vi.fn(); const view = render(<FileViewerDialog file={file} onSave={vi.fn()} onClose={onClose} />);
    editEditor(editor(), "edited"); editor().focus();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled(); expect(await screen.findByRole("button", { name: "继续编辑" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "继续编辑" })); view.unmount();
    await waitFor(() => expect(document.activeElement).toBe(trigger)); trigger.remove();
  });
  it("retains local edits and blocks writes when an external revision arrives", () => {
    const onSave = vi.fn(); const view = render(<FileViewerDialog file={file} onSave={onSave} onClose={vi.fn()} />);
    editEditor(editor(), "local\nB\n");
    view.rerender(<FileViewerDialog file={{ ...file, revision: "other", result: "remote\n" }} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("版本已更新"); expect(editorText(editor())).toBe("local\nB\n");
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled(); expect(onSave).not.toHaveBeenCalled();
  });
  it("disables mutations in read-only mode", () => {
    render(<FileViewerDialog file={file} onSave={vi.fn()} onClose={vi.fn()} readOnly />);
    expect(screen.getByRole("button", { name: "采用右侧" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled(); expect(editor()).toHaveAttribute("aria-readonly", "true");
  });
  it("restores old per-row decisions into the continuous editor without losing text", async () => {
    const original = decideRows(createMergeModel(file), ["1:0"], "source");
    const resolutionState = await serializeMergeResolutionState(original, file);
    render(<FileViewerDialog file={{ ...file, result: original.text, resolutionState }} onSave={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(editorText(editor())).toBe("a\nB\n"));
    expect(resolve()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认当前结果" })); expect(resolve()).toBeEnabled();
  });
  it("gates editing while restoring saved state, then allows a new local edit", async () => {
    const original = decideRows(createMergeModel(file), ["1:0"], "source");
    const resolutionState = await serializeMergeResolutionState(original, file);
    render(<FileViewerDialog file={{ ...file, result: original.text, resolutionState }} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    await waitFor(() => expect(editorText(editor())).toBe("a\nB\n"));
    editEditor(editor(), "new local edit\n");
    await waitFor(() => expect(editorText(editor())).toBe("new local edit\n")); expect(resolve()).toBeDisabled();
  });
  it("shows actual version labels and Base without losing the result", () => {
    render(<FileViewerDialog file={{ ...file, targetLabel: "main@abc123", sourceLabel: "feature/work@def456", baseLabel: "Base：base@789abc" }} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getAllByText(/main@abc123/).length).toBeGreaterThan(0); expect(screen.getAllByText(/feature\/work@def456/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "查看 Base" })); expect(screen.getByText("Base：base@789abc")).toBeInTheDocument(); expect(editorText(editor())).toBe("A\nB\n");
  });
  it("requires a whole-file decision for structural conflicts and disallows absent sides", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<FileViewerDialog file={{ ...file, kind: "structural", sourceExists: false }} onSave={onSave} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "采用来源完整文件" })).toBeDisabled(); expect(resolve()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除文件" })); fireEvent.click(resolve());
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ expectedRevision: "rev1", choice: "delete", resolve: true }));
  });
});
