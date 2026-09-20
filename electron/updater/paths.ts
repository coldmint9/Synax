import path from "node:path";
export function updaterExecutable(
  root: string,
  platform = process.platform,
): string {
  return platform === "darwin"
    ? path.join(root, "Synax Updater.app/Contents/MacOS/Synax Updater")
    : path.join(root, "Synax Updater.exe");
}
