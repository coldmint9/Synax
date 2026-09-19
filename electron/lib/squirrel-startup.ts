import { spawn } from "node:child_process";
import { win32 as path } from "node:path";
import { app } from "electron";

/** Squirrel launches the app during installation; never start the API in that process. */
export function handleSquirrelEvent(): boolean {
  if (process.platform !== "win32") return false;
  const event = process.argv[1];
  if (event === "--squirrel-obsolete") {
    app.quit();
    return true;
  }
  const operation =
    event === "--squirrel-install" || event === "--squirrel-updated"
      ? "--createShortcut"
      : event === "--squirrel-uninstall"
        ? "--removeShortcut"
        : null;
  if (!operation) return false;

  const update = path.resolve(
    path.dirname(process.execPath),
    "..",
    "Update.exe",
  );
  const child = spawn(update, [operation, path.basename(process.execPath)], {
    windowsHide: true,
    stdio: "ignore",
  });
  const timer = setTimeout(() => app.quit(), 10_000);
  const finish = () => {
    clearTimeout(timer);
    app.quit();
  };
  child.once("close", finish);
  child.once("error", (error) => {
    console.error("[installer]", error.message);
    finish();
  });
  return true;
}
