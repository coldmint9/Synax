import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";
import RuntimeTestProgress from "./runtime-test-progress.js";

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["services/local-node/modules/agent-runtime/**/*.{test,spec}.{ts,tsx}"],
    // Each file owns a temporary data root and Rust supervisor. Bound concurrency
    // because process lifecycle tests also start children of their own.
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 4,
    reporters: ["default", new RuntimeTestProgress(), "hanging-process"],
  },
});
