import { act, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RuntimeAccessGate } from "./RuntimeAccessGate";
import { useApiConnectivityStore } from "../../../lib/apiConnectivity";

const auth = vi.hoisted(() => ({
  ensureRuntimeAuthentication: vi.fn(),
  enableRuntimeAuth: vi.fn(),
  setRuntimeAccessToken: vi.fn(),
  RUNTIME_AUTH_REQUIRED: "synax-runtime-auth-required",
}));
vi.mock("../../../lib/api/runtimeAuth", () => auth);
vi.mock("../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));

const desktopWindow = window as Window & { electronAPI?: unknown };
const workspace = (
  <RuntimeAccessGate>
    <div>Workspace</div>
  </RuntimeAccessGate>
);

beforeEach(() => {
  vi.resetAllMocks();
  useApiConnectivityStore.setState({
    apiReachable: "unknown",
    browserOnline: true,
  });
});
afterEach(() => {
  delete desktopWindow.electronAPI;
});

it("shows only connection status on the very first render, before effects run", () => {
  const html = renderToString(workspace);
  expect(html).toContain("正在连接运行服务");
  expect(html).not.toContain("需要连接授权");
  expect(html).not.toContain("<input");
});

it("waits for automatic authentication before opening the workspace", async () => {
  let connected!: () => void;
  auth.ensureRuntimeAuthentication.mockReturnValue(
    new Promise<void>((resolve) => {
      connected = resolve;
    }),
  );
  render(workspace);
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(screen.queryByLabelText("Runtime access token")).toBeNull();
  await act(async () => connected());
  expect(screen.getByText("Workspace")).toBeInTheDocument();
});

it("offers retry for a connection failure without asking for a token", async () => {
  auth.ensureRuntimeAuthentication.mockRejectedValueOnce(
    new TypeError("Failed to fetch"),
  );
  render(workspace);
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Runtime access token")).toBeNull();
  auth.ensureRuntimeAuthentication.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "连接 / 重试" }));
  await screen.findByText("Workspace");
});

it("uses automatic desktop credentials on retry, including authentication failures", async () => {
  desktopWindow.electronAPI = { getRuntimeToken: vi.fn() };
  auth.ensureRuntimeAuthentication.mockRejectedValueOnce(
    Object.assign(new Error("Denied"), { code: "AUTH_REQUIRED" }),
  );
  render(workspace);
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Runtime access token")).toBeNull();
  auth.ensureRuntimeAuthentication.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "连接 / 重试" }));
  await screen.findByText("Workspace");
});

it("asks for a token only after the browser runtime explicitly requires authentication", async () => {
  auth.ensureRuntimeAuthentication.mockRejectedValueOnce(
    Object.assign(new Error("Denied"), { code: "AUTH_REQUIRED" }),
  );
  render(workspace);
  fireEvent.change(await screen.findByLabelText("Runtime access token"), {
    target: { value: "test-token" },
  });
  auth.ensureRuntimeAuthentication.mockResolvedValueOnce(undefined);
  fireEvent.click(screen.getByRole("button", { name: "连接 / 重试" }));
  await screen.findByText("Workspace");
  expect(auth.setRuntimeAccessToken).toHaveBeenCalledWith("test-token");
});
