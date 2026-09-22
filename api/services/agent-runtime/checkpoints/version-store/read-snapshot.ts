import type Database from "libsql";
import {
  assertTransactionSafe,
  rollbackAfterError,
} from "../../../../db/transaction-safety.js";

/** One synchronous bounded page sees a fixed WAL snapshot. Never keep this open
 * across an await/HTTP stream; long readers require a durable version pin instead. */
export function readVersionSnapshot<T>(
  db: Database.Database,
  read: () => T,
): T {
  const existing = db.inTransaction;
  if (!existing) db.exec("BEGIN");
  try {
    const value = read();
    if (
      value != null &&
      typeof (value as { then?: unknown }).then === "function"
    )
      throw new TypeError("Version read snapshots must be synchronous.");
    if (!existing) {
      assertTransactionSafe(db);
      db.exec("COMMIT");
    }
    return value;
  } catch (error) {
    if (!existing) rollbackAfterError(db, error);
    throw error;
  }
}
