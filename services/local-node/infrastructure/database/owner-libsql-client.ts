import type { Client, InStatement, InArgs, ResultSet, TransactionMode } from '@libsql/client';
import { connectStorageOwner, type OwnerConnection } from './owner-client.js';

/** Preserve Drizzle's async facade without opening a second native file writer.
 * Transactions use their own IPC connection, so unrelated async callers cannot
 * accidentally join an open transaction. */
export function createOwnerClient(databasePath: string): Client {
  const connection = connectStorageOwner(databasePath);
  let closed = false;
  const transactions = new Set<OwnerConnection>();
  function execute(db: OwnerConnection, input: InStatement, args?: InArgs): ResultSet {
    const sql = typeof input === 'string' ? input : input.sql;
    const bindings = typeof input === 'string' ? args : input.args;
    const result = db.executeStatement(sql, Array.isArray(bindings) ? bindings : bindings ? [bindings] : []);
    const rows = result.rows.map(values => {
      const row = [...values] as unknown as ResultSet['rows'][number];
      result.columns.forEach((name, index) => Object.defineProperty(row, name, { value: values[index], enumerable: true }));
      return row;
    });
    return { ...result, rows, toJSON() { return { ...result, lastInsertRowid: result.lastInsertRowid?.toString() }; } };
  }
  const begin = (db: OwnerConnection, mode?: TransactionMode) => db.exec(mode === 'read' || mode === 'deferred' ? 'BEGIN DEFERRED' : 'BEGIN IMMEDIATE');
  const client = {
    protocol: 'file',
    get closed() { return closed; },
    async execute(input: InStatement, args?: InArgs) { return execute(connection, input, args); },
    async executeMultiple(sql: string) { connection.exec(sql); },
    async batch(inputs: Array<InStatement | [string, InArgs?]>, mode?: TransactionMode) {
      const db = connectStorageOwner(databasePath);
      try {
        begin(db, mode);
        const result = inputs.map(input => Array.isArray(input) ? execute(db, input[0], input[1]) : execute(db, input));
        db.exec('COMMIT'); return result;
      } catch (error) { if (db.inTransaction) db.exec('ROLLBACK'); throw error; }
      finally { db.close(); }
    },
    async migrate(inputs: InStatement[]) { return client.batch(inputs, 'write'); },
    async transaction(mode?: TransactionMode) {
      const db = connectStorageOwner(databasePath);
      transactions.add(db);
      let done = false;
      const finish = () => { done = true; transactions.delete(db); db.close(); };
      try { begin(db, mode); } catch (error) { finish(); throw error; }
      return {
        get closed() { return done; },
        async execute(input: InStatement) { return execute(db, input); },
        async batch(inputs: InStatement[]) { return inputs.map(input => execute(db, input)); },
        async executeMultiple(sql: string) { db.exec(sql); },
        async commit() { try { db.exec('COMMIT'); } finally { finish(); } },
        async rollback() { try { if (db.inTransaction) db.exec('ROLLBACK'); } finally { finish(); } },
        close() { if (!done) { try { if (db.inTransaction) db.exec('ROLLBACK'); } finally { finish(); } } },
      };
    },
    close() {
      if (closed) return; closed = true;
      for (const db of transactions) db.close();
      transactions.clear(); connection.close();
    },
    async sync() { throw new Error('Local storage owner does not use remote replication.'); },
    reconnect() { throw new Error('Recreate the local storage client after a connection failure.'); },
  };
  return client as unknown as Client;
}
