import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export interface FileOpener {
  id: string;
  name: string;
  icon: string | null;
}
interface InstalledOpener extends FileOpener {
  appPath: string;
  cli?: string;
  kind: "editor" | "finder" | "terminal";
}
const candidates = [
  {
    id: "vscode",
    name: "VS Code",
    apps: ["Visual Studio Code.app"],
    bin: "code",
    bundled: "Contents/Resources/app/bin/code",
  },
  {
    id: "cursor",
    name: "Cursor",
    apps: ["Cursor.app"],
    bin: "cursor",
    bundled: "Contents/Resources/app/bin/cursor",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    apps: ["Windsurf.app"],
    bin: "windsurf",
    bundled: "Contents/Resources/app/bin/windsurf",
  },
  {
    id: "zed",
    name: "Zed",
    apps: ["Zed.app"],
    bin: "zed",
    bundled: "Contents/MacOS/cli",
  },
  {
    id: "xcode",
    name: "Xcode",
    apps: ["Xcode.app", "Xcode-beta.app"],
    bin: "xed",
    bundled: "Contents/Developer/usr/bin/xed",
  },
  {
    id: "idea",
    name: "IntelliJ IDEA",
    apps: ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"],
    bin: "idea",
    bundled: "Contents/MacOS/idea",
  },
  {
    id: "webstorm",
    name: "WebStorm",
    apps: ["WebStorm.app"],
    bin: "webstorm",
    bundled: "Contents/MacOS/webstorm",
  },
  {
    id: "pycharm",
    name: "PyCharm",
    apps: ["PyCharm.app", "PyCharm CE.app"],
    bin: "pycharm",
    bundled: "Contents/MacOS/pycharm",
  },
  {
    id: "sublime",
    name: "Sublime Text",
    apps: ["Sublime Text.app"],
    bin: "subl",
    bundled: "Contents/SharedSupport/bin/subl",
  },
];

