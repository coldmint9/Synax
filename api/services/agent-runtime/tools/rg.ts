import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { fileGlobTool } from "./file-glob.js";
import { grepSearchTool } from "./grep-search.js";

const rgArgsSchema = z
  .object({
    mode: z
      .enum(["search", "files"])
      .default("search")
      .describe("Search text or list matching files."),
    query: z
      .string()
      .min(1)
      .optional()
      .describe("Text or regex pattern when mode is search."),
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe("Glob pattern when mode is files."),
    path: z.string().min(1).optional(),
    limit: z.number().int().positive().max(300).optional(),
    caseSensitive: z.boolean().optional(),
    regex: z.boolean().optional(),
    filePattern: z.string().optional(),
    excludePattern: z.string().optional(),
    contextLines: z.number().int().min(0).max(5).optional(),
    wordBoundary: z.boolean().optional(),
    multiline: z.boolean().optional(),
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
    "Search workspace text or list matching files using Synax's bundled ripgrep, with grep and Node.js compatibility fallbacks.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  progressiveDetails:
    'Accepts { mode?: "search" | "files", query?: string, pattern?: string, path?: string, limit?: number, caseSensitive?: boolean, regex?: boolean, filePattern?: string, excludePattern?: string, contextLines?: number, wordBoundary?: boolean, multiline?: boolean }. Default mode is search. Use mode=files to find files by glob pattern.',
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
