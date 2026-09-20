import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentQuickApproval } from "../AgentQuickApproval";
import type { PermissionDecision } from "../../../../../lib/api/agentRuntime";
vi.mock("../../../../../hooks/useLocale", () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));
const permission = (allowedReplies?: string[]) =>
  ({
    id: "p1",
    action: "ask",
    patterns: ["echo hello"],
    resolvedAt: null,
    metadata: allowedReplies ? { allowedReplies } : {},
  }) as PermissionDecision;

describe("native approval capability UI", () => {
  it("does not offer always when the CLI only supports this operation", async () => {
    const onReply = vi.fn();
    render(
      <AgentQuickApproval
        permissions={[permission(["once", "reject"])]}
        onReply={onReply}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "permAlwaysAllow" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "permAllowOnce" }),
    );
    expect(onReply).toHaveBeenCalledWith("p1", "once");
  });
  it("retains legacy Native approval choices and explicit session approval support", () => {
    const view = render(
      <AgentQuickApproval permissions={[permission()]} onReply={vi.fn()} />,
    );
    expect(
      screen.getByRole("button", { name: "permAlwaysAllow" }),
    ).toBeInTheDocument();
    view.rerender(
      <AgentQuickApproval
        permissions={[permission(["once", "always", "reject"])]}
        onReply={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "permAlwaysAllow" }),
    ).toBeInTheDocument();
  });
});

it("shows queued operation details and replies only to the selected request", async () => {
  const onReply = vi.fn();
  render(
    <AgentQuickApproval
      permissions={[
        permission(),
        {
          ...permission(["once", "reject"]),
          id: "p2",
          reason: "Network requires approval.",
          metadata: {
            allowedReplies: ["once", "reject"],
            command: "curl example.test",
            args: { workdir: "/project" },
          },
        },
      ]}
      onReply={onReply}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Next approval" }));
  expect(screen.getByText("curl example.test")).toBeInTheDocument();
  expect(screen.getByText("/project")).toBeInTheDocument();
  expect(screen.getByText("2 / 2")).toBeInTheDocument();
  screen.getByRole("button", { name: "permAllowOnce" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onReply).toHaveBeenCalledWith("p2", "once");
});

it("locks in-flight approvals, reports failures and permits an explicit retry", async () => {
  let reject: (reason: Error) => void = () => {};
  const onReply = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    )
    .mockResolvedValue(undefined);
  render(<AgentQuickApproval permissions={[permission()]} onReply={onReply} />);
  const approve = screen.getByRole("button", { name: "permAllowOnce" });
  await userEvent.dblClick(approve);
  expect(onReply).toHaveBeenCalledTimes(1);
  expect(approve).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Submitting");
  await act(async () => reject(new Error("Connection lost")));
  expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  expect(approve).toBeEnabled();
  await userEvent.click(approve);
  expect(onReply).toHaveBeenCalledTimes(2);
});
