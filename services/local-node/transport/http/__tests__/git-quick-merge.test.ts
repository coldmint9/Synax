import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createQuickMergeRoutes } from "../git-quick-merge.js";
import { GitMrError } from "../../../modules/git-mr/errors.js";
import type { QuickMergeService } from "../../../modules/git-quick-merge/service.js";

function fixture() {
  const service = {
    board: vi.fn().mockResolvedValue({ groups: [], rules: [] }),
    createGroup: vi.fn().mockResolvedValue({ id: "g", name: "发布" }),
    renameGroup: vi.fn().mockResolvedValue({ id: "g", name: "改名" }),
    deleteGroup: vi.fn().mockResolvedValue(undefined),
    createRule: vi.fn().mockResolvedValue({ id: "r" }),
    updateRule: vi.fn().mockResolvedValue({ id: "r" }),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    merge: vi.fn().mockResolvedValue({ id: "r", status: "merged" }),
    push: vi.fn().mockResolvedValue({ id: "r", status: "pushed" }),
  };
  const app = new Hono();
  app.route(
    "/api/projects/:projectId/git/quick-merge",
    createQuickMergeRoutes(
      () => ({ kind: "host", path: "/repo" }),
      service as unknown as QuickMergeService,
    ),
  );
  return { app, service };
}

const json = (value: unknown, method = "POST") => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

describe("quick merge HTTP contracts", () => {
  it("scopes the board to the URL project", async () => {
    const { app, service } = fixture();
    const response = await app.request("/api/projects/p/git/quick-merge");
    expect(response.status).toBe(200);
    expect(service.board).toHaveBeenCalledWith("p");
  });

  it("rejects unknown fields and empty branches", async () => {
    const { app, service } = fixture();
    const extra = await app.request(
      "/api/projects/p/git/quick-merge/rules",
      json({ groupId: "g", source: "feature/a", target: "test", title: "x" }),
    );
    expect(extra.status).toBe(400);
    const empty = await app.request(
      "/api/projects/p/git/quick-merge/rules",
      json({ groupId: "g", source: "", target: "test" }),
    );
    expect(empty.status).toBe(400);
    expect(service.createRule).not.toHaveBeenCalled();
  });

  it("creates rules and runs them with the resolved root", async () => {
    const { app, service } = fixture();
    const created = await app.request(
      "/api/projects/p/git/quick-merge/rules",
      json({ groupId: "g", source: "feature/a", target: "test", rootId: "root" }),
    );
    expect(created.status).toBe(201);
    expect(service.createRule).toHaveBeenCalledWith("p", {
      groupId: "g",
      source: "feature/a",
      target: "test",
      rootId: "root",
    });

    const merged = await app.request(
      "/api/projects/p/git/quick-merge/rules/r/merge",
      json({ rootId: "root" }),
    );
    expect(merged.status).toBe(200);
    expect(service.merge).toHaveBeenCalledWith("p", "r", { kind: "host", path: "/repo" });
  });

  it("keeps GitMrError statuses and codes on the wire", async () => {
    const { app, service } = fixture();
    service.merge.mockRejectedValue(
      new GitMrError("本地 test 与远端已分叉。不提供强制推送。", "DIVERGED", 409),
    );
    const response = await app.request(
      "/api/projects/p/git/quick-merge/rules/r/merge",
      json({}),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "DIVERGED" });
  });
});
