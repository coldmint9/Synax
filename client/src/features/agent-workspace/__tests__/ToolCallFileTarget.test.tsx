import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { InterleavedTurn, ToolCallView, TurnContentBlock } from "../buildInterleavedTurns";
import { TurnBody } from "../TurnBody";
import { useShellStore } from "../../../shared/state/shellStore";
import { TranscriptSessionProvider } from "../SessionTranscriptContext";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";

const emptyTurn: InterleavedTurn = { stepId: "step-1", index: 0, status: "running", duration: null, completedAt: null, blocks: [] };

const record = (toolId: string, input: unknown): TurnContentBlock => {
  const call: ToolCallView = {
    id: `call-${toolId}`,
    toolId,
    inputSummary: typeof input === "string" ? input : JSON.stringify(input),
    outputSummary: "done",
    status: "completed",
    category: "read",
    duration: "10ms",
    mutability: "read",
  };
  return { type: "tool_call", call };
};

function renderTurn(blocks: TurnContentBlock[], { workspacePath = "/repo" } = {}) {
  return render(
    <TranscriptSessionProvider sessionId="session-1" workspacePath={workspacePath}>
      <TurnBody turn={{ ...emptyTurn, blocks }} entryId="entry" isWorking />
    </TranscriptSessionProvider>,
  );
}

function tabs() {
  return useSessionWorkspaceStore.getState().sessions["session-1"]?.tabs ?? [];
}

describe("tool record file targets", () => {
  beforeEach(() => {
    useSessionWorkspaceStore.setState({ sessions: {} });
    useShellStore.setState((s) => ({ preferences: { ...s.preferences, locale: "zh", sessionShowThinking: true } }));
  });

  afterEach(cleanup);

  it("opens the file a read record names in the workspace viewer", () => {
    renderTurn([record("file.read", { path: "web/src/index.css" })]);

    fireEvent.click(screen.getByRole("button", { name: "index.css" }));

    expect(tabs()).toEqual([
      expect.objectContaining({ kind: "file", path: "web/src/index.css", line: null }),
    ]);
  });

  it("does not nest the file link inside the record's disclosure button", () => {
    const { container } = renderTurn([record("file.read", { path: "src/a.ts" })]);

    expect(container.querySelectorAll("button button")).toHaveLength(0);
    expect(container.querySelector(".bui-tool-target")).toHaveAttribute("data-file", "true");
  });

  it("keeps the rest of the record expandable next to its file link", () => {
    const { container } = renderTurn([record("file.read", { path: "src/a.ts" })]);

    fireEvent.click(container.querySelector(".bui-tool-disclosure")!);

    expect(container.querySelector(".bui-tool-disclosure")).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector(".bui-tool-details")).toHaveTextContent("done");
    // Opening the record expands only this row; the window keeps its budget.
    expect(container.querySelector(".session-process-window-viewport"))
      .toHaveAttribute("data-windowed", "true");
    expect(container.querySelector(".session-process-window-row"))
      .toHaveAttribute("data-row-expanded", "true");
  });

  it("leaves a multi-file patch unlinked", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Update File: src/b.ts",
      "*** End Patch",
    ].join("\n");
    const { container } = renderTurn([record("file.patch", { patch })]);

    expect(container.querySelector(".bui-tool-target")).not.toHaveAttribute("data-file");
    expect(container.querySelector(".bui-tool-target")?.tagName).toBe("SPAN");
    expect(tabs()).toEqual([]);
  });

  it("leaves a target outside the session workspace unlinked", () => {
    const { container } = renderTurn([record("file.read", "/elsewhere/src/a.ts")]);

    expect(container.querySelector(".bui-tool-target")).not.toHaveAttribute("data-file");
    expect(tabs()).toEqual([]);
  });

  it("keeps a non-file record's target as plain text", () => {
    const { container } = renderTurn([record("bash", { command: "pnpm test" })]);

    expect(container.querySelector(".bui-tool-target")).toHaveTextContent("pnpm test");
    expect(container.querySelector(".bui-tool-target")).not.toHaveAttribute("data-file");
    expect(container.querySelector(".bui-tool-trigger--split")).toBeNull();
  });
});
