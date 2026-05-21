import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    fileParallelism: false,
    exclude: [
      ...configDefaults.exclude,
      '**/.claude/worktrees/**',
      'web/src/react/features/**/*.test.tsx',
    ],
  },
})
