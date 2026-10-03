import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Source modules use their own URL; CJS bundles resolve resources beside the executable entry, not the caller's cwd. */
export function runtimeAsset(moduleUrl: string | undefined, sourceRelative: string, bundledRelative: string): string {
  if (moduleUrl) return path.resolve(path.dirname(fileURLToPath(moduleUrl)), sourceRelative);
  if (!process.argv[1]) throw new Error('The Runtime executable entry path is unavailable.');
  const entryDir = path.dirname(path.resolve(process.argv[1]));
  const root = path.basename(entryDir) === 'workers' ? path.dirname(entryDir) : entryDir;
  return path.resolve(root, bundledRelative);
}
