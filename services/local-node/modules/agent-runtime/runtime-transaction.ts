import { getRawSqlite } from '../../infrastructure/database/index.js';

/** Use Synax's compatibility wrapper, which supplies nested savepoints for libSQL. */
export function runtimeTransaction<T>(action: () => T): T {
  return getRawSqlite().transaction(action)();
}
