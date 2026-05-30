import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['api/server.ts'],
  format: ['cjs'],
  outDir: 'server-dist',
  clean: false,
  dts: false,
  platform: 'node',
  target: 'node22',
  splitting: false,
  noExternal: [/.*/],
  external: ['libsql', 'better-sqlite3', '@libsql/*'],
  removeNodeProtocol: false,
});
