import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    env: {
      SYNAX_SCAN_IN_PROCESS: '1',
      SYNAX_WIKI_JOB_IN_PROCESS: '1',
      SYNAX_AGENT_SESSION_IN_PROCESS: '1',
    },
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      'web/src/react/features/**/*.test.tsx',
    ],
  },
});
