import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const api = vi.hoisted(() => ({
  getSessionEnvironmentFile: vi.fn(),
  getSessionEnvironmentFileMedia: vi.fn(),
  getSessionInputSource: vi.fn(),
  saveSessionEnvironmentFile: vi.fn(),
}));
const holder = vi.hoisted(() => ({ harness: null as any }));
const media = vi.hoisted(() => ({ blob: vi.fn() }));
vi.mock("../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: api,
}));
vi.mock("../../../adapters/transport/runtimeMedia", () => ({
  runtimeMedia: media,
}));
vi.mock("../../../shared/ui/file-viewer/monacoRuntime", async () => {
  const { createMonacoHarness } =
    await import("../../../shared/ui/file-viewer/__tests__/monacoTestHarness");
  holder.harness = createMonacoHarness();
  return {
    monaco: holder.harness.monaco,
    languageForPath: async () => "typescript",
  };
});
vi.mock("../codeHighlight", () => ({
  languageForPath: (path: string) =>
    path.endsWith(".html") ? "html" : "typescript",
}));
const { CodeViewer } = await import("../CodeViewer");
const {
  clearWorkspaceDraft,
  useSessionWorkspaceStore,
  getWorkspaceDraft,
  saveWorkspaceTab,
} = await import("../state/sessionWorkspaceStore");
const SOURCE = "const a = 1\nconst b = 2\n";
const fileView = (content: string) => ({
  sessionId: "sess-1",
  path: "src/app.ts",
  kind: "input",
  content,
  truncated: false,
});
async function renderEditor(path = "src/app.ts") {
  const view = render(
    <CodeViewer sessionId="sess-1" path={path} tabId={`file:${path}`} />,
  );
  return {
    ...view,
    editor: await screen.findByRole("textbox", { name: `编辑文件 ${path}` }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  holder.harness?.reset();
  for (const path of [
    "src/app.ts",
    "src/page.html",
    "src/icon.svg",
    "docs/guide.md",
  ])
    clearWorkspaceDraft("sess-1", `file:${path}`);
  api.getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE));
  api.saveSessionEnvironmentFile.mockResolvedValue({ bytes: SOURCE.length });
  vi.spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:https://synax.test/preview",
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => cleanup());

