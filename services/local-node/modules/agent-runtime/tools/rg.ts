import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { fileGlobTool } from "./file-glob.js";
import { grepSearchTool } from "./grep-search.js";

const rgArgsSchema = z
  .object({
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    includeIgnored: z.boolean().optional(),
    mode: z
      .enum(["search", "files"])
      .default("search")
      .describe("Search text (default) or list matching files."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Text or regex pattern required when mode is search. Fixed-string unless regex=true. Leading hyphens are passed as pattern text, not CLI options.',
      ),
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Glob pattern when mode is files, e.g. "client/src/**/*.tsx". Not interchangeable with query.',
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "File or directory relative to the session working directory (default .), or an absolute path permitted by the sandbox. mode=files requires a directory.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Requested maximum results (search default 50, effective cap 200; files default 100, effective cap 300)."),
    caseSensitive: z
      .boolean()
      .optional()
      .describe("Case-sensitive search (default false)."),
    regex: z
      .boolean()
      .optional()
      .describe(
        "Treat query as regex (default false = fixed-string); set it for ( ) | [ ] . * ? + patterns.",
      ),
    filePattern: z
      .string()
      .optional()
      .describe('Include glob, e.g. "*.ts" or "src/**/*.tsx".'),
    excludePattern: z
      .string()
      .optional()
      .describe('Exclude glob, e.g. "*.test.ts" or "node_modules".'),
    contextLines: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Requested context lines around each match (default 0, effective cap 5)."),
    wordBoundary: z
      .boolean()
      .optional()
      .describe("Match whole words only (default false)."),
    multiline: z
      .boolean()
      .optional()
      .describe("Enable multiline matching (default false)."),
  })
  .superRefine((value, context) => {
    if (value.mode === "search" && !value.query) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "query is required when mode is search.",
      });
    }
    if (value.mode === "files" && !value.pattern) {
      context.addIssue({
        code: "custom",
        path: ["pattern"],
        message: "pattern is required when mode is files.",
      });
    }
  });

export const rgTool: RegisteredTool = {
  id: "rg",
  label: "rg",
  description:
    "Search workspace text as literal or regex patterns (mode=search, the default) or list files by glob (mode=files) using Synax's bundled ripgrep, with grep and Node.js compatibility fallbacks. Matching is fixed-string unless regex=true, and case-insensitive unless caseSensitive=true.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  progressiveDetails:
    "Accepts { mode?: \"search\" | \"files\", query?: string, pattern?: string, path?: string, limit?: number, caseSensitive?: boolean, regex?: boolean, filePattern?: string, excludePattern?: string, contextLines?: number, wordBoundary?: boolean, multiline?: boolean }. Default mode is search; query is required for search and pattern for mode=files, and the two are not interchangeable. path defaults to the workspace root, so narrow it to keep searches fast. limit is a requested maximum with an effective cap of 200 for search and 300 for files; contextLines is a requested value with an effective cap of 5. Examples: { \"query\": \"Dialog\", \"path\": \"client/src/react/components/ui\" } literal search inside one folder; { \"query\": \"(?:--color|--bg|:root)\", \"regex\": true, \"filePattern\": \"*.css\" } regex alternation, which silently returns nothing when regex is omitted; { \"query\": \"resolveWorkspacePath\", \"wordBoundary\": true, \"contextLines\": 2, \"filePattern\": \"*.ts\", \"excludePattern\": \"*.test.ts\" }; { \"mode\": \"files\", \"pattern\": \"client/src/**/*.tsx\" }. Pitfalls: set regex=true for ( ) | [ ] . * ? + alternations or character classes, otherwise the query is matched literally and reports no hits. Search mode requires query; files mode requires pattern. Files mode ignores text-search options, including query. Search limit defaults to 50; files limit defaults to 100; both report effectiveLimit after applying the mode-specific cap. Leading hyphens are safely passed as patterns. Match and context previews are capped at 240 characters; previewMetadata/contextBeforeMetadata/contextAfterMetadata report truncated and originalLength. Use file.read for complete current text before patching a truncated preview.",
  inputSchema: rgArgsSchema,
  getPattern(args) {
    const value = args as { mode?: string; query?: string; pattern?: string };
    return value.mode === "files" ? value.pattern : value.query;
  },
  execute(input) {
    const args = input.args as {
      mode?: "search" | "files";
      query?: string;
      pattern?: string;
      [key: string]: unknown;
    };
    const { mode = "search", pattern, ...forwarded } = args;
    const limitCap = mode === "files" ? 300 : 200;
    const effectiveLimit = Math.min(
      (typeof forwarded.limit === "number" ? forwarded.limit : mode === "files" ? 100 : 50),
      limitCap,
    );
    const effectiveContextLines = mode === "files" ? 0 : Math.min(
      typeof forwarded.contextLines === "number" ? forwarded.contextLines : 0,
      5,
    );
    const boundedArgs = {
      ...forwarded,
      limit: effectiveLimit,
      contextLines: effectiveContextLines,
    };
    if (mode === "files") {
      return Promise.resolve(fileGlobTool.execute({
        ...input,
        args: { ...boundedArgs, pattern },
      })).then((execution) => ({
        ...execution,
        result: {
          ...(execution.result as Record<string, unknown>),
          effectiveLimit,
          effectiveContextLines,
        },
      }));
    }
    return Promise.resolve(grepSearchTool.execute({
      ...input,
      args: boundedArgs,
    })).then((execution) => ({
      ...execution,
      result: {
        ...(execution.result as Record<string, unknown>),
        effectiveLimit,
        effectiveContextLines,
      },
    }));
  },
};
