import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDesktopReleaseArtifacts } from "./desktop-release-artifacts.js";
import { sha256 } from "../electron/lib/ui-update-format.js";
let root: string;
afterEach(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true });
});
it.each(["darwin", "win32"] as const)(
  "produces matching release metadata for %s",
  async (platform) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-desktop-release-"));
    const make = path.join(root, "make");
    const output = path.join(root, "updates");
    await fs.mkdir(make);
    const source =
      platform === "darwin"
        ? "Synax-0.2.0-arm64.dmg"
        : "Synax-0.2.0-full.nupkg";
    const bytes = Buffer.from("desktop release package");
    await fs.writeFile(path.join(make, source), bytes);
    const manifest = await createDesktopReleaseArtifacts(
      make,
      output,
      "0.2.0",
      platform,
      "arm64",
    );
    expect(manifest.artifact.sha256).toBe(sha256(bytes));
    expect(manifest.artifact.size).toBe(bytes.length);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(output, `desktop-${platform}-arm64.json`),
          "utf8",
        ),
      ),
    ).toEqual(manifest);
    if (platform === "darwin")
      expect(
        await fs.readFile(path.join(output, manifest.artifact.name)),
      ).toEqual(bytes);
    await expect(
      createDesktopReleaseArtifacts(make, output, "0.3.0", platform, "arm64"),
    ).rejects.toThrow("Expected one");
  },
);
