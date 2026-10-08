import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    server: "services/local-node/entrypoints/http-server.ts",
    "services/cloud-node/server": "services/cloud-node/server.ts",
    cli: "cli/index.ts",
    "workers/code-mode": "services/local-node/modules/agent-runtime/code-mode/worker.mjs",
    "workers/agent-session-runner": "services/worker/jobs/agent-session-runner.ts",
  },
  format: ["cjs"],
  outDir: "server-dist",
  clean: false,
  dts: false,
  platform: "node",
  target: "node22",
  // runtimeAsset() has an explicit CJS fallback based on the bundle entry path.
  define: { "import.meta.url": "undefined" },
  splitting: false,
  // These runtimes resolve package-relative resources and optional modules; ship them intact.
  noExternal: [
    /^(?!(?:pdfjs-dist|@anthropic-ai\/claude-agent-sdk|playwright-core|node-pty|trash|@vscode\/ripgrep-universal)(?:\/|$)).*/,
  ],
  external: [
    "pdfjs-dist",
    "pdfjs-dist/*",
    "libsql",
    "node-pty",
    "@libsql/*",
    "@anthropic-ai/claude-agent-sdk",
    "playwright-core",
    "trash",
    "@vscode/ripgrep-universal",
  ],
  removeNodeProtocol: false,
});
