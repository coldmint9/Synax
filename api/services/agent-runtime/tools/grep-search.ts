import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./exec-async.js";
import { resolveRipgrep, RIPGREP_MISSING_HELP } from "./ripgrep.js";
import * as z from "zod/v4";
import type { RegisteredTool, ToolExecutionResult } from "../contracts.js";
import { resolveWorkspacePath, toWorkspaceRelative } from "./workspace.js";

export const grepSearchTool: RegisteredTool = {
  id: "grep.search",
  label: "Search Text",
  description:
    "Fast workspace text search backed by bundled ripgrep, with grep as a compatibility fallback. Supports regex, glob filters, context lines, word boundary, and multiline matching.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  progressiveDetails:
    "Accepts { query: string, path?: string, limit?: number, caseSensitive?: boolean, regex?: boolean, filePattern?: string, excludePattern?: string, contextLines?: number, wordBoundary?: boolean, multiline?: boolean }. Returns matching lines with file path, line number, preview text, and optional context lines.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Text or regex pattern to search for."),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Workspace-relative path to search under."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max matches (default 50)."),
    caseSensitive: z
      .boolean()
      .optional()
      .describe("Case-sensitive search (default false)."),
    regex: z
      .boolean()
      .optional()
      .describe("Treat query as regex (default false = fixed-string)."),
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
      .describe("Context lines around match (default 0)."),
    wordBoundary: z
      .boolean()
      .optional()
      .describe("Match whole words only (default false)."),
    multiline: z
      .boolean()
      .optional()
      .describe("Enable multiline matching (default false)."),
  }),
  execute(input) {
    const args = input.args as {
      query?: string;
      path?: string;
      limit?: number;
      caseSensitive?: boolean;
      regex?: boolean;
      filePattern?: string;
      excludePattern?: string;
      contextLines?: number;
      wordBoundary?: boolean;
      multiline?: boolean;
    };
    if (!args?.query)
      throw new Error(
        "query is required. Provide a text or regex pattern to search for. " +
          "Available options: query (required), path, limit, caseSensitive, regex, filePattern, excludePattern, contextLines, wordBoundary, multiline.",
      );
    const requested = resolveWorkspacePath(args.path ?? ".", input.sessionId);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const contextLines = Math.min(Math.max(args.contextLines ?? 0, 0), 5);
    const stat = fs.statSync(requested);
    const cwd = stat.isDirectory() ? requested : path.dirname(requested);

    const rgArgs = [
      "--json",
      "--line-number",
      "--with-filename",
      "--color",
      "never",
    ];
    if (!args.regex) rgArgs.push("--fixed-strings");
    if (!args.caseSensitive) rgArgs.push("--ignore-case");
    if (args.wordBoundary) rgArgs.push("--word-regexp");
    if (args.multiline) rgArgs.push("--multiline");
    if (contextLines > 0) rgArgs.push("-C", String(contextLines));
    if (args.filePattern) rgArgs.push("--glob", args.filePattern);
    if (args.excludePattern) rgArgs.push("--glob", `!${args.excludePattern}`);

    rgArgs.push(args.query);
    rgArgs.push(stat.isDirectory() ? "." : path.basename(requested));

    // ripgrep runs asynchronously so parallel tool calls and side-channel
    // work (profile panels, title generation) keep running while it searches.
    return runGrepSearch({
      sessionId: input.sessionId,
      query: args.query,
      rgArgs,
      cwd,
      limit,
      contextLines,
      grepTarget: stat.isDirectory() ? "." : path.basename(requested),
      regex: args.regex ?? false,
      caseSensitive: args.caseSensitive ?? false,
      wordBoundary: args.wordBoundary ?? false,
      filePattern: args.filePattern,
      excludePattern: args.excludePattern,
      multiline: args.multiline ?? false,
    });
  },
};

