import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ dataRoot: "" }));
vi.mock("../lib/env.js", () => ({
  get DATA_ROOT() {
    return fixture.dataRoot;
  },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../services/context/context-service.js", () => ({
  contextService: {},
}));
vi.mock("../db/index.js", () => ({ getRawSqlite: vi.fn() }));
vi.mock("../services/agent-runtime/session-store.js", () => ({
  agentRuntimeStore: { listSessions: () => [] },
}));
vi.mock("../services/git-workspaces.js", () => ({
  GitWorkspaceError: class extends Error {
    constructor(
      message: string,
      public status = 400,
    ) {
      super(message);
    }
  },
  createGitWorktree: vi.fn(),
  listGitWorkspaces: vi.fn(),
  pruneGitWorktrees: vi.fn(),
  removeGitWorktree: vi.fn(),
}));
vi.mock("../services/wsl.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/wsl.js")>();
  return {
    ...actual,
    canonicalizeWslPath: vi.fn(async (_distribution: string, value: string) =>
      path.posix.normalize(value),
    ),
    listWslDistributions: vi.fn(async () => [
      { name: "Ubuntu", version: 2, default: true },
      { name: "Debian", version: 2, default: false },
    ]),
  };
});

let routes: (typeof import("./projects.js"))["projectRoutes"];

beforeEach(async () => {
  fixture.dataRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "synax-wsl-projects-"),
  );
  fs.writeFileSync(
    path.join(fixture.dataRoot, "projects.json"),
    JSON.stringify({ items: [] }),
  );
  vi.resetModules();
  ({ projectRoutes: routes } = await import("./projects.js"));
});

async function create(roots: unknown[]) {
  return routes.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "WSL workspace", roots }),
  });
}

describe("WSL workspace projects", () => {
  it("persists distribution plus Linux paths without exposing UNC paths", async () => {
    const response = await create([
      {
        location: {
          kind: "wsl",
          distribution: "Ubuntu",
          path: "/home/dev/app",
        },
        name: "app",
      },
      {
        location: {
          kind: "wsl",
          distribution: "Ubuntu",
          path: "/home/dev/lib",
        },
        name: "lib",
      },
    ]);
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.project.source).toEqual({
      kind: "wsl",
      distribution: "Ubuntu",
      path: "/home/dev/app",
    });
    expect(
      body.roots.map((root: any) => ({
        path: root.path,
        location: root.location,
      })),
    ).toEqual([
      {
        path: "/home/dev/app",
        location: {
          kind: "wsl",
          distribution: "Ubuntu",
          path: "/home/dev/app",
        },
      },
      {
        path: "/home/dev/lib",
        location: {
          kind: "wsl",
          distribution: "Ubuntu",
          path: "/home/dev/lib",
        },
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("wsl.localhost");
  });

  it("rejects roots from different WSL distributions", async () => {
    const response = await create([
      {
        location: {
          kind: "wsl",
          distribution: "Ubuntu",
          path: "/home/dev/app",
        },
      },
      {
        location: {
          kind: "wsl",
          distribution: "Debian",
          path: "/home/dev/lib",
        },
      },
    ]);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/same WSL distribution/i),
    });
  });
});
