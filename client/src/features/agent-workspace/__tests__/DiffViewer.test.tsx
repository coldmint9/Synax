import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const getSessionEnvironmentFile = vi.fn();

vi.mock("../../../adapters/transport/agentRuntime", () => ({
  agentRuntimeApi: {
    getSessionEnvironmentFile: (...args: unknown[]) =>
      getSessionEnvironmentFile(...args),
  },
}));

vi.mock("../../../shared/ui/file-viewer/MonacoDiffEditor", () => ({
  default: ({ original, modified, path }: any) => (
    <div
      data-testid="monaco-diff-editor"
      data-path={path}
      data-original={original}
      data-modified={modified}
    />
  ),
}));

vi.mock("../../../shared/ui/file-viewer/MonacoTextEditor", () => ({
  MonacoTextEditor: ({ content }: { content: string }) => (
    <pre className="diff-raw">{content}</pre>
  ),
}));

const { DiffViewer } = await import("../DiffViewer");

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,4 +1,5 @@",
  ' import { a } from "b"',
  "-const x = 1",
  "+const x = 2",
  "+const y = 3",
  " ",
  " export function f() {",
  "",
].join("\n");

function fileView(content: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "sess-1",
    path: "src/app.ts",
    kind: "diff",
    content,
    truncated: false,
    ...extra,
  };
}

async function renderViewer(path = "src/app.ts") {
  const utils = render(<DiffViewer sessionId="sess-1" path={path} />);
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

describe("DiffViewer", () => {
  beforeEach(() => {
    getSessionEnvironmentFile.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses Monaco's native diff surface and keeps change stats", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(PATCH));
    const { container } = await renderViewer();

    expect(container.querySelector('[data-file-type-icon="app.ts"]')).not.toBeNull();
    expect(container.querySelector(".diff-stat--add")?.textContent).toBe("+2");
    expect(container.querySelector(".diff-stat--del")?.textContent).toBe("-1");
    await waitFor(() => {
      expect(screen.getByTestId("monaco-diff-editor")).toBeTruthy();
    });
    const editor = screen.getByTestId("monaco-diff-editor");
    expect(editor.getAttribute("data-path")).toBe("src/app.ts");
    expect(editor.getAttribute("data-original")).toContain("const x = 1");
    expect(editor.getAttribute("data-modified")).toContain("const x = 2");
  });

  it("prefers full text models returned by the runtime", async () => {
    getSessionEnvironmentFile.mockResolvedValue(
      fileView(PATCH, {
        originalContent: 'export const before = "atom";\n',
        modifiedContent: 'export const after = "atom";\n',
      }),
    );
    await renderViewer();

    await waitFor(() => expect(screen.getByTestId("monaco-diff-editor")).toBeTruthy());
    const editor = screen.getByTestId("monaco-diff-editor");
    expect(editor.getAttribute("data-original")).toBe('export const before = "atom";\n');
    expect(editor.getAttribute("data-modified")).toBe('export const after = "atom";\n');
  });

  it("explains an empty diff instead of rendering a blank surface", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView(""));
    await renderViewer();

    expect(screen.getByText("该文件与 HEAD 相比没有可显示的文本差异")).toBeTruthy();
  });

  it("keeps the old and new paths visible for a rename", async () => {
    const renamed = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 90%",
      "rename from src/old.ts",
      "rename to src/new.ts",
      "--- a/src/old.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-const x = 1",
      "+const x = 2",
      "",
    ].join("\n");
    getSessionEnvironmentFile.mockResolvedValue(fileView(renamed));
    const { container } = await renderViewer();

    expect(container.querySelector(".diff-rename-label")?.textContent).toBe(
      "src/old.ts → src/new.ts",
    );
  });

  it("shows untracked files as additions", async () => {
    const untracked = [
      "diff --git a/abs/new-file.ts b/abs/new-file.ts",
      "new file mode 100644",
      "index 0000000..f5e5bd3",
      "--- /dev/null",
      "+++ b/abs/new-file.ts",
      "@@ -0,0 +1,2 @@",
      "+export const a = 1",
      "+export const b = 2",
      "",
    ].join("\n");
    getSessionEnvironmentFile.mockResolvedValue(fileView(untracked));
    const { container } = await renderViewer();

    expect(container.querySelector(".diff-stat--add")?.textContent).toBe("+2");
    await waitFor(() => expect(screen.getByTestId("monaco-diff-editor")).toBeTruthy());
    expect(screen.getByTestId("monaco-diff-editor").getAttribute("data-original")).toBe("");
  });

  it("surfaces read failures", async () => {
    getSessionEnvironmentFile.mockRejectedValue(new Error("boom"));
    await renderViewer();

    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("uses the shared Monaco text surface for an unparseable patch", async () => {
    getSessionEnvironmentFile.mockResolvedValue(fileView("not a patch at all"));
    await renderViewer();

    expect(containerText(".diff-raw")).toBe("not a patch at all");
  });
});

function containerText(selector: string): string | undefined {
  return document.querySelector(selector)?.textContent ?? undefined;
}
