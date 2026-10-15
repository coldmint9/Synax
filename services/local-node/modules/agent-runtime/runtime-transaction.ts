import { getRawSqlite } from '../../infrastructure/database/index.js';
import {
  retryWriteLockAcquisition,
  runtimeWriteLockPolicy,
} from '../../infrastructure/database/write-contention.js';

/** Use Synax's compatibility wrapper, which supplies nested savepoints for libSQL. */
export function runtimeTransaction<T>(action: () => T): T {
  const db = getRawSqlite();
  const transaction = db.transaction(action);
  return retryWriteLockAcquisition(
    runtimeWriteLockPolicy(),
    () => transaction(),
    // A failed transaction is rolled back by the compatibility wrapper before
    // this callback returns, so the entire transaction can be retried safely.
    () => false,
  );
}
