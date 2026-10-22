import fs from "node:fs";
import { SEARCH_TIMEOUT_MS, SEARCH_MAX_FILE_BYTES, searchCanContinue, searchFiles, matchesSearchGlob, type SearchBudget } from "./search-files.js";
import path from "node:path";
import { runCommand } from "./exec-async.js";
import { resolveRipgrep, RIPGREP_MISSING_HELP } from "./ripgrep.js";
import * as z from "zod/v4";
import type { RegisteredTool, ToolExecutionResult } from "../contracts.js";
import { recordSessionFileDiscovery } from "../read-tracker.js";
import { resolveWorkspacePath, toWorkspaceRelative, workspaceRoot } from "./workspace.js";

export const grepSearchTool: RegisteredTool = {
  id: "grep.search",
  label: "Search Text",
  description:
    "Fast workspace text search backed by bundled ripgrep, with bounded, ignore-aware grep as a compatibility fallback. Fixed-string by default (regex=true for regex patterns); supports glob filters, context lines, word boundary, and multiline matching.",
  category: "read",
  mutability: "read",
  resumeBehavior: "auto",
  internalGate: "none",
  progressiveDetails:
    'Accepts { query: string, path?: string, limit?: number, caseSensitive?: boolean, regex?: boolean, filePattern?: string, excludePattern?: string, contextLines?: number, wordBoundary?: boolean, multiline?: boolean }. Returns matching lines with file path, line number, preview text, and optional context lines. Examples: { "query": "needle", "filePattern": "*.ts", "contextLines": 1 }; { "query": "resolve(Workspace)?Path", "regex": true }. Pitfalls: query is a fixed string unless regex=true, so ( ) | [ ] . * ? + are literal and a regex-style query reports no hits; put file filters in filePattern/excludePattern and the search base in path instead of encoding them in the query.',
  inputSchema: z.object({
    timeoutMs: z.number().int().min(100).max(120_000).optional().describe("Search deadline in milliseconds (default 30000, maximum 120000)."),
    includeIgnored: z.boolean().optional().describe("Explicitly search hidden/ignored files (default false)."),
    query: z
      .string()
      .min(1)
      .describe(
        "Text or regex pattern to search for. Fixed-string unless regex=true.",
      ),
    path: z
      .string()
      .min(1)
      .optional()
      .describe("Workspace-relative path to search under (default: workspace root)."),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe("Max matches (default 50, capped at 200)."),
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
      timeoutMs?: number;
      includeIgnored?: boolean;
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
      "--max-filesize", String(SEARCH_MAX_FILE_BYTES),
      "--line-number",
      "--with-filename",
      "--color",
      "never",
    ];
    if (args.includeIgnored) rgArgs.push("--hidden", "--no-ignore");
    if (!args.regex) rgArgs.push("--fixed-strings");
    if (!args.caseSensitive) rgArgs.push("--ignore-case");
    if (args.wordBoundary) rgArgs.push("--word-regexp");
    if (args.multiline) rgArgs.push("--multiline");
    if (contextLines > 0) rgArgs.push("-C", String(contextLines));
    if (args.filePattern) rgArgs.push("--glob", args.filePattern);
    if (args.excludePattern) rgArgs.push("--glob", `!${args.excludePattern}`);

    // End of options: a query that begins with "-" is a pattern, not a flag.
    rgArgs.push("--", args.query);
    rgArgs.push(stat.isDirectory() ? "." : path.basename(requested));

    // ripgrep runs asynchronously so parallel tool calls and side-channel
    // work (profile panels, title generation) keep running while it searches.
    return runGrepSearch({
      budget: { deadline: Date.now() + Math.min(120_000, Math.max(100, args.timeoutMs ?? SEARCH_TIMEOUT_MS)), signal: input.abortSignal, entries: 0, files: 0, bytes: 0, status: "complete" },
      includeIgnored: args.includeIgnored,
      onProgress: input.onProgress,
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
  budget: SearchBudget;
  includeIgnored?: boolean;
  onProgress?: (progress: { files?: number; bytes?: number; matches?: number }) => void;
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
  const { budget } = prepared;
  if (!searchCanContinue(budget)) return searchResult(prepared, [], false);
  const rgPath = await resolveRipgrep();
  if (!rgPath) {
    return runGrepFallback(prepared);
  }
  let lineBuffer = ""; let matchCount = 0;
  const result = await runCommand(rgPath, rgArgs, {
    cwd, signal: budget.signal, timeoutMs: Math.max(1, budget.deadline - Date.now()),
    maxBufferBytes: 1024 * 1024, stopOnOutputLimit: true,
    onStdout(chunk) {
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "match") matchCount++;
          if (event.type === "end") { budget.files++; budget.bytes += event.data?.stats?.bytes_searched ?? 0; }
        } catch { /* an incomplete output line is ignored */ }
      }
      prepared.onProgress?.({ files: budget.files, bytes: budget.bytes, matches: matchCount });
      return matchCount < limit;
    },
  });
  if (budget.signal?.aborted) budget.status = "cancelled";
  else if (result.timedOut) budget.status = "timeout";
  else if (result.stoppedEarly || result.stdoutTruncated) budget.status = "limit_reached";
  if (result.error && budget.status === "complete") return runGrepFallback(prepared);
  if (budget.status === "complete" && result.status !== 0 && result.status !== 1) {
    const stderrInfo = result.stderr?.trim()
      ? ` stderr: ${result.stderr.trim()}`
      : "";
    const hint = /unrecognized flag/i.test(result.stderr ?? "")
      ? ' The pattern was parsed as a command-line flag; rewrite a query that begins with "-" (for example "--color" as "(?:--color)") and retry.'
      : " Verify that the Synax installation contains a compatible bundled ripgrep.";
    throw new Error(
      `rg failed with exit code ${result.status ?? "unknown"}.${stderrInfo}${hint}`,
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
      recordSessionFileDiscovery(sessionId, currentMatch.path);
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

  return searchResult(prepared, hits, false);
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

  const { budget } = prepared;
  const grepArgs = ["-n", "-H", "-I", regex ? "-E" : "-F"];
  if (!caseSensitive) grepArgs.push("-i");
  if (wordBoundary) grepArgs.push("-w");
  if (contextLines > 0) grepArgs.push("-C", String(contextLines));
  let stdout = ""; let matched = 0;
  const batch: string[] = [];
  const searchBatch = async () => {
    if (!batch.length || !searchCanContinue(budget)) return;
    let pending = "";
    const result = await runCommand("grep", [...grepArgs, "--", queryText, ...batch.splice(0)], {
      cwd, signal: budget.signal, timeoutMs: Math.max(1, budget.deadline - Date.now()),
      maxBufferBytes: Math.max(1, 1024 * 1024 - Buffer.byteLength(stdout)), stopOnOutputLimit: true,
      onStdout(chunk) {
        pending += chunk;
        const lines = pending.split("\n"); pending = lines.pop() ?? "";
        matched += lines.filter(line => /^.*:\d+:/.test(line)).length;
        return matched < limit;
      },
    });
    stdout += result.stdout;
    if (budget.signal?.aborted) budget.status = "cancelled";
    else if (result.timedOut) budget.status = "timeout";
    else if (result.stoppedEarly || result.stdoutTruncated || matched >= limit) budget.status = "limit_reached";
    else if (result.error || result.status !== 0 && result.status !== 1) throw new Error(result.stderr.trim() || `${RIPGREP_MISSING_HELP} grep failed.`);
    prepared.onProgress?.({ files: budget.files, bytes: budget.bytes, matches: matched });
  };
  if (grepTarget !== ".") { batch.push(grepTarget); budget.files++; await searchBatch(); }
  else {
    for await (const file of searchFiles(cwd, workspaceRoot(sessionId), budget, prepared)) {
      batch.push(file);
      if (batch.length >= 32) await searchBatch();
    }
    await searchBatch();
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
  const allowed = (relativePath: string): boolean =>
    (!filePattern || matchesSearchGlob(relativePath, filePattern)) &&
    (!excludePattern || !matchesSearchGlob(relativePath, excludePattern));
  const finish = (): void => {
    current = null;
    before = [];
  };

  for (const outputLine of stdout.split(/\r?\n/)) {
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
      !allowed(path.relative(cwd, absolutePath))
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

  for (const hit of hits) recordSessionFileDiscovery(sessionId, hit.path);
  return searchResult(prepared, hits, true);
}

function searchResult(prepared: GrepSearchInput, hits: unknown[], fallback: boolean): ToolExecutionResult {
  const { status, files, bytes } = prepared.budget;
  const partial = status !== "complete";
  const summary = `Found ${hits.length} matches for "${prepared.query}"${fallback ? " (grep fallback)" : ""}.${partial ? ` Partial search: ${status}.` : ""}`;
  return { result: { query: prepared.query, hits, status, partial, scannedFiles: files, scannedBytes: bytes },
    displaySummary: summary, artifacts: [{ kind: "evidence", title: "Search results", summary, risk: "low" }] };
}
