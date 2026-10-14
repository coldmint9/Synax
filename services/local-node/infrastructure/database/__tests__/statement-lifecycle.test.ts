import NativeDatabase from 'libsql';
import { describe, expect, it } from 'vitest';
import { runToCompletion } from '../statement-lifecycle.js';

describe('row-producing run lifecycle', () => {
  it.each(['INSERT INTO entries VALUES (1),(2),(3) RETURNING id', 'PRAGMA journal_mode'])('finishes %s before commit', (sql) => {
    const db = new NativeDatabase(':memory:');
    try {
      db.exec('CREATE TABLE entries(id INTEGER); BEGIN IMMEDIATE');
      const statement = db.prepare(sql);
      runToCompletion(db, statement, []);
      expect(() => db.exec('COMMIT')).not.toThrow();
      // The same statement can be reused; it does not strand the next reader.
      runToCompletion(db, statement, []);
      expect(() => db.exec('BEGIN; SELECT 1; COMMIT')).not.toThrow();
      if (sql.startsWith('INSERT')) expect(db.prepare('SELECT count(*) AS n FROM entries').get()).toMatchObject({ n: 6 });
    } finally { db.close(); }
  });
  it('preserves changes and insert identity without executing the write twice', () => {
    const db = new NativeDatabase(':memory:');
    try {
      db.exec('CREATE TABLE entries(id INTEGER PRIMARY KEY, value TEXT); BEGIN');
      expect(runToCompletion(db, db.prepare('INSERT INTO entries(value) VALUES (?), (?) RETURNING id'), ['a', 'b']))
        .toMatchObject({ changes: 2, lastInsertRowid: 2 });
      db.exec('COMMIT');
      expect(db.prepare('SELECT value FROM entries').all()).toEqual([{ value: 'a' }, { value: 'b' }]);
    } finally { db.close(); }
  });
});
