import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/** Content-addressed payloads are immutable. SQLite keeps only the reference;
 * a failed transaction may leave an orphan, never a reference to partial bytes. */
export class ImmutablePayloads {
  constructor(readonly root: string) {}
  put(bytes: Uint8Array): string {
    const hash = createHash('sha256').update(bytes).digest('hex');
    this.ensureDirectory(this.root);
    const dir = path.join(this.root, hash.slice(0, 2));
    this.ensureDirectory(dir);
    const file = path.join(dir, hash);
    if (fs.existsSync(file)) { this.get(hash, bytes.byteLength); return hash; }
    const temporary = path.join(dir, `.${hash}-${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const size = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset);
        if (!size) throw new Error('Payload short write.');
        offset += size;
      }
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      // link is atomic and never overwrites an object another writer published.
      try { fs.linkSync(temporary, file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; this.get(hash, bytes.byteLength); }
      this.syncDirectory(dir);
      return hash;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  get(hash: string, maxBytes = 65536): Buffer {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid payload reference.');
    const dir = path.join(this.root, hash.slice(0, 2));
    for (const directory of [this.root, dir]) if (!fs.lstatSync(directory).isDirectory()) throw new Error('Invalid payload directory.');
    const fd = fs.openSync(path.join(dir, hash), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('Payload size/type is invalid.');
      const bytes = fs.readFileSync(fd);
      if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Payload checksum mismatch.');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  remove(hash: string): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid payload reference.');
    const dir = path.join(this.root, hash.slice(0, 2));
    try {
      if (!fs.lstatSync(this.root).isDirectory() || !fs.lstatSync(dir).isDirectory()) throw new Error('Invalid payload directory.');
      fs.unlinkSync(path.join(dir, hash));
      this.syncDirectory(dir);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private ensureDirectory(dir: string): void {
    let created = false;
    try { created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid payload directory.');
    if (created) this.syncDirectory(path.dirname(dir));
  }
  private syncDirectory(dir: string): void {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}
