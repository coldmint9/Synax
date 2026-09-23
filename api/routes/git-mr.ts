import { Hono } from "hono";
import * as z from "zod/v4";
import type { WorkspaceLocation } from "../services/workspace-location.js";
import { gitMrService, type GitMrService } from "../services/git-mr/service.js";
import { GitMrError } from "../services/git-mr/errors.js";
import { GitWorkspaceError } from "../services/git-workspaces.js";

const checkSchema = z
  .object({
    id: z.string().min(1).max(80),
    executable: z
      .string()
      .min(1)
      .max(500)
      .refine((value) => !value.includes("\0")),
    args: z.array(z.string().max(4096)).max(100),
    timeoutMs: z.number().int().min(1000).max(600000),
  })
  .strict();
export const mrInputSchema = z
  .object({
    rootId: z.string().max(100).optional(),
    title: z.string().trim().min(1).max(200),
    target: z.string().min(1).max(250),
    sources: z.array(z.string().min(1).max(250)).min(1).max(30),
    strategy: z.enum(["merge_commit", "squash", "ff_only"]),
    checks: z
      .array(checkSchema)
      .max(10)
      .refine(
        (checks) =>
          new Set(checks.map((check) => check.id)).size === checks.length,
        "Check IDs must be unique.",
      )
      .optional(),
    autoFinalize: z.boolean().optional(),
    allowCheckedOutTarget: z.boolean().optional(),
  })
  .strict();
const versionSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
const fileSchema = z
  .object({
    expectedRevision: z.string().min(1).max(100),
    content: z
      .string()
      .max(2 * 1024 * 1024)
      .optional(),
    choice: z.enum(["target", "source", "delete"]).optional(),
    resolve: z.boolean(),
    resolutionState: z.unknown().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.choice ? value.content === undefined : value.content !== undefined,
    "Provide either content or a whole-file choice.",
  );
export function createGitMrRoutes(
  resolveRoot: (projectId: string, rootId?: string) => WorkspaceLocation,
  service: GitMrService = gitMrService,
) {
  const routes = new Hono();
  routes.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: "Invalid merge request input.",
          details: error.flatten(),
          code: "INVALID_INPUT",
        },
        400,
      );
    if (error instanceof GitMrError)
      return c.json(
        { error: error.message, code: error.code },
        error.status as 400 | 404 | 409 | 500,
      );
    if (error instanceof GitWorkspaceError)
      return c.json(
        { error: error.message, code: "WORKSPACE_ERROR" },
        error.status as 400 | 404 | 409 | 500,
      );
    if (error instanceof SyntaxError)
      return c.json(
        { error: "Invalid JSON body.", code: "INVALID_INPUT" },
        400,
      );
    return c.json({ error: error.message, code: "GIT_MR_ERROR" }, 500);
  });
  routes.use("*", async (c, next) => {
    const projectId = c.req.param("projectId")!;
    resolveRoot(projectId, c.req.query("rootId"));
    await next();
  });
  routes.get("/", async (c) =>
    c.json(await service.list(c.req.param("projectId")!)),
  );
  routes.post("/", async (c) => {
    const input = mrInputSchema.parse(await c.req.json());
    return c.json(
      await service.create(
        c.req.param("projectId")!,
        resolveRoot(c.req.param("projectId")!, input.rootId),
        input,
      ),
      201,
    );
  });
  routes.get("/presets", async (c) =>
    c.json(await service.presets(c.req.param("projectId")!)),
  );
  routes.post("/presets", async (c) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(120), input: mrInputSchema })
      .strict()
      .parse(await c.req.json());
    resolveRoot(c.req.param("projectId")!, body.input.rootId);
    return c.json(
      await service.savePreset(
        c.req.param("projectId")!,
        body.name,
        body.input,
      ),
      201,
    );
  });
  routes.delete("/presets/:presetId", async (c) => {
    await service.deletePreset(
      c.req.param("projectId")!,
      c.req.param("presetId"),
    );
    return c.json({ ok: true });
  });
  routes.post("/presets/:presetId/run", async (c) => {
    const projectId = c.req.param("projectId")!,
      preset = await service.preset(projectId, c.req.param("presetId"));
    return c.json(
      await service.runPreset(
        projectId,
        preset.id,
        resolveRoot(projectId, preset.input.rootId),
      ),
    );
  });
  routes.get("/:id", async (c) =>
    c.json(await service.get(c.req.param("projectId")!, c.req.param("id"))),
  );
  for (const operation of [
    "prepare",
    "continue",
    "checks",
    "finalize",
    "cancel",
    "resume",
  ] as const) {
    routes.post(`/:id/${operation}`, async (c) => {
      const { expectedVersion } = versionSchema.parse(await c.req.json());
      return c.json(
        await service[operation](
          c.req.param("projectId")!,
          c.req.param("id"),
          expectedVersion,
        ),
      );
    });
  }
  routes.get("/:id/files", async (c) =>
    c.json(await service.files(c.req.param("projectId")!, c.req.param("id"))),
  );
  routes.get("/:id/files/:fileId", async (c) =>
    c.json(
      await service.file(
        c.req.param("projectId")!,
        c.req.param("id"),
        c.req.param("fileId"),
      ),
    ),
  );
  routes.put("/:id/files/:fileId", async (c) =>
    c.json(
      await service.saveFile(
        c.req.param("projectId")!,
        c.req.param("id"),
        c.req.param("fileId"),
        fileSchema.parse(await c.req.json()),
      ),
    ),
  );
  routes.get("/:id/proposals", async (c) =>
    c.json(
      await service.proposals(c.req.param("projectId")!, c.req.param("id")),
    ),
  );
  routes.post("/:id/proposals/:proposalId/apply", async (c) => {
    const { expectedVersion } = versionSchema.parse(await c.req.json());
    return c.json(
      await service.applyProposal(
        c.req.param("projectId")!,
        c.req.param("id"),
        c.req.param("proposalId"),
        expectedVersion,
      ),
    );
  });
  routes.post("/:id/agent-session", async (c) => {
    const { createGitMrAgentSession } =
      await import("../services/agent-runtime/git/session.js");
    return c.json(
      await createGitMrAgentSession(
        c.req.param("projectId")!,
        c.req.param("id"),
      ),
      201,
    );
  });
  return routes;
}
