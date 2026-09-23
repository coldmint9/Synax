import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export interface ClipboardCommand {
  bin: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

/** Use native file references, never plain path text masquerading as a copied file. */
export function fileClipboardCommands(filePath: string, platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [{
    bin: "/usr/bin/osascript",
    args: ["-e", "on run argv", "-e", "set the clipboard to (POSIX file (item 1 of argv))", "-e", "end run", filePath],
  }];
  if (platform === "win32") return [{
    bin: "powershell.exe",
    args: ["-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; [void]$files.Add($env:SYNAX_FILE_TO_COPY); [System.Windows.Forms.Clipboard]::SetFileDropList($files)"],
    env: { SYNAX_FILE_TO_COPY: filePath },
  }];
  const input = `${pathToFileURL(filePath).href}\r\n`;
  return [
    { bin: "wl-copy", args: ["--type", "text/uri-list"], input },
    { bin: "xclip", args: ["-selection", "clipboard", "-t", "text/uri-list", "-i"], input },
  ];
}

function run(command: ClipboardCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      env: command.env ? { ...process.env, ...command.env } : process.env,
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let errorText = "";
    child.stderr.on("data", (chunk: Buffer) => { errorText += chunk.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(errorText || `Clipboard helper exited with ${code}`)));
    child.stdin.end(command.input ?? "");
  });
}

export async function copyFileToSystemClipboard(filePath: string): Promise<void> {
  let failure: unknown;
  for (const command of fileClipboardCommands(filePath)) {
    try { await run(command); return; }
    catch (error) { failure = error; }
  }
  throw failure ?? new Error("System file clipboard is unavailable.");
}
