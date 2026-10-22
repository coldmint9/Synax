import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Stage the bundled Python runtime used by the `file.generate` tool.
 *
 * The agent runtime resolves `python-runtime/<platform>-<arch>/bin/python3`
 * from the packaged resources. Downloads are pinned to one python-build-standalone
 * release and verified by SHA-256 so an upstream retag cannot silently change
 * what ships inside the installer.
 */
const RELEASE = '20261021';
const PYTHON_VERSION = '3.12.15';
const BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/`;

interface Artifact { name: string; sha256: string }

const artifacts: Record<string, Artifact> = {
  'darwin-arm64': {
    name: `cpython-${PYTHON_VERSION}+${RELEASE}-aarch64-apple-darwin-install_only.tar.gz`,
    sha256: 'a18cc33862b53bd54a148c710def5375c1b47470cccedf817a19c2d211764584',
  },
  'darwin-x64': {
    name: `cpython-${PYTHON_VERSION}+${RELEASE}-x86_64-apple-darwin-install_only.tar.gz`,
    sha256: '869e0b30959beccc616ce14907439f4d0b3170c5830a2362dade07f07b0ed3b8',
  },
  'linux-x64': {
    name: `cpython-${PYTHON_VERSION}+${RELEASE}-x86_64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: '5ff9f0602ce964a529ed1e8555d3abab6341926d724402ba9a15e9e877191124',
  },
  'linux-arm64': {
    name: `cpython-${PYTHON_VERSION}+${RELEASE}-aarch64-unknown-linux-gnu-install_only.tar.gz`,
    sha256: 'f53cca8fcd20805bddaa8bff1ef722a6918f8225d37561bd36ad901d13d580af',
  },
  'win32-x64': {
    name: `cpython-${PYTHON_VERSION}+${RELEASE}-x86_64-pc-windows-msvc-install_only.tar.gz`,
    sha256: 'be7f14464d1d66f84429ad27e01f6d1482963afff64a2fb5256b2a51c7b5d398',
  },
  'win32-arm64': {
    name: `cpython-${PYTHON_VERSION}+${RELEASE}-aarch64-pc-windows-msvc-install_only.tar.gz`,
    sha256: 'c0660992e1907a8dc31e9069676b1415d585b53f17d0aa7e9075f4b06f38fd65',
  },
};

export const PYTHON_RUNTIME_DIR = 'python-runtime';

export function pythonExecutableName(platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? 'python.exe' : 'python3';
}

async function checksum(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadArchive(artifact: Artifact): Promise<string> {
  const cache = path.join(os.tmpdir(), 'synax-python-runtime-cache');
  await fs.mkdir(cache, { recursive: true });
  const filename = path.join(cache, artifact.name);
  try {
    if ((await checksum(filename)) === artifact.sha256) return filename;
  } catch {
    /* cache miss */
  }
  const url = `${BASE_URL}${encodeURIComponent(artifact.name)}`;
  const temp = `${filename}.${process.pid}.tmp`;
  try {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
    } catch (error) {
      const detail = error instanceof Error
        ? error.cause instanceof Error
          ? `${error.message} (${error.cause.message})`
          : error.message
        : String(error);
      throw new Error(`Python runtime download failed from ${url}: ${detail}`, { cause: error });
    }
    if (!response.ok || !response.body) {
      throw new Error(`Python runtime download failed from ${url}: HTTP ${response.status}`);
    }
    await fs.writeFile(temp, Buffer.from(await response.arrayBuffer()));
    if ((await checksum(temp)) !== artifact.sha256) {
      throw new Error(`Python runtime archive SHA-256 mismatch: ${artifact.name}`);
    }
    await fs.rename(temp, filename);
    return filename;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    // Windows 10+ and every supported CI runner ship tar; the archive itself is
    // the same layout on all three platforms.
    const child = spawn('tar', ['-xzf', archive, '-C', destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(0, 4_000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Could not extract Python runtime archive (exit ${code}): ${stderr}`));
    });
  });
}

async function signMacBinaries(root: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  const pending = [root];
  const binaries: string[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        entry.name.endsWith('.dylib') ||
        entry.name.endsWith('.so') ||
        current === path.join(root, 'bin')
      ) {
        binaries.push(target);
      }
    }
  }
  const codesign = promisify(execFile);
  for (const binary of binaries) {
    await fs.chmod(binary, 0o755);
    await codesign('codesign', ['--force', '--sign', '-', '--timestamp=none', binary], {
      timeout: 60_000,
    });
  }
}

async function smokeTest(executable: string): Promise<void> {
  const { stdout } = await promisify(execFile)(
    executable,
    ['-I', '-c', 'import sys; print(sys.version.split()[0])'],
    { timeout: 30_000, env: { ...process.env, PYTHONHOME: undefined, PYTHONPATH: undefined } },
  );
  if (!stdout.trim().startsWith(PYTHON_VERSION.split('.').slice(0, 2).join('.'))) {
    throw new Error(`Bundled Python reported unexpected version: ${stdout.trim()}`);
  }
}

/**
 * Build-time only. Never runs on Electron's application main thread.
 *
 * Set SYNAX_PYTHON_RUNTIME_PATH to a local `install_only` directory to skip the
 * network download while developing.
 */
export async function stagePythonRuntime(platform: string, arch: string): Promise<void> {
  const artifact = artifacts[`${platform}-${arch}`];
  if (!artifact) throw new Error(`No verified Python runtime artifact for ${platform}/${arch}`);
  const output = path.join(PYTHON_RUNTIME_DIR, `${platform}-${arch}`);
  const executable = path.join(output, 'bin', pythonExecutableName(platform));
  const local = process.env.SYNAX_PYTHON_RUNTIME_PATH?.trim();
  const ready = async (): Promise<boolean> => {
    try {
      await smokeTest(executable);
      return true;
    } catch {
      return false;
    }
  };

  if (local) {
    if (!path.isAbsolute(local)) throw new Error('SYNAX_PYTHON_RUNTIME_PATH must be an absolute path');
    await fs.rm(output, { recursive: true, force: true });
    await fs.cp(local, output, { recursive: true });
  } else if (!(await ready())) {
    const archive = await downloadArchive(artifact);
    const staging = `${output}.${process.pid}.tmp`;
    await fs.rm(staging, { recursive: true, force: true });
    await extractArchive(archive, staging);
    // install_only archives unpack into a single `python/` directory.
    const unpacked = path.join(staging, 'python');
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.rename(unpacked, output);
    await fs.rm(staging, { recursive: true, force: true });
  }

  await fs.chmod(executable, 0o755);
  await signMacBinaries(output);
  await smokeTest(executable);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  stagePythonRuntime(process.platform, process.arch).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
