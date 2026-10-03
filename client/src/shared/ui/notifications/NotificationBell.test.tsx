import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { useNotificationStore } from "../../state/notificationStore";
import { NotificationBell } from "./NotificationBell";

beforeEach(() => useNotificationStore.setState({
  unreadCount: 101,
  notifications: [{ id: "notice", message: "Task complete", type: "success", timestamp: Date.now(), read: false, visible: false }],
}));

it("uses one native trigger, portals the panel, preserves notification actions and returns keyboard focus", async () => {
  const user = userEvent.setup();
  const { container } = render(<NotificationBell />);
  const trigger = screen.getByRole("button", { name: "通知" });
  expect(trigger).toHaveTextContent("99+");
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button button")).toBeNull();
  await user.tab();
  await user.keyboard("{Enter}");
  const panel = await screen.findByRole("dialog", { name: "通知" });
  expect(container).not.toContainElement(panel);
  expect(within(panel).getByText("Task complete")).toBeVisible();
  await user.click(within(panel).getByRole("button", { name: "全部已读" }));
  expect(trigger).not.toHaveTextContent("99+");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(panel).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(screen.getByRole("button", { name: "清空" }));
  expect(screen.getByText("暂无通知")).toBeVisible();
  await user.click(document.body);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});
