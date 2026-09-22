import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getSessionEnvironmentFile = vi.fn();
const getSessionEnvironmentFileMedia = vi.fn();
const getSessionInputSource = vi.fn();
const saveSessionEnvironmentFile = vi.fn();
const highlightCode = vi.fn();

vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    getSessionEnvironmentFile: (...args: unknown[]) =>
      getSessionEnvironmentFile(...args),
    getSessionEnvironmentFileMedia: (...args: unknown[]) =>
      getSessionEnvironmentFileMedia(...args),
    getSessionInputSource: (...args: unknown[]) =>
      getSessionInputSource(...args),
    saveSessionEnvironmentFile: (...args: unknown[]) =>
      saveSessionEnvironmentFile(...args),
  },
}));

vi.mock("../codeHighlight", () => ({
  highlightCode: (...args: unknown[]) => highlightCode(...args),
  languageForPath: (path: string) =>
    path.endsWith(".html")
      ? "html"
      : path.endsWith(".tsx")
        ? "tsx"
        : "typescript",
}));

const { CodeViewer } = await import("../CodeViewer");
const { clearWorkspaceDraft } = await import("../state/sessionWorkspaceStore");

function markup(content: string) {
  const escaped = content
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<pre class="shiki"><code><span style="color:var(--synax-code-token-keyword)">${escaped}</span></code></pre>`;
}

async function renderEditor(path = "src/app.ts") {
  const utils = render(
    <CodeViewer sessionId="sess-1" path={path} tabId={`file:${path}`} />,
  );
  const editor = await screen.findByRole("textbox", {
    name: `编辑文件 ${path}`,
  });
  return { ...utils, editor };
}

const SOURCE = "const a = 1\nconst b = 2\n";

function fileView(content: string) {
  return {
    sessionId: "sess-1",
    path: "src/app.ts",
    kind: "input",
    content,
    truncated: false,
  };
}

async function renderViewer() {
  const utils = render(<CodeViewer sessionId="sess-1" path="src/app.ts" />);
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe("CodeViewer", () => {
  beforeEach(() => {
    clearWorkspaceDraft("file:src/app.ts");
    clearWorkspaceDraft("file:src/page.html");
    clearWorkspaceDraft("file:src/icon.svg");
    getSessionEnvironmentFile.mockReset();
    getSessionEnvironmentFileMedia.mockReset();
    getSessionInputSource.mockReset();
    saveSessionEnvironmentFile.mockReset();
    saveSessionEnvironmentFile.mockResolvedValue({
      sessionId: "sess-1",
      path: "src/app.ts",
      bytes: SOURCE.length,
    });
    highlightCode.mockReset();
    vi.spyOn(URL, "createObjectURL").mockImplementation(
      () => "blob:https://synax.test/preview",
    );
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    highlightCode.mockResolvedValue(
      '<pre class="shiki synax-code" style="color:var(--synax-code-foreground)">' +
        '<code><span class="line"><span style="color:var(--synax-code-token-keyword)">const</span> a = 1</span>' +
        '\n<span class="line">const b = 2</span></code></pre>',
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the highlighted markup and a gutter that matches the file", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE));
    const { container } = await renderViewer();

    await waitFor(() => {
      expect(
        container.querySelector(".code-viewer-content .shiki"),
      ).not.toBeNull();
    });
    expect(highlightCode).toHaveBeenCalledWith(SOURCE, "src/app.ts");
    expect(
      container.querySelector(".code-viewer-content .shiki span span")
        ?.textContent,
    ).toBe("const");

    const numbers = container.querySelectorAll(
      ".code-viewer-line-numbers > div",
    );
    expect(Array.from(numbers, (node) => node.textContent)).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(container.querySelector(".code-viewer-gutter")).not.toBeNull();
  });

  it("shows the detected language in the header", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE));
    const { container } = await renderViewer();

    expect(screen.getByText("typescript")).toBeTruthy();
    expect(
      container.querySelector('[data-file-type-icon="app.ts"]'),
    ).not.toBeNull();
  });

  it("surfaces read failures", async () => {
    getSessionEnvironmentFile.mockRejectedValue(new Error("missing file"));
    await renderViewer();

    expect(screen.getByText("missing file")).toBeTruthy();
  });

  it("edits a file and saves it with Command+S", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE));
    render(
      <CodeViewer
        sessionId="sess-1"
        path="src/app.ts"
        tabId="file:src/app.ts"
      />,
    );
    const editor = await screen.findByRole("textbox", {
      name: "编辑文件 src/app.ts",
    });
    fireEvent.change(editor, { target: { value: "const changed = true\n" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });

    await waitFor(() =>
      expect(saveSessionEnvironmentFile).toHaveBeenCalledWith(
        "sess-1",
        "src/app.ts",
        "const changed = true\n",
        undefined,
      ),
    );
  });

  it("keeps syntax colors and live line numbers while editing", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE));
    highlightCode.mockImplementation(async (text: string) => markup(text));
    const { container, editor } = await renderEditor();
    await waitFor(() =>
      expect(
        container.querySelector(".highlighted-code-editor-paint .shiki"),
      ).not.toBeNull(),
    );
    expect(editor).toHaveValue(SOURCE);
    expect(
      container.querySelector(".highlighted-code-editor-paint span"),
    ).toHaveAttribute("style", "color:var(--synax-code-token-keyword)");
    const next = 'const message = "你好";\n\tconsole.log(message);\n\n';
    fireEvent.change(editor, { target: { value: next } });
    await waitFor(() =>
      expect(
        container.querySelector(".highlighted-code-editor-paint code")
          ?.textContent,
      ).toBe(next),
    );
    expect(highlightCode).toHaveBeenLastCalledWith(next, "src/app.ts");
    expect(
      container.querySelectorAll(".code-viewer-line-numbers > div"),
    ).toHaveLength(4);
    fireEvent.scroll(editor, { target: { scrollTop: 24, scrollLeft: 80 } });
    expect(
      container.querySelector(".highlighted-code-editor-paint"),
    ).toHaveStyle({ transform: "translate(-80px, -24px)" });
    expect(
      container.querySelector(".highlighted-code-editor-numbers"),
    ).toHaveStyle({ transform: "translateY(-24px)" });
  });

  it("ignores stale highlight results and shows the newest draft while waiting", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(SOURCE));
    highlightCode.mockImplementation(async (text: string) => markup(text));
    const { container, editor } = await renderEditor();
    let finishOld!: (html: string) => void;
    let finishNew!: (html: string) => void;
    highlightCode.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishOld = resolve;
        }),
    );
    fireEvent.change(editor, { target: { value: "const old = 1;" } });
    highlightCode.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishNew = resolve;
        }),
    );
    fireEvent.change(editor, { target: { value: "const latest = 2;" } });
    expect(
      container.querySelector(".highlighted-code-editor-paint")?.textContent,
    ).toBe("const latest = 2;");
    await act(async () => {
      finishNew(markup("const latest = 2;"));
    });
    await act(async () => {
      finishOld(markup("const old = 1;"));
    });
    expect(
      container.querySelector(".highlighted-code-editor-paint code")
        ?.textContent,
    ).toBe("const latest = 2;");
    expect(editor).toHaveValue("const latest = 2;");
  });

  it("falls back to escaped text if highlighting fails without blocking edits or saving", async () => {
    const content = '<script>alert("not executed")</script>';
    getSessionEnvironmentFile.mockResolvedValue(fileView(content));
    highlightCode.mockRejectedValue(new Error("Highlighter unavailable"));
    const { container, editor } = await renderEditor();
    await waitFor(() => expect(highlightCode).toHaveBeenCalled());
    expect(
      container.querySelector(".highlighted-code-editor-paint")?.textContent,
    ).toBe(content);
    expect(
      container.querySelector(".highlighted-code-editor-paint script"),
    ).toBeNull();
    fireEvent.change(editor, { target: { value: "recovered" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(saveSessionEnvironmentFile).toHaveBeenCalledWith(
        "sess-1",
        "src/app.ts",
        "recovered",
        undefined,
      ),
    );
  });

  it("can edit an empty file with a first line number", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(""));
    const { container, editor } = await renderEditor();
    expect(editor).toHaveValue("");
    expect(
      container.querySelector(".code-viewer-line-numbers")?.textContent,
    ).toBe("1");
  });

  it("keeps truncated files read-only and highlighted", async () => {
    getSessionEnvironmentFile.mockResolvedValue({
      ...fileView(SOURCE),
      truncated: true,
    });
    const { container } = render(
      <CodeViewer
        sessionId="sess-1"
        path="src/app.ts"
        tabId="file:src/app.ts"
      />,
    );
    await waitFor(() =>
      expect(
        container.querySelector(".code-viewer-content .shiki"),
      ).not.toBeNull(),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存文件" })).toBeNull();
  });

  it("loads raster images as authenticated blobs without decoding them as text", async () => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
      type: "image/png",
    });
    getSessionEnvironmentFileMedia.mockResolvedValue(blob);
    render(
      <CodeViewer
        sessionId="sess-1"
        path="assets/logo.png"
        tabId="file:assets/logo.png"
      />,
    );

    const image = await screen.findByRole("img", { name: "logo.png" });
    expect(image).toHaveAttribute("src", "blob:https://synax.test/preview");
    expect(getSessionEnvironmentFileMedia).toHaveBeenCalledWith(
      "sess-1",
      "assets/logo.png",
      undefined,
    );
    expect(getSessionEnvironmentFile).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "保存文件" })).toBeNull();
    expect(screen.queryByRole("button", { name: "源码" })).toBeNull();
  });

  it("previews SVG as an inert image while retaining editable source", async () => {
    getSessionEnvironmentFile.mockResolvedValue(
      fileView(
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>',
      ),
    );
    const { unmount } = render(
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
      screen.getByRole("textbox", { name: "编辑文件 src/icon.svg" }),
    ).toBeTruthy();
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:https://synax.test/preview",
    );
  });

  it("retains HTML preview and highlights the editable source", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView("<h1>Hello</h1>"));
    highlightCode.mockImplementation(async (text: string) => markup(text));
    const { container } = render(
      <CodeViewer
        sessionId="sess-1"
        path="src/page.html"
        tabId="file:src/page.html"
      />,
    );
    const preview = await screen.findByTitle("HTML 预览：src/page.html");
    expect(preview).toHaveAttribute("sandbox", "allow-scripts");
    expect(preview).not.toHaveAttribute(
      "allow",
      expect.stringContaining("same-origin"),
    );
    fireEvent.click(screen.getByRole("button", { name: "源码" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "<h1>Edited</h1>" } });
    await waitFor(() =>
      expect(
        container.querySelector(".highlighted-code-editor-paint code")
          ?.textContent,
      ).toBe("<h1>Edited</h1>"),
    );
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    expect(screen.getByTitle("HTML 预览：src/page.html")).toHaveAttribute(
      "srcdoc",
      "<h1>Edited</h1>",
    );
  });

  it("opens recorded input results in the file viewer without reading a fake file path", async () => {
    getSessionInputSource.mockResolvedValue({
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
    await waitFor(() =>
      expect(highlightCode).toHaveBeenCalledWith(
        "src/main.ts: matched",
        "search.txt",
      ),
    );
    expect(getSessionInputSource).toHaveBeenCalledWith("sess-1", "read-1");
    expect(getSessionEnvironmentFile).not.toHaveBeenCalled();
    expect(screen.getByText("Search main")).toBeVisible();
  });
});
