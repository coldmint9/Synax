import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Tool subprocesses run with a per-session HOME so caches stay out of the
 * repository without exposing the real user HOME.
 *
 * That directory name has to stay short. On macOS a unix socket path is capped
 * at 104 bytes (`sun_path`) and the Cua driver binds its daemon socket at
 * `$HOME/Library/Caches/cua-driver/cua-driver.sock`. A raw session id
 * (`ars_` + 32 hex chars) pushed that path past the limit, so the driver refused
 * to start inside every agent shell with
 * `bind ...: path must be shorter than SUN_LEN`, and the desktop skill had to be
 * worked around by hand.
 */
export const SESSION_HOME_NAME_MAX_LENGTH = 12;

/** Cua driver socket the session home must leave room for, relative to HOME. */
export const CUA_DRIVER_SOCKET_SUFFIX = "Library/Caches/cua-driver/cua-driver.sock";

/**
 * Directory name for a session home: short ids that are already filesystem safe
 * stay readable, anything else (long ids, separators, traversal) is replaced by a
 * stable digest of the full id.
 */
export function sessionHomeName(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (
    trimmed.length > 0 &&
    trimmed.length <= SESSION_HOME_NAME_MAX_LENGTH &&
    /^[A-Za-z0-9._-]+$/.test(trimmed) &&
    trimmed !== "." &&
    trimmed !== ".."
  ) {
    return trimmed;
  }
  return createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, SESSION_HOME_NAME_MAX_LENGTH);
}

/** Absolute per-session HOME, created on demand. */
export async function sessionHomeDir(
  dataRoot: string,
  sessionId: string,
): Promise<string> {
  const directory = path.join(dataRoot, "agent-home", sessionHomeName(sessionId));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}
