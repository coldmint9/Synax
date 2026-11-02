import path from "node:path";

const INTERNAL_ENV = new Set([
  "AGENT_SESSION_INIT",
  "SYNAX_AGENT_SESSION_CHILD",
  "SYNAX_RECORDED_START",
  "SYNAX_TERMINAL_HOST_ORIGIN",
]);

/** External commands must not inherit the host's runtime identity or credentials.
 * Internal agent workers use their own explicit fork environment instead. */
export function externalCommandEnvironment(
  overrides?: NodeJS.ProcessEnv,
  inherit = true,
): NodeJS.ProcessEnv {
  const env = { ...(inherit ? process.env : {}), ...overrides };
  const runtimeRoot = process.env.SYNAX_RUNTIME_DATA_ROOT;
  const internalHost = Boolean(
    runtimeRoot || process.env.SYNAX_RUNTIME_SIDECAR_SOCKET ||
    process.env.SYNAX_RUNTIME_SIDECAR_SUPERVISOR === "1" ||
    process.env.SYNAX_AGENT_SESSION_CHILD === "1",
  );
  if (env.DATA_ROOT && (
    (runtimeRoot && path.resolve(env.DATA_ROOT) === path.resolve(runtimeRoot)) ||
    (internalHost && env.DATA_ROOT === process.env.DATA_ROOT)
  )) delete env.DATA_ROOT;
  // bash passes a copy of process.env as overrides. Equal values still belong
  // to the host; explicit command assignments happen later, inside the shell.
  if (internalHost && env.NODE_ENV === process.env.NODE_ENV) delete env.NODE_ENV;
  for (const key of Object.keys(env)) {
    if (key.startsWith("SYNAX_RUNTIME_") || INTERNAL_ENV.has(key)) delete env[key];
  }
  return env;
}
