import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DATA_ROOT } from "../../../lib/env.js";

export interface FileVersion {
  kind: "file" | "symlink";
  hash: string;
  mode: number;
}
export interface GitBoundary {
  root: string;
  path: string;
  head: string | null;
  unverified?: boolean;
}
export interface FileChange {
  root: string;
  path: string;
  before: FileVersion | null;
  after: FileVersion | null;
  git?: GitBoundary;
  preserved?: "committed";
}
export interface FileConflict {
  root: string;
  path: string;
  reason: string;
}
export const SNAPSHOT_EXCLUSIONS =
  "Only explicitly recorded session writes are undoable. Git commits, external changes, and untracked command effects are preserved.";
export const FILE_BUFFER_BYTES = 64 * 1024;
export const sameVersion = (
  a: FileVersion | null | undefined,
  b: FileVersion | null | undefined,
) =>
  (!a && !b) ||
  Boolean(
    a && b && a.kind === b.kind && a.hash === b.hash && a.mode === b.mode,
  );
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const stamp = (s: import("node:fs").Stats) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export function excludedSnapshotPath(relative: string): boolean {
  const parts = relative.split("/"),
    name = parts.at(-1)!;
  return (
    parts.some((p) =>
      [
        ".git",
        "node_modules",
        ".pnpm-store",
        ".yarn",
        ".cache",
        ".tmp",
        ".next",
        ".nuxt",
        "__pycache__",
        ".venv",
        "venv",
        ".pytest_cache",
        ".turbo",
        ".gradle",
        ".idea",
        ".synax-forks",
      ].includes(p),
    ) ||
    name === ".DS_Store" ||
    name.startsWith(".synax-restore-") ||
    (/^\.env(?:\.|$)/.test(name) &&
      !/\.(example|sample|template)$/.test(name)) ||
    /^(id_(rsa|ed25519|ecdsa)|credentials(?:\.json)?|\.npmrc|\.netrc)$/.test(
      name,
    ) ||
    /\.(pem|key|p12|pfx)$/.test(name)
  );
}
/** Shared before-images for declared file operations, not directory snapshots.
 * Reads/writes are streamed; memory is bounded independently of file size. */
export class CheckpointFiles {
  constructor(
    readonly directory = path.resolve(DATA_ROOT, "conversation-snapshots"),
  ) {}
  private blobPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid undo content digest.");
    return path.join(this.directory, "blobs", hash.slice(0, 2), hash.slice(2));
  }
  async put(bytes: Buffer): Promise<string> {
    const hash = digest(bytes),
      target = this.blobPath(hash);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (await fs.stat(target).catch(() => null)) return hash;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return hash;
  }
  async get(hash: string): Promise<Buffer> {
    const bytes = await fs.readFile(this.blobPath(hash));
    if (digest(bytes) !== hash)
      throw new Error("Undo content failed integrity verification.");
    return bytes;
  }
  private async streamFile(file: string, persist: boolean): Promise<string> {
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    let output: import("node:fs/promises").FileHandle | undefined,
      temporary: string | undefined;
    try {
      const before = await handle.stat();
      if (!before.isFile())
        throw new Error("Only ordinary files can be recorded.");
      if (persist) {
        await fs.mkdir(path.join(this.directory, "blobs"), {
          recursive: true,
          mode: 0o700,
        });
        temporary = path.join(
          this.directory,
          "blobs",
          `.pending-${randomUUID()}`,
        );
        output = await fs.open(temporary, "wx", 0o600);
      }
      const hash = createHash("sha256"),
        buffer = Buffer.allocUnsafe(FILE_BUFFER_BYTES);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (output) {
          let offset = 0;
          while (offset < bytesRead)
            offset += (
              await output.write(chunk, offset, bytesRead - offset, null)
            ).bytesWritten;
        }
      }
      if (stamp(before) !== stamp(await handle.stat()))
        throw new Error("File changed while recording its before-image.");
      const value = hash.digest("hex");
      if (output && temporary) {
        await output.sync();
        await output.close();
        output = undefined;
        const target = this.blobPath(value);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        if (!(await fs.stat(target).catch(() => null)))
          await fs.rename(temporary, target);
      }
      return value;
    } finally {
      await output?.close();
      await handle.close();
      if (temporary) await fs.unlink(temporary).catch(() => {});
    }
  }
  async verifyBlob(hash: string): Promise<void> {
    if ((await this.streamFile(this.blobPath(hash), false)) !== hash)
      throw new Error("Undo content failed integrity verification.");
  }
  async resolve(root: string, relative: string): Promise<string> {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").some((p) => p === ".." || p === "." || !p)
    )
      throw new Error("Unsafe undo path.");
    if ((await fs.realpath(root)) !== root)
      throw new Error("Workspace location changed.");
    let current = root;
    for (const part of relative.split("/").slice(0, -1)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return null;
        throw e;
      });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error("Undo path has an unsafe ancestor.");
    }
    return path.join(root, relative);
  }
  async version(
    root: string,
    relative: string,
    persist = false,
  ): Promise<FileVersion | null> {
    const file = await this.resolve(root, relative);
    const before = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (!before) return null;
    if (!before.isFile() && !before.isSymbolicLink())
      throw new Error("File was replaced by a directory or special file.");
    const hash = before.isSymbolicLink()
      ? await (async () => {
          const bytes = Buffer.from(await fs.readlink(file));
          return persist ? this.put(bytes) : digest(bytes);
        })()
      : await this.streamFile(file, persist);
    if (stamp(before) !== stamp(await fs.lstat(file)))
      throw new Error("File changed while being recorded.");
    return {
      kind: before.isSymbolicLink() ? "symlink" : "file",
      hash,
      mode: before.mode & 0o777,
    };
  }
  async verify(
    changes: FileChange[],
    side: "before" | "after",
  ): Promise<FileConflict[]> {
    const conflicts: FileConflict[] = [];
    for (const c of changes)
      try {
        if (!sameVersion(await this.version(c.root, c.path), c[side]))
          conflicts.push({
            root: c.root,
            path: c.path,
            reason: "File has independent or subsequent changes.",
          });
        if (c.before) await this.verifyBlob(c.before.hash);
        if (c.after) await this.verifyBlob(c.after.hash);
      } catch (error) {
        conflicts.push({ root: c.root, path: c.path, reason: String(error) });
      }
    return conflicts;
  }
  async write(
    root: string,
    relative: string,
    value: FileVersion | null,
  ): Promise<void> {
    const target = await this.resolve(root, relative);
    if (!value) {
      await fs.unlink(target).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      return;
    }
    await this.verifyBlob(value.hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.resolve(root, relative);
    const temporary = path.join(
      path.dirname(target),
      `.synax-restore-${randomUUID()}`,
    );
    try {
      if (value.kind === "symlink")
        await fs.symlink((await this.get(value.hash)).toString(), temporary);
      else {
        await fs.copyFile(
          this.blobPath(value.hash),
          temporary,
          constants.COPYFILE_EXCL,
        );
        await fs.chmod(temporary, value.mode);
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}
export const checkpointFiles = new CheckpointFiles();
