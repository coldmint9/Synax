import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalManager } from "./terminal-manager.js";

const mocks = vi.hoisted(() => ({
  listTerminalHistory: vi.fn(),
  historyCommandGlobal: vi.fn(),
}));
vi.mock("../../modules/agent-runtime/sidecar/runtime-facade.js", () => ({
  runtimeFacade: {
    listTerminalHistory: mocks.listTerminalHistory,
    historyCommandGlobal: mocks.historyCommandGlobal,
  },
}));

/** A record as the Rust sidecar stored it, with no PTY in this host process. */
function record(
  id: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    projectId,
    rootId: "primary",
    ownerSessionId: null,
    kind: "terminal",
    title: "Project",
    cwd: os.tmpdir(),
    shell: "/bin/sh",
    command: null,
    pid: 999_999,
    state: "active",
    exitCode: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_SOCKET", "/tmp/terminal-recovery.sock");
  vi.stubEnv("SYNAX_RUNTIME_SIDECAR_TOKEN", "terminal-recovery-token");
  mocks.historyCommandGlobal.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("recovered terminal records", () => {
  it("reports a terminal from an earlier host run as ended instead of live", async () => {
    mocks.listTerminalHistory.mockResolvedValue([
      record("recovered", "project-recovered"),
    ]);

    const [item] = await terminalManager.listAuthoritative("project-recovered");

    expect(item.state).toBe("unconfirmed");
    expect(item.endedAt).not.toBeNull();
    // The persisted id still resolves, but it can never take input again.
    expect(() =>
      terminalManager.write(item.id, "ls\n", "request-id-0001"),
    ).toThrow("This terminal has ended. Open a new terminal.");
  });

  it("keeps an explicitly ended record ended", async () => {
    mocks.listTerminalHistory.mockResolvedValue([
      record("ended", "project-ended", {
        state: "closed",
        endedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    const [item] = await terminalManager.listAuthoritative("project-ended");

    expect(item.state).toBe("closed");
    expect(item.endedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("closes a recovered record once its recorded process is confirmed gone", async () => {
    mocks.listTerminalHistory.mockResolvedValue([
      record("stale", "project-stale"),
    ]);
    await terminalManager.listAuthoritative("project-stale");

    await terminalManager.stop("stale");

    expect(terminalManager.get("stale").state).toBe("closed");
  });
});
