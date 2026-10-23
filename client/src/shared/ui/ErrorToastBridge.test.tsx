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

it("never promotes a failed or denied tool call, even when its row is error-marked", async () => {
  render(
    <>
      <ErrorToastBridge />
      <div className="bui-tool" data-tool-status="denied">
        <span className="bui-tool-result" data-tool-failure="true">
          Do not discard user changes for automatic baseline comparisons.
        </span>
      </div>
      <div className="bui-tool" data-tool-status="failed">
        <span className="bui-tool-error">Command failed with exit code 1</span>
      </div>
    </>,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
});

it("leaves opted-out inline errors in place and never hides them", async () => {
  render(
    <>
      <ErrorToastBridge />
      <div data-testid="inline" data-error-toast="off" role="alert">
        对话加载失败，请重试
      </div>
      <div data-testid="wrapper" data-error-toast="off">
        <div data-testid="nested" role="alert">表单必填项</div>
      </div>
    </>,
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(useNotificationStore.getState().notifications).toHaveLength(0);
  for (const id of ["inline", "nested"]) {
    const node = document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    expect(node.style.display).not.toBe("none");
    expect(node).not.toHaveAttribute("data-synax-error-toast-source");
  }
});

it("uses a warning toast for warning-toned regions instead of a hard error", async () => {
  render(
    <>
      <ErrorToastBridge />
      <p role="alert" className="border-warning/25 text-xs">写入已暂停</p>
      <div data-error-toast-tone="warning" role="alert">需要桌面权限</div>
    </>,
  );

  await waitFor(() => {
    expect(useNotificationStore.getState().notifications).toHaveLength(2);
  });
  expect(useNotificationStore.getState().notifications.map((n) => n.type)).toEqual([
    "warning",
    "warning",
  ]);
});
