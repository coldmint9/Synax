import type Database from "libsql";
import { VersionStoreError } from "./limits.js";

let savepointSequence = 0;

/** No awaits or filesystem IO may run inside this boundary. */
export function atomicVersionWrite<T>(db: Database.Database, action: () => T): T {
  const nested = db.inTransaction;
  const savepoint = `synax_version_${++savepointSequence}`;
  db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  try {
    const result = action();
    if (result != null && typeof (result as { then?: unknown }).then === "function")
      throw new TypeError("Version transactions require a synchronous callback.");
    db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (nested) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); }
      finally { db.exec(`RELEASE SAVEPOINT ${savepoint}`); }
    } else {
      db.exec("ROLLBACK");
    }
    if (error instanceof Error && error.message.includes("VERSION_METADATA_BUDGET_EXCEEDED"))
      throw new VersionStoreError("VERSION_METADATA_BUDGET_EXCEEDED", "Version metadata budget exceeded; growth was rolled back.");
    throw error;
  }
}
