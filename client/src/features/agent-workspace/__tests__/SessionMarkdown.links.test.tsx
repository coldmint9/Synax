import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionMarkdown } from "../SessionMarkdown";
import { TranscriptSessionProvider } from "../SessionTranscriptContext";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
import { parseFileLink, type FileLinkRoot } from "../fileLink";

function renderMarkdown(
  content: string,
  sessionId: string | null = "session-1",
  workspacePath?: string,
  roots?: FileLinkRoot[],
) {
  return render(
    <TranscriptSessionProvider sessionId={sessionId} workspacePath={workspacePath} roots={roots}>
      <SessionMarkdown content={content} />
    </TranscriptSessionProvider>,
  );
}

function activeTabs(sessionId: string) {
  const state = useSessionWorkspaceStore.getState().sessions[sessionId];
  return state?.tabs ?? [];
}

describe("SessionMarkdown file links", () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} });
  });

  afterEach(cleanup);

  it("opens the file viewer for a workspace path instead of navigating away", () => {
    const { container } = renderMarkdown(
      "见 [web/src/index.css](web/src/index.css)。",
    );

    const link = screen.getByRole("link", { name: "web/src/index.css" });
    expect(
      container.querySelector('[data-file-type-icon="index.css"]'),
    ).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(true);
    expect(activeTabs("session-1")).toEqual([
      expect.objectContaining({
        kind: "file",
        path: "web/src/index.css",
        line: null,
      }),
    ]);
  });

  it("carries a line anchor from the link into the opened tab", () => {
    renderMarkdown("[a.ts](src/a.ts#L42)");

    fireEvent.click(screen.getByRole("link", { name: "a.ts" }));

    expect(activeTabs("session-1")).toEqual([
      expect.objectContaining({ kind: "file", path: "src/a.ts", line: 42 }),
    ]);
  });

  it("leaves ordinary URLs on their default anchor behaviour", () => {
    renderMarkdown("[docs](https://example.com/guide)");

    const link = screen.getByRole("link", { name: "docs" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(link.getAttribute("href")).toBe("https://example.com/guide");
    expect(activeTabs("session-1")).toEqual([]);
  });

  it.each([
    "[index.page.tsx:237](index.page.tsx:237)",
    "[`index.page.tsx:237`](index.page.tsx:237)",
    "[代码位置](index.page.tsx:237:8)",
  ])("opens a bare filename with a line suffix: %s", (content) => {
    renderMarkdown(content);
    const link = screen.getByRole("link");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(link.getAttribute("target")).toBeNull();
    expect(activeTabs("session-1")).toEqual([
      expect.objectContaining({ path: "index.page.tsx", line: 237 }),
    ]);
  });

  it.each([
    "/repo/frontend/src/index.page.tsx:237",
    "file:///repo/frontend/src/index.page.tsx#L237",
  ])("opens an absolute reference-project link in its owning root: %s", (href) => {
    renderMarkdown(`[代码位置](${href})`, "session-1", "/repo/backend", [
      { rootId: "frontend", name: "frontend", workspacePath: "/repo/frontend" },
    ]);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(screen.getByRole("link"), event);
    expect(event.defaultPrevented).toBe(true);
    expect(activeTabs("session-1")).toEqual([
      expect.objectContaining({ path: "src/index.page.tsx", line: 237, rootId: "frontend" }),
    ]);
  });

  it("preserves the full file URI rather than falling back to its basename label", () => {
    renderMarkdown("[index.page.tsx:237](file:///repo/src/index.page.tsx#L237)", "session-1", "/repo");
    fireEvent.click(screen.getByRole("link"));
    expect(activeTabs("session-1")).toEqual([
      expect.objectContaining({ path: "src/index.page.tsx", line: 237 }),
    ]);
  });

  it("renders a file link without opening anything when there is no session scope", () => {
    renderMarkdown("[a.ts](src/a.ts)", null);

    const link = screen.getByRole("link", { name: "a.ts" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(false);
    expect(useSessionWorkspaceStore.getState().sessions).toEqual({});
  });
});

describe("file link boundaries", () => {
  it.each([
    "https://example.com/a.ts:237",
    "mailto:a.ts:237",
    "javascript:alert(1)",
    "../a.ts:237",
    "/repo-other/a.ts:237",
  ])("does not capture an external or out-of-workspace target: %s", (href) => {
    expect(parseFileLink(href, undefined, "/repo")).toBeNull();
  });

  it("selects the most specific registered root", () => {
    expect(parseFileLink("/repo/frontend/a.ts#L12", undefined, "/repo", [
      { rootId: "main", name: "main", workspacePath: "/repo" },
      { rootId: "frontend", name: "frontend", workspacePath: "/repo/frontend" },
    ])).toEqual({ path: "a.ts", line: 12, rootId: "frontend", rootName: "frontend" });
  });
});
