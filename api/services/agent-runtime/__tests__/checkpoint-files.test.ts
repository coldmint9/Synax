import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointFiles, diffManifests } from "../checkpoints/files.js";
let base: string, root: string, files: CheckpointFiles;
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "synax-checkpoints-"));
  root = await fs.realpath(
    (await fs.mkdir(path.join(base, "workspace"), {
      recursive: true,
    })) as string,
  );
  files = new CheckpointFiles(path.join(base, "snapshots"));
});
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});
describe("checkpoint files", () => {
  it("restores created, modified and deleted binary files without project Git", async () => {
    await fs.writeFile(path.join(root, "edited"), "old");
    await fs.writeFile(path.join(root, "removed"), Buffer.from([0, 255, 10]));
    const before = await files.capture(root);
    await fs.writeFile(path.join(root, "edited"), "new");
    await fs.unlink(path.join(root, "removed"));
    await fs.writeFile(path.join(root, "added"), "new");
    const changes = diffManifests([before], [await files.capture(root)]);
    expect(changes).toHaveLength(3);
    expect(await files.verify(changes, "after")).toEqual([]);
    for (const c of changes) await files.write(c.root, c.path, c.before);
    expect((await files.capture(root)).files).toEqual(before.files);
  });
  it("reports external edits before touching any files", async () => {
    await fs.writeFile(path.join(root, "file"), "before");
    const before = await files.capture(root);
    await fs.writeFile(path.join(root, "file"), "agent");
    const after = await files.capture(root);
    await fs.writeFile(path.join(root, "file"), "human");
    expect(
      await files.verify(diffManifests([before], [after]), "after"),
    ).toMatchObject([{ path: "file" }]);
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("human");
  });
  it("excludes credentials and dependencies but includes ordinary ignored outputs", async () => {
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules/pkg"), "dependency");
    for (const name of [
      ".env",
      ".env.local",
      ".DS_Store",
      "id_rsa",
      "private.pem",
      "output.bin",
      ".env.example",
    ])
      await fs.writeFile(path.join(root, name), name);
    expect(Object.keys((await files.capture(root)).files)).toEqual([
      ".env.example",
      "output.bin",
    ]);
  });
  it("records links without following them and rejects symlink ancestors and traversal", async () => {
    const outside = path.join(base, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret"), "private");
    await fs.symlink(outside, path.join(root, "link"));
    const manifest = await files.capture(root);
    expect(Object.keys(manifest.files)).toEqual(["link"]);
    expect(manifest.files.link.kind).toBe("symlink");
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
  it("detects corrupted content before restore", async () => {
    await fs.writeFile(path.join(root, "file"), "before");
    const before = await files.capture(root);
    await fs.writeFile(path.join(root, "file"), "after");
    const changes = diffManifests([before], [await files.capture(root)]),
      digest = before.files.file.hash;
    await fs.writeFile(
      path.join(files.directory, "blobs", digest.slice(0, 2), digest.slice(2)),
      "corrupt",
    );
    expect(await files.verify(changes, "after")).toHaveLength(1);
  });
});
