import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ToolCallSummaryLine,
  resetToolCallExpansion,
} from "../ToolCallSummaryLine";
import type { ToolCallView } from "../buildInterleavedTurns";
import {
  clearToolCallDetailCache,
  setToolCallRecordLoader,
} from "../state/toolCallDetailCache";

const BIG_INPUT = `{"path":"src/app.ts","body":"${"x".repeat(4_000)}"}`;
const BIG_OUTPUT = `line of output\n${"y".repeat(4_000)}`;

/** A transcript row: preview summaries plus the session that owns the call. */
function savedCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "call-1",
    sessionId: "session-1",
    toolId: "file.read",
    inputSummary: "preview input",
    outputSummary: "preview output",
    status: "completed",
    category: "read",
    duration: "12ms",
    mutability: "read",
    ...overrides,
  };
}

const loadRecord = vi.fn(async () => ({
  id: "call-1",
  sessionId: "session-1",
  runId: null,
  stepId: null,
  toolId: "file.read",
  category: "read",
  mutability: "read" as const,
  inputSummary: BIG_INPUT,
  outputSummary: BIG_OUTPUT,
  status: "completed" as const,
  startedAt: "2026-10-19T00:00:00.000Z",
  endedAt: "2026-10-19T00:00:00.012Z",
  error: null,
}));

/** The row's own trigger: the detail body may add its own retry button. */
function openRow() {
  const toggle = screen.getByRole("button", { name: /展开或收起|Show or hide/ });
  fireEvent.click(toggle);
  return toggle;
}

describe("lazy tool call details", () => {
  beforeEach(() => {
    resetToolCallExpansion();
    clearToolCallDetailCache();
    loadRecord.mockClear();
    setToolCallRecordLoader(loadRecord);
  });
  afterEach(() => {
    clearToolCallDetailCache();
  });

  it("does not request a payload until the row is expanded", () => {
    const { container } = render(<ToolCallSummaryLine call={savedCall()} />);
    expect(loadRecord).not.toHaveBeenCalled();
    expect(container.querySelector(".bui-tool-details")).toBeNull();
    expect(container).toHaveTextContent("preview input");
  });

  it("loads the saved record on expand and shows it in place of the preview", async () => {
    const { container } = render(<ToolCallSummaryLine call={savedCall()} />);
    openRow();
    await waitFor(() => expect(loadRecord).toHaveBeenCalledWith("session-1", "call-1"));
    await waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe(BIG_INPUT),
    );
    expect(container.querySelectorAll("pre")[1]?.textContent).toBe(BIG_OUTPUT);
  });

  it("serves the cached record immediately when the row is reopened", async () => {
    render(<ToolCallSummaryLine call={savedCall()} />);
    openRow();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /展开或收起|Show or hide/ })).toHaveAttribute(
        "aria-expanded",
        "true",
      ),
    );
    await waitFor(() => expect(loadRecord).toHaveBeenCalledTimes(1));
    // Collapse and expand again: the cache, not a second request, answers.
    openRow();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /展开或收起|Show or hide/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    openRow();
    expect(screen.getByRole("button", { name: /展开或收起|Show or hide/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await waitFor(() =>
      expect(document.querySelector("pre")?.textContent).toBe(BIG_INPUT),
    );
    expect(loadRecord).toHaveBeenCalledTimes(1);
  });

  it("keeps one request while two rows describe the same call", async () => {
    render(
      <>
        <ToolCallSummaryLine call={savedCall()} />
        <ToolCallSummaryLine call={savedCall()} />
      </>,
    );
    const [first, second] = screen.getAllByRole("button");
    fireEvent.click(first);
    fireEvent.click(second);
    await waitFor(() => expect(loadRecord).toHaveBeenCalledTimes(1));
  });

  it("reports an unavailable record instead of an empty body", async () => {
    setToolCallRecordLoader(async () => null);
    render(<ToolCallSummaryLine call={savedCall()} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /展开或收起|Show or hide/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      ),
    );
    openRow();
    // A null answer is cached as a miss; the body must say so rather than
    // repeating the preview as if it were the record.
    await waitFor(() =>
      expect(screen.getByText(/没有保留|No saved record/)).toBeInTheDocument(),
    );
    // The known-empty record must not fall back to the truncated preview.
    expect(screen.queryAllByText("preview input", { selector: "pre" })).toHaveLength(0);
  });

  it("retries a failed load only when the reader asks again", async () => {
    let attempts = 0;
    setToolCallRecordLoader(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return loadRecord();
    });
    const { container } = render(<ToolCallSummaryLine call={savedCall()} />);
    openRow();
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')).toHaveTextContent(
        /加载失败|Could not load/i,
      ),
    );
    expect(attempts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /重试|Retry/ }));
    await waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe(BIG_INPUT),
    );
    expect(attempts).toBe(2);
  });
});
