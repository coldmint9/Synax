import { externalCommandEnvironment } from "../local-node/infrastructure/runtime/command-environment.js";

/** Run before Vite resolves modules and again before each test file imports code. */
export function prepareTestProcessEnvironment(): void {
  const hostRuntime = Boolean(
    process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR === "1" ||
    process.env.SYNAX_RUNTIME_SIDECAR_SOCKET,
  );
  const binary = hostRuntime ? undefined : process.env.SYNAX_RUNTIME_SIDECAR_BIN;
  const clean = externalCommandEnvironment();
  for (const key of Object.keys(process.env)) {
    if (!(key in clean)) delete process.env[key];
  }
  // Preserve a custom test executable only outside a desktop host. Connections
  // and storage locations must always be created by the fixture itself.
  if (binary) process.env.SYNAX_RUNTIME_SIDECAR_BIN = binary;
  delete process.env.DATA_ROOT;
  process.env.NODE_ENV = "test";
  // Each test file may boot its own Rust supervisor; the default info stream is
  // megabytes of structured logs that hide failures without affecting timing.
  // Set RUST_LOG before the run to debug (for example RUST_LOG=debug).
  if (!process.env.RUST_LOG) process.env.RUST_LOG = "error";
}
