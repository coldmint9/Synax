import type Database from 'libsql';

/** libsql's run() steps once. A row-producing statement must reach SQLITE_DONE
 * before COMMIT, even when the caller intentionally discards RETURNING rows. */
export function runToCompletion(db: Database.Database, statement: Database.Statement, args: unknown[]) {
  if (!statement.reader) return statement.run(...args);
  // Drain without retaining potentially large RETURNING result sets.
  for (const _row of statement.iterate(...args)) { /* finish the statement */ }
  const result = db.prepare('SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowid').get() as {
    changes: number; lastInsertRowid: number | bigint;
  };
  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
}
