import { Hono } from "hono";
import * as z from "zod/v4";
import { GitMrError } from "../../modules/git-mr/errors.js";
import { AgentRuntimeError } from "../../modules/agent-runtime/runtime-errors.js";
import { assertHistoryUnlocked } from "../../modules/agent-runtime/runtime-history.js";
import {
  RemotePrService,
  remotePrService,
} from "../../modules/remote-pr/service.js";
const id = z.string().trim().min(1).max(160);
const branch = z
  .string()
  .min(1)
  .max(250)
  .refine((v) => !v.startsWith("-") && !/[\x00-\x20]/.test(v));
const scope = z.object({
  rootId: id.optional(),
  remote: z.string().min(1).max(100),
  provider: z.enum(["github", "gitlab"]).optional(),
});
const create = scope
  .extend({
    requestId: id,
    title: z.string().trim().min(1).max(200),
    body: z.string().max(50000),
    head: branch,
    base: branch,
    draft: z.boolean(),
  })
  .strict();
const attach = scope
  .extend({ requestId: id, number: z.number().int().positive() })
  .strict();
const action = z
  .object({
    requestId: id,
    expectedRevision: z.number().int().positive(),
    expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    expectedBaseSha: z.string().regex(/^[a-f0-9]{40,64}$/),
    action: z.enum([
      "update_branch",
      "merge",
      "sync_local",
      "resolve_conflicts",
      "publish_resolution",
    ]),
    mergeMethod: z.enum(["merge", "squash", "rebase"]).optional(),
  })
  .strict();
export function createRemotePrRoutes(
  service: RemotePrService = remotePrService,
) {
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        { error: "远程 PR 输入无效。", code: "INVALID_INPUT" },
        400,
      );
    if (error instanceof GitMrError || error instanceof AgentRuntimeError)
      return c.json(
        { error: error.message, code: error.code },
        error.status as 400 | 403 | 404 | 409 | 422 | 500 | 502,
      );
    return c.json({ error: error.message, code: "PR_ERROR" }, 500);
  });
  routes.use("*", async (c, next) => {
    if (c.req.method !== "GET")
      assertHistoryUnlocked(c.req.param("sessionId")!);
    await next();
  });
  routes.get("/discovery", async (c) =>
    c.json(
      await service.discover(c.req.param("sessionId")!, c.req.query("rootId")),
    ),
  );
  routes.get("/requests", async (c) => {
    const query = scope
      .extend({ page: z.coerce.number().int().min(1).max(100).default(1) })
      .strict()
      .parse(c.req.query());
    return c.json(
      await service.list(c.req.param("sessionId")!, query, query.page),
    );
  });
  routes.post("/create", async (c) =>
    c.json(
      await service.create(
        c.req.param("sessionId")!,
        create.parse(await c.req.json()),
      ),
      201,
    ),
  );
  routes.post("/attach", async (c) =>
    c.json(
      await service.attach(
        c.req.param("sessionId")!,
        attach.parse(await c.req.json()),
      ),
      201,
    ),
  );
  routes.post("/push", async (c) =>
    c.json(
      await service.push(
        c.req.param("sessionId")!,
        scope
          .extend({
            expectedLocalHead: z.string().regex(/^[a-f0-9]{40,64}$/),
            branch,
          })
          .strict()
          .parse(await c.req.json()),
      ),
    ),
  );
  routes.get("/tasks/:objectId", async (c) =>
    c.json(
      await service.get(c.req.param("sessionId")!, c.req.param("objectId")),
    ),
  );
  routes.post("/tasks/:objectId/actions", async (c) =>
    c.json(
      await service.action(
        c.req.param("sessionId")!,
        c.req.param("objectId"),
        action.parse(await c.req.json()),
      ),
    ),
  );
  return routes;
}
