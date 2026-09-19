import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  find: vi.fn(), show: vi.fn(), relaunch: vi.fn(), quit: vi.fn(),
  store: {
    initialize: vi.fn(), markHealthy: vi.fn(), rollback: vi.fn(), prepare: vi.fn(),
    root: "/bundled", currentVersion: null as string | null,
    pendingVersion: null as string | null, rejected: [] as string[],
  },
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/home", getAppPath: () => "/app", isPackaged: false, getVersion: () => "0.1.2", relaunch: mocks.relaunch, quit: mocks.quit },
  dialog: { showMessageBox: mocks.show },
}));
vi.mock("./ui-update-feed.js", () => ({ findUiRelease: mocks.find }));
vi.mock("./ui-update-store.js", () => ({ UiUpdateStore: class { constructor() { return mocks.store; } } }));
import { UiUpdates } from "./ui-updates.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.pendingVersion = null;
  mocks.find.mockResolvedValue(null);
  mocks.show.mockResolvedValue({ response: 0 });
});

describe("desktop UI update interaction", () => {
  it("reports no compatible updates only on manual checks", async () => {
    const updates = new UiUpdates();
    await updates.check(false);
    expect(mocks.show).not.toHaveBeenCalled();
    await updates.check(true);
    expect(mocks.show.mock.lastCall?.[0].message).toContain("最新");
  });

  it("reports network failures only on manual checks", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.find.mockRejectedValue(new Error("offline"));
    const updates = new UiUpdates();
    await updates.check(false);
    expect(mocks.show).not.toHaveBeenCalled();
    await updates.check(true);
    expect(mocks.show.mock.lastCall?.[0].detail).toBe("offline");
    log.mockRestore();
  });

  it("waits for confirmation after staging and never restarts when deferred", async () => {
    mocks.find.mockResolvedValue({ manifest: { version: "1.0.0" } });
    const updates = new UiUpdates();
    await updates.check(false);
    expect(mocks.store.prepare).toHaveBeenCalledOnce();
    expect(mocks.relaunch).not.toHaveBeenCalled();
    mocks.store.pendingVersion = "1.0.0";
    mocks.show.mockResolvedValueOnce({ response: 1 });
    await updates.check(true);
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
