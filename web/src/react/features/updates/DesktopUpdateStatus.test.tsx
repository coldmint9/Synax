import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopUpdateProvider } from "./DesktopUpdateProvider";
import { DesktopUpdatePanel, DesktopUpdateStatus } from "./DesktopUpdateStatus";
import type { UpdaterState } from "../../../lib/desktop-updates";

const initial: UpdaterState = {
  phase: "idle",
  currentVersion: "0.2.0",
  uiVersion: null,
  availableVersion: null,
  size: 0,
  progress: 0,
  notes: "",
  message: "",
  history: [],
};
const api = {
  getDesktopUpdateState: vi.fn(),
  onDesktopUpdateState: vi.fn(),
  onDesktopUpdateShow: vi.fn(),
  checkDesktopUpdate: vi.fn(),
  installDesktopUpdate: vi.fn(),
};
const offState = vi.fn();
const offShow = vi.fn();
let emitState: (state: UpdaterState) => void;
let show: () => void;
beforeEach(() => {
  vi.resetAllMocks();
  api.getDesktopUpdateState.mockResolvedValue(initial);
  api.onDesktopUpdateState.mockImplementation((callback) => {
    emitState = callback;
    return offState;
  });
  api.onDesktopUpdateShow.mockImplementation((callback) => {
    show = callback;
    return offShow;
  });
  api.checkDesktopUpdate.mockResolvedValue(undefined);
  api.installDesktopUpdate.mockResolvedValue(undefined);
  Object.defineProperty(window, "electronAPI", {
    configurable: true,
    value: api,
  });
});
afterEach(() => {
  Reflect.deleteProperty(window, "electronAPI");
});

function renderUpdates() {
  return render(
    <DesktopUpdateProvider>
      <div data-testid="settings">
        <DesktopUpdateStatus />
      </div>
      <DesktopUpdatePanel />
    </DesktopUpdateProvider>,
  );
}
function update(patch: Partial<UpdaterState>) {
  act(() =>
    emitState({
      ...initial,
      availableVersion: "0.2.1",
      size: 100 * 1024 ** 2,
      ...patch,
    }),
  );
}
it("shows actual differential transfer bytes, local reuse and full-download fallback", async () => {
  renderUpdates();
  await screen.findByText("尚未检查更新");
  update({
    phase: "downloading",
    progress: 0.25,
    transfer: {
      mode: "differential",
      downloadedBytes: 5 * 1024 ** 2,
      downloadSize: 20 * 1024 ** 2,
      reusedBytes: 80 * 1024 ** 2,
    },
  });
  const settings = within(screen.getByTestId("settings"));
  expect(settings.getByText("正在差分下载…")).toBeVisible();
  expect(settings.getByText("5.0 / 20.0 MiB")).toBeVisible();
  expect(settings.getByText("本地复用 80.0 MiB")).toBeVisible();
  update({
    phase: "downloading",
    progress: 0,
    transfer: {
      mode: "full",
      downloadedBytes: 0,
      downloadSize: 100 * 1024 ** 2,
      reusedBytes: 0,
      fallback: true,
    },
  });
  expect(settings.getByText("差分不可用，已改为全量下载")).toBeVisible();
  expect(settings.getByText("0.0 / 100.0 MiB")).toBeVisible();
});

