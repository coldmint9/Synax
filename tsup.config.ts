import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
    server: 'api/server.ts',
    'workers/wiki-job-runner': 'api/workers/wiki-job-runner.ts',
    'workers/agent-session-runner': 'api/workers/agent-session-runner.ts',
  },
  format: ['cjs'],
  outDir: 'server-dist',
  clean: false,
  dts: false,
  platform: 'node',
  target: 'node22',
  splitting: false,
  noExternal: [/.*/],
  external: ['libsql', '@libsql/*'],
  removeNodeProtocol: false,
});
