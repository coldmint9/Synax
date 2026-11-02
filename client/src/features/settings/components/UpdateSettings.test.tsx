import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateSettings } from "./UpdateSettings";
import type { UpdateSettings as StoredUpdateSettings } from "../../../adapters/electron/desktop-update-settings";
import { DesktopUpdateProvider } from "../../updates/DesktopUpdateProvider";
import { DesktopUpdateStatus } from "../../updates/DesktopUpdateStatus";

const initial: StoredUpdateSettings = {
  enabled: false,
  sourceUrl: "",
  mode: "direct",
  customProxyUrl: "",
};
const api = {
  getUpdateSettings: vi.fn(),
  setUpdateSettings: vi.fn(),
  getDesktopUpdateState: vi.fn(),
  onDesktopUpdateState: vi.fn(),
  onDesktopUpdateShow: vi.fn(),
  checkDesktopUpdate: vi.fn(),
  installDesktopUpdate: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getUpdateSettings.mockResolvedValue(initial);
  api.setUpdateSettings.mockImplementation(
    async (settings: StoredUpdateSettings) => ({
      ...settings,
      sourceUrl: settings.sourceUrl
        ? settings.sourceUrl.replace(/\/+$/, "") + "/"
        : "",
      customProxyUrl: settings.customProxyUrl
        ? settings.customProxyUrl.replace(/\/+$/, "") + "/"
        : "",
    }),
  );
  api.getDesktopUpdateState.mockResolvedValue(null);
  api.onDesktopUpdateState.mockReturnValue(() => {});
  api.onDesktopUpdateShow.mockReturnValue(() => {});
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: api,
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, "electronAPI");
});

async function selectMode(label: string) {
  await userEvent.click(
    await screen.findByRole("button", { name: /更新连接方式/ }),
  );
  await userEvent.click(
    await screen.findByRole("option", { name: label, exact: true }),
  );
}

it("does not show desktop update settings in the browser or with an older bridge", () => {
  Reflect.deleteProperty(window, "electronAPI");
  const view = render(<UpdateSettings />);
  expect(view.container).toBeEmptyDOMElement();
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: { platform: "darwin" },
  });
  view.rerender(<UpdateSettings />);
  expect(view.container).toBeEmptyDOMElement();
});

it("keeps online updates off until the user enables them", async () => {
  render(
    <DesktopUpdateProvider>
      <UpdateSettings />
      <DesktopUpdateStatus />
    </DesktopUpdateProvider>,
  );
  const toggle = await screen.findByRole("switch", { name: "启用在线更新" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(screen.queryByLabelText(/更新源地址/)).not.toBeInTheDocument();
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  expect(api.setUpdateSettings).not.toHaveBeenCalled();
});

it("enables updates with the configured source and hides the status while off", async () => {
  const view = render(
    <DesktopUpdateProvider>
      <UpdateSettings />
      <DesktopUpdateStatus />
    </DesktopUpdateProvider>,
  );
  await screen.findByRole("switch", { name: "启用在线更新" });
  await userEvent.click(screen.getByRole("switch", { name: "启用在线更新" }));
  const source = screen.getByRole("textbox", { name: /更新源地址/ });
  fireEvent.change(source, { target: { value: "https://updates.example/synax" } });
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateSettings).toHaveBeenLastCalledWith({
    enabled: true,
    sourceUrl: "https://updates.example/synax",
    mode: "direct",
    customProxyUrl: "",
  });
  await waitFor(() =>
    expect(source).toHaveValue("https://updates.example/synax/"),
  );
  await userEvent.click(screen.getByRole("switch", { name: "启用在线更新" }));
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateSettings).toHaveBeenLastCalledWith({
    enabled: false,
    sourceUrl: "https://updates.example/synax/",
    mode: "direct",
    customProxyUrl: "",
  });
  view.rerender(
    <DesktopUpdateProvider>
      <UpdateSettings />
      <DesktopUpdateStatus />
    </DesktopUpdateProvider>,
  );
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});

it("saves the preset and switches back to direct without saving on selection", async () => {
  api.getUpdateSettings.mockResolvedValue({ ...initial, enabled: true });
  render(<UpdateSettings />);
  await selectMode("GH-Proxy");
  expect(screen.getByText("https://gh-proxy.org/")).toBeVisible();
  expect(api.setUpdateSettings).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateSettings).toHaveBeenLastCalledWith({
    enabled: true,
    sourceUrl: "",
    mode: "gh-proxy",
    customProxyUrl: "",
  });
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  await selectMode("直连");
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateSettings).toHaveBeenLastCalledWith({
    enabled: true,
    sourceUrl: "",
    mode: "direct",
    customProxyUrl: "",
  });
});

it("loads, edits and saves a custom prefix, keeping it when returning to direct", async () => {
  api.getUpdateSettings.mockResolvedValue({
    enabled: true,
    sourceUrl: "",
    mode: "custom",
    customProxyUrl: "https://old.example/",
  });
  render(<UpdateSettings />);
  const input = await screen.findByRole("textbox", {
    name: "代理 URL 前缀（HTTPS）",
  });
  expect(input).toHaveValue("https://old.example/");
  fireEvent.change(input, { target: { value: "https://new.example/prefix" } });
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateSettings).toHaveBeenLastCalledWith({
    enabled: true,
    sourceUrl: "",
    mode: "custom",
    customProxyUrl: "https://new.example/prefix",
  });
  await waitFor(() => expect(input).toHaveValue("https://new.example/prefix/"));
  await selectMode("直连");
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateSettings).toHaveBeenLastCalledWith({
    enabled: true,
    sourceUrl: "",
    mode: "direct",
    customProxyUrl: "https://new.example/prefix/",
  });
});

it("preserves the draft on save failure and permits retry", async () => {
  api.getUpdateSettings.mockResolvedValue({ ...initial, enabled: true });
  api.setUpdateSettings.mockRejectedValueOnce(new Error("Write failed"));
  render(<UpdateSettings />);
  const input = await screen.findByRole("textbox", {
    name: /更新源地址/,
  });
  fireEvent.change(input, { target: { value: "https://new.example/" } });
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Write failed");
  expect(input).toHaveValue("https://new.example/");
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
});

it("retries loading and prevents duplicate saves while one is pending", async () => {
  api.getUpdateSettings.mockRejectedValueOnce(new Error("Read failed"));
  render(<UpdateSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await userEvent.click(await screen.findByRole("switch", { name: "启用在线更新" }));
  let finish!: (value: StoredUpdateSettings) => void;
  api.setUpdateSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const button = screen.getByRole("button", { name: "保存更新设置" });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  await userEvent.click(button);
  expect(api.setUpdateSettings).toHaveBeenCalledTimes(1);
  finish({ enabled: true, sourceUrl: "", mode: "direct", customProxyUrl: "" });
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
});
