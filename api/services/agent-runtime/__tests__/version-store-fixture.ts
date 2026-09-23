import { VERSION_SCHEMA_MIGRATIONS } from "../checkpoints/version-store/schema.js";
import { readFileSync } from "node:fs";
import Database from "libsql";
import { atomicVersionWrite } from "../checkpoints/version-store/transaction.js";

export function versionDatabase(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
  db.exec("CREATE TABLE IF NOT EXISTS _version_test_migrations(file TEXT PRIMARY KEY)");
  for (const migration of VERSION_SCHEMA_MIGRATIONS) {
    if (db.prepare("SELECT 1 FROM _version_test_migrations WHERE file=?").get(migration)) continue;
    atomicVersionWrite(db, () => {
      db.exec(readFileSync(new URL(`../../../db/migrations/${migration}`, import.meta.url), "utf8"));
      db.prepare("INSERT INTO _version_test_migrations(file) VALUES(?)").run(migration);
    });
  }
  return db;
}
