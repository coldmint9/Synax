import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
    server: 'api/server.ts',
    cli: 'cli/index.ts',
    'workers/analyzer-worker': 'api/services/analyzer/analyzer-worker.ts',
    'workers/scan-pipeline-worker.thread': 'api/services/analyzer/scan-pipeline-worker.thread.ts',
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
  // The native SDK resolves ESM-relative resources; it must not be folded into our CJS bundle.
  noExternal: [/^(?!@anthropic-ai\/claude-agent-sdk(?:\/|$)).*/],
  external: ['libsql', '@libsql/*', '@anthropic-ai/claude-agent-sdk'],
  removeNodeProtocol: false,
});
