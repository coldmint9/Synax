import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
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

/** The folded row's own trigger; nested activity groups have their own. */
function foldTrigger(container: HTMLElement): Element {
  return container.querySelector(".session-work-log > .session-process-trigger")!;
}

describe("WorkLogEntry", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en", sessionShowThinking: true },
    }));
  });

  it("collapses a run into one row that reports the work duration", () => {
    const { container } = render(<WorkLogEntry entry={ENTRY} />);

    expect(container.textContent).toBe("Worked for 1m 30s");
    expect(container.querySelector("[data-activity-body]")).toBeNull();
    expect(container.textContent).not.toContain("second reasoning");
    expect(container.textContent).not.toContain("Ran commands");
  });

  it("mounts the folded turns only when expanded", async () => {
    const user = userEvent.setup();
    const view = render(<WorkLogEntry entry={ENTRY} />);

    // A collapsed round keeps the folded turns out of the DOM entirely.
    expect(view.container.textContent).not.toContain("Ran in 10ms");

    await user.click(foldTrigger(view.container));

    // Opening the folded row is a request for the record, so its activity
    // groups come up expanded; every reasoning body still stays unmounted
    // until its own disclosure is explicitly opened.
    expect(
      view.container.querySelectorAll("[data-activity-body]"),
    ).toHaveLength(0);
    expect(view.container.textContent).toContain("Ran in 10ms");
    expect(
      view.container.querySelectorAll(".bui-thinking").length,
    ).toBeGreaterThan(0);
    expect(view.container.querySelectorAll(".bui-thinking-preview")).toHaveLength(3);
    expect(view.container.textContent).toContain("second reasoning");
    expect(view.container.querySelectorAll(".bui-thinking-prose")).toHaveLength(0);
  });

  it("keeps the folded summary to one line without repeating a reasoning preview", () => {
    // A fresh id keeps this case out of the expand state the previous tests left.
    const { container } = render(
      <WorkLogEntry entry={{ ...ENTRY, id: "work-log-step-7" }} />,
    );

    const preview = container.querySelector(".session-process-preview");
    expect(preview).toBeNull();
    expect(foldTrigger(container)).toHaveTextContent("Worked for 1m 30s");
    expect(container.textContent).not.toContain("first reasoning");
  });

  it("falls back to a plain label when the round has no timings", () => {
    const { container } = render(
      <WorkLogEntry
        entry={{
          ...ENTRY,
          id: "work-log-untimed",
          stats: { ...ENTRY.stats, elapsedMs: 0 },
        }}
      />,
    );

    expect(foldTrigger(container)).toHaveTextContent("Work log");
    expect(container.textContent).not.toContain("0ms");
  });

  it("hides reasoning previews and restores them when the preference changes", () => {
    const { container } = render(<WorkLogEntry entry={{ ...ENTRY, id: "thinking-visibility" }} />);
    fireEvent.click(foldTrigger(container));
    expect(container).toHaveTextContent("third reasoning");
    act(() => useShellStore.getState().setSessionShowThinking(false));
    expect(container).not.toHaveTextContent("third reasoning");
    expect(container).not.toHaveTextContent("50 chars");
    expect(container).toHaveTextContent("Worked for 1m 30s");
    act(() => useShellStore.getState().setSessionShowThinking(true));
    expect(container).toHaveTextContent("third reasoning");
  });

  it("restores the expanded state after a lazy unmount", async () => {
    const user = userEvent.setup();
    // A fresh id keeps this case out of the expand state the previous test left.
    const entry = { ...ENTRY, id: "work-log-step-42" };
    const first = render(<WorkLogEntry entry={entry} />);
    await user.click(foldTrigger(first.container));
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
    // The failure is reported by the call rows only: the folded summary keeps
    // a neutral label and never replays the error text as a preview.
    expect(container).not.toHaveTextContent("Permission denied");
    expect(foldTrigger(container)).not.toHaveTextContent("Failed");
    expect(container.querySelector(".bui-status")).toBeNull();
    expect(container.querySelector(".bui-tool-details")).toBeNull();
    fireEvent.click(foldTrigger(container));
    expect(container.querySelector(".bui-tool .bui-status")).toHaveAttribute("data-state", "failed");
  });

  it("stays collapsed when the round is opened from history", () => {
    // `foldFrom` is the height of rows that were on screen a moment ago. Without
    // it the row is just history, so it must not start a collapse animation.
    const { container } = render(
      <WorkLogEntry entry={{ ...ENTRY, id: "history-fold" }} />,
    );

    const wrapper = container.querySelector(".session-fold-collapse")!;
    expect(wrapper).not.toHaveAttribute("data-settling");
    expect((wrapper as HTMLElement).style.height).toBe("");
  });

  it("contracts from the height the folded rows occupied", () => {
    // jsdom has no layout, so the settled row height is stubbed.
    const offsetHeight = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockReturnValue(120);
    try {
      const { container } = render(
        <WorkLogEntry entry={{ ...ENTRY, id: "fold-motion" }} foldFrom={640} />,
      );
      const wrapper = container.querySelector(
        ".session-fold-collapse",
      ) as HTMLElement;
      expect(wrapper).toHaveAttribute("data-settling", "true");
      // Started at the measured height of the replaced rows, eased to one line.
      expect(wrapper.style.height).toBe("120px");

      fireEvent.transitionEnd(wrapper);
      // Released to auto, so opening the row is never clipped by the animation.
      expect(wrapper.style.height).toBe("");
      expect(wrapper).not.toHaveAttribute("data-settling");
    } finally {
      offsetHeight.mockRestore();
    }
  });
});
