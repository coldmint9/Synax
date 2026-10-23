import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeFile } from "../../../../../services/local-node/modules/git-mr/contracts";
const holder = vi.hoisted(() => ({ harness: null as any }));
vi.mock("./monacoRuntime", async () => {
  const { createMonacoHarness } = await import("./__tests__/monacoTestHarness");
  holder.harness = createMonacoHarness();
  return {
    monaco: holder.harness.monaco,
    languageForPath: async () => "typescript",
  };
});
import MonacoMergeWorkbench from "./MonacoMergeWorkbench";
const harness = new Proxy({} as any, { get: (_, key) => holder.harness[key] });
const file: MergeFile = {
  id: "f",
  path: "file.ts",
  status: "UU",
  conflicted: true,
  kind: "text",
  base: "old\n",
  target: "left\n",
  source: "right\n",
  result: "<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> source\n",
  revision: "rev1",
  baseExists: true,
  targetExists: true,
  sourceExists: true,
};
const editor = () =>
  screen.getByRole("textbox", { name: "编辑合并结果 file.ts" });
const edit = (value: string) =>
  fireEvent.input(editor(), { target: { value } });
let workers: Array<{ terminate: ReturnType<typeof vi.fn> }>;
beforeEach(() => {
  harness.reset();
  workers = [];
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: unknown;
      onerror: unknown;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        workers.push(this);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Monaco merge workbench lifecycle", () => {
  it("mounts three independent models and disposes every model/editor/worker on close", async () => {
    const view = render(
      <MonacoMergeWorkbench
        file={file}
        managed
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" });
    expect(harness.models).toHaveLength(3);
    expect(harness.editors).toHaveLength(3);
    expect(workers).toHaveLength(1);
    view.unmount();
    for (const model of harness.models)
      expect(model.dispose).toHaveBeenCalledOnce();
    for (const item of harness.editors)
      expect(item.dispose).toHaveBeenCalledOnce();
    expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it("keeps running results read-only and does not expose manual merge actions", async () => {
    render(
      <MonacoMergeWorkbench
        file={file}
        managed
        readOnly
        onSave={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" }),
    ).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "确认当前结果" })).toBeNull();
    expect(screen.queryByRole("button", { name: "采用左侧" })).toBeNull();
  });
  it("autosaves a complete manual buffer as draft and retains the model across checkpoint acknowledgements", async () => {
    const onSave = vi.fn().mockResolvedValue({ revision: "rev2" });
    const view = render(
      <MonacoMergeWorkbench
        file={file}
        managed
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" });
    edit("combined\n");
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        content: "combined\n",
        expectedRevision: "rev1",
        resolve: false,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("草稿已保存"),
    );
    view.rerender(
      <MonacoMergeWorkbench
        file={{ ...file, revision: "rev2", result: "combined\n" }}
        managed
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(harness.models).toHaveLength(3);
    expect(editor()).toHaveValue("combined\n");
    edit("combined again\n");
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith({
        content: "combined again\n",
        expectedRevision: "rev2",
        resolve: false,
      }),
    );
  });
  it("does not overwrite dirty drafts when an external revision arrives", async () => {
    const onSave = vi.fn();
    const view = render(
      <MonacoMergeWorkbench
        file={file}
        managed
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" });
    edit("local draft\n");
    view.rerender(
      <MonacoMergeWorkbench
        file={{ ...file, result: "remote\n", revision: "rev2" }}
        managed
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(editor()).toHaveValue("local draft\n");
    expect(editor()).toHaveAttribute("readonly");
    expect(screen.getByRole("alert")).toHaveTextContent("本地草稿已保留");
  });
  it("flushes latest edits after an inflight save and never overlaps writes", async () => {
    let finish!: (result: { revision: string }) => void;
    const onSave = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ revision: "rev3" });
    let flush: (() => Promise<boolean>) | null = null;
    render(
      <MonacoMergeWorkbench
        file={file}
        managed
        onSave={onSave}
        onClose={vi.fn()}
        registerDraftFlush={(fn) => {
          flush = fn;
        }}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" });
    edit("first\n");
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    edit("second\n");
    let done!: Promise<boolean>;
    act(() => {
      done = flush!();
    });
    await act(async () => {
      finish({ revision: "rev2" });
      await done;
    });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith({
      expectedRevision: "rev2",
      content: "second\n",
      resolve: false,
    });
  });
  it("preserves the buffer after save failure and leaves close confirmation actionable", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("409 文件版本过期"));
    const onClose = vi.fn();
    render(
      <MonacoMergeWorkbench
        file={file}
        managed
        onSave={onSave}
        onClose={onClose}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" });
    edit("manual\n");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("409"),
    );
    expect(editor()).toHaveValue("manual\n");
    fireEvent.click(screen.getByRole("button", { name: "关闭合并编辑器" }));
    expect(
      screen.getByRole("heading", { name: "保留当前草稿？" }),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("updates checkpoint bodies without marking programmatic changes as dirty", async () => {
    const onSave = vi.fn();
    const view = render(
      <MonacoMergeWorkbench
        file={file}
        readOnly
        managed
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("textbox", { name: "编辑合并结果 file.ts" });
    view.rerender(
      <MonacoMergeWorkbench
        file={{ ...file, result: "resolved\n", revision: "rev2" }}
        readOnly
        managed
        onSave={onSave}
        onClose={vi.fn()}
      />,
    );
    expect(editor()).toHaveValue("resolved\n");
    expect(screen.getByRole("status")).toHaveTextContent("检查点");
    expect(onSave).not.toHaveBeenCalled();
  });
});
