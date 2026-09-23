import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "api/**/*.{test,spec}.{ts,tsx}",
      "cli/**/*.{test,spec}.{ts,tsx}",
      "electron/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    fileParallelism: false,
    env: {
      SYNAX_SCAN_IN_PROCESS: "1",
      SYNAX_WIKI_JOB_IN_PROCESS: "1",
      SYNAX_AGENT_SESSION_IN_PROCESS: "1",
      // Most fixtures explicitly opt into v3 history; keep ordinary fixture
      // sessions legacy so tests do not inherit production auto-native state.
      SYNAX_VERSION_HISTORY: "legacy",
    },
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/worktrees/**",
      "web/src/react/features/**/*.test.tsx",
    ],
  },
});
