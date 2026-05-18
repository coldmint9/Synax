import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['api/server.ts'],
  format: ['cjs'],
  outDir: 'server-dist',
  clean: true,
  dts: false,
  platform: 'node',
  target: 'node22',
  splitting: false,
  noExternal: [/.*/],
  removeNodeProtocol: false,
});
