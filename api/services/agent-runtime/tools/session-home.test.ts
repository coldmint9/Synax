import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUA_DRIVER_SOCKET_SUFFIX,
  SESSION_HOME_NAME_MAX_LENGTH,
  sessionHomeDir,
  sessionHomeName,
} from "./session-home.js";

/** The id shape real agent sessions use (`ars_` + 32 hex chars). */
const REAL_SESSION_ID = "ars_e7e687c5b99744acba34e1651b6175d1";
/** macOS caps a unix socket path at 104 bytes (`sun_path`, NUL included). */
const SUN_PATH_LIMIT = 104;
/**
 * A stock install data root. Deliberately not `os.homedir()`: the ambient HOME of
 * a test process is itself the session home under test.
 */
const STOCK_DATA_ROOT = "/Users/example/.synax";

describe("sessionHomeName", () => {
  it("keeps short filesystem-safe ids readable", () => {
    expect(sessionHomeName("chat-42")).toBe("chat-42");
    expect(sessionHomeName("  abc  ")).toBe("abc");
  });

  it("compresses a long session id into a bounded, stable name", () => {
    const name = sessionHomeName(REAL_SESSION_ID);
    expect(name).toHaveLength(SESSION_HOME_NAME_MAX_LENGTH);
    expect(name).toMatch(/^[a-f0-9]+$/);
    expect(sessionHomeName(REAL_SESSION_ID)).toBe(name);
    expect(sessionHomeName(`${REAL_SESSION_ID}x`)).not.toBe(name);
  });

  it("never yields a traversal or separator name", () => {
    for (const id of ["../escape", "a/b", "..", ".", "", "   "]) {
      const name = sessionHomeName(id);
      expect(name).not.toContain("/");
      expect(name).not.toBe(".");
      expect(name).not.toBe("..");
      expect(name.length).toBeLessThanOrEqual(SESSION_HOME_NAME_MAX_LENGTH);
    }
  });
});

describe("session home leaves room for the Cua driver socket", () => {
  it("keeps $HOME/Library/Caches/cua-driver/cua-driver.sock under the unix limit", () => {
    // Regression: with the raw session id as the directory name this path reached
    // 109 bytes on a stock `~/.synax` install and the Cua driver refused to start
    // ("bind ...: path must be shorter than SUN_LEN") inside every agent shell.
    const rawPath = path.join(
      STOCK_DATA_ROOT,
      "agent-home",
      REAL_SESSION_ID,
      CUA_DRIVER_SOCKET_SUFFIX,
    );
    const fixedPath = path.join(
      STOCK_DATA_ROOT,
      "agent-home",
      sessionHomeName(REAL_SESSION_ID),
      CUA_DRIVER_SOCKET_SUFFIX,
    );

    expect(Buffer.byteLength(rawPath)).toBeGreaterThanOrEqual(SUN_PATH_LIMIT);
    expect(Buffer.byteLength(fixedPath)).toBeLessThan(SUN_PATH_LIMIT);
  });

  it("bounds the suffix it appends to any data root", () => {
    const suffix = path.join(
      "agent-home",
      sessionHomeName(REAL_SESSION_ID),
      CUA_DRIVER_SOCKET_SUFFIX,
    );
    // A stock `~/.synax` root is 17 bytes, so 70 leaves 17 bytes of headroom.
    expect(Buffer.byteLength(suffix)).toBeLessThanOrEqual(70);
  });

  it("creates the per-session HOME directory on demand", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "synax-session-home-"));
    try {
      const home = await sessionHomeDir(root, REAL_SESSION_ID);
      expect(home).toBe(path.join(root, "agent-home", sessionHomeName(REAL_SESSION_ID)));
      const info = await stat(home);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
