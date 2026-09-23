import { Hono } from "hono";
import { describe, it, expect, vi } from "vitest";
import { createGitMrRoutes } from "../git-mr.js";
import { GitMrError } from "../../services/git-mr/errors.js";
import type { GitMrService } from "../../services/git-mr/service.js";
function fixture() {
  const service = {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: "mr", version: 1 }),
    get: vi.fn(),
    saveFile: vi.fn(),
    finalize: vi.fn(),
    resume: vi.fn().mockResolvedValue({ id: "mr", status: "ready" }),
  };
  const app = new Hono();
  app.route(
    "/api/projects/:projectId/git/mr",
    createGitMrRoutes(
      () => ({ kind: "host", path: "/repo" }),
      service as unknown as GitMrService,
    ),
  );
  return { app, service };
}
const json = (value: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
describe("MR HTTP contracts", () => {
  it("scopes list to URL project", async () => {
    const { app, service } = fixture();
    expect((await app.request("/api/projects/p/git/mr")).status).toBe(200);
    expect(service.list).toHaveBeenCalledWith("p");
  });
  it("rejects unexpected path and command fields", async () => {
    const { app, service } = fixture();
    const response = await app.request(
      "/api/projects/p/git/mr",
      json({
        title: "x",
        target: "main",
        sources: ["feature/a"],
        strategy: "merge_commit",
        repository: "/other",
      }),
    );
    expect(response.status).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it("creates a local MR with validated scope", async () => {
    const { app, service } = fixture();
    const input = {
      title: "x",
      target: "main",
      sources: ["feature/a"],
      strategy: "merge_commit",
    };
    expect(
      (await app.request("/api/projects/p/git/mr", json(input))).status,
    ).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      "p",
      { kind: "host", path: "/repo" },
      input,
    );
  });
  it("requires versions and returns domain conflict codes", async () => {
    const { app, service } = fixture();
    expect(
      (await app.request("/api/projects/p/git/mr/m/finalize", json({}))).status,
    ).toBe(400);
    service.finalize.mockRejectedValue(
      new GitMrError("Target moved", "STALE_PLAN"),
    );
    const response = await app.request(
      "/api/projects/p/git/mr/m/finalize",
      json({ expectedVersion: 2 }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Target moved",
      code: "STALE_PLAN",
    });
  });
  it("rejects ambiguous binary/text saves and invalid check parameters", async () => {
    const { app, service } = fixture();
    const response = await app.request("/api/projects/p/git/mr/m/files/f", {
      ...json({
        expectedRevision: "r",
        content: "x",
        choice: "target",
        resolve: true,
      }),
      method: "PUT",
    });
    expect(response.status).toBe(400);
    expect(service.saveFile).not.toHaveBeenCalled();
    expect(
      (
        await app.request(
          "/api/projects/p/git/mr",
          json({
            title: "x",
            target: "main",
            sources: ["a"],
            strategy: "merge_commit",
            checks: [
              { id: "x", executable: "npm", args: "test", timeoutMs: 5 },
            ],
          }),
        )
      ).status,
    ).toBe(400);
  });
  it("exposes explicit recovery with optimistic version checking", async () => {
    const { app, service } = fixture();
    expect(
      (
        await app.request(
          "/api/projects/p/git/mr/m/resume",
          json({ expectedVersion: 3 }),
        )
      ).status,
    ).toBe(200);
    expect(service.resume).toHaveBeenCalledWith("p", "m", 3);
  });
});
