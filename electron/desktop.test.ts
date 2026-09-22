import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    name: "Synax",
    isPackaged: false,
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn(() => "/test-home"),
    quit: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  },
  utilityProcess: { fork: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
const spawn = vi.hoisted(() => vi.fn());
vi.mock("electron", () => electron);
vi.mock("node:child_process", () => ({
  spawn,
  execFile: vi.fn((_file, _args, _options, callback) =>
    callback(null, "\0/usr/bin:/bin\0", ""),
  ),
}));

import { buildAppMenu, setUiUpdateAction, updateMenuState } from "./menu.js";
import { handleSquirrelEvent } from "./lib/squirrel-startup.js";
import {
  startSidecar,
  stopSidecar,
  getSidecarPort,
} from "./lib/node-sidecar.js";
import { spawnProcess, waitForExit } from "../scripts/_shared.js";
import forgeConfig from "../forge.config.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const execPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
const argv = process.argv;
const resourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
const child = () =>
  Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });

beforeEach(() => {
  vi.clearAllMocks();
  const readyChild = () => {
    const proc = child();
    queueMicrotask(() => proc.stdout.write("SYNAX_DESKTOP_READY:49152\n"));
    return proc;
  };
  spawn.mockImplementation(readyChild);
  electron.utilityProcess.fork.mockImplementation(readyChild);
  electron.app.isPackaged = false;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});
afterEach(() => {
  stopSidecar();
  Object.defineProperty(process, "platform", platform);
  Object.defineProperty(process, "execPath", execPath);
  if (resourcesPath)
    Object.defineProperty(process, "resourcesPath", resourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
  process.argv = argv;
  vi.unstubAllGlobals();
});

function onPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value });
}

function menuRoles(items: any[]): string[] {
  return items
    .flatMap((item) => [item.role, ...menuRoles(item.submenu ?? [])])
    .filter(Boolean);
}

function flattenMenuLabels(items: any[]): string[] {
  return items.flatMap((item) => [
    item.label,
    ...flattenMenuLabels(item.submenu ?? []),
  ]);
}

describe("desktop UI update menu", () => {
  it.each(["darwin", "win32"] as const)(
    "exposes a manual check on packaged %s",
    (platformName) => {
      onPlatform(platformName);
      electron.app.isPackaged = true;
      const check = vi.fn();
      setUiUpdateAction(check);
      const items = electron.Menu.buildFromTemplate.mock.lastCall![0] as any[];
      const help = items.find((item) => item.label === "帮助");
      const command = help.submenu.find(
        (item: any) => item.id === "ui:check-updates",
      );
      expect(command).toBeTruthy();
      command.click();
      expect(check).toHaveBeenCalledOnce();
      setUiUpdateAction(null);
    },
  );
});

