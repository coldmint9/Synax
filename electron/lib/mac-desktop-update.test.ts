import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  finishMacInstallation,
  macApplicationPath,
  MAC_INSTALL_SCRIPT,
  verifyMacBundle,
  prepareMacInstallation,
} from "./mac-desktop-update.js";
import { hashFile, type DesktopManifest } from "./desktop-update-format.js";
const run = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "synax-mac-update-")),
  );
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe.skipIf(process.platform !== "darwin")(
  "macOS bundle architecture",
  () => {
    it("prepares a verified full ZIP without mounting a DMG or replacing the running bundle", async () => {
      const arch = process.arch as "arm64" | "x64";
      const target = path.join(root, "installed", "Synax.app");
      const source = path.join(root, "release", "Synax.app");
      const code = path.join(root, "fixture.c");
      await fs.writeFile(code, "int main(void) { return 0; }\n");
      for (const [bundle, version] of [
        [target, "0.1.2"],
        [source, "0.2.0"],
      ]) {
        await fs.mkdir(path.join(bundle, "Contents/MacOS"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(bundle, "Contents/Info.plist"),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.Synax.desktop</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>Synax</string></dict></plist>`,
        );
        await run("/usr/bin/xcrun", [
          "clang",
          code,
          "-o",
          path.join(bundle, "Contents/MacOS/Synax"),
        ]);
      }
      const directory = path.join(root, "cache");
      await fs.mkdir(directory);
      const name = `Synax-0.2.0-darwin-${arch}.zip`;
      const zip = path.join(directory, name);
      await run("zip", ["-r", "-y", zip, "Synax.app"], {
        cwd: path.dirname(source),
      });
      const manifest: DesktopManifest = {
        format: 1,
        version: "0.2.0",
        platform: "darwin",
        arch,
        artifact: {
          name: `Synax-0.2.0-darwin-${arch}.dmg`,
          size: 1,
          sha256: "a".repeat(64),
        },
        updateArchive: {
          name,
          size: (await fs.stat(zip)).size,
          sha256: await hashFile(zip),
        },
      };
      const prepared = await prepareMacInstallation(
        zip,
        manifest,
        path.join(target, "Contents/MacOS/Synax"),
        directory,
      );
      expect(
        await fs.readFile(
          path.join(prepared.workspace, "next.app/Contents/Info.plist"),
          "utf8",
        ),
      ).toContain("0.2.0");
      expect(
        await fs.readFile(path.join(target, "Contents/Info.plist"), "utf8"),
      ).toContain("0.1.2");
      expect(await fs.readdir(directory)).toEqual([name]);
    }, 30_000);
    it.each(["x64", "arm64"])(
      "accepts a %s Mach-O bundle and rejects the other architecture",
      async (arch) => {
        const bundle = path.join(root, "Apps with spaces", "Synax.app");
        await fs.mkdir(path.join(bundle, "Contents/MacOS"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(bundle, "Contents/Info.plist"),
          `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.Synax.desktop</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>CFBundleExecutable</key><string>Synax</string>
</dict></plist>`,
        );
        const source = path.join(root, "fixture.c");
        await fs.writeFile(source, "int main(void) { return 0; }\n");
        await run("/usr/bin/xcrun", [
          "clang",
          "-arch",
          arch === "x64" ? "x86_64" : "arm64",
          source,
          "-o",
          path.join(bundle, "Contents/MacOS/Synax"),
        ]);
        await expect(
          verifyMacBundle(bundle, bundle, "0.2.0", arch),
        ).resolves.toBeUndefined();
        await expect(
          verifyMacBundle(
            bundle,
            bundle,
            "0.2.0",
            arch === "x64" ? "arm64" : "x64",
          ),
        ).rejects.toThrow();
      },
      30_000,
    );
  },
);
it.skipIf(process.platform === "win32")(
  "locates only an application bundle executable",
  () => {
    expect(
      macApplicationPath("/Applications/Synax.app/Contents/MacOS/Synax"),
    ).toBe("/Applications/Synax.app");
    expect(() => macApplicationPath("/usr/local/bin/electron")).toThrow(
      "locate",
    );
  },
);
describe.skipIf(process.platform === "win32")(
  "macOS replacement transaction",
  () => {
    async function fixture(next = true, script = MAC_INSTALL_SCRIPT) {
      // Spaces, quotes and shell syntax in paths must remain literal.
      const target = path.join(root, "Synax ' $(touch injected).app");
      const workspace = await fs.mkdtemp(path.join(root, ".synax-update-"));
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "version"), "old");
      if (next) {
        await fs.mkdir(path.join(workspace, "next.app"));
        await fs.writeFile(path.join(workspace, "next.app/version"), "new");
      }
      const helper = path.join(workspace, "install.sh");
      // Exercise real filesystem moves without launching a UI application in CI.
      await fs.writeFile(
        helper,
        script.replaceAll("/usr/bin/open -n", "/usr/bin/true"),
      );
      return { target, workspace, helper };
    }
    it("replaces after exit and retains the previous bundle until health is confirmed", async () => {
      const f = await fixture();
      await run("/bin/sh", [f.helper, "99999999", f.target, f.workspace]);
      expect(await fs.readFile(path.join(f.target, "version"), "utf8")).toBe(
        "new",
      );
      expect(
        await fs.readFile(
          path.join(f.workspace, "previous.app/version"),
          "utf8",
        ),
      ).toBe("old");
      const marker = path.join(root, "pending-install.json");
      await fs.writeFile(
        marker,
        JSON.stringify({
          version: "0.2.0",
          target: f.target,
          workspace: f.workspace,
        }),
      );
      const executable = path.join(f.target, "Contents/MacOS/Synax");
      await finishMacInstallation(root, executable, "0.1.2");
      await fs.access(f.workspace);
      await finishMacInstallation(root, executable, "0.2.0");
      await expect(fs.access(f.workspace)).rejects.toThrow();
      expect(await fs.readFile(path.join(f.target, "version"), "utf8")).toBe(
        "new",
      );
    });
    it("restores the original app if moving the replacement fails", async () => {
      const f = await fixture(false);
      await expect(
        run("/bin/sh", [f.helper, "99999999", f.target, f.workspace]),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(f.target, "version"), "utf8")).toBe(
        "old",
      );
      expect(
        await fs.readFile(path.join(f.workspace, "status"), "utf8"),
      ).toContain("restored");
    });
    it("does not replace files while the current process is still running", async () => {
      const f = await fixture(
        true,
        MAC_INSTALL_SCRIPT.replace('"$count" -ge 120', '"$count" -ge 1'),
      );
      await expect(
        run("/bin/sh", [f.helper, String(process.pid), f.target, f.workspace]),
      ).rejects.toThrow();
      expect(await fs.readFile(path.join(f.target, "version"), "utf8")).toBe(
        "old",
      );
    });
    it("refuses to clean an unrelated directory from a malformed marker", async () => {
      const target = path.join(root, "Synax.app");
      await fs.writeFile(
        path.join(root, "pending-install.json"),
        JSON.stringify({ version: "0.2.0", target, workspace: root }),
      );
      await expect(
        finishMacInstallation(
          root,
          path.join(target, "Contents/MacOS/Synax"),
          "0.2.0",
        ),
      ).rejects.toThrow("Invalid pending");
      await fs.access(root);
    });
  },
);
