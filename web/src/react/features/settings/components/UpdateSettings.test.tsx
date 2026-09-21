import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateSettings } from "./UpdateSettings";
import type { UpdateNetworkSettings } from "../../../../lib/desktop-update-settings";

const initial: UpdateNetworkSettings = { mode: "direct", customProxyUrl: "" };
const api = {
  getUpdateNetworkSettings: vi.fn(),
  setUpdateNetworkSettings: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  api.getUpdateNetworkSettings.mockResolvedValue(initial);
  api.setUpdateNetworkSettings.mockImplementation(
    async (settings: UpdateNetworkSettings) => ({
      ...settings,
      customProxyUrl: settings.customProxyUrl
        ? settings.customProxyUrl.replace(/\/+$/, "") + "/"
        : "",
    }),
  );
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

it("saves the preset and switches back to direct without saving on selection", async () => {
  render(<UpdateSettings />);
  await selectMode("GH-Proxy");
  expect(screen.getByText("https://gh-proxy.org/")).toBeVisible();
  expect(api.setUpdateNetworkSettings).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateNetworkSettings).toHaveBeenLastCalledWith({
    mode: "gh-proxy",
    customProxyUrl: "",
  });
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
  await selectMode("GitHub 直连");
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateNetworkSettings).toHaveBeenLastCalledWith(initial);
});

it("loads, edits and saves a custom prefix, keeping it when returning to direct", async () => {
  api.getUpdateNetworkSettings.mockResolvedValue({
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
  expect(api.setUpdateNetworkSettings).toHaveBeenLastCalledWith({
    mode: "custom",
    customProxyUrl: "https://new.example/prefix",
  });
  await waitFor(() => expect(input).toHaveValue("https://new.example/prefix/"));
  await selectMode("GitHub 直连");
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(api.setUpdateNetworkSettings).toHaveBeenLastCalledWith({
    mode: "direct",
    customProxyUrl: "https://new.example/prefix/",
  });
});

it("preserves the draft on save failure and permits retry", async () => {
  api.getUpdateNetworkSettings.mockResolvedValue({
    mode: "custom",
    customProxyUrl: "https://old.example/",
  });
  api.setUpdateNetworkSettings.mockRejectedValueOnce(new Error("Write failed"));
  render(<UpdateSettings />);
  const input = await screen.findByRole("textbox", {
    name: "代理 URL 前缀（HTTPS）",
  });
  fireEvent.change(input, { target: { value: "https://new.example/" } });
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Write failed");
  expect(input).toHaveValue("https://new.example/");
  await userEvent.click(screen.getByRole("button", { name: "保存更新设置" }));
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
});

it("retries loading and prevents duplicate saves while one is pending", async () => {
  api.getUpdateNetworkSettings.mockRejectedValueOnce(new Error("Read failed"));
  render(<UpdateSettings />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Read failed");
  await userEvent.click(screen.getByRole("button", { name: "重试" }));
  await selectMode("GH-Proxy");
  let finish!: (value: UpdateNetworkSettings) => void;
  api.setUpdateNetworkSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const button = screen.getByRole("button", { name: "保存更新设置" });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  await userEvent.click(button);
  expect(api.setUpdateNetworkSettings).toHaveBeenCalledTimes(1);
  finish({ mode: "gh-proxy", customProxyUrl: "" });
  expect(await screen.findByRole("status")).toHaveTextContent("已保存");
});
