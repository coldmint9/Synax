import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const shimDir = join(root, 'node_modules', 'better-sqlite3');

mkdirSync(shimDir, { recursive: true });
writeFileSync(
  join(shimDir, 'package.json'),
  JSON.stringify({ name: 'better-sqlite3', version: '0.0.0-shim', main: 'index.js' })
);
writeFileSync(
  join(shimDir, 'index.js'),
  'module.exports = require("libsql");\n'
);
console.log('better-sqlite3 shim -> libsql (for drizzle-orm compatibility)');
