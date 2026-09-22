import { readFileSync } from "node:fs";
import Database from "libsql";

export function versionDatabase(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;");
  db.exec(readFileSync(new URL("../../../db/migrations/0051_conversation_version_core.sql", import.meta.url), "utf8"));
  return db;
}
