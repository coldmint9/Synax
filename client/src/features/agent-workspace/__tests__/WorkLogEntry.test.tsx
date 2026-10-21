import { beforeEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useShellStore } from "../../../shared/state/shellStore";
import { WorkLogEntry, type WorkLogEntryData } from "../WorkLogEntry";
import type { InterleavedTurn } from "../buildInterleavedTurns";

function turn(stepNumber: number, content: string): InterleavedTurn {
  const stepId = `step-${stepNumber}`;
  return {
    stepId,
    index: stepNumber,
    status: "completed",
    duration: "3.0s",
    blocks: [
      { type: "thinking", content },
      {
        type: "tool_call",
        call: {
          id: `tool-${stepNumber}`,
          toolId: "bash",
          inputSummary: "ls",
          outputSummary: "ok",
          status: "completed",
          category: "shell",
          duration: "10ms",
          mutability: "read",
        },
      },
    ],
  };
}

const ENTRY: WorkLogEntryData = {
  id: "work-log-step-1",
  kind: "work_log",
  createdAt: "2026-01-01T00:01:00.000Z",
  label: "Work log · 3 steps",
  turns: [
    turn(1, "first reasoning"),
    turn(2, "second reasoning"),
    turn(3, "third reasoning"),
  ],
  stats: {
    stepCount: 3,
    toolCallCount: 3,
    thinkingChars: 50,
    elapsedMs: 90_000,
  },
};

describe("WorkLogEntry", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en", sessionShowThinking: true },
    }));
  });

  it("collapses a run into one row and keeps the folded turns unmounted", () => {
    const { container } = render(<WorkLogEntry entry={ENTRY} />);

    expect(container.textContent).toContain("Process");
    expect(container.textContent).toContain("3 tool calls");
    expect(container.textContent).toContain("1m 30s");
    expect(container.querySelector("[data-activity-body]")).toBeNull();
    expect(container.textContent).not.toContain("second reasoning");
  });

  it("mounts the folded turns only when expanded", async () => {
    const user = userEvent.setup();
    const view = render(<WorkLogEntry entry={ENTRY} />);

    // A collapsed round keeps the folded turns out of the DOM entirely.
    expect(view.container.textContent).not.toContain("Run command");

    await user.click(view.getByRole("button"));

    // The log mounts compact previews, while every full reasoning body stays
    // unmounted until its own disclosure is explicitly opened.
    expect(
      view.container.querySelectorAll("[data-activity-body]"),
    ).toHaveLength(0);
    expect(view.container.textContent).toContain("Run command");
    expect(
      view.container.querySelectorAll(".bui-thinking").length,
    ).toBeGreaterThan(0);
    expect(view.container.querySelectorAll(".bui-thinking-preview")).toHaveLength(3);
    expect(view.container.textContent).toContain("second reasoning");
    expect(view.container.querySelectorAll(".bui-thinking-prose")).toHaveLength(0);
  });

  it("previews the newest record while collapsed", () => {
    // A fresh id keeps this case out of the expand state the previous tests left.
    const { container } = render(
      <WorkLogEntry entry={{ ...ENTRY, id: "work-log-step-7" }} />,
    );

    const preview = container.querySelector(".session-process-preview");
    expect(preview?.textContent).toBe("third reasoning");
    expect(container.textContent).not.toContain("first reasoning");
  });

  it("hides reasoning previews and restores them when the preference changes", () => {
    const { container } = render(<WorkLogEntry entry={{ ...ENTRY, id: "thinking-visibility" }} />);
    expect(container).toHaveTextContent("third reasoning");
    act(() => useShellStore.getState().setSessionShowThinking(false));
    expect(container).not.toHaveTextContent("third reasoning");
    expect(container).not.toHaveTextContent("50 chars");
    expect(container).toHaveTextContent("3 tool calls");
    act(() => useShellStore.getState().setSessionShowThinking(true));
    expect(container).toHaveTextContent("third reasoning");
  });

  it("restores the expanded state after a lazy unmount", async () => {
    const user = userEvent.setup();
    // A fresh id keeps this case out of the expand state the previous test left.
    const entry = { ...ENTRY, id: "work-log-step-42" };
    const first = render(<WorkLogEntry entry={entry} />);
    await user.click(first.getByRole("button"));
    first.unmount();

    const second = render(<WorkLogEntry entry={entry} />);
    expect(
      second.container.querySelector(".bui-thinking-preview"),
    ).not.toBeNull();
  });

  it("keeps a failed tool's output out of the folded summary", () => {
    const failed = turn(9, "Earlier reasoning");
    const tool = failed.blocks.find((block) => block.type === "tool_call")!;
    if (tool.type === "tool_call") {
      tool.call = { ...tool.call, status: "failed", outputSummary: "Permission denied\nExit code: 1" };
    }
    const { container } = render(<WorkLogEntry entry={{ ...ENTRY, id: "failed-folded-log", turns: [failed] }} />);
    // The failure is reported by the row status; folding must not replay the
    // error text as the preview.
    expect(container.querySelector(".session-process-preview")).not.toHaveTextContent("Permission denied");
    expect(container.querySelector(".bui-status")).toHaveAttribute("data-state", "failed");
    expect(container.querySelector(".bui-tool-details")).toBeNull();
  });
});