it("shows live progress in both settings and a minimizable panel, without an install action before verification", async () => {
  renderUpdates();
  await screen.findByText("尚未检查更新");
  update({ phase: "downloading", progress: 0.25 });
  const settings = within(screen.getByTestId("settings"));
  const panel = within(screen.getByRole("region", { name: "软件更新进度" }));
  expect(settings.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "25",
  );
  expect(panel.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  expect(settings.getByText("25.0 / 100.0 MiB")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "安装并重启" }),
  ).not.toBeInTheDocument();
  expect(settings.getByRole("button", { name: "检查更新" })).toBeDisabled();
  await userEvent.click(panel.getByRole("button", { name: "收起更新进度" }));
  update({ phase: "downloading", progress: 0.5 });
  expect(panel.getByText("50%")).toBeVisible();
  expect(panel.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(settings.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "50",
  );
  act(() => show());
  expect(panel.getByRole("progressbar")).toBeVisible();
  update({ phase: "downloading", progress: 1 });
  expect(settings.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  expect(
    screen.queryByRole("button", { name: "安装并重启" }),
  ).not.toBeInTheDocument();
  update({ phase: "verifying", progress: 1 });
  expect(settings.getByText("正在校验安装包…")).toBeVisible();
  expect(settings.getByRole("progressbar")).not.toHaveAttribute(
    "aria-valuenow",
  );
  expect(
    screen.queryByRole("button", { name: "安装并重启" }),
  ).not.toBeInTheDocument();
  update({ phase: "ready", progress: 1 });
  expect(settings.getByText("安装包已缓存并校验")).toBeVisible();
  await userEvent.click(settings.getByRole("button", { name: "安装并重启" }));
  expect(api.installDesktopUpdate).toHaveBeenCalledOnce();
});

it("restores a ready cache in the first snapshot without checking or downloading", async () => {
  api.getDesktopUpdateState.mockResolvedValue({
    ...initial,
    phase: "ready",
    availableVersion: "0.2.1",
    progress: 1,
  });
  renderUpdates();
  const settings = within(screen.getByTestId("settings"));
  expect(
    await settings.findByRole("button", { name: "安装并重启" }),
  ).toBeEnabled();
  expect(api.checkDesktopUpdate).not.toHaveBeenCalled();
  expect(api.installDesktopUpdate).not.toHaveBeenCalled();
});

it("ignores a stale initial snapshot and unsubscribes both channels on unmount", async () => {
  let resolve!: (state: UpdaterState) => void;
  api.getDesktopUpdateState.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = renderUpdates();
  update({ phase: "downloading", progress: 0.6 });
  await act(async () => {
    resolve(initial);
  });
  expect(
    within(screen.getByTestId("settings")).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "60");
  view.unmount();
  expect(offState).toHaveBeenCalledOnce();
  expect(offShow).toHaveBeenCalledOnce();
});

it("reports a failed download and permits a retry but never an installation", async () => {
  renderUpdates();
  await screen.findByText("尚未检查更新");
  update({ phase: "error", progress: 1, message: "checksum mismatch" });
  const settings = within(screen.getByTestId("settings"));
  expect(settings.getByRole("alert")).toHaveTextContent("checksum mismatch");
  expect(
    screen.queryByRole("button", { name: "安装并重启" }),
  ).not.toBeInTheDocument();
  await userEvent.click(settings.getByRole("button", { name: "重试" }));
  expect(api.checkDesktopUpdate).toHaveBeenCalledOnce();
});

it("disables installation while native confirmation is pending and reports IPC errors", async () => {
  let reject!: (error: Error) => void;
  api.installDesktopUpdate.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  api.getDesktopUpdateState.mockResolvedValue({
    ...initial,
    phase: "ready",
    availableVersion: "0.2.1",
    progress: 1,
  });
  renderUpdates();
  const settings = within(screen.getByTestId("settings"));
  const button = await settings.findByRole("button", { name: "安装并重启" });
  await userEvent.click(button);
  expect(button).toBeDisabled();
  await userEvent.click(button);
  expect(api.installDesktopUpdate).toHaveBeenCalledOnce();
  await act(async () => reject(new Error("Installation unavailable")));
  expect(settings.getByRole("alert")).toHaveTextContent(
    "Installation unavailable",
  );
  expect(button).toBeEnabled();
});

it("does not expose updater controls outside a supported desktop build", async () => {
  api.getDesktopUpdateState.mockResolvedValue(null);
  const view = renderUpdates();
  await act(async () => {});
  expect(screen.getByTestId("settings")).toBeEmptyDOMElement();
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
  view.unmount();
  Reflect.deleteProperty(window, "electronAPI");
  renderUpdates();
  expect(screen.getByTestId("settings")).toBeEmptyDOMElement();
});
