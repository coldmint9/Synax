import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { ContextCompactionFeedback } from "../ContextCompactionFeedback";
import { useShellStore } from "../../../shared/state/shellStore";

beforeEach(() => useShellStore.setState(state => ({ preferences: { ...state.preferences, locale: "zh" } })));
const base = { id: "context:run", runId: "run", stepId: "step", startedAt: "2026-10-23T00:00:00Z", requestId: null };

it("announces an in-progress same-session compaction", () => {
  render(<ContextCompactionFeedback state={{ ...base, status: "running" }} />);
  expect(screen.getByRole("status")).toHaveAccessibleName(/正在压缩上下文/);
  expect(screen.getByText("正在压缩上下文")).toBeVisible();
});

it("describes the readonly boundary after a checkpoint commits", () => {
  render(<ContextCompactionFeedback state={{ ...base, status: "completed", compacted: true, checkpointId: "cmp" }} />);
  expect(screen.getByRole("status")).toHaveTextContent("此前上下文已压缩");
  expect(screen.getByText("历史仍可查看，不再支持编辑、回滚或分叉")).toBeInTheDocument();
});

it("keeps a failed attempt distinct from a committed boundary", () => {
  render(<ContextCompactionFeedback state={{ ...base, status: "failed", error: "连接中断" }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("连接中断");
  expect(screen.queryByText("此前上下文已压缩")).not.toBeInTheDocument();
});
