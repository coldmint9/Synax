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
} from "./mac-desktop-update.js";
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