async function nativeIcon(appPath: string): Promise<string | null> {
  let temp: string | undefined;
  try {
    const resources = path.join(appPath, "Contents/Resources");
    const { stdout } = await run(
      "/usr/libexec/PlistBuddy",
      [
        "-c",
        "Print :CFBundleIconFile",
        path.join(appPath, "Contents/Info.plist"),
      ],
      { timeout: 3000 },
    );
    const name = path.basename(stdout.trim());
    let source = path.join(
      resources,
      name.endsWith(".icns") ? name : `${name}.icns`,
    );
    if (!existsSync(source)) {
      const names = await readdir(resources);
      const match = names.find(
        (entry) =>
          entry.toLowerCase() ===
          `${name.replace(/\.icns$/i, "")}.icns`.toLowerCase(),
      );
      if (!match) return null;
      source = path.join(resources, match);
    }
    temp = await mkdtemp(path.join(tmpdir(), "synax-app-icon-"));
    const output = path.join(temp, "icon.png");
    await run(
      "/usr/bin/sips",
      ["-s", "format", "png", "-Z", "64", source, "--out", output],
      { timeout: 5000 },
    );
    return `data:image/png;base64,${(await readFile(output)).toString("base64")}`;
  } catch {
    return null;
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}

let cached: { until: number; apps: InstalledOpener[] } | undefined;
let pending: Promise<InstalledOpener[]> | undefined;
export async function installedOpeners(): Promise<InstalledOpener[]> {
  if (cached && cached.until > Date.now()) return cached.apps;
  if (pending) return pending;
  pending = (async () => {
    const apps: InstalledOpener[] = [];
    if (process.platform === "darwin") {
      const roots = ["/Applications", path.join(homedir(), "Applications")];
      for (const candidate of candidates) {
        const appPath = roots
          .flatMap((root) =>
            candidate.apps.map((name) => path.join(root, name)),
          )
          .find(existsSync);
        if (!appPath) continue;
        const cli = candidate.bundled
          ? path.join(appPath, candidate.bundled)
          : undefined;
        apps.push({
          id: candidate.id,
          name: candidate.name,
          appPath,
          kind: "editor",
          cli: cli && existsSync(cli) ? cli : undefined,
          icon: await nativeIcon(appPath),
        });
      }
      for (const entry of [
        {
          id: "finder",
          name: "Finder",
          appPath: "/System/Library/CoreServices/Finder.app",
          kind: "finder" as const,
        },
        {
          id: "terminal",
          name: "Terminal",
          appPath: "/System/Applications/Utilities/Terminal.app",
          kind: "terminal" as const,
        },
      ])
        if (existsSync(entry.appPath))
          apps.push({ ...entry, icon: await nativeIcon(entry.appPath) });
    } else {
      // Only advertise launchers found on this host; never send client executables to a shell.
      for (const candidate of candidates) {
        try {
          const { stdout } = await run(
            process.platform === "win32" ? "where.exe" : "which",
            [candidate.bin],
            { timeout: 2000, windowsHide: true },
          );
          const cli = stdout.trim().split(/\r?\n/)[0];
          if (cli && !/\.(cmd|bat)$/i.test(cli))
            apps.push({
              id: candidate.id,
              name: candidate.name,
              appPath: cli,
              cli,
              kind: "editor",
              icon: null,
            });
        } catch {
          /* Not installed. */
        }
      }
    }
    cached = { until: Date.now() + 30_000, apps };
    return apps;
  })();
  try {
    return await pending;
  } finally {
    pending = undefined;
  }
}

export async function listFileOpeners(): Promise<FileOpener[]> {
  const apps = await installedOpeners();
  return [
    {
      id: "system",
      name: "System default",
      icon: apps.find((app) => app.id === "finder")?.icon ?? null,
    },
    ...apps.map(({ id, name, icon }) => ({ id, name, icon })),
  ];
}

export function openerCommand(
  filePath: string,
  line: number | undefined,
  app?: InstalledOpener,
  platform = process.platform,
  directory = false,
): { bin: string; args: string[] } {
  if (!app) {
    if (platform === "darwin")
      return { bin: "/usr/bin/open", args: [filePath] };
    if (platform === "win32") return { bin: "explorer.exe", args: [filePath] };
    return { bin: "xdg-open", args: [filePath] };
  }
  if (app.kind === "finder")
    return {
      bin: "/usr/bin/open",
      args: directory ? ["-a", app.appPath, filePath] : ["-R", filePath],
    };
  if (app.kind === "terminal")
    return {
      bin: "/usr/bin/open",
      args: ["-a", app.appPath, directory ? filePath : path.dirname(filePath)],
    };
  // LaunchServices returns after dispatch; executing a JetBrains GUI binary
  // directly can leave the HTTP request waiting until the IDE exits.
  if (
    platform === "darwin" &&
    ["idea", "webstorm", "pycharm"].includes(app.id)
  ) {
    return {
      bin: "/usr/bin/open",
      args: [
        "-na",
        app.appPath,
        "--args",
        ...(!directory && line ? ["--line", String(line)] : []),
        filePath,
      ],
    };
  }
  if (app.cli) {
    if (!directory && line) {
      if (["vscode", "cursor", "windsurf"].includes(app.id))
        return { bin: app.cli, args: ["--goto", `${filePath}:${line}`] };
      if (["idea", "webstorm", "pycharm", "xcode"].includes(app.id))
        return { bin: app.cli, args: ["--line", String(line), filePath] };
      if (["zed", "sublime"].includes(app.id))
        return { bin: app.cli, args: [`${filePath}:${line}`] };
    }
    return { bin: app.cli, args: [filePath] };
  }
  return { bin: "/usr/bin/open", args: ["-a", app.appPath, filePath] };
}

export async function resolveFileOpener(
  filePath: string,
  line?: number,
  id = "system",
) {
  const directory = (await stat(filePath)).isDirectory();
  if (id === "system")
    return {
      command: openerCommand(
        filePath,
        line,
        undefined,
        process.platform,
        directory,
      ),
      fallback: false,
    };
  const app = (await installedOpeners()).find(
    (item) => item.id === id && existsSync(item.appPath),
  );
  return {
    command: openerCommand(filePath, line, app, process.platform, directory),
    fallback: !app,
  };
}

/** Opens a host terminal at the file's directory, without interpolating a shell command. */
export function systemTerminalCommand(directory: string, platform = process.platform): { bin: string; args: string[]; cwd: string } {
  if (platform === "darwin") return { bin: "/usr/bin/open", args: ["-a", "Terminal", directory], cwd: directory };
  if (platform === "win32") return { bin: "cmd.exe", args: ["/K"], cwd: directory };
  return { bin: "x-terminal-emulator", args: [], cwd: directory };
}

export async function openSystemTerminal(directory: string): Promise<void> {
  const options = systemTerminalCommand(directory);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
