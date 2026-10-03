import fs from "node:fs/promises";
import path from "node:path";

// These trees contain repository internals, dependencies or generated caches,
// and must not crowd source files out of the context picker.
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  "target",
]);
const CACHE_TTL_MS = 5_000;
const MAX_CACHED_ROOTS = 16;
interface IndexEntry {
  files: Promise<string[]>;
  expiresAt: number;
}
const indexes = new Map<string, IndexEntry>();

async function scan(root: string): Promise<string[]> {
  const files: string[] = [];
  let directories = [root];
  // Bounded I/O concurrency without a file-count/depth cutoff. Only the final
  // search result is limited; late directories remain searchable.
  while (directories.length) {
    const next: string[] = [];
    for (let offset = 0; offset < directories.length; offset += 8) {
      await Promise.all(
        directories.slice(offset, offset + 8).map(async (dir) => {
          let entries;
          try {
            entries = await fs.readdir(dir, { withFileTypes: true });
          } catch (error) {
            if (dir === root) throw error;
            // Concurrent removals and unreadable subdirectories do not hide peers.
            return;
          }
          for (const entry of entries) {
            if (entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!EXCLUDED_DIRECTORIES.has(entry.name)) next.push(full);
            } else if (entry.isFile() && entry.name !== ".git") {
              files.push(full);
            }
          }
        }),
      );
    }
    directories = next;
  }
  return files.sort();
}

/** Share a complete, asynchronous index across queries and sessions. */
export function workspaceFileIndex(root: string): Promise<string[]> {
  root = path.resolve(root);
  const cached = indexes.get(root);
  if (cached && cached.expiresAt > Date.now()) {
    indexes.delete(root);
    indexes.set(root, cached);
    return cached.files;
  }
  const entry: IndexEntry = { files: Promise.resolve([]), expiresAt: Infinity };
  entry.files = scan(root)
    .then((files) => {
      entry.expiresAt = Date.now() + CACHE_TTL_MS;
      return files;
    })
    .catch((error) => {
      if (indexes.get(root) === entry) indexes.delete(root);
      throw error;
    });
  indexes.delete(root);
  indexes.set(root, entry);
  while (indexes.size > MAX_CACHED_ROOTS)
    indexes.delete(indexes.keys().next().value!);
  return entry.files;
}
