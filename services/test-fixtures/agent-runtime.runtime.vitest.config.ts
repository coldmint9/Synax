import { defineConfig } from "vitest/config";
import full from "./agent-runtime.vitest.config.js";
import { classifyAgentRuntimeTests } from "./agent-runtime-tier.js";

/** Runtime tier: the agent-runtime tests that boot the real Rust supervisor.
 *
 * These own a temporary data root and a sidecar process, so they stay on the
 * inherited four-worker bound; shard them for deadline-bound runs. */
export default defineConfig({
  ...full,
  test: {
    ...full.test,
    include: classifyAgentRuntimeTests().runtime,
  },
});
