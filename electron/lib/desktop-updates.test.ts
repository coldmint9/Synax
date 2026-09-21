import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: "/tmp/synax-desktop-updates",
  version: "0.1.2",
  dialog: vi.fn(),
  quit: vi.fn(),
  controller: {
    state: {
      phase: "current",
      currentVersion: "0.1.2",
      uiVersion: null,
      availableVersion: null,
      size: 0,
      progress: 0,
      notes: "",
      message: "",
      history: [],
    },
    initialize: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
  },
  controllerConstructor: vi.fn(function MockController() {
    return mocks.controller;
  }),
}));

vi.mock("original-fs", () => ({
  promises: {
    readFile: vi.fn(),
    rm: vi.fn(),
  },
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => mocks.profile,
    getVersion: () => mocks.version,
    quit: mocks.quit,
  },
  dialog: { showMessageBox: mocks.dialog },
}));
vi.mock("../updater/controller.js", () => ({
  UpdaterController: mocks.controllerConstructor,
}));
vi.mock("./mac-desktop-update.js", () => ({
  finishMacInstallation: vi.fn().mockResolvedValue(undefined),
}));

import { DesktopUpdates } from "./desktop-updates.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.controller.state.phase = "current";
  mocks.controller.state.availableVersion = null;
  mocks.controller.state.message = "";
  mocks.controller.check.mockImplementation(async () => {});
  mocks.controller.download.mockImplementation(async () => {});
  mocks.controller.install.mockImplementation(async () => {});
  mocks.dialog.mockResolvedValue({ response: 0 });
});

describe("main-process desktop updates", () => {
  it("checks and downloads silently before asking with a native dialog", async () => {
    mocks.controller.check.mockImplementation(async () => {
      mocks.controller.state.phase = "available";
      mocks.controller.state.availableVersion = "0.2.0";
    });
    mocks.controller.download.mockImplementation(async () => {
      mocks.controller.state.phase = "ready";
    });
    const updates = new DesktopUpdates(() => null);

    await updates.check(false);

    expect(mocks.controller.initialize).toHaveBeenCalledOnce();
    expect(mocks.controller.download).toHaveBeenCalledOnce();
    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "question",
        message: expect.stringContaining("0.2.0"),
      }),
    );
  });

  it("reports that a manual check is current without launching another app", async () => {
    const updates = new DesktopUpdates(() => null);

    await updates.check(true);

    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        message: "当前已是最新版本。",
      }),
    );
    expect(mocks.controller.install).not.toHaveBeenCalled();
  });

  it("installs only after the user confirms the native prompt", async () => {
    mocks.controller.check.mockImplementation(async () => {
      mocks.controller.state.phase = "ready";
      mocks.controller.state.availableVersion = "0.2.0";
    });
    mocks.dialog.mockResolvedValue({ response: 1 });
    const updates = new DesktopUpdates(() => null);

    await updates.check(true);

    expect(mocks.controller.install).toHaveBeenCalledOnce();
    const quitHost = mocks.controllerConstructor.mock
      .calls[0][3] as () => Promise<void>;
    quitHost();
    expect(mocks.quit).toHaveBeenCalledOnce();
  });
});
