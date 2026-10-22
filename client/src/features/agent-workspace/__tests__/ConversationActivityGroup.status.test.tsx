import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationActivityGroup } from "../ConversationActivityGroup";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import type { ToolCallView } from "../buildInterleavedTurns";

function call(
  id: string,
  status: string,
  toolId = "bash",
  category = "shell",
): ToolCallView {
  return {
    id,
    toolId,
    inputSummary: "pnpm test",
    outputSummary: "",
    status,
    category,
    duration: null,
    mutability: "read",
  };
}

function renderGroup(status: string, toolId?: string, category?: string) {
  return render(
    <ConversationActivityGroup
      blocks={[{ type: "tool_call", call: call("tc_1", status, toolId, category) }]}
      working={false}
      streaming={false}
    />,
  );
}

describe("conversation activity group", () => {
  it("does not badge a call that is still pending", () => {
    renderGroup("pending", "mcp.browser.take_screenshot", "");
    expect(screen.getByText("调用了工具")).toBeInTheDocument();
    expect(screen.queryByText("待执行")).toBeNull();
  });

  it("keeps a failure out of the summary line", () => {
    const { container } = renderGroup("failed");
    const trigger = container.querySelector(".session-process-trigger")!;
    expect(trigger).toHaveTextContent("运行了命令");
    expect(trigger).not.toHaveTextContent("失败");
    expect(trigger.querySelector(".bui-status")).toBeNull();
    // The outcome still belongs to the call row inside the disclosure.
    fireEvent.click(trigger);
    expect(container.querySelector(".bui-tool")!).toHaveTextContent("失败");
  });

  it("keeps the per-call row free of a pending badge", () => {
    render(
      <ToolCallSummaryLine
        call={call("tc_2", "pending", "mcp.browser.take_screenshot", "")}
      />,
    );
    expect(screen.queryByText("待执行")).toBeNull();
  });
});
