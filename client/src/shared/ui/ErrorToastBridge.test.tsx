import { render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useNotificationStore } from "../state/notificationStore";
import { ErrorToastBridge } from "./ErrorToastBridge";

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
});

it("promotes alert regions to the shared toast stack and keeps their actions", async () => {
  const retry = vi.fn();
  render(
    <>
      <ErrorToastBridge />
      <div data-testid="source" role="alert">
        <p>加载项目失败</p>
        <button type="button" onClick={retry}>重试</button>
      </div>
    </>,
  );

  await waitFor(() => {
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  const source = document.querySelector('[data-testid="source"]') as HTMLElement;
  expect(source).toHaveStyle({ display: "none" });
  expect(useNotificationStore.getState().notifications[0]).toMatchObject({
    type: "error",
    message: "加载项目失败",
  });

  useNotificationStore.getState().notifications[0].actions?.[0].onClick();
  expect(retry).toHaveBeenCalledOnce();
});

it("promotes class-marked error content without duplicating nested nodes", async () => {
  render(
    <>
      <ErrorToastBridge />
      <div className="file-viewer-status--error">
        <span className="nested-error">读取 diff 失败</span>
      </div>
    </>,
  );

  await waitFor(() => {
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });
  expect(useNotificationStore.getState().notifications[0].message).toBe("读取 diff 失败");
});
