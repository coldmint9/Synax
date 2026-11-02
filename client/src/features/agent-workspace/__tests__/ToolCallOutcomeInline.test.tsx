import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import { ToolCallBatchSummaryLine } from "../ToolCallBatchSummaryLine";
import type { ToolCallView } from "../buildInterleavedTurns";
import { useShellStore } from "../../../shared/state/shellStore";
import { toolCallRecordToView } from "../toolCallUtils";
import type { ToolCallRecord } from "../../../adapters/transport/agentRuntime";
import { ActivityRowScope } from "../ActivityRowScope";

beforeEach(() => useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "zh" } })));
afterEach(cleanup);

const legacyBusyMessage = "The subagent is already running; wait or pause it before messaging it.";
function busyCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "busy", toolId: "subagent.lifecycle", status: "blocked", category: "task", mutability: "task", duration: null,
    inputSummary: JSON.stringify({ action: "message", childSessionId: "child", message: "Please finish" }),
    outputSummary: "The subagent is already running; the message was not sent. Wait or pause it before messaging it.",
    outputRef: { code: "SUBAGENT_BUSY", accepted: false, queued: false },
    ...overrides,
  };
}

function bashCall(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "call-1",
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
  it.each(["rg", "file.list", "file.read"])("keeps a completed %s path probe quiet with inspectable details", toolId => {
    const summary = 'Path not found: missing/agent-session. Discover an existing path before retrying.';
    const record = {
      ...bashCall({ toolId, status: "completed", inputSummary: '{"path":"missing/agent-session"}', outputSummary: summary }),
      category: "read", mutability: "read", error: null,
      outputRef: { status: "not_found", code: "READ_PATH_NOT_FOUND", recoverable: true },
      sessionId: "parent", runId: null, stepId: null,
      startedAt: "2026-10-30T00:00:00Z", endedAt: "2026-10-30T00:00:01Z",
    } as ToolCallRecord;
    const { container } = render(<ToolCallSummaryLine call={toolCallRecordToView(record)} />);
    expect(container.querySelector('[data-tool-failure]')).toBeNull();
    expect(container.querySelector('.bui-status')).toBeNull();
    expect(screen.queryByText(summary)).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(summary)).toBeVisible();
  });

  it("does not let a quiet path miss mask a real search failure in a batch", () => {
    const { container } = render(<ToolCallBatchSummaryLine batch={{ toolId: "rg", calls: [
      bashCall({ id: "miss", toolId: "rg", status: "completed", outputSummary: "Path not found: missing" }),
      bashCall({ id: "real", toolId: "rg", status: "failed", outputSummary: "Search executor unavailable" }),
    ] }} />);
    expect(screen.getByText("Search executor unavailable")).toBeVisible();
    expect(container.querySelector('[data-tool-failure]')).not.toBeNull();
    expect(container.querySelector('.bui-status')).toHaveAttribute('data-state', 'failed');
  });

  it("keeps a completed command's runtime echo behind the disclosure", () => {
    const call = bashCall({
      status: "completed",
      inputSummary: JSON.stringify({ command: "npx vitest run services/local-node" }),
      outputSummary: "bash (exit 0): npx vitest run services/local-node",
    });
    const { container } = render(<ToolCallSummaryLine call={call} />);
    // The folded row states the command it ran; the echo only repeats it.
    expect(container.querySelector(".bui-tool-copy")?.textContent)
      .toBe("已在 4ms 内运行npx vitest run services/local-node");
    expect(screen.queryByText(call.outputSummary)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(call.outputSummary)).toBeVisible();
  });

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

  it.each(["blocked", "legacy"])("shows only a neutral sentence and keeps raw details (%s)", kind => {
    const call = kind === "legacy" ? busyCall({ status: "failed", outputRef: undefined, outputSummary: legacyBusyMessage }) : busyCall();
    const { container } = render(<ToolCallSummaryLine call={call} />);
    const trigger = screen.getByRole("button", { name: "子代理运行中，消息未发送" });
    expect(trigger.textContent).toBe("子代理运行中，消息未发送");
    expect(container.querySelector("[data-tool-failure]")).toBeNull();
    expect(container.querySelector(".bui-status")).toBeNull();
    expect(container.querySelector(".bui-tool")).toHaveAttribute("data-tool-status", "blocked");
    expect(screen.queryByText(call.outputSummary)).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText(call.outputSummary)).toBeVisible();
    expect(screen.getByText(call.inputSummary)).toBeVisible();
    expect(call.status).toBe(kind === "legacy" ? "failed" : "blocked");
  });

  it("retains the structured busy receipt when projecting a persisted call", () => {
    const record = { ...busyCall(), sessionId: "parent", runId: null, stepId: null,
      startedAt: "2026-10-30T00:00:00Z", endedAt: "2026-10-30T00:00:01Z", error: null } as ToolCallRecord;
    render(<ToolCallSummaryLine call={toolCallRecordToView(record)} />);
    expect(screen.getByRole("button", { name: "子代理运行中，消息未发送" })).toBeVisible();
  });

  it("allows raw details to open on the individual row in the live compact window", () => {
    const call = busyCall();
    render(<ActivityRowScope compact><ToolCallSummaryLine call={call} /></ActivityRowScope>);
    fireEvent.click(screen.getByRole("button", { name: "子代理运行中，消息未发送" }));
    expect(screen.getByText(call.outputSummary)).toBeVisible();
  });

  it.each(["failed", "denied"])("does not hide a real %s in a mixed batch", status => {
    const { container } = render(<ToolCallBatchSummaryLine batch={{ toolId: "subagent.lifecycle", calls: [
      busyCall({ status: "failed", outputRef: null, outputSummary: legacyBusyMessage }),
      busyCall({ id: "other", status, outputRef: null, outputSummary: "Actual execution error" }),
    ] }} />);
    expect(screen.getByText("Actual execution error")).toBeVisible();
    expect(container.querySelector("[data-tool-failure]")).not.toBeNull();
    expect(container.querySelector(".bui-status")).toHaveAttribute("data-state", status);
  });

  it("keeps a fully busy batch neutral, including a legacy receipt", () => {
    const { container } = render(<ToolCallBatchSummaryLine batch={{ toolId: "subagent.lifecycle", calls: [
      busyCall(), busyCall({ id: "old", status: "failed", outputRef: null, outputSummary: legacyBusyMessage }),
    ] }} />);
    expect(screen.getByText("子代理运行中，消息未发送")).toBeVisible();
    expect(container.querySelector("[data-tool-failure]")).toBeNull();
    expect(container.querySelector(".bui-status")).toBeNull();
    expect(container.querySelector(".bui-tool")).toHaveAttribute("data-tool-status", "blocked");
  });

  it.each(["running", "pending"])("does not hide an in-flight %s call in a mixed batch", status => {
    const { container } = render(<ToolCallBatchSummaryLine batch={{ toolId: "subagent.lifecycle", calls: [
      busyCall(), busyCall({ id: "live", status, outputRef: null, outputSummary: "" }),
    ] }} />);
    expect(container.querySelector(".bui-status")).toHaveAttribute("data-state", status);
  });

  it("does not reclassify arbitrary lifecycle failures or matching output from another tool", () => {
    const { container } = render(<>
      <ToolCallSummaryLine call={busyCall({ status: "failed", outputRef: null, outputSummary: "Child not found" })} />
      <ToolCallSummaryLine call={bashCall({ status: "failed", outputSummary: legacyBusyMessage })} />
    </>);
    expect(container.querySelectorAll("[data-tool-failure]")).toHaveLength(2);
    expect(container.querySelector("[data-tool-blocked]")).toBeNull();
  });

  it.each(["zh", "en"] as const)("distinguishes shortened tool output from context compaction (%s)", locale => {
    useShellStore.setState(state => ({ preferences: { ...state.preferences, locale } }));
    render(<ToolCallSummaryLine call={bashCall({ status: "compacted" })} />);
    expect(screen.getByText(locale === "zh" ? "输出已精简" : "Output shortened")).toBeVisible();
    expect(screen.queryByText("历史已压缩")).toBeNull();
  });

  it("localizes the busy sentence", () => {
    useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "en" } }));
    render(<ToolCallSummaryLine call={busyCall()} />);
    expect(screen.getByRole("button", { name: "Subagent is running; message not sent" })).toBeVisible();
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
