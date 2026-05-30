import { cpSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const serverDist = join(root, 'server-dist');
const src = join(root, 'node_modules');

// Place a package.json in server-dist so require() resolves correctly
writeFileSync(
  join(serverDist, 'package.json'),
  JSON.stringify({ name: 'synax-server', private: true })
);
console.log('  wrote server-dist/package.json');

// Create a better-sqlite3 shim that re-exports libsql.
// drizzle-orm/better-sqlite3 driver imports 'better-sqlite3' at runtime,
// but libsql provides an API-compatible replacement.
const dest = join(serverDist, 'node_modules');
mkdirSync(dest, { recursive: true });

const shimDir = join(dest, 'better-sqlite3');
mkdirSync(shimDir, { recursive: true });
writeFileSync(
  join(shimDir, 'package.json'),
  JSON.stringify({ name: 'better-sqlite3', version: '0.0.0', main: 'index.js' })
);
writeFileSync(
  join(shimDir, 'index.js'),
  'module.exports = require("libsql");\n'
);
console.log('  created better-sqlite3 shim -> libsql');

// Copy libsql and its dependencies
const libsqlPackages = ['libsql', '@neon-rs/load', 'detect-libc'];
const libsqlPlatforms = readdirSync(src).filter(
  (d) => d.startsWith('@libsql')
);

// Copy @libsql scoped packages (platform binaries)
for (const scope of libsqlPlatforms) {
  const scopeSrc = join(src, scope);
  const scopeDest = join(dest, scope);
  try {
    cpSync(scopeSrc, scopeDest, { recursive: true });
    console.log(`  copied ${scope}`);
  } catch (e: any) {
    console.warn(`  skip ${scope}: ${e.message}`);
  }
}

// Copy libsql main package
for (const pkg of libsqlPackages) {
  try {
    cpSync(join(src, pkg), join(dest, pkg), { recursive: true });
    console.log(`  copied ${pkg}`);
  } catch (e: any) {
    console.warn(`  skip ${pkg}: ${e.message}`);
  }
}

// tree-sitter packages use dynamic import() at runtime
const dynamicPackages = [
  'tree-sitter',
  'node-gyp-build',
  'node-addon-api',
];

const treeSitterLangs = readdirSync(src).filter(
  (d) => d.startsWith('tree-sitter-') && d !== 'tree-sitter'
);

for (const pkg of [...dynamicPackages, ...treeSitterLangs]) {
  try {
    cpSync(join(src, pkg), join(dest, pkg), { recursive: true });
    console.log(`  copied ${pkg}`);
  } catch (e: any) {
    console.warn(`  skip ${pkg}: ${e.message}`);
  }
}

console.log('native modules ready.');
