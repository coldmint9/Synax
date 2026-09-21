import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readSnapshot } from '../snapshot.js';
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-snapshot-')); fs.writeFileSync(path.join(root, 'index.html'), '<p>Snapshot</p>'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it.each(['../secret', '/etc/passwd', '%2e%2e/secret', '%252e%252e/secret', 'C:\\secret', '.env', 'index.html\0'])('rejects unsafe paths %s', source => { expect(() => readSnapshot(root, source)).toThrow(); });
it('rejects symlinks and detects source mutation', () => {
  fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'link.html'));
  expect(() => readSnapshot(root, 'link.html')).toThrow();
  const snapshot = readSnapshot(root, 'index.html');
  expect(snapshot.files()[0].content).toContain('Snapshot');
  fs.writeFileSync(path.join(root, 'index.html'), '<p>Changed</p>');
  expect(() => snapshot.verify()).toThrow();
});
it('bounds text size and file count, rejects sensitive files and case collisions', () => {
  fs.writeFileSync(path.join(root,'too-big.js'),'x'.repeat(2*1024*1024+1));
  expect(() => readSnapshot(root,'too-big.js')).toThrow(/limit/i);
  fs.writeFileSync(path.join(root,'secret.key'),'secret'); expect(() => readSnapshot(root,'secret.key')).toThrow();
  fs.writeFileSync(path.join(root,'config.json'),'{}');
  const snapshot = readSnapshot(root,'index.html'); snapshot.read('config.json');
  fs.writeFileSync(path.join(root,'CONFIG.json'),'{}'); expect(() => snapshot.read('CONFIG.json')).toThrow(/collid/i);
  for (let i=0; i<98; i++) { fs.writeFileSync(path.join(root,`file${i}.js`),'1'); snapshot.read(`file${i}.js`); }
  fs.writeFileSync(path.join(root,'extra.js'),'1'); expect(() => snapshot.read('extra.js')).toThrow(/count limit/i);
});
