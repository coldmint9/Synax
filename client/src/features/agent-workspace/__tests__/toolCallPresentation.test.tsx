import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { toolCallPresentation } from "../toolCallPresentation";
import { conversationToolPresentation } from "../conversationActivity";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import { ToolCallBatchSummaryLine } from "../ToolCallBatchSummaryLine";
import { ToolCallRoundPanel } from "../ToolCallRoundPanel";
import { TranscriptSessionProvider } from "../SessionTranscriptContext";
import { useSessionWorkspaceStore } from "../state/sessionWorkspaceStore";
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

const workflowAliases = [
  ["command.manage", "管理命令任务", "Manage command tasks"],
  ["subagent.lifecycle", "管理子任务", "Manage subagents"],
  ["super.plan", "编排多智能体任务", "Orchestrate multi-agent tasks"],
  ["super.message", "传递多智能体指令", "Send multi-agent directive"],
  ["super.close", "完成多智能体协同验证", "Finalize multi-agent verification"],
  ["plan.propose", "提交实施计划", "Propose plan"],
  ["plan.execute", "执行实施计划", "Execute plan"],
  ["goal.finish", "提交目标验收", "Submit goal acceptance"],
  ["work.checkpoint", "更新工作检查点", "Update work checkpoint"],
  ["presentation.select", "选择呈现方式", "Select presentation"],
  ["code.result", "读取执行结果", "Read execution result"],
  ["code.tools", "查找可组合工具", "Find composable tools"],
  ["code.run", "执行工具步骤", "Run tool steps"],
  ["git.merge.create", "创建合并任务", "Create merge task"],
  ["git.merge.analyze", "分析合并", "Analyze merge"],
  ["git.merge.resume", "继续合并任务", "Resume merge task"],
  ["git.merge.cancel", "取消合并任务", "Cancel merge task"],
  ["git.merge.configure", "配置合并检查", "Configure merge checks"],
  ["git.merge.read", "查看合并任务", "Inspect merge task"],
  ["git.merge.propose", "提交冲突解决方案", "Propose conflict resolution"],
  ["git.pr.read", "查看合并请求", "Read pull request"],
] as const;

const subagentLifecycleActions = [
  ["start", "启动子代理", "Start subagent"],
  ["list", "列出全部子代理", "List all subagents"],
  ["inspect", "查看子代理", "Inspect subagent"],
  ["wait", "等待子代理", "Wait for subagent"],
  ["message", "向子代理发送消息", "Message subagent"],
  ["pause", "暂停子代理", "Pause subagent"],
  ["resume", "恢复子代理", "Resume subagent"],
  ["cancel", "取消子代理", "Cancel subagent"],
  ["terminate", "终止子代理", "Terminate subagent"],
  ["close", "关闭子代理", "Close subagent"],
] as const;

