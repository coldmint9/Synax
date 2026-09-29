import { defineConfig } from "tsup";

/**
 * The Computer Use helper is a separate process with its own permission identity,
 * so it gets its own build (and its own resource directory) instead of sharing
 * `server-dist` with the API sidecar.
 *
 * `@trycua/cua-driver` and its UniFFI natives must stay external: they resolve
 * package-relative native libraries and are copied verbatim by
 * `scripts/copy-native-modules.ts`.
 */
export default defineConfig({
  entry: { "cua-helper": "cua-helper/main.ts" },
  format: ["cjs"],
  outDir: "cua-helper-dist",
  clean: false,
  dts: false,
  platform: "node",
  target: "node22",
  splitting: false,
  noExternal: [/^(?!@trycua\/|@ubjs\/)/],
  external: ["@trycua/cua-driver", /^@trycua\//, /^@ubjs\//],
  removeNodeProtocol: false,
});
