import { afterEach, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/unused-synax-profile", getVersion: () => "0.2.0" },
  dialog: { showMessageBox: vi.fn() },
}));
vi.mock("original-fs", () => ({ promises: {} }));
vi.mock("./mac-desktop-update.js", () => ({ finishMacInstallation: vi.fn() }));

import { DesktopUpdates } from "./desktop-updates.js";
import { ONLINE_UPDATES_DISABLED_MESSAGE } from "../updater/update-policy.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("never schedules checks or shows update notifications at startup", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const window = {
    isDestroyed: () => false, setProgressBar: vi.fn(),
    webContents: { isDestroyed: () => false, send: vi.fn() },
  };
  const updates = new DesktopUpdates(() => null);
  updates.start(window as any);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  await updates.check(false);
  await updates.check(true);
  await updates.markHealthy();
  await expect(updates.install()).rejects.toThrow(ONLINE_UPDATES_DISABLED_MESSAGE);
  expect(window.webContents.send).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  updates.stop();
});
