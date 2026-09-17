import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "api/server.ts",
    cli: "cli/index.ts",
    "workers/analyzer-worker": "api/services/analyzer/analyzer-worker.ts",
    "workers/scan-pipeline-worker.thread":
      "api/services/analyzer/scan-pipeline-worker.thread.ts",
    "workers/wiki-job-runner": "api/workers/wiki-job-runner.ts",
    "workers/agent-session-runner": "api/workers/agent-session-runner.ts",
  },
  format: ["cjs"],
  outDir: "server-dist",
  clean: false,
  dts: false,
  platform: "node",
  target: "node22",
  splitting: false,
  // These runtimes resolve package-relative resources and optional modules; ship them intact.
  noExternal: [
    /^(?!(?:@anthropic-ai\/claude-agent-sdk|playwright-core)(?:\/|$)).*/,
  ],
  external: [
    "libsql",
    "@libsql/*",
    "@anthropic-ai/claude-agent-sdk",
    "playwright-core",
  ],
  removeNodeProtocol: false,
});
