import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { decodeUiArchive, validateManifest } from "../electron/lib/ui-update-format.js";
import { createUiReleaseArtifacts } from "./ui-release-artifacts.js";

let root: string;
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

describe("UI release packaging", () => {
  it("generates a full snapshot and only changed/new files in the delta", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-ui-build-"));
    await fs.mkdir(path.join(root, "assets"));
    await fs.writeFile(path.join(root, "index.html"), "old");
    await fs.writeFile(path.join(root, "assets", "keep.js"), "unchanged");
    await fs.writeFile(path.join(root, "assets", "remove.js"), "old");
    const first = await createUiReleaseArtifacts(root, "1.0.0", "0.1.2");
    await fs.writeFile(path.join(root, "index.html"), "new");
    await fs.rm(path.join(root, "assets", "remove.js"));
    await fs.writeFile(path.join(root, "assets", "added.js"), "new file");
    const next = await createUiReleaseArtifacts(root, "1.0.1", "0.1.2", first.manifest);
    expect(next.manifest.delta?.baseVersion).toBe("1.0.0");
    expect(next.manifest.delta?.paths).toEqual(["assets/added.js", "index.html"]);
    expect(decodeUiArchive(next.delta!, next.manifest.files.filter((entry) => next.manifest.delta!.paths.includes(entry.path))).size).toBe(2);
    expect(decodeUiArchive(next.full, next.manifest.files).size).toBe(3);
    expect(validateManifest(next.manifest)).toEqual(next.manifest);
  });
});
