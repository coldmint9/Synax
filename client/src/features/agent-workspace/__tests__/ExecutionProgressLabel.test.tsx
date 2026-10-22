import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../../../shared/hooks/useLocale", () => ({ useLocale: () => ({ locale: "zh" }) }));
import { ExecutionProgressLabel, executionProgressText } from "../ExecutionProgressLabel";

describe("execution progress", () => {
  it("distinguishes admission, execution, model waiting and cancellation", () => {
    expect(executionProgressText({ phase: "queued_resources", resource: "search" }, "zh")).toBe("等待搜索资源");
    expect(executionProgressText({ phase: "executing_tool", files: 42 }, "zh")).toBe("正在搜索 · 已扫描 42 个文件");
    expect(executionProgressText({ phase: "cancelling" }, "zh")).toBe("正在停止工具");
  });
  it("renders no progress label while waiting for the model", () => {
    const { container } = render(<ExecutionProgressLabel progress={{ phase: "waiting_model", startedAt: "2000-01-01T00:00:00.000Z" }} />);
    expect(container.textContent).toBe("");
  });
  it("reports an exceeded deadline without claiming the process has stopped", () => {
    render(<ExecutionProgressLabel progress={{ phase: "executing_tool", deadline: "2000-01-01T00:00:00.000Z" }} />);
    expect(screen.getByText("执行超时，正在确认工具状态")).toBeTruthy();
  });
});
