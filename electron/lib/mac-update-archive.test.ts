import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateMacUpdateArchive } from "./mac-update-archive.js";

const run = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-zip-test-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
async function archive(...names: string[]) {
  const file = path.join(root, "update.zip");
  await run("zip", ["-r", "-y", file, ...names], { cwd: root });
  return file;
}
describe.skipIf(process.platform === "win32")(
  "macOS update ZIP preflight",
  () => {
    it("accepts a normal app and framework symlinks", async () => {
      const framework = path.join(
        root,
        "Synax.app/Contents/Frameworks/Example.framework",
      );
      await fs.mkdir(path.join(framework, "Versions/A"), { recursive: true });
      await fs.writeFile(path.join(framework, "Versions/A/Example"), "binary");
      await fs.symlink("A", path.join(framework, "Versions/Current"));
      await fs.symlink(
        "Versions/Current/Example",
        path.join(framework, "Example"),
      );
      await expect(
        validateMacUpdateArchive(await archive("Synax.app")),
      ).resolves.toBeUndefined();
    });
    it("rejects files outside the app root", async () => {
      await fs.writeFile(path.join(root, "outside.txt"), "outside");
      await expect(
        validateMacUpdateArchive(await archive("outside.txt")),
      ).rejects.toThrow("Unsafe");
    });
    it("rejects symlinks that escape the app", async () => {
      await fs.mkdir(path.join(root, "Synax.app/Contents"), {
        recursive: true,
      });
      await fs.symlink(
        "../../outside",
        path.join(root, "Synax.app/Contents/escape"),
      );
      await expect(
        validateMacUpdateArchive(await archive("Synax.app")),
      ).rejects.toThrow("escapes");
    });
    it("rejects archive entries that would write through a symlink", async () => {
      await fs.mkdir(path.join(root, "Synax.app/target"), { recursive: true });
      await fs.writeFile(path.join(root, "Synax.app/target/file"), "file");
      await fs.symlink("target", path.join(root, "Synax.app/link"));
      await expect(
        validateMacUpdateArchive(
          await archive("Synax.app", "Synax.app/link/file"),
        ),
      ).rejects.toThrow("through a symlink");
    });
  },
);
