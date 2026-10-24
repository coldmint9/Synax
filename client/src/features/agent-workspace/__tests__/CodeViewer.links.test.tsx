import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CodeViewer } from "../CodeViewer";
import { TranscriptSessionProvider } from "../SessionTranscriptContext";
import { openWorkspaceFile, useSessionWorkspace, useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";

const api = vi.hoisted(() => ({ getSessionEnvironmentFile: vi.fn() }));
vi.mock("../../../adapters/transport/agentRuntime", () => ({ agentRuntimeApi: api }));
vi.mock("../../../shared/ui/file-viewer/FileViewer", () => ({ FileViewer: () => null }));

const sourcePath = "docs/investigations/2026-10-24-first-token-realtime-transport-refactor-plan.md";
const baselinePath = "docs/investigations/2026-10-23-first-token-latency-benchmark.md";
const planPath = "docs/investigations/2026-10-23-first-token-optimization-plan.md";

function WorkspacePreview() {
  const workspace = useSessionWorkspace("docs-session");
  const tab = workspace.tabs.find((item) => item.id === workspace.activeTabId)!;
  return <main aria-label="Synax 工作区">
    <CodeViewer sessionId="docs-session" path={tab.path!} rootId={tab.rootId} />
  </main>;
}

beforeEach(() => {
  useSessionWorkspaceStore.setState({ sessions: {} });
  api.getSessionEnvironmentFile.mockReset().mockImplementation(async (_sessionId, path) => {
    const content = {
      [sourcePath]: "# 重构方案\n\n[优化前基线](./2026-10-23-first-token-latency-benchmark.md)\n\n[第一版优化方案](./2026-10-23-first-token-optimization-plan.md)\n\n[缺失文档](./missing.md)",
      [baselinePath]: "# 优化前基线",
      [planPath]: "# 第一版优化方案",
    }[path as string];
    if (content === undefined) throw new Error("文件不存在");
    return { content, truncated: false };
  });
});

describe("Markdown document navigation in CodeViewer", () => {
  it.each([
    ["优化前基线", baselinePath],
    ["第一版优化方案", planPath],
  ])("opens %s in the same session and repository without leaving Synax", async (label, target) => {
    openWorkspaceFile("docs-session", sourcePath, null, "reference");
    render(<TranscriptSessionProvider sessionId="other-session" workspacePath="/unrelated">
      <WorkspacePreview />
    </TranscriptSessionProvider>);
    const originalUrl = window.location.href;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(await screen.findByRole("link", { name: label }), event);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole("heading", { name: label })).toBeVisible();
    expect(api.getSessionEnvironmentFile).toHaveBeenLastCalledWith("docs-session", target, "input", "reference");
    expect(useSessionWorkspaceStore.getState().sessions["docs-session"].tabs).toHaveLength(2);
    expect(useSessionWorkspaceStore.getState().sessions["other-session"]).toBeUndefined();
    expect(window.location.href).toBe(originalUrl);
  });

  it("keeps a missing target error inside the file viewer", async () => {
    openWorkspaceFile("docs-session", sourcePath);
    render(<WorkspacePreview />);
    const originalUrl = window.location.href;
    fireEvent.click(await screen.findByRole("link", { name: "缺失文档" }));
    await waitFor(() => expect(screen.getByText("文件不存在")).toBeVisible());
    expect(screen.getByRole("main", { name: "Synax 工作区" })).toBeVisible();
    expect(window.location.href).toBe(originalUrl);
  });
});
