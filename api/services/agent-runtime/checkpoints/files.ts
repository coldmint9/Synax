import { parseWslUncPath } from "../../workspace-location.js";
import { wslCommandSpec } from "../../wsl.js";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_ROOT } from "../../../lib/env.js";

const execute = promisify(execFile);
export const SNAPSHOT_POLICY_VERSION = 1;
const EXCLUDED_DIRECTORIES = new Set([
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
]);
export const SNAPSHOT_EXCLUSIONS =
  "Git internals, .DS_Store, dependencies, caches, .env credentials, private keys and the Synax data directory";
export interface FileVersion {
  kind: "file" | "symlink";
  hash: string;
  mode: number;
}
export interface FileManifest {
  root: string;
  files: Record<string, FileVersion>;
  gitHead: string | null;
  observations?: Record<string, string>;
}
export interface FileChange {
  root: string;
  path: string;
  before: FileVersion | null;
  after: FileVersion | null;
}
export interface FileConflict {
  root: string;
  path: string;
  reason: string;
}
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const sameVersion = (
  a: FileVersion | null | undefined,
  b: FileVersion | null | undefined,
) =>
  (!a && !b) ||
  Boolean(
    a && b && a.kind === b.kind && a.hash === b.hash && a.mode === b.mode,
  );

export function excludedSnapshotPath(relative: string): boolean {
  const parts = relative.split("/");
  const name = parts.at(-1)!;
  return (
    parts.some((p) => EXCLUDED_DIRECTORIES.has(p)) ||
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

/** Immutable, private, content-addressed storage. No project Git/index writes. */
export class CheckpointFiles {
  constructor(
    readonly directory = path.resolve(DATA_ROOT, "conversation-snapshots"),
  ) {}
  private blobPath(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid snapshot digest.");
    return path.join(
      this.directory,
      "blobs",
      digest.slice(0, 2),
      digest.slice(2),
    );
  }
  async put(bytes: Buffer): Promise<string> {
    const digest = hash(bytes),
      target = this.blobPath(digest);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    if (await fs.stat(target).catch(() => null)) return digest;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return digest;
  }
  async get(digest: string): Promise<Buffer> {
    const bytes = await fs.readFile(this.blobPath(digest));
    if (hash(bytes) !== digest)
      throw new Error("Snapshot content failed integrity verification.");
    return bytes;
  }
  async head(root: string): Promise<string | null> {
    const wsl = parseWslUncPath(root);
    const args = ["rev-parse", "--verify", "HEAD"];
    const command = wsl
      ? wslCommandSpec(wsl.distribution, wsl.path, "git", args)
      : { command: "git", args };
    try {
      return (
        await execute(command.command, command.args, {
          cwd: wsl ? undefined : root,
          timeout: 5_000,
        })
      ).stdout.trim();
    } catch {
      return null;
    }
  }
  /** Reject traversal and symlinked ancestors, including during recovery. */
  async resolve(root: string, relative: string): Promise<string> {
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").some((p) => p === ".." || !p || p === ".")
    )
      throw new Error("Unsafe snapshot path.");
    const canonical = await fs.realpath(root);
    if (canonical !== root) throw new Error("Workspace location changed.");
    let current = root;
    for (const part of relative.split("/").slice(0, -1)) {
      current = path.join(current, part);
      const stat = await fs
        .lstat(current)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        throw new Error("Snapshot path has an unsafe ancestor.");
    }
    return path.join(root, relative);
  }
  async version(
    root: string,
    relative: string,
    persist = false,
  ): Promise<FileVersion | null> {
    const file = await this.resolve(root, relative);
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return null;
    if (!stat.isFile() && !stat.isSymbolicLink())
      throw new Error("A file was replaced by a directory or special file.");
    // Bounded memory; oversized snapshots fail closed instead of silently omitting files.
    if (stat.size > 128 * 1024 * 1024)
      throw new Error("Snapshot file exceeds the 128 MiB safety limit.");
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(await fs.readlink(file))
      : await fs.readFile(file);
    const after = await fs.lstat(file);
    if (
      stat.ino !== after.ino ||
      stat.size !== after.size ||
      stat.mtimeMs !== after.mtimeMs ||
      stat.ctimeMs !== after.ctimeMs
    )
      throw new Error("Workspace changed while capturing a file.");
    return {
      kind: stat.isSymbolicLink() ? "symlink" : "file",
      hash: persist ? await this.put(bytes) : hash(bytes),
      mode: stat.mode & 0o777,
    };
  }
  async capture(
    rootPath: string,
    observeWrites = false,
  ): Promise<FileManifest> {
    const root = await fs.realpath(rootPath),
      files: Record<string, FileVersion> = {};
    const observations: Record<string, string> = {};
    const entries: Array<{ relative: string; stamp: string }> = [];
    let total = 0;
    const privateRoot = path.resolve(DATA_ROOT);
    const visit = async (relative: string): Promise<void> => {
      const names = (
        await fs.readdir(path.join(root, relative), { withFileTypes: true })
      )
        .filter((entry) => {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          const absolute = path.join(root, child);
          return (
            !excludedSnapshotPath(child) &&
            absolute !== this.directory &&
            absolute !== privateRoot
          );
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      // Preflight metadata before storing any bytes. Large build trees fail fast,
      // rather than copying hundreds of megabytes just to discover an oversized artifact.
      for (let i = 0; i < names.length; i += 32) {
        const batch = names.slice(i, i + 32);
        const stats = await Promise.all(
          batch.map((entry) => fs.lstat(path.join(root, relative, entry.name))),
        );
        for (let n = 0; n < batch.length; n++) {
          const child = relative
            ? `${relative}/${batch[n].name}`
            : batch[n].name;
          const stat = stats[n];
          if (stat.isDirectory()) continue;
          if (!stat.isFile() && !stat.isSymbolicLink())
            throw new Error("Snapshot contains a special file.");
          total += stat.size;
          if (stat.size > 128 * 1024 * 1024)
            throw new Error("Snapshot file exceeds the 128 MiB safety limit.");
          if (total > 512 * 1024 * 1024)
            throw new Error(
              "Workspace snapshot exceeds the 512 MiB safety limit.",
            );
          entries.push({
            relative: child,
            stamp: `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`,
          });
        }
        for (let n = 0; n < batch.length; n++)
          if (stats[n].isDirectory())
            await visit(
              relative ? `${relative}/${batch[n].name}` : batch[n].name,
            );
      }
    };
    const gitHead = await this.head(root);
    await visit("");
    entries.sort((a, b) => a.relative.localeCompare(b.relative));
    // Bound file IO parallelism and peak buffering; immutable blobs deduplicate later captures.
    let index = 0;
    const versions = new Map<string, FileVersion>();
    const captures = await Promise.allSettled(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (index < entries.length) {
          const entry = entries[index++];
          const value = await this.version(root, entry.relative, true);
          const stat = await fs.lstat(path.join(root, entry.relative));
          const stamp = `${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}`;
          if (!value || stamp !== entry.stamp)
            throw new Error("Workspace changed during snapshot.");
          versions.set(entry.relative, value);
          if (observeWrites) observations[entry.relative] = stamp;
        }
      }),
    );
    const failed = captures.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    for (const entry of entries)
      files[entry.relative] = versions.get(entry.relative)!;
    if ((await this.head(root)) !== gitHead)
      throw new Error("Git HEAD changed during snapshot.");
    return { root, files, gitHead, ...(observeWrites ? { observations } : {}) };
  }
  async verify(
    changes: FileChange[],
    side: "before" | "after",
  ): Promise<FileConflict[]> {
    const conflicts: FileConflict[] = [];
    for (const change of changes) {
      try {
        if (
          !sameVersion(
            await this.version(change.root, change.path),
            change[side],
          )
        )
          conflicts.push({
            root: change.root,
            path: change.path,
            reason: "File has independent or subsequent changes.",
          });
        // Verify required blobs before modifying any files.
        if (change.before) await this.get(change.before.hash);
        if (change.after) await this.get(change.after.hash);
      } catch (error) {
        conflicts.push({
          root: change.root,
          path: change.path,
          reason: String(error),
        });
      }
    }
    return conflicts;
  }
  async write(
    root: string,
    relative: string,
    version: FileVersion | null,
  ): Promise<void> {
    const target = await this.resolve(root, relative);
    if (!version) {
      await fs.unlink(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    const bytes = await this.get(version.hash);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Recheck after mkdir; never write through an ancestor symlink.
    await this.resolve(root, relative);
    const temporary = path.join(
      path.dirname(target),
      `.synax-restore-${randomUUID()}`,
    );
    try {
      if (version.kind === "symlink")
        await fs.symlink(bytes.toString(), temporary);
      else {
        await fs.writeFile(temporary, bytes, {
          flag: "wx",
          mode: version.mode,
        });
        await fs.chmod(temporary, version.mode);
      }
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}
export const checkpointFiles = new CheckpointFiles();
export function diffManifests(
  before: FileManifest[],
  after: FileManifest[],
): FileChange[] {
  return before.flatMap((a) => {
    const b = after.find((item) => item.root === a.root);
    if (!b) throw new Error("Snapshot workspace roots changed.");
    return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])]
      .sort()
      .flatMap((file) =>
        sameVersion(a.files[file], b.files[file]) &&
        a.observations?.[file] === b.observations?.[file]
          ? []
          : [
              {
                root: a.root,
                path: file,
                before: a.files[file] ?? null,
                after: b.files[file] ?? null,
              },
            ],
      );
  });
}
