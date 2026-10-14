import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImmutablePayloads } from '../immutable-payloads.js';
import { VersionObjects } from '../../../modules/agent-runtime/checkpoints/version-store/objects.js';
import { versionDatabase } from '../../../modules/agent-runtime/__tests__/version-store-fixture.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function store() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-payloads-')); roots.push(root); return new ImmutablePayloads(root); }
describe('external version payloads', () => {
  it('publishes immutable bytes, deduplicates and detects corruption', () => {
    const payloads = store();
    const id = payloads.put(Buffer.from('body'));
    expect(payloads.put(Buffer.from('body'))).toBe(id);
    expect(payloads.get(id).toString()).toBe('body');
    fs.writeFileSync(path.join(payloads.root, id.slice(0, 2), id), 'oops');
    expect(() => payloads.get(id)).toThrow('checksum');
  });
  it('migrates old payloads without changing identity and retains referenced objects across rollback', () => {
    const db = versionDatabase();
    const migration = fs.readFileSync(new URL('../../database/migrations/0076_external_version_payloads.sql', import.meta.url), 'utf8');
    db.exec(migration);
    const budget = { maxBytes: 10_000_000, maxObjects: 1000 };
    const legacy = new VersionObjects(db, budget);
    const id = legacy.put('chunk', Buffer.from('old'));
    const objects = new VersionObjects(db, budget, undefined, store());
    expect(objects.externalize()).toBe(1);
    expect(objects.get(id).bytes.toString()).toBe('old');
    const child = objects.put('chunk', Buffer.from('new'));
    const parent = objects.put('record', Buffer.from('parent'), [child]);
    expect(objects.reclaim(child)).toBeNull();
    db.exec('BEGIN IMMEDIATE'); objects.reclaim(parent); db.exec('ROLLBACK');
    objects.collectPayloads();
    expect(objects.get(parent).references).toEqual([child]);
    objects.reclaim(parent); objects.reclaim(child); objects.collectPayloads();
    expect(() => objects.get(child)).toThrow('missing');
    expect(objects.get(id).bytes.toString()).toBe('old');
    db.close();
  });
});
