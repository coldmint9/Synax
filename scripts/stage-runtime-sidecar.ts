import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Build on the target host and stage outside ASAR so the supervisor can spawn it. */
export async function stageRuntimeSidecar(platform: string, arch: string): Promise<void> {
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(`Rust sidecar must be built on ${platform}/${arch}, not ${process.platform}/${process.arch}.`);
  }
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    path.join(root, 'scripts/runtime-sidecar-cargo.mjs'), 'build', '--release', '--locked',
  ], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const name = platform === 'win32' ? 'synax-runtime-sidecar.exe' : 'synax-runtime-sidecar';
  const destination = path.join(root, 'server-dist/workers', name);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(root, 'runtime-sidecar/target/release', name), destination);
  if (platform !== 'win32') await chmod(destination, 0o755);
}
