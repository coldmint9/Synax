import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileViewerDialog } from "./FileViewerDialog";
import {
  createMergeModel,
  decideRows,
  serializeMergeResolutionState,
} from "./mergeModel";
import type { MergeFile } from "../../../../../api/services/git-mr/contracts";
const file: MergeFile = {
  id: "f",
  path: "file.ts",
  status: "UU",
  conflicted: true,
  kind: "text",
  base: "old\nold2\n",
  target: "A\nB\n",
  source: "a\nb\n",
  result:
    "<<<<<<< HEAD\nA\nB\n||||||| base\nold\nold2\n=======\na\nb\n>>>>>>> source\n",
  revision: "rev1",
  baseExists: true,
  targetExists: true,
  sourceExists: true,
};
afterEach(cleanup);

describe("shared FileViewerDialog", () => {
  it("gates unresolved rows, accepts each side independently, undoes and saves expected revision", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined),
      onClose = vi.fn();
    render(<FileViewerDialog file={file} onSave={onSave} onClose={onClose} />);
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "采用源第 1 行到冲突行 1" }),
    );
    expect(screen.getByRole("textbox", { name: "编辑冲突行 1" })).toHaveValue(
      "a\n",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "采用目标第 2 行到冲突行 2" }),
    );
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重做" }));
    fireEvent.click(screen.getByRole("button", { name: "标记文件已解决" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        expectedRevision: "rev1",
        content: "a\nB\n",
        resolutionState: expect.objectContaining({ schemaVersion: 1 }),
        resolve: true,
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
  it("saves drafts without marking resolved and preserves stale error and edited buffer", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("409 文件版本已过期"));
    render(<FileViewerDialog file={file} onSave={onSave} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "编辑冲突行 1" }), {
      target: { value: "manual\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("409"),
    );
    expect(onSave).toHaveBeenCalledWith({
      expectedRevision: "rev1",
      content: "manual\nB\n",
      resolutionState: expect.objectContaining({ schemaVersion: 1 }),
      resolve: false,
    });
    expect(screen.getByRole("textbox", { name: "编辑冲突行 1" })).toHaveValue(
      "manual\n",
    );
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeDisabled();
  });
  it("requires confirmation after both-side selection and supports shift multi-select", () => {
    render(<FileViewerDialog file={file} onSave={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "选择冲突行 1" }));
    fireEvent.click(screen.getByRole("button", { name: "选择冲突行 2" }), {
      shiftKey: true,
    });
    expect(screen.getByText("已选 2 行")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "目标 → 源" }));
    expect(screen.getByRole("textbox", { name: "编辑冲突行 1" })).toHaveValue(
      "A\na\n",
    );
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "确认选中行" }));
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeEnabled();
  });
  it("does not silently close dirty buffers with Escape and restores trigger focus", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const onClose = vi.fn();
    const view = render(
      <FileViewerDialog file={file} onSave={vi.fn()} onClose={onClose} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "编辑冲突行 1" }), {
      target: { value: "edited" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "继续编辑" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
    view.unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
  it("keeps old expectedRevision when an external revision arrives and retains edits", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("409 stale"));
    const view = render(
      <FileViewerDialog file={file} onSave={onSave} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "编辑冲突行 1" }), {
      target: { value: "local\n" },
    });
    view.rerender(
      <FileViewerDialog
        file={{ ...file, revision: "other-revision", result: "remote\n" }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("版本已更新");
    expect(screen.getByRole("textbox", { name: "编辑冲突行 1" })).toHaveValue(
      "local\n",
    );
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        expectedRevision: "rev1",
        content: "local\nB\n",
        resolutionState: expect.objectContaining({ schemaVersion: 1 }),
        resolve: false,
      }),
    );
  });
  it("disables mutations in read-only mode", () => {
    render(
      <FileViewerDialog
        file={file}
        onSave={vi.fn()}
        onClose={vi.fn()}
        readOnly
      />,
    );
    expect(
      screen.getByRole("button", { name: "采用源第 1 行到冲突行 1" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存草稿" })).toBeDisabled();
    expect(
      screen.getByRole("textbox", { name: "编辑冲突行 1" }),
    ).toHaveAttribute("readonly");
  });
  it("restores saved row decisions after closing and reopening a marker-free draft", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <FileViewerDialog file={file} onSave={onSave} onClose={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "采用源第 1 行到冲突行 1" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "编辑冲突行 2" }), {
      target: { value: "manual second\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    const saved = onSave.mock.calls[0][0];
    view.unmount();
    render(
      <FileViewerDialog
        file={{
          ...file,
          result: saved.content,
          revision: "saved-revision",
          resolutionState: saved.resolutionState,
        }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("已恢复草稿及逐行决定");
    expect(screen.getByRole("textbox", { name: "编辑冲突行 1" })).toHaveValue(
      "a\n",
    );
    expect(screen.getByRole("textbox", { name: "编辑冲突行 2" })).toHaveValue(
      "manual second\n",
    );
    expect(screen.getByRole("button", { name: "确认冲突行 1" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认冲突行 2" })).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "采用源第 2 行到冲突行 2" }),
    );
    expect(screen.getByRole("textbox", { name: "编辑冲突行 1" })).toHaveValue(
      "a\n",
    );
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeEnabled();
  });
  it("ignores an asynchronously hydrated state after the user edits", async () => {
    const original = decideRows(createMergeModel(file), ["1:0"], "source");
    const resolutionState = await serializeMergeResolutionState(original, file);
    render(
      <FileViewerDialog
        file={{ ...file, result: original.text, resolutionState }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑完整结果" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "编辑文件 file.ts" }),
      { target: { value: "new local edit\n" } },
    );
    await waitFor(() =>
      expect(screen.queryByText("恢复草稿行决定中…")).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("textbox", { name: "编辑文件 file.ts" }),
    ).toHaveValue("new local edit\n");
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeDisabled();
  });
  it("shows actual side labels and exposes keyboard-operated narrow-screen tabs", () => {
    const { container } = render(
      <FileViewerDialog
        file={{
          ...file,
          targetLabel: "main@abc123",
          sourceLabel: "feature/work@def456",
          baseLabel: "base@789abc",
        }}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/main@abc123/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/feature\/work@def456/).length).toBeGreaterThan(
      0,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看 Base" }));
    expect(screen.getByText("Base：base@789abc")).toBeInTheDocument();
    const target = screen.getByRole("tab", { name: "目标", hidden: true });
    fireEvent.click(target);
    expect(document.querySelector(".shared-file-dialog")).toHaveAttribute(
      "data-mobile-side",
      "target",
    );
    fireEvent.keyDown(target, { key: "ArrowRight" });
    expect(document.querySelector(".shared-file-dialog")).toHaveAttribute(
      "data-mobile-side",
      "result",
    );
    expect(container).toBeTruthy();
  });
  it("requires a whole-file decision for structural conflicts and disallows absent sides", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <FileViewerDialog
        file={{ ...file, kind: "structural", sourceExists: false }}
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "保留完整源文件" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "标记文件已解决" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "删除文件" }));
    fireEvent.click(screen.getByRole("button", { name: "标记文件已解决" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        expectedRevision: "rev1",
        choice: "delete",
        resolve: true,
      }),
    );
  });
});
