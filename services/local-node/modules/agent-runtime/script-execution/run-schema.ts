import * as z from "zod/v4";
import { getScript } from "./cache.js";
import { hasBackgroundBashOperator } from "../tools/bash-command-policy.js";

const text = z.string().refine(value => !value.includes("\0"), "NUL bytes are not allowed");
const source = z.union([text.min(1).max(100_000), z.array(text.max(100_000)).min(1).max(10_000)])
  .refine(value => (Array.isArray(value) ? value.join("\n") : value).trim().length > 0, "source must not be blank")
  .refine(value => Buffer.byteLength(Array.isArray(value) ? value.join("\n") : value, "utf8") <= 100_000, "source exceeds 100000 UTF-8 bytes");

/** Root stays object for OpenAI-compatible providers; combinations checked here. */
export const runSchema = z.object({
  argv: z.array(text.max(16_000)).min(1).max(256).optional()
    .describe("Direct executable and literal arguments. No shell expansion, quoting, pipes or redirection. argv[0] must not be empty. Do not include args/language/source/scriptId."),
  language: z.enum(["sh", "python", "node"]).optional()
    .describe("Required with source. sh is POSIX /bin/sh (not Bash); node is ESM. Omit with argv or scriptId."),
  source: source.optional().describe("Script source or lines joined with newline, at most 100000 UTF-8 bytes. Sent directly to the interpreter, never written to a temporary source file. JSON string escaping still applies."),
  scriptId: text.min(1).max(160).optional()
    .describe("Reuse an immutable script returned by this session. Omit source/language/argv. References expire or disappear after worker restart; resubmit source on a cache miss. Reuse always checks permissions again."),
  args: z.array(text.max(16_000)).max(256).optional().describe("Literal script arguments; only with source or scriptId. Not shell-escaped."),
  workdir: text.min(1).max(4096).optional().describe("Existing workspace-relative directory or sandbox-permitted absolute directory. WSL uses the legacy bash tool."),
  stdin: z.string().max(1_000_000).optional().describe("Independent script/command data input, not source. At most 1 MB of text; never staged in a temporary data file."),
  timeoutMs: z.number().int().min(1000).max(600_000).optional().describe("Execution deadline in ms, including shell preflight; default 120000. Timeout preserves partial output. Inspect effects before retrying."),
  async: z.boolean().optional().describe("Return a managed commandTaskId before setup/resource waiting; completion is queued into the next step. Use command.manage wait/cancel, never rerun to poll. No detached/background services."),
}).strict().superRefine((args, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if ([args.argv, args.source, args.scriptId].filter(value => value !== undefined).length !== 1)
    fail("Provide exactly one of argv, source, or scriptId.");
  if (args.argv && (!args.argv[0] || !args.argv[0].trim() || args.args !== undefined || args.language !== undefined))
    fail("argv requires a non-empty executable and forbids args/language.");
  if (args.source !== undefined && !args.language) fail("source requires language.");
  if (args.scriptId !== undefined && args.language !== undefined) fail("scriptId already identifies its language; omit language.");
  if (args.language === "sh" && args.source !== undefined &&
      hasBackgroundBashOperator(Array.isArray(args.source) ? args.source.join("\n") : args.source))
    fail("Detached shell operators (&) are not supported. Use async:true for managed finite commands or bash for background services.");
});
export type RunArgs = z.infer<typeof runSchema>;

/** Resolve before approval: the durable receipt binds the exact source being approved.
 * The cache itself never contains a permission decision. No cache entry is created here. */
export function prepareRunArgs(sessionId: string, input: unknown): RunArgs {
  const args = runSchema.parse(input);
  if (args.scriptId) {
    const script = getScript(sessionId, args.scriptId);
    // Keep the reference in the normalized snapshot for the result/audit, but
    // do not re-parse the resolved object as a fresh source invocation (the
    // public schema intentionally requires exactly one execution mode).
    return { ...args, language: script.language, source: script.source } as RunArgs;
  }
  return { ...args, ...(Array.isArray(args.source) ? { source: args.source.join("\n") } : {}) };
}
