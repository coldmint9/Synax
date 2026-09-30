import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { fileGlobTool } from "./file-glob.js";
import { grepSearchTool } from "./grep-search.js";

const rgArgsSchema = z
  .object({
    mode: z
      .enum(["search", "files"])
      .default("search")
      .describe("Search text (default) or list matching files."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Text or regex pattern when mode is search. Fixed-string unless regex=true; never begin it with "-".',
      ),
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Glob pattern when mode is files, e.g. "web/src/**/*.tsx". Not interchangeable with query.',
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Workspace-relative file or directory; defaults to the workspace root.",
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe("Max results (default 50; search caps at 200, files at 300)."),
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
      .max(5)
      .optional()
      .describe("Context lines around each match (default 0)."),
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
    'Accepts { mode?: "search" | "files", query?: string, pattern?: string, path?: string, limit?: number, caseSensitive?: boolean, regex?: boolean, filePattern?: string, excludePattern?: string, contextLines?: number, wordBoundary?: boolean, multiline?: boolean }. Default mode is search; query is required for search and pattern for mode=files, and the two are not interchangeable. path defaults to the workspace root, so narrow it to keep searches fast. limit caps at 200 for search and 300 for files. Examples: { "query": "Dialog", "path": "web/src/react/components/ui" } literal search inside one folder; { "query": "(?:--color|--bg|:root)", "regex": true, "filePattern": "*.css" } regex alternation, which silently returns nothing when regex is omitted; { "query": "resolveWorkspacePath", "wordBoundary": true, "contextLines": 2, "filePattern": "*.ts", "excludePattern": "*.test.ts" }; { "mode": "files", "pattern": "web/src/**/*.tsx" }. Pitfalls: set regex=true for ( ) | [ ] . * ? + alternations or character classes, otherwise the query is matched literally and reports no hits; never begin query or pattern with "-" (write (?:--color) instead of --color) because ripgrep reads a leading dash as a command-line flag and fails with an unrecognized-flag error.',
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
    if (mode === "files") {
      return fileGlobTool.execute({
        ...input,
        args: { ...forwarded, pattern },
      });
    }
    return grepSearchTool.execute({
      ...input,
      args: forwarded,
    });
  },
};
