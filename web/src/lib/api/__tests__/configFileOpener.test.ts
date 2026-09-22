import { beforeEach, expect, it, vi } from "vitest";
import { configApi } from "../config";
import { apiFetch } from "../origin";
import { useShellStore } from "../../../react/state/shellStore";
import { useNotificationStore } from "../../../react/state/notificationStore";
vi.mock("../origin", () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  useShellStore.setState((s) => ({
    preferences: { ...s.preferences, editor: "zed", locale: "zh" },
  }));
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
});
it("passes the saved app and line/location to the backend", async () => {
  await configApi.openFile("/repo/a.ts", 12, { kind: "host", path: "/repo" });
  const init = vi.mocked(apiFetch).mock.calls[0][1];
  expect(JSON.parse(init!.body as string)).toEqual({
    opener: "zed",
    filePath: "/repo/a.ts",
    line: 12,
    location: { kind: "host", path: "/repo" },
  });
});
it("also honors the preference when opening global configuration", async () => {
  await configApi.openGlobalFile();
  expect(
    JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string),
  ).toEqual({ target: "global", opener: "zed" });
});
it("warns when the backend falls back to the system association", async () => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ ok: true, fallback: true })),
  );
  await configApi.openFile("/repo");
  expect(useNotificationStore.getState().notifications[0].message).toContain(
    "系统默认",
  );
});
