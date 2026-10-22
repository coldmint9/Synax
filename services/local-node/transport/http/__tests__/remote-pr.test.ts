import { Hono } from "hono";
import { it, expect, vi } from "vitest";
vi.mock("../../../modules/agent-runtime/runtime-history.js", () => ({
  assertHistoryUnlocked: vi.fn(),
}));
vi.mock("../../../modules/remote-pr/service.js", () => ({
  remotePrService: {},
}));
import { createRemotePrRoutes } from "../remote-pr.js";
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
it("scopes all remote actions and rejects client path/token overrides", async () => {
  const service = {
    create: vi.fn().mockResolvedValue({}),
    action: vi.fn().mockResolvedValue({}),
    list: vi.fn().mockResolvedValue({ items: [] }),
    discover: vi.fn(),
  };
  const app = new Hono();
  app.route(
    "/sessions/:sessionId/git-pr",
    createRemotePrRoutes(service as any),
  );
  const create = {
    requestId: "r",
    remote: "origin",
    provider: "github",
    title: "Title",
    body: "body",
    head: "feature/a",
    base: "main",
    draft: true,
  };
  expect(
    (await app.request("/sessions/owner/git-pr/create", json(create))).status,
  ).toBe(201);
  expect(service.create).toHaveBeenCalledWith("owner", create);
  for (const extra of [
    { path: "/other" },
    { token: "secret" },
    { host: "evil.example" },
    { projectId: "other" },
  ])
    expect(
      (
        await app.request(
          "/sessions/owner/git-pr/create",
          json({ ...create, ...extra }),
        )
      ).status,
    ).toBe(400);
  const action = {
    requestId: "m",
    expectedRevision: 1,
    expectedHeadSha: "a".repeat(40),
    expectedBaseSha: "b".repeat(40),
    action: "merge",
  };
  expect(
    (
      await app.request(
        "/sessions/owner/git-pr/tasks/task/actions",
        json(action),
      )
    ).status,
  ).toBe(200);
  expect(service.action).toHaveBeenCalledWith("owner", "task", action);
  expect(
    (
      await app.request(
        "/sessions/owner/git-pr/tasks/task/actions",
        json({ ...action, expectedHeadSha: undefined }),
      )
    ).status,
  ).toBe(400);
});
