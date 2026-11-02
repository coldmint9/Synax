import { defineConfig } from "vitest/config";
import full from "./agent-runtime.vitest.config.js";
import { classifyAgentRuntimeTests } from "./agent-runtime-tier.js";

/** Unit tier: every agent-runtime test that does not boot the Rust supervisor.
 *
 * Inherits pool, worker bound and reporters from the full config so the tiers
 * cannot drift; only the file selection differs. */
export default defineConfig({
  ...full,
  test: {
    ...full.test,
    include: classifyAgentRuntimeTests().unit,
  },
});
