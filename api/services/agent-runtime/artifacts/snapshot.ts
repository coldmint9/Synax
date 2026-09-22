import fs from 'node:fs';
import path from 'node:path';
import { ArtifactError, ARTIFACT_LIMITS, type ArtifactFile } from './contracts.js';
import { hash } from './validation.js';
import { isPathWithin } from './paths.js';

const media: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.jsx': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const textExtensions = new Set(['.html', '.htm', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.css', '.json', '.svg']);
export function safeRelativePath(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[%\\\x00-\x1f\x7f:#?]/.test(value) || path.posix.isAbsolute(value)) throw new ArtifactError('PATH_OUTSIDE_WORKSPACE', 'Only unencoded workspace-relative paths are allowed.');
  const parts = value.split('/');
  if (parts.includes('..') || parts.some(p => /^\./.test(p) && p !== '.')
    || parts.some(p => /^(?:node_modules|\.git|credentials|secrets?|id_rsa|id_ed25519|service[-_]account)(?:\..*)?$/i.test(p) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(p))) {
    throw new ArtifactError('PATH_OUTSIDE_WORKSPACE', 'Sensitive files and path traversal are not allowed.');
  }
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized.endsWith('/')) throw new ArtifactError('INVALID_SOURCE', 'Expected a source file.');
  return normalized;
}
export function resolveReference(importer: string, reference: string): string {
  if (!reference || /[%\\\x00-\x20\x7f:#?]/.test(reference) || reference.startsWith('/')) throw new ArtifactError('POLICY_BLOCKED', 'Only local relative resource references are allowed.');
  return safeRelativePath(path.posix.join(path.posix.dirname(importer), reference));
}
interface Captured { file: ArtifactFile; digest: string; bytes: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }
export interface SnapshotReader {
  readonly root: string;
  readonly entry: string;
  read(name: string): ArtifactFile;
  resolve(importer: string, reference: string): ArtifactFile;
  files(): ArtifactFile[];
  verify(): void;
}
export class ArtifactSnapshot implements SnapshotReader {
  onCapture?: (files: ArtifactFile[]) => void;
  readonly root: string;
  readonly entry: string;
  private captured = new Map<string, Captured>();
  private folded = new Map<string, string>();
  private textBytes = 0;
  private assetBytes = 0;
  constructor(root: string, entry: string) {
    if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory()) throw new ArtifactError('INVALID_SOURCE', 'Workspace root must be an authorized local directory.');
    this.root = fs.realpathSync(root);
    this.entry = safeRelativePath(entry);
    this.read(this.entry);
  }
  private checkPath(relative: string): string {
    let current = this.root;
    for (const part of relative.split('/')) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new ArtifactError('PATH_OUTSIDE_WORKSPACE', 'Symlinks are not allowed in artifact snapshots.');
    }
    const real = fs.realpathSync(current);
    if (!isPathWithin(this.root, real)) throw new ArtifactError('PATH_OUTSIDE_WORKSPACE', 'Resource is outside the authorized workspace.');
    return current;
  }
  private capture(relative: string): Captured {
    const extension = path.posix.extname(relative).toLowerCase();
    if (!media[extension]) throw new ArtifactError('INVALID_SOURCE', `Unsupported resource type: ${relative}`);
    let descriptor: number | undefined;
    try {
      const target = this.checkPath(relative);
      // NONBLOCK avoids hanging on FIFOs before the regular-file check.
      descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = fs.fstatSync(descriptor);
      if (!before.isFile()) throw new ArtifactError('INVALID_SOURCE', 'Artifact resources must be regular files.');
      const maxBytes = textExtensions.has(extension) ? ARTIFACT_LIMITS.textBytes : ARTIFACT_LIMITS.assetBytes;
      if (before.size > maxBytes) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact resource size limit exceeded.');
      // Bounded read even if a producer grows the file concurrently.
      const data = Buffer.alloc(before.size + 1);
      let length = 0;
      while (length < data.length) { const n = fs.readSync(descriptor, data, length, data.length - length, null); if (!n) break; length += n; }
      const after = fs.fstatSync(descriptor);
      const live = fs.statSync(this.checkPath(relative));
      if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || live.ino !== after.ino || live.dev !== after.dev) throw new ArtifactError('INVALID_SOURCE', 'Source changed while being snapshotted; publish again.');
      const bytes = data.subarray(0, length);
      const isText = textExtensions.has(extension);
      let content: string;
      try { content = isText ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes.toString('base64'); }
      catch { throw new ArtifactError('INVALID_SOURCE', `Source is not valid UTF-8: ${relative}`); }
      return { file: { path: relative, content, encoding: isText ? 'utf8' : 'base64', mediaType: media[extension] }, digest: hash(bytes), bytes: length, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs };
    } catch (error) {
      if (error instanceof ArtifactError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactError('INVALID_SOURCE', `Source file not found: ${relative}`);
      throw new ArtifactError('INVALID_SOURCE', `Source file cannot be read: ${relative}`);
    } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  read(name: string): ArtifactFile {
    const relative = safeRelativePath(name);
    const existing = this.captured.get(relative);
    if (existing) return { ...existing.file };
    const fold = relative.normalize('NFC').toLowerCase();
    if (this.folded.has(fold) && this.folded.get(fold) !== relative) throw new ArtifactError('INVALID_SOURCE', 'Case-colliding resource paths are not allowed.');
    if (this.captured.size >= ARTIFACT_LIMITS.files) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact file count limit exceeded.');
    const captured = this.capture(relative);
    const text = captured.file.encoding === 'utf8';
    if (this.textBytes + (text ? captured.bytes : 0) > ARTIFACT_LIMITS.textBytes || this.assetBytes + (text ? 0 : captured.bytes) > ARTIFACT_LIMITS.assetBytes) throw new ArtifactError('RESOURCE_LIMIT', 'Artifact snapshot size limit exceeded.');
    this.textBytes += text ? captured.bytes : 0; this.assetBytes += text ? 0 : captured.bytes;
    this.folded.set(fold, relative); this.captured.set(relative, captured);
    this.onCapture?.(this.files());
    return { ...captured.file };
  }
  resolve(importer: string, reference: string): ArtifactFile {
    const candidate = resolveReference(importer, reference);
    const candidates = path.posix.extname(candidate) ? [candidate] : [candidate, ...['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.css'].map(ext => candidate + ext), ...['/index.tsx', '/index.ts', '/index.jsx', '/index.js'].map(ext => candidate + ext)];
    for (const name of candidates) {
      try { this.checkPath(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue; throw error; }
      if (fs.lstatSync(path.join(this.root, name)).isDirectory()) continue;
      return this.read(name);
    }
    throw new ArtifactError('INVALID_SOURCE', `Source dependency not found: ${candidate}`);
  }
  files(): ArtifactFile[] { return [...this.captured.values()].map(c => ({ ...c.file })).sort((a, b) => a.path.localeCompare(b.path, 'en')); }
  verify(): void {
    for (const [name, old] of this.captured) {
      const fresh = this.capture(name);
      if (fresh.digest !== old.digest || fresh.dev !== old.dev || fresh.ino !== old.ino || fresh.mtimeMs !== old.mtimeMs || fresh.ctimeMs !== old.ctimeMs) throw new ArtifactError('INVALID_SOURCE', 'Source changed during compilation; regenerate the prototype.');
    }
  }
}
export function readSnapshot(root: string, entry: string): ArtifactSnapshot { return new ArtifactSnapshot(root, entry); }
