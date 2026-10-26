import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../contracts.js";
import type { ProjectWorkspaceRoot } from "../../project-workspace.js";

const store = vi.hoisted(() => ({
  current: null as AgentSession | null,
  hydrated: null as AgentSession | null,
  hydrateCalls: 0,
}));

vi.mock("../session-store.js", () => ({
  agentRuntimeStore: {
    tryGetSession: () => store.current ?? undefined,
    hydrateSessionSummary: async () => {
      store.hydrateCalls += 1;
      store.current = store.hydrated;
    },
  },
}));

const { clearSessionWorkspaceRoot, resolveSessionWorkspaceRoots } = await import("../tools/workspace.js");
const { syncWorkerSessionBinding } = await import("../session-binding-sync.js");

const projectId = "binding-sync-project";
let directory = "";
let main = "";
let worktree = "";

function session(workspacePath: string): AgentSession {
  const root: ProjectWorkspaceRoot = {
    id: projectId,
    name: "Synax",
    role: "primary",
    path: workspacePath,
    status: "available",
  };
  return {
    id: "binding-sync-session",
    projectId,
    sessionMetadata: {
      backend: {
        workspaceRoots: [root],
        workspaceLocation: { kind: "host", path: workspacePath },
        workDir: workspacePath,
        workspaceBindingRevision: 1,
      },
    },
  } as unknown as AgentSession;
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synax-binding-sync-")));
  main = path.join(directory, "main");
  worktree = path.join(directory, "worktree");
  fs.mkdirSync(main);
  fs.mkdirSync(worktree);
  store.current = session(main);
  store.hydrated = session(worktree);
  store.hydrateCalls = 0;
  clearSessionWorkspaceRoot("binding-sync-session");
  resolveSessionWorkspaceRoots("binding-sync-session", projectId);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("worker session binding sync", () => {
  it("re-reads the binding a worker switched and drops the cached roots", async () => {
    expect(resolveSessionWorkspaceRoots("binding-sync-session", projectId)[0].path).toBe(main);
    // Until the worker's patch is mirrored this process keeps the old checkout.
    expect(resolveSessionWorkspaceRoots("binding-sync-session", projectId)[0].path).toBe(main);

    await syncWorkerSessionBinding({
      type: "session_changed",
      sessionId: "binding-sync-session",
      patch: { sessionMetadata: { backend: { workDir: worktree } } },
    });

    expect(store.hydrateCalls).toBe(1);
    expect(resolveSessionWorkspaceRoots("binding-sync-session", projectId)[0].path).toBe(worktree);
  });

  it("ignores events that cannot move a session's checkout", async () => {
    await syncWorkerSessionBinding({
      type: "session_changed",
      sessionId: "binding-sync-session",
      patch: { sessionMetadata: { title: "Renamed" } },
    });
    await syncWorkerSessionBinding({
      type: "session_step_completed",
      sessionId: "binding-sync-session",
    });

    expect(store.hydrateCalls).toBe(0);
    expect(resolveSessionWorkspaceRoots("binding-sync-session", projectId)[0].path).toBe(main);
  });

  it("follows a cached copy that changed without an event", () => {
    expect(resolveSessionWorkspaceRoots("binding-sync-session", projectId)[0].path).toBe(main);

    store.current = session(worktree);

    expect(resolveSessionWorkspaceRoots("binding-sync-session", projectId)[0].path).toBe(worktree);
  });
});
