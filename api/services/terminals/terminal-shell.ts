import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function systemTerminalShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || os.userInfo().shell || "/bin/sh";
}

export function validateTerminalShellPath(value: string): void {
  if (!value) return;
  if (!path.isAbsolute(value) || /[\r\n\0]/.test(value)) {
    throw new Error(
      "终端路径必须是可执行文件的绝对路径 / Use an absolute executable path.",
    );
  }
  try {
    if (!fs.statSync(value).isFile()) throw new Error("Not a file");
    fs.accessSync(
      value,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
  } catch {
    throw new Error(
      "终端文件不存在或不可执行 / Terminal file does not exist or is not executable.",
    );
  }
}