interface GrepSearchInput {
  sessionId: string;
  query: string;
  rgArgs: string[];
  cwd: string;
  limit: number;
  contextLines: number;
  grepTarget: string;
  regex: boolean;
  caseSensitive: boolean;
  wordBoundary: boolean;
  filePattern?: string;
  excludePattern?: string;
  multiline: boolean;
}

async function runGrepSearch(
  prepared: GrepSearchInput,
): Promise<ToolExecutionResult> {
  const {
    sessionId,
    query: queryText,
    rgArgs,
    cwd,
    limit,
    contextLines,
  } = prepared;
  const rgPath = await resolveRipgrep();
  if (!rgPath) {
    return runGrepFallback(prepared);
  }
  const result = await runCommand(rgPath, rgArgs, {
    cwd,
    maxBufferBytes: 8 * 1024 * 1024,
  });
  if (result.error) return runGrepFallback(prepared);
  if (result.status !== 0 && result.status !== 1) {
    const stderrInfo = result.stderr?.trim()
      ? ` stderr: ${result.stderr.trim()}`
      : "";
    throw new Error(
      `rg failed with exit code ${result.status ?? "unknown"}.${stderrInfo} ` +
        "Verify that the Synax installation contains a compatible bundled ripgrep.",
    );
  }

  const hits: Array<{
    path: string;
    line: number;
    preview: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }> = [];
  let currentMatch: (typeof hits)[number] | null = null;
  const contextBefore: string[] = [];
  const contextAfter: string[] = [];
  let collectingAfter = false;

  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: {
      type?: string;
      data?: {
        path?: { text?: string };
        line_number?: number;
        lines?: { text?: string };
      };
    };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === "context" && contextLines > 0) {
      const text = (event.data?.lines?.text ?? "")
        .replace(/\r?\n$/, "")
        .slice(0, 240);
      if (collectingAfter) {
        contextAfter.push(text);
      } else {
        contextBefore.push(text);
      }
      continue;
    }

    if (event.type === "match") {
      if (currentMatch && contextLines > 0) {
        currentMatch.contextAfter = [...contextAfter];
      }
      contextAfter.length = 0;
      collectingAfter = true;

      if (!event.data?.path?.text || typeof event.data.line_number !== "number")
        continue;
      const absolutePath = path.resolve(cwd, event.data.path.text);
      const fileInfo = fs.statSync(absolutePath);
      if (fileInfo.size > 256_000) continue;

      currentMatch = {
        path: toWorkspaceRelative(absolutePath, sessionId),
        line: event.data.line_number,
        preview: (event.data.lines?.text ?? "")
          .replace(/\r?\n$/, "")
          .slice(0, 240),
      };
      if (contextLines > 0) {
        currentMatch.contextBefore = [...contextBefore];
      }
      contextBefore.length = 0;
      hits.push(currentMatch);
      if (hits.length >= limit) break;
      continue;
    }

    if (event.type === "end") {
      if (currentMatch && contextLines > 0) {
        currentMatch.contextAfter = [...contextAfter];
      }
      contextBefore.length = 0;
      contextAfter.length = 0;
      currentMatch = null;
      collectingAfter = false;
    }
  }

  if (currentMatch && contextLines > 0 && contextAfter.length > 0) {
    currentMatch.contextAfter = [...contextAfter];
  }

  return {
    result: { query: queryText, hits },
    displaySummary: `Found ${hits.length} matches for "${queryText}".`,
    artifacts: [
      {
        kind: "evidence",
        title: "Search results",
        summary: `Found ${hits.length} matches for "${queryText}".`,
        risk: "low",
      },
    ],
  };
}

/**
 * Portable degradation path for installations where the bundled binary cannot
 * start (for example, a damaged package or an unsupported CPU). `grep` is
 * deliberately invoked by name: unlike rg, it is the platform-provided
 * compatibility tool and is not part of Synax's search contract.
 */
