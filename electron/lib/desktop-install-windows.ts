// Squirrel cannot replace a running Synax.exe. The main process therefore hands
// the swap to a detached helper that reuses the same Electron binary in Node
// mode, waits for the host to exit, then runs the installation's own Update.exe.
// Nothing extra is shipped in the package for this.

export interface WindowsInstallation {
  format: 1;
  parentPid: number;
  updateExe: string;
  directory: string;
  executable: string;
  profile: string;
  marker: string;
  log: string;
}

export function validateWindowsInstallation(
  value: unknown,
): WindowsInstallation {
  const data = value as WindowsInstallation;
  if (
    !data ||
    data.format !== 1 ||
    !Number.isSafeInteger(data.parentPid) ||
    data.parentPid <= 0 ||
    typeof data.updateExe !== "string" ||
    typeof data.directory !== "string" ||
    typeof data.executable !== "string" ||
    typeof data.profile !== "string" ||
    typeof data.marker !== "string" ||
    typeof data.log !== "string"
  )
    throw new Error("Invalid desktop installation request");
  return data;
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs as `Synax --synax-install-windows=<file>` with ELECTRON_RUN_AS_NODE=1, so
// a second application instance is never started and no window is ever shown.
export async function runWindowsInstallation(
  file: string,
): Promise<number> {
  const fs = await import("node:fs/promises");
  const { execFile, spawn } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const log = await fs.open(file.replace(/\.json$/, ".log"), "a", 0o600);
  const note = (message: string) => {
    void log.write(`${new Date().toISOString()} ${message}\n`);
  };
  try {
    const request = validateWindowsInstallation(
      JSON.parse(await fs.readFile(file, "utf8")),
    );
    const deadline = Date.now() + 120_000;
    while (processRunning(request.parentPid)) {
      if (Date.now() > deadline) {
        note("Synax 尚未退出，安装已取消。");
        return 1;
      }
      await delay(250);
    }
    note("正在安装新版本…");
    await run(request.updateExe, ["--update", request.directory], {
      timeout: 15 * 60_000,
      windowsHide: true,
    });
    note("正在重新启动 Synax…");
    await fs.writeFile(
      request.marker,
      JSON.stringify({
        version: JSON.parse(await fs.readFile(file, "utf8")).version,
        installRoot: request.directory,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      request.updateExe,
      [
        "--processStart",
        request.executable.split(/[\\/]/).pop()!,
        "--process-start-args",
        `--user-data-dir="${request.profile}"`,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    note("安装完成。");
    return 0;
  } catch (error) {
    note(`安装失败：${error instanceof Error ? error.message : error}`);
    return 1;
  } finally {
    await log.close();
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

export function windowsInstallArgument(argv: string[]): string | null {
  const prefix = "--synax-install-windows=";
  const entry = argv.find((value) => value.startsWith(prefix));
  return entry ? entry.slice(prefix.length) : null;
}
