import { Hono } from "hono";
import * as z from "zod/v4";
import type { WorkspaceLocation } from "../../modules/workspace-location.js";
import { GitMrError } from "../../modules/git-mr/errors.js";
import { GitWorkspaceError } from "../../modules/git-workspaces.js";
import { quickMergeService, type QuickMergeService } from "../../modules/git-quick-merge/service.js";

const branch = z.string().trim().min(1).max(250);
const rootId = z.string().max(100).optional();

const groupInput = z.object({ rootId, name: z.string().trim().min(1).max(60) }).strict();
const ruleInput = z.object({ rootId, groupId: z.string().min(1).max(160), source: branch, target: branch }).strict();
const ruleUpdate = z.object({ source: branch, target: branch }).strict();
const runInput = z.object({ rootId }).strict();

export function createQuickMergeRoutes(
  resolveRoot: (projectId: string, rootId?: string) => WorkspaceLocation,
  service: QuickMergeService = quickMergeService,
) {
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        { error: "Invalid quick-merge input.", details: error.flatten(), code: "INVALID_INPUT" },
        400,
      );
    if (error instanceof GitMrError)
      return c.json({ error: error.message, code: error.code }, error.status as 400 | 404 | 409 | 500);
    if (error instanceof GitWorkspaceError)
      return c.json({ error: error.message, code: "WORKSPACE_ERROR" }, error.status as 400 | 404 | 409 | 500);
    if (error instanceof SyntaxError)
      return c.json({ error: "Invalid JSON body.", code: "INVALID_INPUT" }, 400);
    return c.json({ error: error.message, code: "QUICK_MERGE_ERROR" }, 500);
  });

  routes.get("/", async (c) => c.json(await service.board(c.req.param("projectId")!)));

  routes.post("/groups", async (c) => {
    const projectId = c.req.param("projectId")!;
    const input = groupInput.parse(await c.req.json());
    resolveRoot(projectId, input.rootId);
    return c.json(await service.createGroup(projectId, input), 201);
  });
  routes.patch("/groups/:groupId", async (c) => {
    const input = z.object({ name: z.string().trim().min(1).max(60) }).strict().parse(await c.req.json());
    return c.json(await service.renameGroup(c.req.param("projectId")!, c.req.param("groupId")!, input.name));
  });
  routes.delete("/groups/:groupId", async (c) => {
    await service.deleteGroup(c.req.param("projectId")!, c.req.param("groupId")!);
    return c.body(null, 204);
  });

  routes.post("/rules", async (c) => {
    const projectId = c.req.param("projectId")!;
    const input = ruleInput.parse(await c.req.json());
    resolveRoot(projectId, input.rootId);
    return c.json(await service.createRule(projectId, input), 201);
  });
  routes.put("/rules/:ruleId", async (c) => {
    const input = ruleUpdate.parse(await c.req.json());
    return c.json(await service.updateRule(c.req.param("projectId")!, c.req.param("ruleId")!, input));
  });
  routes.delete("/rules/:ruleId", async (c) => {
    await service.deleteRule(c.req.param("projectId")!, c.req.param("ruleId")!);
    return c.body(null, 204);
  });

  routes.post("/rules/:ruleId/merge", async (c) => {
    const projectId = c.req.param("projectId")!;
    const input = runInput.parse((await c.req.json().catch(() => ({}))) ?? {});
    return c.json(
      await service.merge(projectId, c.req.param("ruleId")!, resolveRoot(projectId, input.rootId)),
    );
  });
  routes.post("/rules/:ruleId/push", async (c) => {
    const projectId = c.req.param("projectId")!;
    const input = runInput.parse((await c.req.json().catch(() => ({}))) ?? {});
    return c.json(
      await service.push(projectId, c.req.param("ruleId")!, resolveRoot(projectId, input.rootId)),
    );
  });

  return routes;
}
