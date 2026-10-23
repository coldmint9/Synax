import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import { ToolCallBatchSummaryLine } from "../ToolCallBatchSummaryLine";
import type { ToolCallView } from "../buildInterleavedTurns";

function bashCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "call-1",
    sessionId: "session-1",
    toolId: "bash",
    inputSummary: "git stash push -u -m baseline",
    outputSummary: "Do not discard user changes for automatic baseline comparisons.",
    status: "denied",
    category: "shell",
    duration: "4ms",
    mutability: "write",
    ...overrides,
  };
}

describe("tool call outcomes stay inline", () => {
  it("keeps a policy denial out of the error markers the toast bridge promotes", () => {
    const { container } = render(<ToolCallSummaryLine call={bashCall()} />);
    const preview = container.querySelector(".bui-tool-result");
    expect(preview?.getAttribute("data-tool-failure")).toBe("true");
    expect(preview?.hasAttribute("data-error")).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps a genuine tool failure out of the error markers too", () => {
    const { container } = render(<ToolCallSummaryLine call={bashCall({ status: "failed" })} />);
    const preview = container.querySelector(".bui-tool-result");
    expect(preview?.getAttribute("data-tool-failure")).toBe("true");
    expect(preview?.hasAttribute("data-error")).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("marks a grouped row the same way as a single call", () => {
    const { container } = render(
      <ToolCallBatchSummaryLine
        batch={{ toolId: "bash", calls: [bashCall(), bashCall({ id: "call-2" }), bashCall({ id: "call-3" })] }}
      />,
    );
    const preview = container.querySelector(".bui-tool-result");
    expect(preview?.getAttribute("data-tool-failure")).toBe("true");
    expect(preview?.hasAttribute("data-error")).toBe(false);
  });
});
