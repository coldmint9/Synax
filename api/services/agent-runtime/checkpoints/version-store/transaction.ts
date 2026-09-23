import type Database from "libsql";
import { VersionStoreError } from "./limits.js";
import { assertTransactionSafe, rollbackAfterError } from "../../../../db/transaction-safety.js";

let savepointSequence = 0;

/** No awaits or filesystem IO may run inside this boundary. */
export function atomicVersionWrite<T>(db: Database.Database, action: () => T): T {
  assertTransactionSafe(db);
  const nested = db.inTransaction;
  const savepoint = `synax_version_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const result = action();
    if (result != null && typeof (result as { then?: unknown }).then === "function")
      throw new TypeError("Version transactions require a synchronous callback.");
    // An inner failure may have been caught by the caller. Never commit if its
    // rollback failed or SQLite implicitly aborted the entire outer transaction.
    assertTransactionSafe(db);
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    rollbackAfterError(db, error, nested ? savepoint : undefined);
    if (error instanceof Error && error.message.includes("VERSION_METADATA_BUDGET_EXCEEDED"))
      throw new VersionStoreError("VERSION_METADATA_BUDGET_EXCEEDED", "Version metadata budget exceeded; growth was rolled back.");
    throw error;
  }
}
