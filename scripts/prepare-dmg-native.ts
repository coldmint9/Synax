import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const DMG_NATIVE_MODULES = ["macos-alias", "fs-xattr"] as const;

export type DmgNativeOptions = {
  platform?: NodeJS.Platform;
  loadModule?: (name: string) => unknown;
  rebuild?: (name: string) => void;
};

function defaultLoadModule(name: string): unknown {
  return createRequire(import.meta.url)(name);
}

function defaultRebuild(name: string): void {
  const result = spawnSync("npm", ["rebuild", name], {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm rebuild ${name} exited with status ${result.status}`);
  }
}

/** Ensure native dependencies used by the macOS DMG maker are loadable. */
export function ensureDmgNative(options: DmgNativeOptions = {}): void {
  if ((options.platform ?? process.platform) !== "darwin") return;

  const loadModule = options.loadModule ?? defaultLoadModule;
  const rebuild = options.rebuild ?? defaultRebuild;

  for (const name of DMG_NATIVE_MODULES) {
    try {
      loadModule(name);
      continue;
    } catch (initialError) {
      try {
        rebuild(name);
        loadModule(name);
      } catch (rebuildError) {
        const detail =
          rebuildError instanceof Error
            ? rebuildError.message
            : String(rebuildError);
        const initial =
          initialError instanceof Error
            ? initialError.message
            : String(initialError);
        throw new Error(
          `${name} is unavailable for the macOS DMG maker after rebuilding. ` +
            `Run "npm rebuild ${name}" manually and check Xcode Command Line Tools. ` +
            `Initial error: ${initial}; rebuild error: ${detail}`,
          { cause: rebuildError },
        );
      }
    }
  }
}