describe("workflow tool aliases", () => {
  it.each(subagentLifecycleActions)("shows the concrete subagent action %s", (action, zh, en) => {
    const lifecycleCall = {
      ...call,
      toolId: "subagent.lifecycle",
      inputSummary: JSON.stringify({ action }),
      category: "task",
    };
    expect(toolCallPresentation(lifecycleCall, "zh").name).toBe(zh);
    expect(toolCallPresentation(lifecycleCall, "en").name).toBe(en);
    expect(conversationToolPresentation(lifecycleCall, "zh").label).toBe(`已${zh}`);
    expect(conversationToolPresentation(lifecycleCall, "en").label).toBe(`Used ${en}`);
  });

  it("renders the addressed subagent in the lifecycle action", () => {
    const lifecycleCall = {
      ...call,
      toolId: "subagent.lifecycle",
      inputSummary: JSON.stringify({ action: "message", childSessionId: "child-1234", message: "Finish the task" }),
      outputRef: { childSessionId: "child-1234", name: "林墨" },
      category: "task",
    };
    expect(toolCallPresentation(lifecycleCall, "zh").name).toBe("向林墨子代理发送消息");
    expect(toolCallPresentation(lifecycleCall, "zh").target).toBe("");
    expect(conversationToolPresentation(lifecycleCall, "zh").label).toBe("已向林墨子代理发送消息");
  });

  it("renders a highlighted Bot object that opens the child session", () => {
    const lifecycleCall = {
      ...call,
      toolId: "subagent.lifecycle",
      inputSummary: JSON.stringify({ action: "message", childSessionId: "child-1234", message: "Finish the task" }),
      outputRef: { childSessionId: "child-1234", name: "林墨" },
      category: "task",
    };
    useSessionWorkspaceStore.getState().resetSession("parent");
    const { getByRole, container } = render(
      <TranscriptSessionProvider sessionId="parent">
        <ToolCallSummaryLine call={lifecycleCall} />
      </TranscriptSessionProvider>,
    );
    const objectButton = getByRole("button", { name: "打开林墨子代理会话" });
    const disclosureButton = getByRole("button", { name: "已向林墨子代理发送消息" });
    expect(objectButton.querySelector("svg")).not.toBeNull();
    expect(objectButton).toHaveClass("bui-subagent-object");
    expect(disclosureButton.querySelector(".bui-chevron")).not.toBeNull();
    expect(disclosureButton).toHaveTextContent("已向");
    expect(disclosureButton).toHaveTextContent("发送消息");
    expect(disclosureButton).not.toContainElement(objectButton);
    expect(objectButton.parentElement).toBe(disclosureButton.parentElement);
    fireEvent.click(disclosureButton);
    expect(disclosureButton).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(objectButton);
    expect(useSessionWorkspaceStore.getState().sessions.parent?.subagent).toEqual({
      sessionId: "child-1234",
      title: "林墨子代理",
    });
    expect(container.querySelector(".bui-subagent-object")).toBe(objectButton);
    useSessionWorkspaceStore.getState().resetSession("parent");
  });

  it("falls back to a short child id when a lifecycle result has no name", () => {
    const lifecycleCall = {
      ...call,
      toolId: "subagent.lifecycle",
      inputSummary: JSON.stringify({ action: "message", childSessionId: "child-123456789", message: "Finish the task" }),
      category: "task",
    };
    expect(toolCallPresentation(lifecycleCall, "zh").name).toBe("向子代理 child-12发送消息");
  });

  it.each(workflowAliases)("localizes %s in running and completed rows", (toolId, zh, en) => {
    const workflowCall = { ...call, toolId, category: "task" };
    expect(toolCallPresentation(workflowCall, "zh").name).toBe(zh);
    expect(toolCallPresentation(workflowCall, "en").name).toBe(en);
    for (const status of ["pending", "running", "completed"] as const) {
      const current = { ...workflowCall, status };
      expect(conversationToolPresentation(current, "zh").label)
        .toBe(`${status === "completed" ? "已" : "正在"}${zh}`);
      expect(conversationToolPresentation(current, "en").label)
        .toBe(`${status === "completed" ? "Used" : "Using"} ${en}`);
    }
  });

  it.each(workflowAliases)("preserves the raw payload when displaying %s", (toolId, zh) => {
    const workflowCall = { ...call, toolId, category: "task" };
    const before = { ...workflowCall };
    const { container, getByRole } = render(<ToolCallSummaryLine call={workflowCall} />);
    expect(container.querySelector(".bui-tool-label")).toHaveTextContent(`已${zh}`);
    fireEvent.click(getByRole("button"));
    expect(Array.from(container.querySelectorAll("pre"), (node) => node.textContent))
      .toEqual([workflowCall.inputSummary, workflowCall.outputSummary]);
    expect(workflowCall).toEqual(before);
  });

  it("uses the same alias in grouped command calls and their expanded rows", () => {
    const command = { ...call, toolId: "command.manage", inputSummary: '{"action":"status"}', category: "task" };
    const { container, getByRole } = render(<ToolCallBatchSummaryLine batch={{
      toolId: command.toolId,
      calls: [command, { ...command, id: "call-2", inputSummary: '{"action":"wait"}' }],
    }} />);
    expect(container.querySelector(".bui-tool-label")).toHaveTextContent("管理命令任务");
    fireEvent.click(getByRole("button"));
    expect(Array.from(container.querySelectorAll(".bui-tool-label"), (node) => node.textContent))
      .toEqual(["管理命令任务", "已管理命令任务", "已管理命令任务"]);
  });

  it("keeps a readable fallback for unknown tools and incomplete inputs", () => {
    expect(toolCallPresentation({ ...call, toolId: "future.manage", inputSummary: "{" }).name)
      .toBe("Future manage");
    expect(toolCallPresentation({ ...call, toolId: "command.manage", inputSummary: "{" }).name)
      .toBe("管理命令任务");
  });
});

describe("tool call display names", () => {
  it("shows merge worker file and side before expanding the read details", () => {
    const read = { ...call, toolId: "git.merge.worker.read", inputSummary: JSON.stringify({
      fileId: "ae2f7f6eb712b936", side: "source", byteOffset: 48000, expectedRevision: "rev",
    }), outputSummary: "client/package-lock.json" };
    const { container, getByRole } = render(<ToolCallSummaryLine call={read} />);
    expect(container.querySelector(".bui-tool-label")).toHaveTextContent("已读取合并文件");
    expect(container.querySelector(".bui-tool-target")).toHaveTextContent("client/package-lock.json · 来源分支 · 字节 48000");
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(getByRole("button"));
    expect(container.querySelector("pre")?.textContent).toBe(read.inputSummary);
  });
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

  it("uses aliases in the heading and details while preserving raw input and output", async () => {
    const { container, getByRole } = render(<ToolCallSummaryLine call={call} />);
    expect(container).toHaveTextContent("查看数据库连接");
    expect(container.innerHTML).not.toContain(call.toolId);
    // A folded record states the call, never its output summary.
    expect(container.querySelector(".bui-tool-result")).toBeNull();
    fireEvent.click(getByRole("button"));
    expect(Array.from(container.querySelectorAll("pre"), (node) => node.textContent))
      .toEqual([call.inputSummary, call.outputSummary]);
    expect(container.innerHTML).not.toContain(call.toolId);
    fireEvent.click(getByRole("button"));
    await waitFor(() => expect(container.querySelector(".bui-tool-details")).toBeNull());
  });

  it("states an edit as its line counts and file instead of the runtime echo", () => {
    const edit = { ...call, toolId: "file.patch", inputSummary: JSON.stringify({
      patch: "*** Begin Patch\n*** Update File: client/src/Button.tsx\n@@\n+new\n*** End Patch",
    }), outputSummary: "Patched 1 file: client/src/Button.tsx" };
    const { container, getByRole } = render(<ToolCallSummaryLine call={edit} />);
    expect(container.querySelector(".bui-tool-copy")?.textContent).toBe("已编辑+1 -0Button.tsx");
    expect(container).not.toHaveTextContent("Patched 1 file");
    fireEvent.click(getByRole("button"));
    expect(container.querySelector(".bui-tool-target")).toHaveTextContent("client/src/Button.tsx");
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
    expect(container.querySelector(".bui-tool-label")).toHaveTextContent("查看数据库连接");
    fireEvent.click(getByRole("button"));
    expect(container.querySelector(".bui-tool-label")).toHaveTextContent("查看数据库连接");
    expect(container.innerHTML).not.toContain(call.toolId);
  });
});
