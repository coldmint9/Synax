import { Hono } from "hono";
import { businessStore } from "../../infrastructure/persistence/business-store.js";
import { subagentTemplates } from "../../modules/agent-runtime/subagent-templates.js";
import { customSubagentSchema } from "../../modules/agent-runtime/subagent-config.js";
import { ZodError } from "zod/v4";
import { AgentNotFoundError } from "../../modules/agent-runtime/runtime-errors.js";

export const subagentTemplateRoutes = new Hono();
subagentTemplateRoutes.onError((error, c) => c.json({ error: error.message },
  error instanceof ZodError ? 400 : error instanceof AgentNotFoundError ? 404 : 409));
subagentTemplateRoutes.use("*", async (c, next) => {
  await businessStore.refresh(["subagent-templates"]);
  await next();
  await businessStore.flush(["subagent-templates"]);
});
subagentTemplateRoutes.get("/", c => c.json({ items: subagentTemplates.list() }));
subagentTemplateRoutes.post("/", async c => c.json({ item: subagentTemplates.save(customSubagentSchema.parse(await c.req.json())) }, 201));
subagentTemplateRoutes.put("/:id", async c => c.json({ item: subagentTemplates.save(customSubagentSchema.parse(await c.req.json()), c.req.param("id")) }));
subagentTemplateRoutes.delete("/:id", c => {
  subagentTemplates.remove(c.req.param("id"));
  return c.json({ ok: true });
});