async function runGrepFallback(
  prepared: GrepSearchInput,
): Promise<ToolExecutionResult> {
  const {
    sessionId,
    query: queryText,
    cwd,
    limit,
    contextLines,
    grepTarget,
    regex,
    caseSensitive,
    wordBoundary,
    filePattern,
    excludePattern,
    multiline,
  } = prepared;
  if (multiline) {
    throw new Error(
      `${RIPGREP_MISSING_HELP} grep fallback does not support multiline matching.`,
    );
  }

  const grepArgs = ["-n", "-H", "-I"];
  if (grepTarget === ".") grepArgs.push("-R");
  if (!regex) grepArgs.push("-F");
  if (!caseSensitive) grepArgs.push("-i");
  if (wordBoundary) grepArgs.push("-w");
  if (contextLines > 0) grepArgs.push("-C", String(contextLines));
  // BSD grep (the system grep on macOS) does not support GNU's --include and
  // --exclude flags. Filter those globs after parsing so the fallback remains
  // portable across macOS, Linux, and Windows environments with grep.
  grepArgs.push("--", queryText, grepTarget);

  const result = await runCommand("grep", grepArgs, {
    cwd,
    maxBufferBytes: 8 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(
      `${RIPGREP_MISSING_HELP} Traditional grep is also unavailable.`,
    );
  }
  if (result.status !== 0 && result.status !== 1) {
    const stderrInfo = result.stderr?.trim()
      ? ` stderr: ${result.stderr.trim()}`
      : "";
    throw new Error(
      `grep failed with exit code ${result.status ?? "unknown"}.${stderrInfo}`,
    );
  }

  const hits: Array<{
    path: string;
    line: number;
    preview: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }> = [];
  let current: (typeof hits)[number] | null = null;
  let before: string[] = [];
  const globMatches = (candidate: string, pattern: string): boolean => {
    const normalized = candidate.replaceAll(path.sep, "/");
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replaceAll("**/", "(?:.*/)?")
      .replaceAll("**", ".*")
      .replaceAll("*", "[^/]*")
      .replaceAll("?", "[^/]");
    return (
      new RegExp(`^${escaped}$`).test(normalized) ||
      new RegExp(`(?:^|/)${escaped}$`).test(normalized)
    );
  };
  const allowed = (relativePath: string): boolean =>
    (!filePattern || globMatches(relativePath, filePattern)) &&
    (!excludePattern || !globMatches(relativePath, excludePattern));
  const finish = (): void => {
    current = null;
    before = [];
  };

  for (const outputLine of result.stdout.split(/\r?\n/)) {
    if (!outputLine || outputLine === "--") {
      finish();
      continue;
    }
    const parsed = outputLine.match(/^(.*)([:-])(\d+)([:-])(.*)$/);
    if (!parsed) continue;
    const [, rawPath, , lineText, separator, text] = parsed;
    const absolutePath = path.resolve(cwd, rawPath);
    if (
      !fs.existsSync(absolutePath) ||
      !allowed(toWorkspaceRelative(absolutePath, sessionId))
    )
      continue;
    if (separator === "-") {
      if (current) (current.contextAfter ??= []).push(text.slice(0, 240));
      else before.push(text.slice(0, 240));
      continue;
    }
    if (current && contextLines > 0) current.contextAfter ??= [];
    try {
      if (fs.statSync(absolutePath).size > 256_000) continue;
    } catch {
      continue;
    }
    current = {
      path: toWorkspaceRelative(absolutePath, sessionId),
      line: Number(lineText),
      preview: text.slice(0, 240),
    };
    if (contextLines > 0 && before.length) current.contextBefore = before;
    before = [];
    hits.push(current);
    if (hits.length >= limit) break;
  }

  return {
    result: { query: queryText, hits },
    displaySummary: `Found ${hits.length} matches for "${queryText}" (grep fallback).`,
    artifacts: [
      {
        kind: "evidence",
        title: "Search results",
        summary: `Found ${hits.length} matches for "${queryText}".`,
        risk: "low",
      },
    ],
  };
}