describe("desktop platform contract", () => {
  it.each(["darwin", "win32"] as const)("uses native menus on %s", (target) => {
    onPlatform(target);
    buildAppMenu();
    const items = electron.Menu.buildFromTemplate.mock.lastCall![0] as any[];
    expect(items[0].label).toBe(target === "darwin" ? "Synax" : "文件");
    const roles = menuRoles(items);
    const labels = flattenMenuLabels(items);
    expect(labels).toContain("关于 Synax");
    expect(roles).toContain("quit");
    for (const role of ["services", "hide", "hideOthers", "unhide", "front"]) {
      expect(roles.includes(role)).toBe(target === "darwin");
    }
    const views = items.find((item) => item.label === "视图").submenu;
    expect(views.map((item: any) => item.label)).not.toContain("Work");
    expect(views.map((item: any) => item.label)).not.toContain("Wiki");
    expect(views.map((item: any) => item.label)).not.toContain("Coordinates");
  });

  it.each([
    ["--squirrel-install", "--createShortcut"],
    ["--squirrel-updated", "--createShortcut"],
    ["--squirrel-uninstall", "--removeShortcut"],
  ])("handles %s without booting the app", (event, operation) => {
    onPlatform("win32");
    Object.defineProperty(process, "execPath", {
      value: "C:\\Users\\User Name\\Synax\\app-0.1.2\\Synax.exe",
    });
    process.argv = [process.execPath, event];
    expect(handleSquirrelEvent()).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Users\\User Name\\Synax\\Update.exe",
      [operation, "Synax.exe"],
      expect.objectContaining({ windowsHide: true }),
    );
    expect(electron.app.quit).not.toHaveBeenCalled();
    spawn.mock.results[0].value.emit("close", 0);
    expect(electron.app.quit).toHaveBeenCalledOnce();
  });

  it("exits obsolete installers but allows normal first runs and non-Windows launches", () => {
    onPlatform("win32");
    process.argv = [process.execPath, "--squirrel-obsolete"];
    expect(handleSquirrelEvent()).toBe(true);
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(spawn).not.toHaveBeenCalled();
    process.argv = [process.execPath, "--squirrel-firstrun"];
    expect(handleSquirrelEvent()).toBe(false);
    onPlatform("darwin");
    process.argv = [process.execPath, "--squirrel-install"];
    expect(handleSquirrelEvent()).toBe(false);
  });

  it("runs the development sidecar without npx or a platform-specific shell", async () => {
    await startSidecar();
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringMatching(/tsx.*cli\.mjs$/),
        expect.stringMatching(/server\.ts$/),
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          ELECTRON_RUN_AS_NODE: "1",
          PORT: "0",
          SYNAX_DESKTOP_SIDECAR: "1",
        }),
      }),
    );
    stopSidecar();
    expect(spawn.mock.results[0].value.kill).toHaveBeenCalledOnce();
  });

  it("uses Electron utilityProcess for the installed backend", async () => {
    electron.app.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/test resources",
      configurable: true,
    });
    await startSidecar();
    expect(spawn).not.toHaveBeenCalled();
    expect(electron.utilityProcess.fork).toHaveBeenCalledWith(
      expect.stringContaining("server.cjs"),
      [],
      expect.objectContaining({ cwd: "/test resources" }),
    );
  });

  it("shares concurrent startup and waits for the bound port, including split output", async () => {
    const proc = child();
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        proc.stdout.write(
          "ordinary log\nSYNAX_DESKTOP_READY:0\nSYNAX_DESKTOP_READY:99999\n",
        );
        proc.stdout.write("SYNAX_DESKTOP_");
        proc.stdout.write("READY:54321\n");
      });
      return proc;
    });
    const first = startSidecar();
    expect(startSidecar()).toBe(first);
    expect(await first).toBe(54321);
    expect(getSidecarPort()).toBe(54321);
    expect(spawn).toHaveBeenCalledOnce();
    proc.emit("exit", 0);
    expect(getSidecarPort()).toBe(0);
  });

  it("can retry after the backend exits before announcing its port", async () => {
    spawn.mockImplementationOnce(() => {
      const proc = child();
      queueMicrotask(() => proc.emit("exit", 1));
      return proc;
    });
    await expect(startSidecar()).rejects.toThrow("exited with code 1");
    expect(await startSidecar()).toBe(49152);
  });

  it("times out a backend that never announces readiness and permits retry", async () => {
    vi.useFakeTimers();
    const proc = child();
    spawn.mockImplementationOnce(() => proc);
    try {
      const starting = startSidecar();
      const rejected = expect(starting).rejects.toThrow("startup timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await rejected;
      expect(proc.kill).toHaveBeenCalledOnce();
      expect(getSidecarPort()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(await startSidecar()).toBe(49152);
  });

  it("rejects a broken sidecar immediately and cleans it up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const failed = child();
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => failed.emit("error", new Error("spawn failed")));
      return failed;
    });
    await expect(startSidecar()).rejects.toThrow("spawn failed");
    expect(failed.kill).toHaveBeenCalledOnce();
  });

  it("launches Windows npm wrappers through the platform-aware helper and reports errors", async () => {
    onPlatform("win32");
    const proc = spawnProcess(
      ["npx", "electronmon", "."],
      "C:\\Project Files\\Synax",
    );
    expect(spawn).toHaveBeenCalledWith(
      "npx",
      ["electronmon", "."],
      expect.objectContaining({ shell: true, cwd: "C:\\Project Files\\Synax" }),
    );
    const done = waitForExit(proc);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    proc.emit("error", new Error("not installed"));
    expect(await done).toBe(1);
    log.mockRestore();
  });

  it("unsubscribes native menu callbacks instead of accumulating them on navigation", () => {
    const ipc = new EventEmitter();
    let api: any;
    const source = readFileSync(
      new URL("./preload.ts", import.meta.url),
      "utf8",
    );
    runInNewContext(transpileModule(source, {}).outputText, {
      process: { platform: "win32" },
      require: () => ({
        ipcRenderer: ipc,
        contextBridge: {
          exposeInMainWorld: (_name: string, value: unknown) => {
            api = value;
          },
        },
      }),
    });
    expect(api.platform).toBe("win32");
    expect(api).not.toHaveProperty("appearance");
    for (const [method, event] of [
      ["onMenuNavigate", "menu:navigate"],
      ["onMenuAction", "menu:action"],
    ]) {
      const listener = vi.fn();
      const off = api[method](listener);
      ipc.emit(event, {}, "value");
      expect(listener).toHaveBeenCalledWith("value");
      off();
      ipc.emit(event, {}, "value");
      expect(listener).toHaveBeenCalledOnce();
      expect(ipc.listenerCount(event)).toBe(0);
    }
  });

  it("exposes bounded notification IPC and subscribes before announcing renderer readiness", async () => {
    const ipc = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      invoke: vi.fn(async () => true),
    });
    let api: any;
    runInNewContext(
      transpileModule(
        readFileSync(new URL("./preload.ts", import.meta.url), "utf8"),
        {},
      ).outputText,
      {
        process: { platform: "darwin" },
        require: () => ({
          ipcRenderer: ipc,
          contextBridge: {
            exposeInMainWorld: (_name: string, value: unknown) => {
              api = value;
            },
          },
        }),
      },
    );
    const target = { projectId: "p", sessionId: "s", kind: "input" };
    const callback = vi.fn();
    ipc.send.mockImplementation((channel, ready) => {
      if (channel === "notifications:renderer-ready" && ready)
        ipc.emit("notifications:open-session", {}, target);
    });
    const off = api.onDesktopNotificationOpen(callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(target);
    api.setDesktopNotificationsEnabled(false);
    api.dismissDesktopNotification("s");
    await api.showDesktopNotification({
      ...target,
      id: "e",
      title: "Title",
      body: "Question",
    });
    expect(ipc.send).toHaveBeenCalledWith("notifications:enabled", false);
    expect(ipc.send).toHaveBeenCalledWith("notifications:dismiss", "s");
    expect(ipc.invoke).toHaveBeenCalledWith(
      "notifications:show",
      expect.objectContaining(target),
    );
    await api.getUpdateNetworkSettings();
    expect(ipc.invoke).toHaveBeenCalledWith("updates:get-network");
    const updateSettings = {
      mode: "custom",
      customProxyUrl: "https://proxy.example/",
    };
    await api.setUpdateNetworkSettings(updateSettings);
    expect(ipc.invoke).toHaveBeenCalledWith(
      "updates:set-network",
      updateSettings,
    );
    await api.getDesktopUpdateState();
    await api.checkDesktopUpdate();
    await api.installDesktopUpdate();
    expect(ipc.invoke).toHaveBeenCalledWith("updates:state");
    expect(ipc.invoke).toHaveBeenCalledWith("updates:check");
    expect(ipc.invoke).toHaveBeenCalledWith("updates:install");
    const progress = vi.fn();
    const show = vi.fn();
    const offProgress = api.onDesktopUpdateState(progress);
    const offShow = api.onDesktopUpdateShow(show);
    const state = { phase: "downloading", progress: 0.5 };
    ipc.emit("updates:state", {}, state);
    ipc.emit("updates:show", {});
    expect(progress).toHaveBeenCalledExactlyOnceWith(state);
    expect(show).toHaveBeenCalledOnce();
    offProgress();
    offShow();
    ipc.emit("updates:state", {}, state);
    ipc.emit("updates:show", {});
    expect(progress).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    expect(ipc.listenerCount("updates:state")).toBe(0);
    expect(ipc.listenerCount("updates:show")).toBe(0);
    off();
    expect(ipc.listenerCount("notifications:open-session")).toBe(0);
    expect(ipc.send).toHaveBeenLastCalledWith(
      "notifications:renderer-ready",
      false,
    );
  });

  it("rejects cross-platform packages containing the host native modules", async () => {
    const prePackage = forgeConfig.hooks!.prePackage as (
      ...args: any[]
    ) => Promise<void>;
    await expect(
      prePackage({}, process.platform, process.arch),
    ).resolves.toBeUndefined();
    const other = process.platform === "win32" ? "darwin" : "win32";
    await expect(prePackage({}, other, process.arch)).rejects.toThrow(
      "Native dependencies",
    );
    await expect(
      prePackage(
        {},
        process.platform,
        process.arch === "arm64" ? "x64" : "arm64",
      ),
    ).rejects.toThrow("Native dependencies");
  });
});

it("keeps desktop commands contextual and uses the import dialog instead of a fake project route", () => {
  updateMenuState({
    projectId: null,
    hasSession: false,
    hasViewer: false,
    inWork: false,
    inWiki: false,
    dark: false,
  });
  const get = (id: string): any => {
    const flatten = (items: any[]): any[] =>
      items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
    return flatten(
      electron.Menu.buildFromTemplate.mock.lastCall![0] as any[],
    ).find((item) => item.id === id);
  };
  expect(get("session:new").enabled).toBe(false);
  expect(get("view:conversation").enabled).toBe(false);
  expect(get("project:import").accelerator).toBe("CmdOrCtrl+O");
  updateMenuState({
    projectId: "p",
    hasSession: true,
    hasViewer: true,
    inWork: true,
    inWiki: false,
    dark: true,
  });
  expect(get("session:new").enabled).toBe(true);
  expect(get("view:conversation").enabled).toBe(true);
  expect(get("workspace:refresh").enabled).toBe(true);
  expect(get("theme:toggle").checked).toBe(true);
});
