import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "services/**/*.{test,spec}.{ts,tsx}",
      "packages/**/*.{test,spec}.{ts,tsx}",
      "cli/**/*.{test,spec}.{ts,tsx}",
      "cua-helper/**/*.{test,spec}.ts",
      "electron/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    fileParallelism: false,
    env: {
      SYNAX_AGENT_SESSION_IN_PROCESS: "1",
      // Most fixtures explicitly opt into v3 history; keep ordinary fixture
      // sessions legacy so tests do not inherit production auto-native state.
      SYNAX_VERSION_HISTORY: "legacy",
    },
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/worktrees/**",
      "client/src/react/features/**/*.test.tsx",
    ],
  },
});
