import fs from "node:fs";
import path from "node:path";
import NativeDatabase from "libsql";
import { auditIndexes } from "../services/local-node/infrastructure/storage/index-audit.js";

const root = process.argv[2] ?? process.env.DATA_ROOT;
if (!root) throw new Error("Pass DATA_ROOT or a data-root path as the first argument.");

const dbPath = path.join(path.resolve(root), "context.db");
if (!fs.existsSync(dbPath)) throw new Error(`Database does not exist: ${dbPath}`);

const db = new NativeDatabase(dbPath, { readonly: true });
try {
  process.stdout.write(`${JSON.stringify({ dbPath, ...auditIndexes(db) }, null, 2)}\n`);
} finally {
  db.close();
}
