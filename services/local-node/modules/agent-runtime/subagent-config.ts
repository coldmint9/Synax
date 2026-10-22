import * as z from "zod/v4";
const normalizeScope = (value: string) => value.split("/").filter(part => part && part !== ".").join("/");

const ids = z.array(z.string().trim().min(1).max(256)).max(64)
  .transform(values => [...new Set(values)]);
export const subagentProfileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(500).optional(),
  instructions: z.string().trim().min(1).max(16_000).optional(),
  access: z.enum(["inherit", "read-only"]).optional().describe("inherit automatically uses the parent's current permissions; read-only further restricts them. Never expands parent authorization."),
  capabilities: ids.optional().describe("Optional exact tool IDs. Omit to inherit the parent's available tools; nested delegation and primary workflow controls are excluded."),
  skillIds: ids.optional(),
  mcpServerIds: ids.optional(),
  writeScope: z.array(z.string().min(1).max(1024).refine(value => value === value.trim() &&
    !value.startsWith("/") && !value.startsWith("~") && !/[\\:*?%\x00-\x1f\x7f]/.test(value) &&
    !value.split("/").includes("..") && Boolean(normalizeScope(value)),
  "Use concrete workspace-relative files or directories, without traversal or globs.").transform(normalizeScope))
    .min(1).max(32).optional().describe("Optional file-write boundary, e.g. [\"client/src\"]. Scoped agents use native file tools; shell and external tools are unavailable because their write targets cannot be enforced."),
  model: z.string().trim().min(1).max(256).optional().describe("Optional provider/model ID. Omit to inherit the parent's model."),
  thinkingMode: z.enum(["fast", "standard", "deep"]).optional(),
}).strict();
export type SubagentProfileConfig = z.infer<typeof subagentProfileSchema>;

export const customSubagentSchema = subagentProfileSchema.extend({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  instructions: z.string().trim().min(1).max(16_000),
  access: z.enum(["inherit", "read-only"]).default("inherit"),
  enabled: z.boolean().default(true),
});
export type CustomSubagentInput = z.input<typeof customSubagentSchema>;
export type CustomSubagent = z.infer<typeof customSubagentSchema> & { id: string; createdAt: string; updatedAt: string };

export const subagentStartFields = {
  prompt: z.string().trim().min(1).max(100_000).describe("The focused task and expected deliverable."),
  name: z.string().trim().min(1).max(80).optional(),
  profile: subagentProfileSchema.optional().describe("Configure the general-purpose child for this task. No fixed explorer/reviewer roles. Omit fields to inherit the parent configuration."),
  templateId: z.string().min(1).max(128).optional().describe("ID of a user-selected custom subagent. Its instructions and restrictions are preserved."),
  deliverable: z.string().trim().min(1).max(4000).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
};
