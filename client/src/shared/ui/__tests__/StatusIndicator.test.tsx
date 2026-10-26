import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusIndicator } from "../StatusIndicator";

describe("StatusIndicator", () => {
  it("transitions from active work to a static result and a readable error", () => {
    const { rerender } = render(<StatusIndicator active label="正在压缩上下文" />);
    expect(screen.getByRole("status")).toHaveAccessibleName("正在压缩上下文");
    expect(screen.getByRole("status").closest(".status-indicator")).toHaveAttribute("data-active", "true");

    rerender(<StatusIndicator label="上下文已压缩" tone="success" />);
    expect(screen.getByRole("status")).toHaveAccessibleName("上下文已压缩");
    expect(screen.getByRole("status").closest(".status-indicator")).toHaveAttribute("data-active", "false");

    rerender(<StatusIndicator label="上下文压缩失败：连接中断" tone="danger" role="alert" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAccessibleName("上下文压缩失败：连接中断");
  });

  it("keeps changing metadata outside the live announcement and supports expandable details", () => {
    const props = { label: "网络连接异常", announcement: "网络连接异常 · 等待自动重试" };
    const { rerender } = render(<StatusIndicator {...props} meta="3s" description="第 1 次重试" />);
    const status = screen.getByRole("status");
    const announcement = status.textContent;
    rerender(
      <StatusIndicator {...props} meta="2s" description="第 1 次重试">
        <details><summary>错误详情</summary><p>连接超时</p></details>
      </StatusIndicator>,
    );
    expect(status.textContent).toBe(announcement);
    expect(status).not.toContainElement(screen.getByText("2s"));
    expect(status).not.toContainElement(screen.getByText("第 1 次重试"));
    fireEvent.click(screen.getByText("错误详情"));
    expect(screen.getByText("错误详情").closest("details")).toHaveAttribute("open");
  });

  it("can be embedded in a control without introducing another live region", () => {
    render(<button><StatusIndicator inline active announce={false} label="等待搜索资源" /></button>);
    expect(screen.getByRole("button")).toHaveAccessibleName("等待搜索资源");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button").querySelector("div")).toBeNull();
  });
});
