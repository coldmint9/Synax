import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type Database from "libsql";
import { VersionStoreError } from "./version-store/limits.js";

const MiB = 1024 * 1024;
export const HISTORY_RESOURCE_LIMITS = {
  database: 4 * 1024 * MiB,
  wal: 64 * MiB,
  freeDisk: 512 * MiB,
  externalDirectory: 2 * 1024 * MiB,
  externalInFlight: 128 * MiB,
};
interface Sample {
  at: number;
  charged: number;
  file: string;
  wal: number;
  free: number;
}
const samples = new WeakMap<Database.Database, Sample>();
function fail(message: string): never {
  throw new VersionStoreError("VERSION_DISK_BUDGET", message);
}
function size(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
}
/** Admission, not a post-write alarm. Re-sample by time AND charged bytes, so a
 * burst cannot consume an entire stale free-space/WAL allowance. GC bypasses it. */
export function admitVersionGrowth(db: Database.Database, bytes: number): void {
  let sample = samples.get(db);
  const charged = bytes * 4 + 4096;
  if (
    !sample ||
    Date.now() - sample.at > 250 ||
    sample.charged + charged > MiB
  ) {
    const file =
      sample?.file ??
      (
        db
          .prepare("SELECT file FROM pragma_database_list WHERE name='main'")
          .get() as { file: string }
      ).file;
    if (!file) return;
    const disk = fs.statfsSync(path.dirname(file));
    sample = {
      file,
      at: Date.now(),
      charged: 0,
      wal: size(`${file}-wal`),
      free: disk.bavail * disk.bsize,
    };
    samples.set(db, sample);
  }
  if (sample.wal + sample.charged + charged > HISTORY_RESOURCE_LIMITS.wal)
    fail(
      "History writes are backpressured by the WAL budget. Close stale readers and retry after maintenance.",
    );
  if (sample.free - sample.charged - charged < HISTORY_RESOURCE_LIMITS.freeDisk)
    fail(
      "Insufficient disk headroom for safe history writes. Free storage before retrying.",
    );
  sample.charged += charged;
}

interface ExternalUsage {
  bytes: number;
  added: number;
  reserved: number;
  active: number;
  at: number;
  scan?: Promise<void>;
}
const external = new Map<string, ExternalUsage>();
/** Stream directory entries; never recursively build an array of filenames. */
async function directoryBytes(directory: string, depth = 0, maxDepth = 4): Promise<number> {
  if (depth > maxDepth)
    fail("Unexpected depth in history storage; refusing unaccounted writes.");
  let dir: Awaited<ReturnType<typeof fsp.opendir>>;
  try {
    dir = await fsp.opendir(directory);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw e;
  }
  let bytes = 0;
  for await (const entry of dir) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += 4096 + await directoryBytes(file, depth + 1, maxDepth);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      try {
        const stat = await fsp.lstat(file);
        bytes += Math.max(stat.size, stat.blocks * 512) + 4096;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    if (bytes > HISTORY_RESOURCE_LIMITS.externalDirectory) return bytes;
  }
  return bytes;
}
export async function reserveExternalBytes(
  directory: string,
  bytes: number,
  maxDepth = 4,
): Promise<(committed?: boolean) => void> {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 64) fail("Invalid storage scan depth.");
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > HISTORY_RESOURCE_LIMITS.externalInFlight
  )
    fail("File exceeds the bounded history write budget.");
  const key = path.resolve(directory);
  let usage = external.get(key);
  if (!usage) {
    // Production has two roots. Do not retain arbitrary test/workspace paths.
    if (external.size >= 8) {
      const idle = [...external].find(
        ([, value]) => !value.active && !value.scan,
      );
      if (idle) external.delete(idle[0]);
      else fail("History storage is busy.");
    }
    usage = { bytes: 0, added: 0, reserved: 0, active: 0, at: 0 };
    external.set(key, usage);
  }
  if (
    usage.active >= 4 ||
    usage.reserved + bytes > HISTORY_RESOURCE_LIMITS.externalInFlight
  )
    fail(
      "History file writes are busy; retry instead of queueing more buffers.",
    );
  usage.active++;
  usage.reserved += bytes;
  let released = false;
  const release = (committed = false) => {
    if (released) return;
    released = true;
    usage!.active--;
    usage!.reserved -= bytes;
    if (committed) usage!.added += bytes;
  };
  try {
    if (!usage.at || Date.now() - usage.at > 30_000) {
      if (!usage.scan) {
        const before = usage.added;
        usage.scan = directoryBytes(key, 0, maxDepth)
          .then((total) => {
            usage!.bytes = total + usage!.added - before;
            usage!.added = 0;
            usage!.at = Date.now();
          })
          .finally(() => {
            usage!.scan = undefined;
          });
      }
      await usage.scan;
    }
    if (
      usage.bytes + usage.added + usage.reserved >
      HISTORY_RESOURCE_LIMITS.externalDirectory
    )
      fail(
        "History/media storage limit reached. Reclaim old retained content before retrying.",
      );
    let parent = key;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    const disk = fs.statfsSync(parent);
    if (
      disk.bavail * disk.bsize - usage.reserved <
      HISTORY_RESOURCE_LIMITS.freeDisk
    )
      fail("Insufficient free disk space for history/media storage.");
    return release;
  } catch (e) {
    release();
    throw e;
  }
}
