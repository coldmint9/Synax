import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['api/server.ts'],
  format: ['cjs'],
  outDir: 'server-dist',
  clean: true,
  dts: false,
  platform: 'node',
  target: 'node24',
  splitting: false,
  noExternal: [/.*/],
  removeNodeProtocol: false,
});
