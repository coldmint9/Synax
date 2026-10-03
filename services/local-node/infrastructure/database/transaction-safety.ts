/** A failed rollback makes transaction nesting unknowable. Keep this shared by
 * raw version writes and the application's compatibility transaction wrapper. */
const unsafeConnections = new WeakSet<object>();
export class TransactionUnsafeError extends Error {
  readonly code = "SQLITE_TRANSACTION_UNSAFE";
  constructor(cause?: unknown) {
    super("Unsafe transaction state; reopen the database connection before writing.", { cause });
    this.name = "TransactionUnsafeError";
  }
}
export function poisonTransaction(connection: object): void {
  unsafeConnections.add(connection);
}
export function assertTransactionSafe(connection: object): void {
  if (unsafeConnections.has(connection)) throw new TransactionUnsafeError();
}

/** Preserve errors such as SQLITE_FULL when SQLite already rolled back. A failed
 * savepoint rollback, or an implicit abort beyond it, must fence later writes. */
export function rollbackAfterError(
  connection: { open: boolean; inTransaction: boolean; exec(sql: string): unknown },
  error: unknown,
  savepoint?: string,
): void {
  if (connection.open && connection.inTransaction) {
    try {
      if (savepoint) {
        connection.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        connection.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else connection.exec("ROLLBACK");
    } catch (rollbackError) {
      poisonTransaction(connection);
      throw new TransactionUnsafeError(new AggregateError([error, rollbackError], "Transaction action and rollback failed."));
    }
  } else if (savepoint) {
    poisonTransaction(connection);
  }
}
