import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LargeMergeFileViewer from "./LargeMergeFileViewer";
vi.mock("./MonacoTextEditor", () => ({
  MonacoTextEditor: ({ content, ariaLabel, onChange }: any) => (
    <textarea aria-label={ariaLabel} readOnly={!onChange} value={content} />
  ),
}));
const file = {
  id: "f",
  path: "huge.java",
  kind: "text",
  contentState: "partial",
  editable: false,
  revision: "r1",
  target: "start target",
  result: "start result",
  source: "start source",
  base: "start base",
} as any;
afterEach(cleanup);
describe("oversized merge document paging", () => {
  it("rejects a response from a different server revision", async () => {
    const readSlice = vi
      .fn()
      .mockResolvedValue({
        content: "wrong version",
        byteOffset: 0,
        nextByteOffset: 10,
        totalBytes: 100,
        eof: false,
        revision: "r2",
      });
    render(
      <LargeMergeFileViewer
        file={file}
        onSave={vi.fn()}
        onClose={vi.fn()}
        readSlice={readSlice}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "文件版本已变化",
    );
    expect(screen.getByRole("textbox", { name: /只读片段/ })).not.toHaveValue(
      "wrong version",
    );
  });
  it("loads only a bounded page and navigates by server UTF8-safe cursor", async () => {
    const readSlice = vi
      .fn()
      .mockResolvedValueOnce({
        content: "page one",
        byteOffset: 0,
        nextByteOffset: 65534,
        totalBytes: 30000000,
        eof: false,
        revision: "r1",
      })
      .mockResolvedValueOnce({
        content: "page two",
        byteOffset: 65534,
        nextByteOffset: 131068,
        totalBytes: 30000000,
        eof: false,
        revision: "r1",
      });
    const save = vi.fn();
    render(
      <LargeMergeFileViewer
        file={file}
        onSave={save}
        onClose={vi.fn()}
        readSlice={readSlice}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /只读片段/ })).toHaveValue(
        "page one",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一片段" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: /只读片段/ })).toHaveValue(
        "page two",
      ),
    );
    expect(readSlice).toHaveBeenLastCalledWith(
      "result",
      65534,
      65536,
      "r1",
      expect.any(AbortSignal),
    );
    expect(save).not.toHaveBeenCalled();
  });
  it("aborts previous side reads and never shows a stale response", async () => {
    let finish!: (value: any) => void;
    const readSlice = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        content: "source page",
        byteOffset: 0,
        nextByteOffset: 65536,
        totalBytes: 30000000,
        eof: false,
        revision: "r1",
      });
    const view = render(
      <LargeMergeFileViewer
        file={file}
        onSave={vi.fn()}
        onClose={vi.fn()}
        readSlice={readSlice}
      />,
    );
    const signal = readSlice.mock.calls[0][4];
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "source" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: /来源版本只读片段/ }),
      ).toHaveValue("source page"),
    );
    expect(signal.aborted).toBe(true);
    await act(async () =>
      finish({
        content: "old result",
        byteOffset: 0,
        nextByteOffset: 10,
        totalBytes: 20,
        eof: false,
        revision: "r1",
      }),
    );
    expect(screen.getByRole("textbox", { name: /只读片段/ })).toHaveValue(
      "source page",
    );
    const latestSignal = readSlice.mock.calls[1][4];
    view.unmount();
    expect(latestSignal.aborted).toBe(true);
  });
});
