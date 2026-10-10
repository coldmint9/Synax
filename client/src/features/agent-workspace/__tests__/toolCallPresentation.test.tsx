import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toolCallPresentation } from "../toolCallPresentation";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import { ToolCallRoundPanel } from "../ToolCallRoundPanel";
import type { ToolCallView } from "../buildInterleavedTurns";

const call: ToolCallView = {
  id: "call-1",
  toolId: "mcp.custom-581863fe-d9f.list_database_connections",
  inputSummary: '{}',
  outputSummary: '{"connections":[{"id":"internal-123","name":"test"}]}',
  status: "completed",
  category: "read",
  duration: "607ms",
  mutability: "read",
};

describe("tool call display names", () => {
  it.each([
    ["agent.discover", "查找可用工具"],
    ["webSearch", "搜索网页"],
    ["skill.load", "加载技能"],
    [call.toolId, "查看数据库连接"],
    ["mcp__custom-581863fe-d9f__list_database_connections", "查看数据库连接"],
    ["mcp.custom-581863fe-d9f.fetchCustomerOrders", "Fetch Customer Orders"],
    ["mcp.custom-581863fe-d9f.fetch_customer_orders", "Fetch customer orders"],
  ])("renders %s without its internal namespace", (toolId, name) => {
    expect(toolCallPresentation({ ...call, toolId }).name).toBe(name);
  });

  it("localizes known names and keeps a useful search target", () => {
    const result = toolCallPresentation({
      ...call, toolId: "webSearch", inputSummary: '{"query":"React 19"}',
    }, "en");
    expect(result.name).toBe("Search the web");
    expect(result.target).toBe("React 19");
    expect(toolCallPresentation(call).target).toBe("");
    expect(toolCallPresentation({ ...call, inputSummary: '{"connectionId":"internal-123"}' }).target).toBe("");
  });

  it("recovers a target from truncated JSON without displaying the JSON tail", () => {
    expect(toolCallPresentation({ ...call, inputSummary: '{"query":"SQL tables","other":' }).target).toBe("SQL tables");
  });

  it("uses aliases in the heading and details while preserving raw input and output", () => {
    const { container, getByRole } = render(<ToolCallSummaryLine call={call} />);
    expect(container).toHaveTextContent("查看数据库连接");
    expect(container.innerHTML).not.toContain(call.toolId);
    fireEvent.click(getByRole("button"));
    expect(Array.from(container.querySelectorAll("pre"), (node) => node.textContent))
      .toEqual([call.inputSummary, call.outputSummary]);
    expect(container.innerHTML).not.toContain(call.toolId);
  });

  it("shows edited files in the collapsed row while preserving the raw patch", () => {
    const edit = { ...call, toolId: "file.patch", inputSummary: JSON.stringify({
      patch: "*** Begin Patch\n*** Update File: client/src/Button.tsx\n@@\n-old\n+new\n*** End Patch",
    }) };
    const { container, getByRole } = render(<ToolCallSummaryLine call={edit} />);
    expect(container.querySelector(".bui-tool-target")).toHaveTextContent("client/src/Button.tsx");
    fireEvent.click(getByRole("button"));
    expect(container.querySelector("pre")?.textContent).toBe(edit.inputSummary);
  });

  it("includes unique targets for additions, deletions, updates and moves", () => {
    const patch = "*** Begin Patch\n*** Add File: new file.ts\n+x\n*** Delete File: old.ts\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Update File: a.ts\n@@\n-y\n+z\n*** End Patch";
    expect(toolCallPresentation({ ...call, toolId: "file.patch", inputSummary: JSON.stringify({ patch }) }).target)
      .toBe("new file.ts, old.ts, a.ts, b.ts");
  });

  it("recovers complete patch paths from truncated JSON without inventing partial paths", () => {
    const input = JSON.stringify({ patch: "*** Begin Patch\n*** Update File: client/组件.tsx\n@@\n-old\n+new\n*** Update File: incomplete.ts\n" });
    for (const suffix of ["", "\\", "\\u12"]) {
      expect(toolCallPresentation({ ...call, toolId: "file.patch", inputSummary: input.slice(0, input.indexOf("incomplete")) + suffix }).target)
        .toBe("client/组件.tsx");
    }
  });

  it("uses the same alias in the outer preview and grouped calls", () => {
    const { container, getByRole } = render(<ToolCallRoundPanel toolBlocks={[{
      type: "tool_call_group", calls: [call, { ...call, id: "call-2" }],
    }]} />);
    expect(container.querySelector(".bui-thinking-label")).toHaveTextContent("查看数据库连接");
    fireEvent.click(getByRole("button"));
    expect(container.querySelector(".bui-tool-label")).toHaveTextContent("查看数据库连接");
    expect(container.innerHTML).not.toContain(call.toolId);
  });
});