describe("global Monaco file viewer", () => {
  it("retains rendered Markdown attachments instead of decoding them into an empty preview", async () => {
    media.blob.mockResolvedValue(
      new Blob(["# Attached guide"], { type: "text/plain" }),
    );
    render(
      <CodeViewer
        sessionId="sess-1"
        path="attachment.txt"
        inputSource={
          { kind: "file", label: "guide.md", assetId: "asset-md" } as any
        }
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Attached guide" }),
    ).toBeVisible();
    expect(api.getSessionEnvironmentFile).not.toHaveBeenCalled();
  });
  it("uses one read-only Monaco model with its own viewport", async () => {
    const view = render(<CodeViewer sessionId="sess-1" path="src/app.ts" />);
    const editor = await screen.findByRole("textbox", {
      name: "查看文件 src/app.ts",
    });
    expect(editor).toHaveValue(SOURCE);
    expect(editor).toHaveAttribute("readonly");
    expect(view.container.querySelector(".code-viewer-body")).toHaveClass(
      "overflow-hidden",
    );
    expect(view.container.querySelector(".code-viewer-gutter")).toBeNull();
    expect(holder.harness.models).toHaveLength(1);
  });
  it("edits and immediately flushes the debounce buffer before Command+S", async () => {
    const { editor } = await renderEditor();
    fireEvent.input(editor, { target: { value: "const changed = true\n" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(api.saveSessionEnvironmentFile).toHaveBeenCalledWith(
        "sess-1",
        "src/app.ts",
        "const changed = true\n",
        undefined,
      ),
    );
  });
  it("does not replace the model or reset undo history for input echoes", async () => {
    const { editor } = await renderEditor();
    fireEvent.input(editor, { target: { value: "new value" } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(holder.harness.models).toHaveLength(1);
    expect(editor).toHaveValue("new value");
  });
  it("keeps edits that arrive while a save is in flight dirty", async () => {
    let finish!: () => void;
    api.saveSessionEnvironmentFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        }),
    );
    const { editor } = await renderEditor();
    fireEvent.input(editor, { target: { value: "first" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(api.saveSessionEnvironmentFile).toHaveBeenCalledOnce(),
    );
    fireEvent.input(editor, { target: { value: "second" } });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "保存文件" })).toBeEnabled();
  });
  it("does not save the previous file buffer while a reused viewer is reading a new path", async () => {
    let finishB!: (value: any) => void;
    api.getSessionEnvironmentFile
      .mockResolvedValueOnce(fileView("file A"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishB = resolve;
          }),
      );
    const view = render(
      <CodeViewer sessionId="sess-1" path="a.ts" tabId="file:a.ts" />,
    );
    const oldEditor = await screen.findByRole("textbox", {
      name: "编辑文件 a.ts",
    });
    fireEvent.input(oldEditor, { target: { value: "old A draft" } });
    view.rerender(
      <CodeViewer sessionId="sess-1" path="b.ts" tabId="file:b.ts" />,
    );
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    expect(api.saveSessionEnvironmentFile).not.toHaveBeenCalled();
    await act(async () => finishB(fileView("file B")));
    expect(
      await screen.findByRole("textbox", { name: "编辑文件 b.ts" }),
    ).toHaveValue("file B");
    expect(api.saveSessionEnvironmentFile).not.toHaveBeenCalled();
  });
  it("saves an inactive file using its captured session/path and preserves the active file", async () => {
    api.getSessionEnvironmentFile.mockImplementation(
      async (_: string, path: string) => fileView(`disk ${path}`),
    );
    const view = render(
      <CodeViewer
        sessionId="sess-1"
        path="inactive.ts"
        tabId="file:inactive.ts"
      />,
    );
    fireEvent.input(
      await screen.findByRole("textbox", { name: "编辑文件 inactive.ts" }),
      { target: { value: "inactive draft" } },
    );
    view.rerender(
      <CodeViewer sessionId="sess-1" path="active.ts" tabId="file:active.ts" />,
    );
    expect(
      await screen.findByRole("textbox", { name: "编辑文件 active.ts" }),
    ).toHaveValue("disk active.ts");
    await act(async () => {
      expect(await saveWorkspaceTab("sess-1", "file:inactive.ts")).toBe(true);
    });
    expect(api.saveSessionEnvironmentFile).toHaveBeenCalledWith(
      "sess-1",
      "inactive.ts",
      "inactive draft",
      undefined,
    );
    expect(
      screen.getByRole("textbox", { name: "编辑文件 active.ts" }),
    ).toHaveValue("disk active.ts");
  });
  it("does not resurrect a discarded draft during Monaco unmount or a late save receipt", async () => {
    const view = render(
      <CodeViewer
        sessionId="discard-session"
        path="discard.ts"
        tabId="file:discard.ts"
      />,
    );
    fireEvent.input(
      await screen.findByRole("textbox", { name: "编辑文件 discard.ts" }),
      { target: { value: "discard this" } },
    );
    act(() =>
      useSessionWorkspaceStore
        .getState()
        .closeTab("discard-session", "file:discard.ts"),
    );
    view.unmount();
    expect(
      getWorkspaceDraft("discard-session", "file:discard.ts"),
    ).toBeUndefined();
    const reopened = render(
      <CodeViewer
        sessionId="discard-session"
        path="discard.ts"
        tabId="file:discard.ts"
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "编辑文件 discard.ts" }),
    ).toHaveValue(SOURCE);
    reopened.unmount();
  });
  it("uses Monaco for empty files and truncated read-only sources", async () => {
    api.getSessionEnvironmentFile.mockResolvedValue(fileView(""));
    const view = await renderEditor();
    expect(view.editor).toHaveValue("");
    view.unmount();
    api.getSessionEnvironmentFile.mockResolvedValue({
      ...fileView(SOURCE),
      truncated: true,
    });
    render(
      <CodeViewer
        sessionId="sess-1"
        path="src/app.ts"
        tabId="file:src/app.ts"
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "查看文件 src/app.ts" }),
    ).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存文件" })).toBeNull();
  });
  it("preserves dirty drafts when a text tab unmounts before debounce", async () => {
    const view = await renderEditor();
    fireEvent.input(view.editor, { target: { value: "unsaved local" } });
    view.unmount();
    const reopened = await renderEditor();
    expect(reopened.editor).toHaveValue("unsaved local");
  });
  it("does not restore a saved cache over a newer file written by another actor", async () => {
    const view = await renderEditor();
    fireEvent.input(view.editor, { target: { value: "my saved file" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() =>
      expect(api.saveSessionEnvironmentFile).toHaveBeenCalledOnce(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存文件" })).toBeDisabled(),
    );
    expect(getWorkspaceDraft("sess-1", "file:src/app.ts")).toBeUndefined();
    view.unmount();
    api.getSessionEnvironmentFile.mockResolvedValue(
      fileView("new agent version"),
    );
    const reopened = await renderEditor();
    expect(reopened.editor).toHaveValue("new agent version");
  });
  it("shows language metadata and read errors", async () => {
    const view = await renderEditor();
    expect(screen.getByText("typescript")).toBeVisible();
    view.unmount();
    api.getSessionEnvironmentFile.mockRejectedValue(new Error("missing file"));
    render(<CodeViewer sessionId="sess-1" path="missing.ts" />);
    expect(await screen.findByText("missing file")).toBeVisible();
  });
  it("keeps raster images as authenticated blobs and releases the URL", async () => {
    api.getSessionEnvironmentFileMedia.mockResolvedValue(
      new Blob(["png"], { type: "image/png" }),
    );
    const view = render(
      <CodeViewer
        sessionId="sess-1"
        path="assets/logo.png"
        tabId="file:assets/logo.png"
      />,
    );
    expect(
      await screen.findByRole("img", { name: "logo.png" }),
    ).toHaveAttribute("src", "blob:https://synax.test/preview");
    expect(api.getSessionEnvironmentFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://synax.test/preview",
    );
  });
  it("previews audio and video files with native controls and keeps them read-only", async () => {
    api.getSessionEnvironmentFileMedia.mockImplementation(
      async (_session: string, path: string) =>
        new Blob([path], {
          type: path.endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
        }),
    );
    const audio = render(
      <CodeViewer
        sessionId="sess-1"
        path="media/voice.mp3"
        tabId="file:media/voice.mp3"
      />,
    );
    expect(
      await screen.findByTitle("音频预览：media/voice.mp3"),
    ).toHaveAttribute("controls");
    expect(screen.queryByRole("textbox")).toBeNull();
    audio.unmount();
    render(
      <CodeViewer
        sessionId="sess-1"
        path="media/demo.mp4"
        tabId="file:media/demo.mp4"
      />,
    );
    expect(
      await screen.findByTitle("视频预览：media/demo.mp4"),
    ).toHaveAttribute("controls");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps PDF as a media preview", async () => {
    api.getSessionEnvironmentFileMedia.mockResolvedValue(
      new Blob(["pdf"], { type: "application/pdf" }),
    );
    render(<CodeViewer sessionId="sess-1" path="docs/spec.pdf" />);
    expect(await screen.findByTitle("PDF 预览：docs/spec.pdf")).toHaveAttribute(
      "src",
      "blob:https://synax.test/preview",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("keeps SVG inert while making its source editable in Monaco", async () => {
    api.getSessionEnvironmentFile.mockResolvedValue(
      fileView('<svg xmlns="http://www.w3.org/2000/svg"><rect /></svg>'),
    );
    render(
      <CodeViewer
        sessionId="sess-1"
        path="src/icon.svg"
        tabId="file:src/icon.svg"
      />,
    );
    expect(
      await screen.findByRole("img", { name: "icon.svg" }),
    ).toHaveAttribute("src", "blob:https://synax.test/preview");
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    expect(
      await screen.findByRole("textbox", { name: "编辑文件 src/icon.svg" }),
    ).not.toHaveAttribute("readonly");
  });
  it("keeps HTML sandbox preview and flushes edited source before switching back", async () => {
    api.getSessionEnvironmentFile.mockResolvedValue(fileView("<h1>Hello</h1>"));
    render(
      <CodeViewer
        sessionId="sess-1"
        path="src/page.html"
        tabId="file:src/page.html"
      />,
    );
    expect(
      await screen.findByTitle("HTML 预览：src/page.html"),
    ).toHaveAttribute("sandbox", "allow-scripts");
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    const editor = await screen.findByRole("textbox", {
      name: "编辑文件 src/page.html",
    });
    fireEvent.input(editor, { target: { value: "<h1>Edited</h1>" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    await waitFor(() =>
      expect(screen.getByTitle("HTML 预览：src/page.html")).toHaveAttribute(
        "srcdoc",
        "<h1>Edited</h1>",
      ),
    );
  });
  it.each([undefined, "file:docs/guide.md"])(
    "keeps Markdown rendering and source navigation (tab %s)",
    async (tabId) => {
      const text = "# Long guide\n\n" + "Paragraph\n\n".repeat(50);
      api.getSessionEnvironmentFile.mockResolvedValue(fileView(text));
      const { container } = render(
        <CodeViewer sessionId="sess-1" path="docs/guide.md" tabId={tabId} />,
      );
      await screen.findByRole("heading", { name: "Long guide" });
      expect(container.querySelector(".code-viewer-body")).toHaveClass(
        "overflow-auto",
      );
      fireEvent.click(screen.getByRole("button", { name: "源码" }));
      expect(
        await screen.findByRole("textbox", {
          name: `${tabId ? "编辑" : "查看"}文件 docs/guide.md`,
        }),
      ).toHaveValue(text);
      expect(container.querySelector(".code-viewer-body")).toHaveClass(
        "overflow-hidden",
      );
      fireEvent.click(screen.getByRole("button", { name: "预览" }));
      expect(
        await screen.findByRole("heading", { name: "Long guide" }),
      ).toBeVisible();
    },
  );
  it("loads Markdown images using authenticated workspace-relative URLs", async () => {
    api.getSessionEnvironmentFile.mockResolvedValue(
      fileView("![配置](../images/my%20screen.png)"),
    );
    api.getSessionEnvironmentFileMedia.mockResolvedValue(
      new Blob(["image"], { type: "image/png" }),
    );
    render(
      <CodeViewer sessionId="sess-1" path="docs/guide.md" rootId="reference" />,
    );
    expect(await screen.findByRole("img", { name: "配置" })).toHaveAttribute(
      "src",
      "blob:https://synax.test/preview",
    );
    expect(api.getSessionEnvironmentFileMedia).toHaveBeenCalledWith(
      "sess-1",
      "images/my screen.png",
      "reference",
    );
  });
  it("opens recorded tool input in a read-only Monaco model without reading a fake path", async () => {
    api.getSessionInputSource.mockResolvedValue({
      content: "src/main.ts: matched",
      truncated: false,
    });
    render(
      <CodeViewer
        sessionId="sess-1"
        path="search.txt"
        inputSource={{
          kind: "search",
          label: "Search main",
          toolCallId: "read-1",
        }}
      />,
    );
    expect(
      await screen.findByRole("textbox", { name: "查看文件 search.txt" }),
    ).toHaveValue("src/main.ts: matched");
    expect(api.getSessionInputSource).toHaveBeenCalledWith("sess-1", "read-1");
    expect(api.getSessionEnvironmentFile).not.toHaveBeenCalled();
  });
});
