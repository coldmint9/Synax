import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const getSessionEnvironmentFile = vi.fn();
const getSessionInputSource = vi.fn();
const saveSessionEnvironmentFile = vi.fn();
const highlightCode = vi.fn();

vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    getSessionEnvironmentFile: (...args: unknown[]) =>
      getSessionEnvironmentFile(...args),
    getSessionInputSource: (...args: unknown[]) =>
      getSessionInputSource(...args),
    saveSessionEnvironmentFile: (...args: unknown[]) =>
      saveSessionEnvironmentFile(...args),
  },
}));

vi.mock("../codeHighlight", () => ({
  highlightCode: (...args: unknown[]) => highlightCode(...args),
  languageForPath: (path: string) =>
    path.endsWith(".tsx") ? "tsx" : "typescript",
}));

const { CodeViewer } = await import("../CodeViewer");

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
    getSessionEnvironmentFile.mockReset();
    getSessionInputSource.mockReset();
    saveSessionEnvironmentFile.mockReset();
    saveSessionEnvironmentFile.mockResolvedValue({
      sessionId: "sess-1",
      path: "src/app.ts",
      bytes: SOURCE.length,
    });
    highlightCode.mockReset();
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
