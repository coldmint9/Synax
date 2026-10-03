import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CheckpointFiles,
  FILE_BUFFER_BYTES,
  excludedSnapshotPath,
} from "../checkpoints/files.js";
let base: string, root: string, files: CheckpointFiles;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "synax-undo-files-"));
  root = path.join(base, "work");
  await fs.mkdir(root);
  root = await fs.realpath(root);
  files = new CheckpointFiles(path.join(base, "undo"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(base, { recursive: true, force: true });
});
describe("targeted file before-images", () => {
  it("round-trips binary files and detects subsequent edits", async () => {
    const beforeBytes = Buffer.from([0, 255, 10]);
    await fs.writeFile(path.join(root, "file"), beforeBytes);
    const before = await files.version(root, "file", true);
    await fs.writeFile(path.join(root, "file"), "agent");
    const after = await files.version(root, "file", true);
    const changes = [{ root, path: "file", before, after }];
    expect(await files.verify(changes, "after")).toEqual([]);
    await fs.writeFile(path.join(root, "file"), "human");
    expect(await files.verify(changes, "after")).toHaveLength(1);
    await files.write(root, "file", before);
    expect(await fs.readFile(path.join(root, "file"))).toEqual(beforeBytes);
  });
  it("streams a file larger than the old 128 MiB limit without readFile", async () => {
    const handle = await fs.open(path.join(root, "large"), "w");
    await handle.truncate(129 * 1024 * 1024);
    await handle.close();
    const read = vi.spyOn(fs, "readFile");
    const version = await files.version(root, "large", true);
    expect(version?.hash).toHaveLength(64);
    expect(read).not.toHaveBeenCalled();
    expect(FILE_BUFFER_BYTES).toBe(64 * 1024);
    await files.write(root, "copy", version);
    expect((await fs.stat(path.join(root, "copy"))).size).toBe(
      129 * 1024 * 1024,
    );
    expect(read).not.toHaveBeenCalled();
  }, 20_000);
  it("deduplicates equal contents independently of file names", async () => {
    await fs.writeFile(path.join(root, "a"), "same");
    await fs.writeFile(path.join(root, "b"), "same");
    expect((await files.version(root, "a", true))?.hash).toBe(
      (await files.version(root, "b", true))?.hash,
    );
  });
  it("never follows symlink ancestors or traverses out of a root", async () => {
    const outside = path.join(base, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret"), "private");
    await fs.symlink(outside, path.join(root, "link"));
    expect((await files.version(root, "link", true))?.kind).toBe("symlink");
    await expect(files.write(root, "link/secret", null)).rejects.toThrow(
      "unsafe ancestor",
    );
    await expect(files.write(root, "../outside/secret", null)).rejects.toThrow(
      "Unsafe",
    );
    expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe(
      "private",
    );
  });
  it("excludes secrets from file undo but does not exclude ordinary build outputs", () => {
    expect(excludedSnapshotPath(".env")).toBe(true);
    expect(excludedSnapshotPath(".DS_Store")).toBe(true);
    expect(excludedSnapshotPath("node_modules/a.js")).toBe(true);
    expect(excludedSnapshotPath("out/app.zip")).toBe(false);
  });
});
