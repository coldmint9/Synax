import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import yauzl from 'yauzl';

const VERSION = '0.30.2';
const RELEASE = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/`;
const archives: Record<string, { name: string; sha256: string }> = {
  'darwin-arm64': { name: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`, sha256: 'b545f63b746dc87004836c316245a1b5769ad5373ac6d7737996308042af7eed' },
  'darwin-x64': { name: `cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz`, sha256: 'b545f63b746dc87004836c316245a1b5769ad5373ac6d7737996308042af7eed' },
  'linux-arm64': { name: `cua-driver-rs-${VERSION}-linux-arm64-binary.tar.gz`, sha256: '11573eed8e7ce16cad97212ebedacc1b911a9e20192b09551cff8795482cee8a' },
  'linux-x64': { name: `cua-driver-rs-${VERSION}-linux-x86_64-binary.tar.gz`, sha256: '3b05920e412717be150b9629b96c1817499088ec779cadc13700d07084abe504' },
  'win32-arm64': { name: `cua-driver-rs-${VERSION}-windows-arm64-binary.zip`, sha256: '5697c6479b3972e00472172d8a698ca07f2809fa3567ba8899d3d89d1356dfaa' },
  'win32-x64': { name: `cua-driver-rs-${VERSION}-windows-x86_64-binary.zip`, sha256: 'bbf9909b92cf57e6faf0edc3542cff2accd52096e34d56baadcf1a2340c8ec2d' },
};

async function checksum(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
async function downloadArchive(name: string, expected: string): Promise<string> {
  const root = path.join(os.tmpdir(), 'synax-cua-driver-cache');
  await fs.mkdir(root, { recursive: true });
  const filename = path.join(root, name);
  try { if (await checksum(filename) === expected) return filename; } catch { /* cache miss */ }
  const temp = `${filename}.${process.pid}.tmp`;
  try {
    const response = await fetch(`${RELEASE}${name}`, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`Cua binary download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
    if (await checksum(temp) !== expected) throw new Error('Cua Driver release SHA-256 mismatch');
    await fs.rename(temp, filename);
    return filename;
  } finally { await fs.rm(temp, { force: true }); }
}
async function extractTarBinary(archive: string, output: string): Promise<void> {
  const child = spawn('tar', ['-xOzf', archive, 'cua-driver'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 1000); });
  const exit = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Could not extract Cua binary: ${stderr}`)));
  });
  await Promise.all([pipeline(child.stdout, createWriteStream(output)), exit]);
}
async function extractZipBinary(archive: string, output: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('Invalid Cua release archive'));
      let extracted = false;
      zip.on('entry', entry => {
        if (entry.fileName !== 'cua-driver.exe') return zip.readEntry();
        if (extracted) return reject(new Error('Duplicate Cua executable'));
        extracted = true;
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error('No Cua executable'));
          void pipeline(stream, createWriteStream(output)).then(resolve, reject).finally(() => zip.close());
        });
      });
      zip.on('end', () => { if (!extracted) reject(new Error('Cua executable not found in archive')); });
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

/** Build-time only. Never runs on Electron's application main thread. */
export async function stageCuaDriver(platform: string, arch: string): Promise<void> {
  const config = archives[`${platform}-${arch}`];
  if (!config) throw new Error(`No verified Cua Driver artifact for ${platform}/${arch}`);
  const source = process.env.SYNAX_CUA_DRIVER_PATH?.trim();
  // Keep the native executable outside server-dist to avoid shipping it twice.
  await fs.rm(path.join('server-dist', 'cua-driver'), { recursive: true, force: true });
  const resource = path.join('dist', 'cua-driver');
  await fs.mkdir(resource, { recursive: true });
  const binary = path.join(resource, platform === 'win32' ? 'cua-driver.exe' : 'cua-driver');
  if (source) {
    if (!path.isAbsolute(source)) throw new Error('SYNAX_CUA_DRIVER_PATH must be an absolute path');
    await fs.copyFile(source, binary);
  } else {
    const archive = await downloadArchive(config.name, config.sha256);
    if (config.name.endsWith('.zip')) await extractZipBinary(archive, binary);
    else await extractTarBinary(archive, binary);
  }
  if (platform !== 'win32') await fs.chmod(binary, 0o755);
  const { stdout } = await promisify(execFile)(binary, ['--version'], { timeout: 3_000 });
  if (!new RegExp(`\\bcua-driver\\s+${VERSION.replaceAll('.', '\\.')}\\b`).test(stdout))
    throw new Error(`Cua Driver executable must match the SDK version ${VERSION}`);
}
