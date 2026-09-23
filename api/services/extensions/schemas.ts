import * as z from 'zod/v4';
export const extensionKindSchema = z.enum(['tool', 'skill', 'mcp']);
const stringMap = z.record(z.string().max(256), z.string().max(8192));
const httpUrl = z
  .url()
  .refine(
    (value) =>
      ['http:', 'https:'].includes(new URL(value).protocol) &&
      !new URL(value).username &&
      !new URL(value).password,
    'Use an HTTP(S) URL without embedded credentials',
  );
export const mcpExtensionSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    command: z.string().max(4096).default(''),
    args: z.array(z.string().max(4096)).max(64).optional(),
    cwd: z.string().max(4096).optional(),
    env: stringMap.optional(),
    enabled: z.boolean().optional(),
    transport: z.enum(['stdio', 'http']).optional(),
    url: httpUrl.optional(),
    headers: stringMap.optional(),
  })
  .refine(
    (value) =>
      value.transport === 'http'
        ? Boolean(value.url)
        : Boolean(value.command.trim()),
    'A command or remote MCP URL is required',
  );
export const customToolSchema = z
  .object({
    mode: z.enum(['command', 'http']),
    command: z.string().max(4096).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    url: httpUrl.optional(),
    headers: stringMap.optional(),
    cwd: z.string().max(4096).optional(),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    inputSchema: z
      .record(z.string(), z.unknown())
      .refine(
        (value) => value.type === 'object',
        'Input schema must describe an object',
      ),
  })
  .refine(
    (value) =>
      value.mode === 'http'
        ? Boolean(value.url)
        : Boolean(value.command?.trim()),
    'A command or HTTP endpoint is required',
  );
export const customExtensionSchema = z
  .object({
    id: z.string().min(1).max(256).optional(),
    kind: extensionKindSchema,
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(4000),
    tool: customToolSchema.optional(),
    content: z
      .string()
      .max(256 * 1024)
      .optional(),
    mcp: mcpExtensionSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.kind === 'tool' && !value.tool) ||
      (value.kind === 'skill' && !value.content?.trim()) ||
      (value.kind === 'mcp' && !value.mcp)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide the configuration for the selected extension type',
      });
    }
  });
